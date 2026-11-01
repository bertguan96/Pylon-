import { app } from 'electron'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Receiver, ReceiverEvent, Sender, SenderEvent } from 'zmodem2'
import { SessionManager } from '../ssh/session-manager'
import type { ZmodemDialogs } from '../zmodem/controller'
import type { ConnectionConfig, MainEvent, ZmodemState } from '../../shared/types'

/**
 * rz / sz 的端到端自测（ZMODEM_E2E=1 时运行）。
 *
 * 和 zmodem-probe 的区别：那个只测协议引擎（内存里对喂字节），这个把整条真实链路跑一遍 ——
 * 真 ssh2 服务端 → 真 TCP → 真 ssh2 客户端 → SessionManager → ZmodemController → 终端事件。
 * 唯一被替换掉的是「弹窗选路径」，换成自动应答，否则没法无界面跑。
 *
 * 覆盖的点：
 *   - 起始帧在真实 TCP 分段下能否被识别（sz / rz 各一次）
 *   - 落盘字节是否一字不差（下载 300KB / 上传 250KB）
 *   - 二进制有没有泄漏到终端（终端里不该再出现 ZDLE 0x18）
 *   - 传输中敲 Ctrl+C 能不能中止并删掉半截文件
 *
 * 模拟服务端的 sz / rz 用同一个 zmodem2 库扮演，等价于一台装了 lrzsz 的主机。
 */

const checks: Array<[string, boolean, string?]> = []
const record = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail])
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/** 造一份可复现的负载：按字节序填 i & 0xff，客户端不传数据也能算出来比对 */
function payloadOf(size: number): Buffer {
  const buf = Buffer.allocUnsafe(size)
  for (let i = 0; i < size; i++) buf[i] = i & 0xff
  return buf
}

export function maybeRunZmodemE2E(): void {
  if (!process.env.ZMODEM_E2E) return

  void (async () => {
    const dir = mkdtempSync(join(tmpdir(), 'pylon-zmodem-'))
    const uploadPath = join(dir, 'up.bin')
    const uploadPayload = payloadOf(250_000)
    writeFileSync(uploadPath, uploadPayload)

    const remote = new MockRemote()
    const port = await remote.listen()

    const events: ZmodemState[] = []
    /** 终端收到的所有字节，用来查二进制泄漏 */
    const terminal: Buffer[] = []

    const dialogs: ZmodemDialogs = {
      async save(_win, name) {
        return join(dir, `recv-${name}`)
      },
      async pick() {
        return [uploadPath]
      }
    }

    const sessions = new SessionManager(
      (evt: MainEvent) => {
        if (evt.type === 'zmodem:update') events.push(evt.state)
        else if (evt.type === 'session:data') terminal.push(Buffer.from(evt.data))
      },
      () => null,
      dialogs
    )

    try {
      const conn: ConnectionConfig = {
        id: 'e2e',
        name: 'e2e',
        host: '127.0.0.1',
        port,
        username: 'demo',
        authType: 'password',
        legacyAlgorithms: false,
        timeout: 8000,
        hasSecret: true,
        createdAt: Date.now(),
        updatedAt: Date.now()
      }

      const info = await sessions.open(conn, 'demo1234', 120, 30)
      record('真 SSH 链路上建连成功', info.status === 'connected', `${info.host}:${port}`)
      // 服务端 banner 要先走完，键盘输入才不会被它吃掉
      await sleep(150)

      // ---------------------------------------------------------- 下载（远端 sz）
      sessions.write(info.sessionId, 'sz down.bin 300000\r')
      const dl = await waitState(events, (s) => s.direction === 'download' && s.status !== 'active')
      const dlPath = join(dir, 'recv-down.bin')
      const dlGot = existsSync(dlPath) ? readFileSync(dlPath) : Buffer.alloc(0)
      record('下载：远端 sz 被识别为下载并完成', dl?.status === 'done', dl?.message)
      record(
        '下载：落盘字节完全一致',
        dlGot.length === 300_000 && dlGot.equals(payloadOf(300_000)),
        `${dlGot.length} 字节`
      )

      // 收尾握手（ZFIN 往返）还在进行时键盘输入会被接管，等它走完再敲下一条命令
      await sleep(300)

      // ---------------------------------------------------------- 上传（远端 rz）
      events.length = 0
      sessions.write(info.sessionId, 'rz up.bin 250000\r')
      const ul = await waitState(events, (s) => s.direction === 'upload' && s.status !== 'active')
      const ulGot = remote.received
      record('上传：远端 rz 被识别为上传并完成', ul?.status === 'done', ul?.message)
      record(
        '上传：远端收到的字节完全一致',
        ulGot.length === uploadPayload.length && ulGot.equals(uploadPayload),
        `${ulGot.length} 字节`
      )

      // ---------------------------------------------------------- 终端洁净度
      // 只在正常传输之后查：中止那一刻远端可能还有在途的数据，跟泄漏不是一回事
      record('终端：正常传输期间没有二进制泄漏', !Buffer.concat(terminal).includes(0x18))

      // ---------------------------------------------------------- 中止（传输中 Ctrl+C）
      await sleep(300)
      events.length = 0
      remote.received = Buffer.alloc(0)
      sessions.write(info.sessionId, 'sz big.bin 4000000\r')
      const started = await waitState(events, (s) => s.status === 'active', 15_000)
      // 键盘输入被接管，只放行 Ctrl+C
      sessions.write(info.sessionId, '\u0003')
      const stopped = await waitState(events, (s) => s.status === 'error', 15_000)
      record('中止：传输中真的跑起来了', Boolean(started))
      record('中止：Ctrl+C 让传输失败退出', stopped?.status === 'error', stopped?.message)
      // 半截文件必须删掉，否则用户会拿着一个看起来完整、其实截断的文件
      await sleep(200)
      record('中止：半截文件被清理', !existsSync(join(dir, 'recv-big.bin')))
    } catch (err) {
      record('端到端异常', false, (err as Error).message)
    } finally {
      sessions.closeAll()
      remote.close()
      try {
        rmSync(dir, { recursive: true, force: true })
      } catch {
        // 临时目录删不掉无所谓
      }
    }

    console.log('\n===== ZMODEM 端到端自测 =====')
    for (const [name, ok, detail] of checks) {
      console.log(`${ok ? '[通过]' : '[失败]'} ${name}${detail ? ` —— ${detail}` : ''}`)
    }
    const failed = checks.filter(([, ok]) => !ok).length
    console.log(`===== ${checks.length - failed}/${checks.length} 通过 =====\n`)
    app.exit(failed === 0 ? 0 : 1)
  })()
}

/** 等一个满足条件的 zmodem 状态事件 */
async function waitState(
  events: ZmodemState[],
  match: (s: ZmodemState) => boolean,
  timeoutMs = 30_000
): Promise<ZmodemState | null> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const hit = events.find(match)
    if (hit) return hit
    if (Date.now() > deadline) return null
    await sleep(20)
  }
}

// ---------------------------------------------------------------- 模拟远端

/**
 * 扮演一台装了 lrzsz 的 Linux 主机。
 *
 * 命令行的行为与真实 shell 对齐：
 *   sz <name> <size>  → 先吐 ZRQINIT，然后按协议发文件（远端是发送方）
 *   rz <name> <size>  → 先吐 ZRINIT，等客户端发文件（远端是接收方）
 */
class MockRemote {
  /** 最近一次 rz 收到的内容，供断言用 */
  received: Buffer = Buffer.alloc(0)
  private server: import('ssh2').Server | null = null

  async listen(): Promise<number> {
    // 动态 import：ssh2 不能出现在主进程的启动依赖里（见 ssh/client.ts 的说明）
    const mod = (await import('ssh2')) as unknown as {
      Server: typeof import('ssh2').Server
      utils: typeof import('ssh2').utils
      default?: { Server: typeof import('ssh2').Server; utils: typeof import('ssh2').utils }
    }
    const { Server, utils } = mod.Server ? mod : mod.default!

    const hostKey = utils.generateKeyPairSync('ed25519')
    const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
      client.on('authentication', (ctx) => {
        if (ctx.method === 'password' && ctx.username === 'demo' && ctx.password === 'demo1234') {
          return ctx.accept()
        }
        ctx.reject(['password'])
      })

      client.on('ready', () => {
        client.on('session', (accept) => {
          const session = accept()
          session.on('pty', (acceptPty) => acceptPty?.())
          session.on('window-change', (acceptResize) => acceptResize?.())
          session.on('shell', (acceptShell) => {
            const stream = acceptShell()
            this.wireShell(stream)
          })
        })
      })
      client.on('error', () => undefined)
    })

    this.server = server
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()))
    const addr = server.address()
    return typeof addr === 'object' && addr ? addr.port : 0
  }

  close(): void {
    this.server?.close()
  }

  private wireShell(stream: import('ssh2').ServerChannel): void {
    let line = ''
    /** 传输进行中：进来的字节直接喂给协议对端，不再当命令行解析 */
    let peer: ((bytes: Uint8Array) => void) | null = null

    const prompt = () => stream.write('$ ')

    /**
     * 当前传输的泵送函数。
     *
     * 除了收到数据时推一次，还要靠定时器持续推：sender 在 FileComplete 里调 finishSession()
     * 只是把 ZFIN 塞进出站队列，不推就发不出去，双方会互相等（一个等 ZFIN，一个等 ack）。
     * 真实 lrzsz 是常驻循环，这里用个 10ms 的 tick 等效模拟。
     */
    let tick: (() => void) | null = null
    const timer = setInterval(() => tick?.(), 10)
    stream.on('close', () => clearInterval(timer))

    const sz = (name: string, size: number) => {
      const sx = new Sender() // 远端 sz 是发起方
      const payload = payloadOf(size)
      sx.startFile(name, size, Date.now())

      /**
       * 一轮「排空出站 → 满足文件请求」。
       *
       * 必须边喂边排：sender 的 offset 要等数据真的排出去了才前进，
       * 只 pollFile/feedFile 而不 drainOutgoing 会永远拿到同一个 offset，
       * 于是同一段数据被反复塞进缓冲区 —— 死循环 + 内存暴涨（踩过，现象是整个进程卡死）。
       */
      const pump = () => {
        for (let guard = 0; guard < 2000; guard++) {
          let out = sx.drainOutgoing()
          while (out.length) {
            stream.write(Buffer.from(out))
            out = sx.drainOutgoing()
          }
          const req = sx.pollFile()
          if (!req) break
          const len = Math.min(req.len, payload.length - req.offset)
          if (len <= 0) break
          sx.feedFile(payload.subarray(req.offset, req.offset + len))
        }
        let ev = sx.pollEvent()
        while (ev) {
          // 真实 lrzsz 的 sz 发完文件会立刻发 ZFIN 收尾，这里照做
          if (ev === SenderEvent.FileComplete) sx.finishSession()
          if (ev === SenderEvent.SessionComplete) {
            peer = null
            tick = null
            stream.write(`\r\nsz 完成 ${name}\r\n`)
            prompt()
          }
          ev = sx.pollEvent()
        }
      }

      peer = (bytes) => {
        // 客户端中止时发 8 个连续 CAN(0x18)，真实 lrzsz 收到就收手，这里照做
        if (collapsed(bytes)) {
          peer = null
          tick = null
          stream.write('\r\nsz 已中止\r\n')
          prompt()
          return
        }
        deliver(sx, bytes)
        pump()
      }
      tick = pump
      pump()
    }

    const rz = (name: string, size: number) => {
      const rx = new Receiver() // 远端 rz 是接收方
      this.received = Buffer.alloc(0)
      const chunks: Buffer[] = []

      const pump = () => {
        let out = rx.drainOutgoing()
        while (out.length) {
          stream.write(Buffer.from(out))
          out = rx.drainOutgoing()
        }
        let data = rx.drainFile()
        while (data.length) {
          chunks.push(Buffer.from(data))
          data = rx.drainFile()
        }
        let ev = rx.pollEvent()
        while (ev) {
          if (ev === ReceiverEvent.SessionComplete) {
            peer = null
            tick = null
            this.received = Buffer.concat(chunks)
            stream.write(`\r\nrx 收到 ${name} ${this.received.length}/${size} 字节\r\n`)
            prompt()
          }
          ev = rx.pollEvent()
        }
      }

      peer = (bytes) => {
        deliver(rx, bytes)
        pump()
      }
      tick = pump
      // 远端先发 ZRINIT，客户端的检测器就是靠这一帧认出「远端在等文件」
      pump()
    }

    stream.on('data', (chunk: Buffer) => {
      if (peer) {
        peer(chunk)
        return
      }
      for (const ch of chunk.toString('utf8')) {
        if (ch === '\r' || ch === '\n') {
          // 收尾时客户端会补一个 "OO"（ZMODEM 的会话结束应答），真实 lrzsz 会吃掉它，
          // 这里的假 shell 已经退出传输态，得手动剥掉，否则它会被粘到下一条命令前面
          const cmdline = line.trim().replace(/^OO/, '')
          line = ''
          const [cmd, name, arg] = cmdline.split(/\s+/)
          if (cmd === 'sz' && name) {
            stream.write(`\r\n正在发送 ${name}...\r\n`)
            sz(name, Number(arg) || 100_000)
          } else if (cmd === 'rz' && name) {
            stream.write(`\r\n等待接收 ${name}...\r\n`)
            rz(name, Number(arg) || 100_000)
          } else if (cmd) {
            stream.write(`mock: ${cmd}: not found\r\n`)
            prompt()
          } else {
            prompt()
          }
        } else if (ch === '\u007f' || ch === '\b') {
          line = line.slice(0, -1)
        } else {
          line += ch
        }
      }
    })

    stream.write('mock lrzsz 主机就绪\r\n')
    prompt()
  }
}

/** 判断这一包里有没有中止序列（ZMODEM 用连续 8 个 CAN 表示放弃） */
function collapsed(bytes: Uint8Array): boolean {
  let run = 0
  for (const b of bytes) {
    if (b === 0x18) {
      if (++run >= 8) return true
    } else run = 0
  }
  return false
}

/** 喂给协议对端，尊重「部分消费」返回值（接收端缓冲满时只吃一部分） */
function deliver(peer: Sender | Receiver, bytes: Uint8Array): void {
  let offset = 0
  for (let guard = 0; guard < 500 && offset < bytes.length; guard++) {
    const consumed = peer.feedIncoming(bytes.subarray(offset))
    offset += consumed
    if (consumed === 0) break
  }
}
