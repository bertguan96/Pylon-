import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { homedir, userInfo } from 'node:os'
import type { MainEvent, SessionInfo, SessionStatus } from '../../shared/types'
import type { TrafficStats } from '../ssh/session-manager'

/**
 * 本机 PowerShell 会话。
 *
 * 为什么不走 SSH：本机没装 sshd，而 node-pty 这类原生模块又需要 MSVC 才能编译。
 * 所以这里直接 spawn 一个 PowerShell 子进程，用管道收发 —— 代价是没有真正的 PTY：
 *
 * 1. **没有行编辑**。管道模式下 PowerShell 会逐字符回显，但退格、方向键一律当普通字符处理，
 *    打错一个字就再也改不掉。所以输入必须由我们本地接管：自己维护行缓冲、自己回显、自己重绘，
 *    只在按下回车时把整行交给 PowerShell。
 * 2. **没有信号**。Ctrl+C 传不到子进程，只能丢掉当前行再补一个空行，让 PowerShell 吐出新提示符。
 * 3. **没有窗口尺寸**。vim / htop 这类全屏程序不可用，普通命令（git / npm / dir）正常。
 * 4. **编码**。默认 GBK 会让中文变乱码，启动时用 -Command 把输入/输出编码都切到 UTF-8。
 *
 * 回车时的画面处理：先按已回显的宽度把行擦掉，再发送整行 —— PowerShell 自己会回显命令，
 * 于是屏幕上仍是「提示符 + 命令」一行，不会出现两份。
 */

type EmitFn = (event: MainEvent) => void

/** 和 SSH 会话保持同一套水位，背压行为一致 */
const HIGH_WATERMARK = 512 * 1024
const LOW_WATERMARK = HIGH_WATERMARK / 4

/** 历史命令上限 */
const HISTORY_MAX = 200

/** 启动时就绪脚本：把控制台编码切成 UTF-8，否则中文输入输出全是乱码 */
const INIT_COMMAND =
  '[Console]::InputEncoding=[Text.Encoding]::UTF8; ' +
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8; ' +
  '$OutputEncoding=[Text.Encoding]::UTF8'

/** 优先 pwsh 7，没有就退回系统自带的 5.1 */
function pickShell(): { cmd: string; args: string[] } {
  const custom = process.env.PYLON_LOCAL_SHELL
  if (custom) return { cmd: custom, args: ['-NoLogo', '-NoExit', '-Command', INIT_COMMAND] }

  const candidates = [
    'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    'C:\\Program Files\\PowerShell\\7-preview\\pwsh.exe'
  ]
  const pwsh = candidates.find((p) => existsSync(p))
  if (pwsh) return { cmd: pwsh, args: ['-NoLogo', '-NoExit', '-Command', INIT_COMMAND] }

  return { cmd: 'powershell.exe', args: ['-NoLogo', '-NoExit', '-Command', INIT_COMMAND] }
}

/** 终端列宽：中日韩全角算 2 列，重绘时光标位置才不会错 */
function charWidth(cp: number): number {
  if (cp === 0 || cp < 32) return 0
  if (
    cp >= 0x1100 &&
    (cp <= 0x115f ||
      cp === 0x2329 ||
      cp === 0x232a ||
      (cp >= 0x2e80 && cp <= 0xa4cf && cp !== 0x303f) ||
      (cp >= 0xac00 && cp <= 0xd7a3) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe30 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f300 && cp <= 0x1f64f) ||
      (cp >= 0x1f900 && cp <= 0x1f9ff) ||
      (cp >= 0x20000 && cp <= 0x3fffd))
  ) {
    return 2
  }
  return 1
}

function textWidth(text: string): number {
  let w = 0
  for (const ch of text) w += charWidth(ch.codePointAt(0) ?? 0)
  return w
}

export class LocalSession {
  readonly id = randomUUID()
  readonly connectionId = '__local__'
  readonly title = '本机 PowerShell'
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

  private child: ChildProcessWithoutNullStreams | null = null
  private status: SessionStatus = 'connecting'
  private closedByUser = false
  private cols = 120
  private rows = 30

  /** 行编辑状态：line 是还没交给 PowerShell 的内容，cursor 是插入点在 line 里的下标 */
  private line = ''
  private cursor = 0
  private history: string[] = []
  private histIndex = -1
  private draft = ''

  /** 出站合并与背压，和 SSH 会话同一套逻辑 */
  private outBuf: Buffer[] = []
  private outLen = 0
  private flushHandle: NodeJS.Immediate | null = null
  private pendingBytes = 0
  private paused = false
  private pausedAt = 0

  private readonly emit: EmitFn

  constructor(emit: EmitFn) {
    this.emit = emit
  }

  private setStatus(status: SessionStatus, error?: string): void {
    this.status = status
    this.emit({ type: 'session:status', sessionId: this.id, status, error })
  }

  info(): SessionInfo {
    return {
      sessionId: this.id,
      connectionId: this.connectionId,
      title: this.title,
      host: 'localhost',
      username: userInfo().username,
      status: this.status,
      cols: this.cols,
      rows: this.rows
    }
  }

  async connect(cols: number, rows: number): Promise<void> {
    this.cols = cols
    this.rows = rows

    await new Promise<void>((resolve, reject) => {
      const shell = pickShell()
      let child: ChildProcessWithoutNullStreams
      try {
        child = spawn(shell.cmd, shell.args, {
          cwd: homedir(),
          env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe']
        })
      } catch (err) {
        reject(err as Error)
        return
      }

      this.child = child
      let settled = false
      const settle = (err?: Error) => {
        if (settled) return
        settled = true
        err ? reject(err) : resolve()
      }

      child.on('spawn', () => {
        this.setStatus('connected')
        settle()
      })

      child.on('error', (err) => {
        const msg = `无法启动本机 PowerShell：${err.message}`
        this.setStatus('error', msg)
        settle(new Error(msg))
      })

      child.stdout.on('data', (chunk: Buffer) => this.queue(chunk))
      child.stderr.on('data', (chunk: Buffer) => this.queue(chunk))

      child.on('exit', (code) => {
        this.flush()
        this.child = null
        if (this.status !== 'error') {
          this.setStatus('closed', this.closedByUser ? undefined : `PowerShell 已退出（${code ?? 0}）`)
        }
        this.emit({ type: 'session:exit', sessionId: this.id, code: code ?? 0 })
      })
    })
  }

  // ---------------- 数据出站 ----------------

  private queue(chunk: Buffer): void {
    const t = this.traffic
    const now = performance.now()
    if (!t.firstAt) t.firstAt = now
    t.lastAt = now
    t.bytesIn += chunk.length
    t.chunks++

    this.pendingBytes += chunk.length
    if (this.pendingBytes > t.maxPending) t.maxPending = this.pendingBytes

    this.outBuf.push(chunk)
    this.outLen += chunk.length
    if (this.outLen >= 32 * 1024) this.flush()
    else if (!this.flushHandle) this.flushHandle = setImmediate(() => this.flush())

    if (this.pendingBytes > HIGH_WATERMARK && !this.paused && this.child) {
      this.child.stdout.pause()
      this.paused = true
      t.pauses++
      this.pausedAt = now
    }
  }

  private flush(): void {
    if (this.flushHandle) {
      clearImmediate(this.flushHandle)
      this.flushHandle = null
    }
    if (this.outLen === 0) return
    const out = this.outBuf.length === 1 ? this.outBuf[0] : Buffer.concat(this.outBuf, this.outLen)
    this.outBuf = []
    this.outLen = 0
    this.traffic.msgs++
    this.emit({
      type: 'session:data',
      sessionId: this.id,
      data: new Uint8Array(out.buffer, out.byteOffset, out.byteLength)
    })
  }

  /** 本地回显走同一条通道，渲染端不需要区分数据来源 */
  private out(text: string): void {
    if (!text) return
    this.queue(Buffer.from(text, 'utf8'))
  }

  ack(bytes: number): void {
    this.pendingBytes = Math.max(0, this.pendingBytes - bytes)
    if (this.paused && this.pendingBytes < LOW_WATERMARK && this.child) {
      this.child.stdout.resume()
      this.paused = false
      this.traffic.pausedMs += performance.now() - this.pausedAt
    }
  }

  // ---------------- 行编辑 ----------------

  write(input: string): void {
    if (!this.child) return

    let i = 0
    while (i < input.length) {
      const cp = input.codePointAt(i) ?? 0

      if (cp === 0x1b) {
        i = this.handleEscape(input, i)
        continue
      }
      if (cp === 0x0d || cp === 0x0a) {
        this.submit()
        i++
        continue
      }
      if (cp === 0x7f || cp === 0x08) {
        this.backspace()
        i++
        continue
      }
      if (cp === 0x03) {
        this.cancel()
        i++
        continue
      }
      if (cp === 0x15) {
        this.replaceLine('')
        i++
        continue
      }
      if (cp === 0x01) {
        this.moveTo(0)
        i++
        continue
      }
      if (cp === 0x05) {
        this.moveTo(this.line.length)
        i++
        continue
      }
      if (cp === 0x17) {
        this.deleteWord()
        i++
        continue
      }
      if (cp === 0x0c) {
        this.out('\x1b[2J\x1b[H')
        this.out(this.line)
        i++
        continue
      }
      if (cp === 0x04) {
        if (this.line.length === 0) {
          this.close()
          return
        }
        i++
        continue
      }
      // 其余控制键（Tab / Ctrl 组合）在管道模式下没有意义，直接吞掉
      if (cp < 0x20) {
        i++
        continue
      }

      const s = String.fromCodePoint(cp)
      this.insert(s)
      i += s.length
    }
  }

  private insert(s: string): void {
    if (this.cursor === this.line.length) {
      // 绝大多数情况：在行尾追加，直接回显一个字符即可，不用重绘整行
      this.line += s
      this.cursor = this.line.length
      this.out(s)
      return
    }
    this.line = this.line.slice(0, this.cursor) + s + this.line.slice(this.cursor)
    this.cursor += s.length
    this.repaint()
  }

  private backspace(): void {
    if (this.cursor === 0) return
    const cp = this.line.codePointAt(this.cursor - 2)
    const step = cp !== undefined && cp > 0xffff ? 2 : 1
    const removedWidth = textWidth(this.line.slice(this.cursor - step, this.cursor))
    this.line = this.line.slice(0, this.cursor - step) + this.line.slice(this.cursor)
    this.cursor -= step

    if (this.cursor === this.line.length) {
      // 行尾退格：擦掉一个字符，全角字符占两列
      this.out('\b'.repeat(removedWidth) + ' '.repeat(removedWidth) + '\b'.repeat(removedWidth))
    } else {
      this.repaint()
    }
  }

  private deleteWord(): void {
    if (this.cursor === 0) return
    let start = this.cursor
    while (start > 0 && this.line[start - 1] === ' ') start--
    while (start > 0 && this.line[start - 1] !== ' ') start--
    this.line = this.line.slice(0, start) + this.line.slice(this.cursor)
    this.cursor = start
    this.repaint()
  }

  private moveTo(next: number): void {
    const clamped = Math.max(0, Math.min(this.line.length, next))
    if (clamped === this.cursor) return
    const delta = textWidth(this.line.slice(Math.min(this.cursor, clamped), Math.max(this.cursor, clamped)))
    if (delta === 0) {
      this.cursor = clamped
      return
    }
    this.out(clamped > this.cursor ? `\x1b[${delta}C` : `\x1b[${delta}D`)
    this.cursor = clamped
  }

  /** 整行重绘：回到行首 → 清到行尾 → 重写 → 光标归位 */
  private repaint(): void {
    const before = textWidth(this.line.slice(0, this.cursor))
    const after = textWidth(this.line.slice(this.cursor))
    let seq = ''
    if (before > 0) seq += `\x1b[${before}D`
    seq += '\x1b[K' + this.line
    if (after > 0) seq += `\x1b[${after}D`
    this.out(seq)
  }

  /** 换掉整行内容（历史命令、Ctrl+U 用） */
  private replaceLine(next: string): void {
    const before = textWidth(this.line.slice(0, this.cursor))
    let seq = before > 0 ? `\x1b[${before}D` : ''
    seq += '\x1b[K' + next
    this.out(seq)
    this.line = next
    this.cursor = next.length
  }

  /** 提交前把已回显的那一份擦掉，交给 PowerShell 自己回显，屏幕上不会出现两份命令 */
  private eraseEcho(): void {
    const before = textWidth(this.line.slice(0, this.cursor))
    this.out(`${before > 0 ? `\x1b[${before}D` : ''}\x1b[K`)
  }

  private submit(): void {
    const cmd = this.line
    this.eraseEcho()
    this.line = ''
    this.cursor = 0
    this.histIndex = -1
    this.draft = ''

    if (cmd.trim()) {
      if (this.history[this.history.length - 1] !== cmd) this.history.push(cmd)
      if (this.history.length > HISTORY_MAX) this.history.shift()
    }

    this.child?.stdin.write(`${cmd}\r\n`)
  }

  private cancel(): void {
    this.eraseEcho()
    this.out('^C')
    this.line = ''
    this.cursor = 0
    this.histIndex = -1
    this.draft = ''
    // 管道模式没有信号，只能丢一个空行让 PowerShell 回一个新提示符
    this.child?.stdin.write('\r\n')
  }

  private historyUp(): void {
    if (this.history.length === 0) return
    if (this.histIndex === -1) {
      this.draft = this.line
      this.histIndex = this.history.length - 1
    } else if (this.histIndex > 0) {
      this.histIndex--
    }
    this.replaceLine(this.history[this.histIndex])
  }

  private historyDown(): void {
    if (this.histIndex === -1) return
    if (this.histIndex < this.history.length - 1) {
      this.histIndex++
      this.replaceLine(this.history[this.histIndex])
      return
    }
    this.histIndex = -1
    this.replaceLine(this.draft)
  }

  private handleEscape(s: string, i: number): number {
    const next = s[i + 1]
    if (next === '[') {
      let j = i + 2
      let params = ''
      while (j < s.length && !/[\x40-\x7e]/.test(s[j])) {
        params += s[j]
        j++
      }
      this.csi(params, s[j] ?? '')
      return j + 1
    }
    if (next === 'O') {
      this.csi('', s[i + 2] ?? '')
      return i + 3
    }
    // Alt+键：不支持，整段跳过
    return i + 2
  }

  private csi(params: string, final: string): void {
    switch (final) {
      case 'A':
        this.historyUp()
        return
      case 'B':
        this.historyDown()
        return
      case 'C':
        this.moveTo(this.cursor + 1)
        return
      case 'D':
        this.moveTo(this.cursor - 1)
        return
      case 'H':
        this.moveTo(0)
        return
      case 'F':
        this.moveTo(this.line.length)
        return
      case '~': {
        if (params === '3') {
          // Delete：删掉光标处的字符
          if (this.cursor < this.line.length) {
            const cp = this.line.codePointAt(this.cursor) ?? 0
            const step = cp > 0xffff ? 2 : 1
            this.line = this.line.slice(0, this.cursor) + this.line.slice(this.cursor + step)
            this.repaint()
          }
          return
        }
        if (params === '1' || params === '7') this.moveTo(0)
        if (params === '4' || params === '8') this.moveTo(this.line.length)
        // 200 / 201 是 bracketed paste 的边界标记，内容按普通字符处理即可
        return
      }
      default:
        return
    }
  }

  resize(cols: number, rows: number): void {
    // 没有 PTY，改不了子进程的窗口尺寸；只记录下来，留给将来接 ConPTY 时用
    this.cols = cols
    this.rows = rows
  }

  close(): void {
    this.closedByUser = true
    if (this.flushHandle) {
      clearImmediate(this.flushHandle)
      this.flushHandle = null
    }
    this.outBuf = []
    this.outLen = 0
    const child = this.child
    this.child = null
    if (child) {
      // 直接 kill 只结束 PowerShell 本身，正在跑的子命令会留下来
      child.kill()
      if (child.pid) {
        import('node:child_process').then(({ execFile }) =>
          execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], () => undefined)
        )
      }
    }
    this.setStatus('closed')
  }
}
