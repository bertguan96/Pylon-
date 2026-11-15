/**
 * 原生引擎的 Node 侧代理。
 *
 * 这里只做三件事：拉起 native/pylon-vnc 进程、把管道里的二进制帧拆成 VncRect、
 * 把指针/键盘指令编码成 8 字节小端包写进它的 stdin。没有解码，没有位图，
 * 也没有任何逐帧分配的主进程工作 —— 所以主进程的事件循环不会被画面拖住。
 *
 * 为什么要独立进程而不是原生插件（napi/node-gyp）：
 *   插件跟 Electron 的 ABI 绑定，每次升 Electron 都要按新版头文件重编，还得要求
 *   打包机上有 MSVC。独立 exe 把这层耦合切干净了：换 Electron 不用动它，崩了也
 *   只影响自己（主进程侧表现为一次正常的「连接断开」）。
 */

import { spawn, type ChildProcess } from 'node:child_process'
import { app } from 'electron'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import type { VncRect } from '../../shared/types'
import type { VncEngine, VncEngineOptions, VncInitInfo } from './engine'

const KIND_INIT = 1
const KIND_FRAMES = 2
const KIND_STATS = 3
const KIND_ERROR = 4
const KIND_CLOSED = 5
const KIND_CLIPBOARD = 6

const CMD_POINTER = 0x10
const CMD_KEY = 0x11
const CMD_FULL = 0x12
const CMD_CLOSE = 0x13
const CMD_CUT_TEXT = 0x14

const HEADER = 8
const MAGIC0 = 0x50 // 'P'
const MAGIC1 = 0x56 // 'V'

/** 握手 + 首帧最多等这么久；超过说明 exe 卡住或对端无响应 */
const CONNECT_TIMEOUT_MS = 15000

/**
 * 找引擎 exe 的位置。
 *
 * 开发时在仓库里（native/pylon-vnc/bin），打包后被 electron-builder 放到
 * resources 根目录。都不在就返回 null，上层自动退回 JS 引擎。
 */
export function nativeEnginePath(): string | null {
  const candidates = [
    process.env.PYLON_VNC_ENGINE,
    join(app.getAppPath(), 'native', 'pylon-vnc', 'bin', 'pylon-vnc.exe'),
    join(process.cwd(), 'native', 'pylon-vnc', 'bin', 'pylon-vnc.exe'),
    process.resourcesPath ? join(process.resourcesPath, 'pylon-vnc.exe') : undefined
  ].filter((p): p is string => typeof p === 'string' && p.length > 0)

  for (const p of candidates) {
    try {
      if (existsSync(p)) return p
    } catch {
      // 路径不可读就跳过
    }
  }
  return null
}

interface Pending {
  resolve: (info: VncInitInfo) => void
  reject: (err: Error) => void
  timer: NodeJS.Timeout
}

export class NativeVncClient implements VncEngine {
  readonly engine = 'native' as const
  readonly securityTypes: number[] = [2]

  private readonly options: VncEngineOptions
  private readonly exe: string
  private child: ChildProcess | null = null
  private pending: Pending | null = null
  private closed = false
  private active = true
  private ready = false

  /** 收包缓冲：按块存放，只在真的需要拼的时候才 concat 一次 */
  private parts: Buffer[] = []
  private total = 0

  constructor(options: VncEngineOptions, exe: string) {
    this.options = options
    this.exe = exe
  }

  connect(): Promise<VncInitInfo> {
    return new Promise<VncInitInfo>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.fail(new Error('原生引擎启动超时，请检查 native/pylon-vnc/bin 是否存在'))
      }, CONNECT_TIMEOUT_MS)
      this.pending = { resolve, reject, timer }

      const args = [
        'serve',
        '--host',
        this.options.host,
        '--port',
        String(this.options.port),
        '--quality',
        this.options.quality === 'sharp' ? 'sharp' : 'speed'
      ]

      const child = spawn(this.exe, args, {
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: {
          ...process.env,
          // 密码走环境变量而不是命令行：命令行参数在进程列表里是公开的
          PYLON_VNC_PASSWORD: this.options.password ?? ''
        }
      })
      this.child = child

      child.stdout?.on('data', (chunk: Buffer) => this.feed(chunk))
      child.stdout?.on('error', (err) => this.fail(err))
      child.stderr?.on('data', (chunk: Buffer) => {
        // 引擎的诊断信息只往 stderr 写，这里原样转出去，方便用户在日志里看到原因
        const text = chunk.toString('utf8').trim()
        if (text) console.log(text)
      })
      child.on('error', (err) => this.fail(new Error(`拉起原生引擎失败：${err.message}`)))
      child.on('exit', (code) => {
        if (this.closed) return
        this.fail(
          new Error(
            this.lastError ?? `原生引擎退出（code ${code ?? 'null'}），连接已断开`
          )
        )
      })
    })
  }

  private lastError: string | undefined

  private fail(err: Error): void {
    if (this.closed) return
    this.closed = true
    const pending = this.pending
    this.pending = null
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(err)
      return
    }
    this.options.onClose?.(err)
  }

  /** 正常关闭：不发错误回调 */
  close(): void {
    if (this.closed) {
      this.kill()
      return
    }
    this.closed = true
    const pending = this.pending
    this.pending = null
    if (pending) {
      clearTimeout(pending.timer)
      pending.reject(new Error('连接已取消'))
    }
    this.send(CMD_CLOSE, Buffer.alloc(0))
    // 给引擎一点时间自己退出，超时就强杀
    setTimeout(() => this.kill(), 400)
    this.options.onClose?.()
  }

  private kill(): void {
    const child = this.child
    this.child = null
    if (!child) return
    try {
      child.stdin?.end()
      child.kill()
    } catch {
      // 已经退了
    }
  }

  pointer(x: number, y: number, mask: number): void {
    if (this.closed || !this.ready) return
    const buf = Buffer.alloc(5)
    buf[0] = mask & 0xff
    buf.writeUInt16LE(clamp(x), 1)
    buf.writeUInt16LE(clamp(y), 3)
    this.send(CMD_POINTER, buf)
  }

  key(keysym: number, down: boolean): void {
    if (this.closed || !this.ready) return
    const buf = Buffer.alloc(8)
    buf[0] = down ? 1 : 0
    buf.writeUInt32LE(keysym >>> 0, 4)
    this.send(CMD_KEY, buf)
  }

  cutText(text: string): void {
    if (this.closed || !this.ready) return
    this.send(CMD_CUT_TEXT, Buffer.from(text, 'utf8'))
  }

  refresh(): void {
    if (this.closed || !this.ready) return
    this.send(CMD_FULL, Buffer.alloc(0))
  }

  setActive(active: boolean): void {
    this.active = active
    if (active) this.refresh()
  }

  private send(kind: number, payload: Buffer): void {
    const child = this.child
    if (!child?.stdin || child.stdin.destroyed) return
    const head = Buffer.alloc(HEADER)
    head[0] = MAGIC0
    head[1] = MAGIC1
    head[2] = kind
    head[3] = 0
    head.writeUInt32LE(payload.length, 4)
    try {
      child.stdin.write(head)
      if (payload.length > 0) child.stdin.write(payload)
    } catch {
      this.fail(new Error('向原生引擎写数据失败'))
    }
  }

  // ---------- 收包 ----------

  private feed(chunk: Buffer): void {
    this.parts.push(chunk)
    this.total += chunk.length

    for (;;) {
      const head = this.peek(HEADER)
      if (!head) return
      if (head[0] !== MAGIC0 || head[1] !== MAGIC1) {
        this.fail(new Error('原生引擎输出错位（magic 不匹配）'))
        return
      }
      const len = head.readUInt32LE(4)
      if (len > 64 * 1024 * 1024) {
        this.fail(new Error(`原生引擎输出长度异常：${len}`))
        return
      }
      const whole = this.peek(HEADER + len)
      if (!whole) return
      const kind = whole[2]
      const payload = whole.subarray(HEADER, HEADER + len)
      this.consume(HEADER + len)
      this.handle(kind, payload)
      if (this.closed) return
    }
  }

  private peek(n: number): Buffer | null {
    if (this.total < n) return null
    if (this.parts[0].length >= n) return this.parts[0]
    // 只有跨块时才真正拼一次，拼完把队列收敛成一块
    const merged = Buffer.concat(this.parts)
    this.parts = [merged]
    return merged
  }

  private consume(n: number): void {
    this.total -= n
    let left = n
    while (left > 0 && this.parts.length > 0) {
      const head = this.parts[0]
      if (head.length <= left) {
        this.parts.shift()
        left -= head.length
      } else {
        this.parts[0] = head.subarray(left)
        left = 0
      }
    }
  }

  private handle(kind: number, payload: Buffer): void {
    switch (kind) {
      case KIND_INIT: {
        if (payload.length < 10) return
        const width = payload.readUInt16LE(0)
        const height = payload.readUInt16LE(2)
        const remoteWidth = payload.readUInt16LE(4)
        const remoteHeight = payload.readUInt16LE(6)
        const scale = payload.readUInt16LE(8) || 1
        const name = payload.subarray(10).toString('utf8')
        const info: VncInitInfo = { width, height, remoteWidth, remoteHeight, scale, name }
        this.ready = true
        const pending = this.pending
        this.pending = null
        if (pending) {
          clearTimeout(pending.timer)
          pending.resolve(info)
        }
        this.options.onInit?.(info)
        return
      }
      case KIND_FRAMES: {
        if (!this.ready || payload.length < 2) return
        const count = payload.readUInt16LE(0)
        let off = 2
        const rects: VncRect[] = []
        for (let i = 0; i < count; i++) {
          if (off + 8 > payload.length) break
          const x = payload.readUInt16LE(off)
          const y = payload.readUInt16LE(off + 2)
          const w = payload.readUInt16LE(off + 4)
          const h = payload.readUInt16LE(off + 6)
          off += 8
          const bytes = w * h * 4
          if (off + bytes > payload.length) break
          // 复制一份：管道缓冲会被复用，直接给视图会在 IPC 传递时读到后面帧的数据
          const data = new Uint8Array(bytes)
          data.set(payload.subarray(off, off + bytes))
          off += bytes
          rects.push({ x, y, w, h, data })
        }
        if (rects.length > 0 && this.active) this.options.onRects?.(rects)
        return
      }
      case KIND_STATS: {
        if (payload.length < 10) return
        this.options.onStats?.({
          fps: payload.readUInt16LE(0),
          kbps: payload.readUInt32LE(2)
        })
        return
      }
      case KIND_CLIPBOARD: {
        this.options.onClipboard?.(payload.toString('utf8'))
        return
      }
      case KIND_ERROR: {
        this.lastError = payload.toString('utf8')
        return
      }
      case KIND_CLOSED: {
        if (!this.closed) {
          this.closed = true
          const err = this.lastError ? new Error(this.lastError) : undefined
          this.options.onClose?.(err)
        }
        return
      }
      default:
        return
    }
  }
}

function clamp(v: number): number {
  return Math.max(0, Math.min(0xffff, Math.round(v)))
}
