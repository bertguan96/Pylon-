import type { Client, ClientChannel } from 'ssh2'
import { LocalSession } from '../local/local-session'
import { loadSsh2 } from './client'
import { randomUUID } from 'node:crypto'
import { LEGACY_ALGORITHMS } from './algorithms'
import { attachKeyboardHandler, buildAuthConfig } from './auth'
import { translateSshError } from './errors'
import type {
  ConnectionConfig,
  MainEvent,
  SessionInfo,
  SessionStatus
} from '../../shared/types'

/**
 * 背压水位线。
 * 远程 `cat` 大文件时每秒可达数 MB，若不暂停读取，IPC 消息队列会迅速堆积把渲染进程拖死。
 * 超过高水位就 pause，等渲染端 xterm 消费完并 ack 后再 resume。
 *
 * 水位不是越小越好：暂停-恢复本身有开销，水太浅会变成频繁的抖动；
 * 水太深则渲染端排队变长、交互回显变迟钝。可用 PERF_HIGH_WM 覆盖来做对照实验。
 */
const HIGH_WATERMARK = Number(process.env.PERF_HIGH_WM) || 512 * 1024
const LOW_WATERMARK = Math.floor(HIGH_WATERMARK / 4)

/**
 * 发送合并阈值（实测调过，别随手改大）。
 *
 * TCP 交给我们的包平均 18.6 KB，一个包发一条 IPC 消息时 100 MB 要发 5500 条。
 * 合并能砍掉一半消息，但**阈值一旦过 64 KB 就会出现断崖**（实测数据，100 MB 纯文本）：
 *
 *   不合并   18.6 KB/条  主进程 71.8 MB/s  端到端 65.0 MB/s
 *   32 KB    37.1 KB/条  主进程 71.4 MB/s  端到端 64.6 MB/s   ← 消息数减半，吞吐不掉
 *   64 KB    71.5 KB/条  主进程 59.7 MB/s  端到端 55.5 MB/s   ← 掉 15%
 *   128 KB  131.6 KB/条  主进程 62.9 MB/s  端到端 55.3 MB/s   ← 掉 15%
 *
 * 也就是说 Electron 的 IPC 对 50 KB 上下的消息很便宜，超过 64 KB 后每字节的代价变了。
 * 32 KB 是「消息数减半 + 吞吐不掉」的甜点。PERF_COALESCE=0 可完全关掉做对照。
 */
const COALESCE_TARGET =
  process.env.PERF_COALESCE === undefined ? 32 * 1024 : Number(process.env.PERF_COALESCE)

type EmitFn = (event: MainEvent) => void

/**
 * 流量统计。
 *
 * 几个字段对应压测要回答的问题：
 * - bytesIn / chunks：TCP 层实际收到多少数据、被切成了多少个 TCP 包
 * - msgs：真正发出去的 IPC 消息条数（合并后的），chunks / msgs 就是合并倍率
 * - pauses / pausedMs：背压有没有真的触发、暂停占了多少时间
 *   （暂停时间是吞吐上限的关键 —— 只要它接近总耗时，瓶颈就在渲染端而非网络）
 * - maxPending：待确认队列的峰值，超过水位线太多说明 ack 给得太慢
 */
export interface TrafficStats {
  bytesIn: number
  chunks: number
  msgs: number
  pauses: number
  pausedMs: number
  maxPending: number
  firstAt: number
  lastAt: number
}

/** 单个 SSH 会话：一次 client + 一条 shell channel */
class Session {
  readonly id = randomUUID()
  readonly connection: ConnectionConfig
  readonly traffic: TrafficStats = {
    bytesIn: 0,
    chunks: 0,
    msgs: 0,
    pauses: 0,
    pausedMs: 0,
    maxPending: 0,
    firstAt: 0,
    lastAt: 0
  }
  private client: Client | null = null
  private stream: ClientChannel | null = null
  private status: SessionStatus = 'connecting'
  private pendingBytes = 0
  private paused = false
  private pausedAt = 0
  private closedByUser = false
  /** 待合并发送的分片（已收到但还没打包进 IPC 消息） */
  private outBuf: Buffer[] = []
  private outLen = 0
  private flushHandle: NodeJS.Immediate | null = null
  private readonly emit: EmitFn

  constructor(connection: ConnectionConfig, emit: EmitFn) {
    this.connection = connection
    this.emit = emit
  }

  private setStatus(status: SessionStatus, error?: string) {
    this.status = status
    this.emit({ type: 'session:status', sessionId: this.id, status, error })
  }

  info(cols: number, rows: number): SessionInfo {
    return {
      sessionId: this.id,
      connectionId: this.connection.id,
      title: this.connection.name || this.connection.host,
      host: this.connection.host,
      username: this.connection.username,
      status: this.status,
      cols,
      rows
    }
  }

  async connect(secret: string | undefined, cols: number, rows: number): Promise<void> {
    const cfg = this.connection
    // ssh2 首次建连时才加载（38ms），不占启动时间
    const [{ Client }, auth] = await Promise.all([loadSsh2(), buildAuthConfig(cfg, secret)])
    const client = new Client()
    this.client = client

    return new Promise<void>((resolve, reject) => {
      // 只 resolve / reject 一次，避免 ready 和 error 都触发
      let settled = false
      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        err ? reject(err) : resolve()
      }

      client.on('ready', () => {
        client.shell(
          { term: 'xterm-256color', cols, rows },
          (err, stream) => {
            if (err) {
              this.setStatus('error', `打开 shell 失败：${err.message}`)
              settle(err)
              return
            }
            this.stream = stream
            this.bindStream(stream)
            this.setStatus('connected')
            settle()
          }
        )
      })

      client.on('error', (err) => {
        const msg = translateSshError(err.message || String(err), this.connection)
        this.setStatus('error', msg)
        settle(new Error(msg))
      })

      client.on('close', () => {
        if (this.status === 'connected' || this.status === 'connecting') {
          this.setStatus('closed', this.closedByUser ? undefined : '连接已断开')
        }
      })

      try {
        attachKeyboardHandler(client, auth)
        client.connect({
          host: cfg.host,
          port: cfg.port,
          username: cfg.username,
          readyTimeout: cfg.timeout || 15000,
          keepaliveInterval: 15000,
          keepaliveCountMax: 3,
          ...(cfg.legacyAlgorithms ? { algorithms: LEGACY_ALGORITHMS } : {}),
          ...auth.options
        })
      } catch (err) {
        const msg = (err as Error).message
        this.setStatus('error', msg)
        settle(new Error(msg))
      }
    })
  }

  private bindStream(stream: ClientChannel) {
    stream.on('data', (chunk: Buffer) => {
      // 全程按二进制透传，绝不 toString：UTF-8 汉字被 TCP 分包切断后会变成替换字符
      const t = this.traffic
      const now = performance.now()
      if (!t.firstAt) t.firstAt = now
      t.lastAt = now
      t.bytesIn += chunk.length
      t.chunks++

      this.pendingBytes += chunk.length
      if (this.pendingBytes > t.maxPending) t.maxPending = this.pendingBytes

      this.enqueue(chunk)

      if (this.pendingBytes > HIGH_WATERMARK && !this.paused) {
        stream.pause()
        this.paused = true
        t.pauses++
        this.pausedAt = now
      }
    })

    stream.on('close', () => {
      // 关流前把没发出去的分片先排空，否则最后一段输出会丢
      this.flush()
      this.client?.end()
      if (this.status !== 'error') {
        this.setStatus('closed', this.closedByUser ? undefined : '远端已关闭会话')
      }
      this.emit({ type: 'session:exit', sessionId: this.id, code: 0 })
    })

    // stderr 也送进终端，否则报错信息会整段丢失
    stream.stderr.on('data', (chunk: Buffer) => {
      this.enqueue(chunk)
    })
  }

  /**
   * 收数据：攒够一批或本轮事件循环结束再发。
   * 关掉合并（PERF_COALESCE=0）时退化成每包一发，用来做 A/B 对照。
   */
  private enqueue(chunk: Buffer): void {
    if (COALESCE_TARGET <= 0) {
      this.deliver(chunk)
      return
    }

    this.outBuf.push(chunk)
    this.outLen += chunk.length

    if (this.outLen >= COALESCE_TARGET) {
      this.flush()
      return
    }
    // setImmediate 而不是 setTimeout：同一轮 I/O 里到达的所有分片并成一条消息，
    // 单次按键的回显最多晚一个 tick，用户感知不到
    if (!this.flushHandle) this.flushHandle = setImmediate(() => this.flush())
  }

  private flush(): void {
    if (this.flushHandle) {
      clearImmediate(this.flushHandle)
      this.flushHandle = null
    }
    if (this.outLen === 0) return

    // 单个分片零拷贝直接发；多片才付一次 concat 的拷贝成本
    const out = this.outBuf.length === 1 ? this.outBuf[0] : Buffer.concat(this.outBuf, this.outLen)
    this.outBuf = []
    this.outLen = 0
    this.deliver(out)
  }

  private deliver(buf: Buffer): void {
    this.traffic.msgs++
    this.emit({
      type: 'session:data',
      sessionId: this.id,
      data: new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength)
    })
  }

  /** 渲染端消费完数据后回调，降低水位到阈值以下就恢复读取 */
  ack(bytes: number) {
    this.pendingBytes = Math.max(0, this.pendingBytes - bytes)
    if (this.paused && this.pendingBytes < LOW_WATERMARK && this.stream) {
      this.stream.resume()
      this.paused = false
      this.traffic.pausedMs += performance.now() - this.pausedAt
    }
  }

  write(data: string) {
    if (this.stream && this.status === 'connected') this.stream.write(data)
  }

  resize(cols: number, rows: number) {
    // 不同步到远端 PTY，vim / htop / tmux 的界面会错位
    if (this.stream && this.status === 'connected') {
      this.stream.setWindow(rows, cols, 0, 0)
    }
  }

  close() {
    this.closedByUser = true
    if (this.flushHandle) {
      clearImmediate(this.flushHandle)
      this.flushHandle = null
    }
    this.outBuf = []
    this.outLen = 0
    this.stream?.close()
    this.client?.end()
    this.setStatus('closed')
  }
}

export class SessionManager {
  /** SSH 会话和本机会话共用一张表，管理器只依赖它们的公共方法 */
  private sessions = new Map<string, Session | LocalSession>()
  private emit: EmitFn

  constructor(emit: EmitFn) {
    this.emit = emit
  }

  async open(connection: ConnectionConfig, secret: string | undefined, cols: number, rows: number): Promise<SessionInfo> {
    const session = new Session(connection, this.emit)
    this.sessions.set(session.id, session)
    try {
      await session.connect(secret, cols, rows)
      return session.info(cols, rows)
    } catch (err) {
      this.sessions.delete(session.id)
      throw err
    }
  }

  /** 打开一个本机会话（不走 SSH，实现与限制见 LocalSession 的注释） */
  async openLocal(cols: number, rows: number): Promise<SessionInfo> {
    const session = new LocalSession(this.emit)
    this.sessions.set(session.id, session)
    try {
      await session.connect(cols, rows)
      return session.info()
    } catch (err) {
      this.sessions.delete(session.id)
      throw err
    }
  }

  write(id: string, data: string) {
    this.sessions.get(id)?.write(data)
  }

  resize(id: string, cols: number, rows: number) {
    this.sessions.get(id)?.resize(cols, rows)
  }

  ack(id: string, bytes: number) {
    this.sessions.get(id)?.ack(bytes)
  }

  /** 压测读取流量统计；正常运行时无人调用，零额外开销 */
  traffic(): Array<{ sessionId: string; stats: TrafficStats }> {
    return [...this.sessions.values()].map((s) => ({ sessionId: s.id, stats: s.traffic }))
  }

  /** 压测前清零，否则 firstAt 还停在会话建立时的 banner 上，算出来的吞吐没有意义 */
  resetTraffic(): void {
    for (const s of this.sessions.values()) {
      const t = s.traffic
      t.bytesIn = 0
      t.chunks = 0
      t.msgs = 0
      t.pauses = 0
      t.pausedMs = 0
      t.maxPending = 0
      t.firstAt = 0
      t.lastAt = 0
    }
  }

  close(id: string) {
    const s = this.sessions.get(id)
    if (!s) return
    s.close()
    this.sessions.delete(id)
  }

  closeAll() {
    for (const s of this.sessions.values()) s.close()
    this.sessions.clear()
  }
}
