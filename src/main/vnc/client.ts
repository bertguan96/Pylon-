/**
 * VNC（RFB）客户端。
 *
 * 只跑在主进程：解码出来的帧是 RGBA 原始位图，直接通过 IPC 交给渲染进程贴图。
 * 之所以不在渲染进程建连，一是 node:net / zlib 在那边的沙箱里拿不到，
 * 二是渲染进程被注入脚本时能直接连任意主机，不是好的默认值。
 *
 * 协议侧有几个必须守住的不变量：
 *  1. 同一时刻只允许一个 FramebufferUpdateRequest 在飞 —— 服务端按请求回帧，
 *     堆请求只会把内存和带宽一起打满；
 *  2. ZRLE 的 zlib 上下文是整条会话共用的，不能每帧新建 inflate；
 *  3. 每个消息的字节数必须完整吞掉，漏读一个字节后面全乱。
 */

import { connect, type Socket } from 'node:net'
import type { VncRect, VncSecurity } from '../../shared/types'
import {
  ByteStream,
  ENCODING,
  PIXEL_FORMAT_RGBA32,
  SECURITY,
  SERVER_MSG,
  readPixelFormat,
  readU32String,
  writePixelFormat
} from './rfb'
import {
  Framebuffer,
  PixelCodec,
  ZrleDecoder,
  decodeCopyRect,
  decodeRaw
} from './decoders'
import { vncAuthResponse } from './des'

export interface VncInitInfo {
  width: number
  height: number
  name: string
}

export interface VncClientCallbacks {
  onInit?: (info: VncInitInfo) => void
  onRects?: (rects: VncRect[]) => void
  onClipboard?: (text: string) => void
  onStats?: (stats: { fps: number; kbps: number }) => void
  /** 只回调一次：正常情况下是用户关掉，异常时带一个可读的原因 */
  onClose?: (error?: Error) => void
}

interface Options extends VncClientCallbacks {
  host: string
  port: number
  password?: string
  /** TCP 建连超时，不含握手 */
  timeout?: number
}

/** 单帧最小刷新间隔：再快也没意义，服务端本来就按请求回 */
const REFRESH_IDLE_MS = 900

/**
 * 两次 FramebufferUpdateRequest 之间的最小间隔。
 *
 * RFB 是「一问一答」的：收完一帧就发下一个请求。对真实的 Mac 这没问题，
 * 服务端没有变化时会压着请求不回；但碰上环回地址、或者某些实现得比较粗糙的
 * 服务端（有变化就立刻回），这个循环会退化成几千 fps 的空转 —— 实测在
 * mock 上跑到 5900 fps / 2.4Gbps，CPU 与带宽全被烧在了几个像素的位移上。
 * 12ms 相当于 80fps 的天花板，高于人眼与常见屏幕刷新，够用且能兜住这种空转。
 */
const MIN_REQUEST_GAP_MS = 12

export class VncClient {
  private readonly options: Options
  private socket: Socket | null = null
  private stream: ByteStream | null = null
  private fb: Framebuffer | null = null
  private codec: PixelCodec = new PixelCodec(PIXEL_FORMAT_RGBA32)
  private zrle: ZrleDecoder | null = null
  private useZrle = true

  private closed = false
  private active = true
  private lastRequestAt = 0
  private statsTimer: NodeJS.Timeout | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private requestTimer: NodeJS.Timeout | null = null
  /** 排队中的请求是否为增量；false 表示整帧。null = 没有排队 */
  private pendingIncremental: boolean | null = null
  private statsBytes = 0
  private statsFrames = 0

  /** 上一次握手时对端给出的认证方式，探测报告里用得上 */
  securityTypes: number[] = []

  constructor(options: Options) {
    this.options = options
  }

  get width(): number {
    return this.fb?.width ?? 0
  }

  get height(): number {
    return this.fb?.height ?? 0
  }

  /** 建连 + 握手。失败时抛出的是可以直接展示给用户的中文原因 */
  async connect(): Promise<VncInitInfo> {
    await this.openSocket()
    const info = await this.handshake()
    this.startLoop()
    return info
  }

  private async openSocket(): Promise<void> {
    const { host, port } = this.options
    const stream = new ByteStream()
    this.stream = stream

    const socket = connect({ host, port })
    this.socket = socket
    socket.on('data', (chunk: Buffer) => {
      this.statsBytes += chunk.length
      stream.push(chunk)
    })
    socket.on('error', (err) => this.finish(describeSocketError(err, host, port)))
    socket.on('close', () => this.finish())

    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`连接 ${host}:${port} 超时（${this.options.timeout ?? 8000}ms）`))
      }, this.options.timeout ?? 8000)

      socket.once('connect', () => {
        clearTimeout(timer)
        resolve()
      })
      socket.once('error', (err) => {
        clearTimeout(timer)
        reject(describeSocketError(err, host, port))
      })
    })

    // 键鼠事件是大量小包，Nagle 会把它们攒起来，操作会明显发黏
    socket.setNoDelay(true)
  }

  private async handshake(): Promise<VncInitInfo> {
    const stream = this.mustStream()

    const hello = (await stream.read(12)).toString('latin1')
    const match = /^RFB (\d{3})\.(\d{3})\n$/.exec(hello)
    if (!match) {
      throw new Error(`对端不是 VNC 服务（收到 ${JSON.stringify(hello.slice(0, 12))}）`)
    }
    const minor = Number(match[2])

    // 高版本一律按 3.8 谈：3.889 之类的私有小版本号在认证流程上是兼容的
    if (minor >= 8) {
      this.write(Buffer.from('RFB 003.008\n', 'latin1'))
      await this.security38()
    } else if (minor >= 7) {
      this.write(Buffer.from('RFB 003.007\n', 'latin1'))
      await this.security37()
    } else {
      this.write(Buffer.from('RFB 003.003\n', 'latin1'))
      await this.security33()
    }

    // ClientInit：shared=1，允许其他客户端同时连着（Mac 那边可能有别的窗口在看）
    this.write(Buffer.from([1]))

    const width = await stream.u16()
    const height = await stream.u16()
    const serverFormat = readPixelFormat(await stream.read(16), 0)
    const name = await readU32String(stream)

    if (width === 0 || height === 0) {
      throw new Error(`对端报告的屏幕尺寸异常：${width}×${height}`)
    }
    if (!serverFormat.trueColor) {
      throw new Error('对端使用调色板模式，本客户端只支持真彩色（现代服务端不会走到这里）')
    }

    this.fb = new Framebuffer(width, height)
    this.zrle = new ZrleDecoder()

    // 统一像素格式，省掉解码时的位运算（详见 PIXEL_FORMAT_RGBA32 的注释）
    const fmt = Buffer.alloc(20)
    fmt[0] = 0
    writePixelFormat(fmt, 4, PIXEL_FORMAT_RGBA32)
    this.write(fmt)
    this.sendEncodings()

    const info = { width, height, name }
    this.options.onInit?.(info)
    return info
  }

  private async security38(): Promise<void> {
    const stream = this.mustStream()
    const count = await stream.u8()
    if (count === 0) {
      throw new Error(`服务端拒绝连接：${await readU32String(stream)}`)
    }
    this.securityTypes = [...(await stream.read(count))]
    const chosen = this.chooseSecurity(this.securityTypes)
    this.write(Buffer.from([chosen]))
    if (chosen === SECURITY.VNC_AUTH) await this.doVncAuth()
    await this.readSecurityResult()
  }

  private async security37(): Promise<void> {
    const stream = this.mustStream()
    const count = await stream.u8()
    if (count === 0) {
      throw new Error(`服务端拒绝连接：${await readU32String(stream)}`)
    }
    this.securityTypes = [...(await stream.read(count))]
    const chosen = this.chooseSecurity(this.securityTypes)
    this.write(Buffer.from([chosen]))
    if (chosen === SECURITY.VNC_AUTH) {
      await this.doVncAuth()
      await this.readSecurityResult()
    }
    // 3.7 里 None 认证不发 SecurityResult
  }

  private async security33(): Promise<void> {
    const stream = this.mustStream()
    const type = await stream.u32()
    if (type === 0) {
      throw new Error(`服务端拒绝连接：${await readU32String(stream)}`)
    }
    this.securityTypes = [type]
    if (type === SECURITY.VNC_AUTH) {
      await this.doVncAuth()
      await this.readSecurityResult()
      return
    }
    if (type !== SECURITY.NONE) {
      throw unsupportedSecurity([type])
    }
  }

  private async doVncAuth(): Promise<void> {
    const stream = this.mustStream()
    if (!this.options.password) {
      throw new Error('对端要求 VNC 密码，但这条连接没有保存密码')
    }
    const challenge = await stream.read(16)
    this.write(vncAuthResponse(challenge, this.options.password))
  }

  private async readSecurityResult(): Promise<void> {
    const stream = this.mustStream()
    const result = await stream.u32()
    if (result === 0) return
    // 3.8 起失败时会带原因，3.3/3.7 没有
    let reason = ''
    try {
      reason = await readU32String(stream)
    } catch {
      reason = ''
    }
    throw new Error(reason || '认证失败：VNC 密码不对（注意只取前 8 位）')
  }

  private chooseSecurity(types: number[]): number {
    if (types.includes(SECURITY.VNC_AUTH)) {
      if (!this.options.password) throw new Error('对端要求 VNC 密码，但这条连接没有保存密码')
      return SECURITY.VNC_AUTH
    }
    if (types.includes(SECURITY.NONE)) return SECURITY.NONE
    throw unsupportedSecurity(types)
  }

  private sendEncodings(): void {
    const list = this.useZrle
      ? [ENCODING.ZRLE, ENCODING.COPY_RECT, ENCODING.RAW]
      : [ENCODING.COPY_RECT, ENCODING.RAW]
    const buf = Buffer.alloc(4 + list.length * 4)
    buf[0] = 2 // SetEncodings
    buf[1] = 0
    buf.writeUInt16BE(list.length, 2)
    for (let i = 0; i < list.length; i++) buf.writeInt32BE(list[i], 4 + i * 4)
    this.write(buf)
  }

  private startLoop(): void {
    void this.runLoop().catch((err: unknown) => {
      this.finish(err instanceof Error ? err : new Error(String(err)))
    })

    // 先要一整帧（incremental=0），之后每次都只要变化部分
    this.requestUpdate(false)

    this.statsTimer = setInterval(() => {
      const fps = this.statsFrames
      const kbps = Math.round((this.statsBytes * 8) / 1000)
      this.statsFrames = 0
      this.statsBytes = 0
      this.options.onStats?.({ fps, kbps })
    }, 1000)

    // 服务端偶尔会漏掉一次响应（尤其 Wi-Fi 抖动时），补一个请求避免画面停住
    this.refreshTimer = setInterval(() => {
      if (this.closed || !this.active) return
      if (Date.now() - this.lastRequestAt > REFRESH_IDLE_MS) this.requestUpdate(true)
    }, 500)
  }

  private async runLoop(): Promise<void> {
    const stream = this.mustStream()
    while (!this.closed) {
      const type = await stream.u8()
      switch (type) {
        case SERVER_MSG.FRAMEBUFFER_UPDATE:
          await this.handleUpdate()
          break
        case SERVER_MSG.SET_COLOUR_MAP:
          await this.skipColourMap()
          break
        case SERVER_MSG.BELL:
          break
        case SERVER_MSG.CUT_TEXT: {
          await stream.skip(3)
          const text = await readU32String(stream)
          this.options.onClipboard?.(text)
          break
        }
        default:
          throw new Error(`未知的服务端消息类型 ${type}，连接可能已错位`)
      }
    }
  }

  /** 调色板更新：我们用的是真彩色，内容没用，但字节必须完整吞掉 */
  private async skipColourMap(): Promise<void> {
    const stream = this.mustStream()
    await stream.skip(1)
    await stream.u16()
    const count = await stream.u16()
    await stream.skip(count * 6)
  }

  private async handleUpdate(): Promise<void> {
    const stream = this.mustStream()
    const fb = this.fb
    if (!fb) throw new Error('还没收到 ServerInit 就来了帧数据')

    await stream.skip(1)
    const count = await stream.u16()
    const rects: VncRect[] = []

    for (let i = 0; i < count; i++) {
      const x = await stream.u16()
      const y = await stream.u16()
      const w = await stream.u16()
      const h = await stream.u16()
      const encoding = await stream.i32()

      if (x + w > fb.width || y + h > fb.height) {
        throw new Error(`帧越界：${w}×${h}@${x},${y}，屏幕 ${fb.width}×${fb.height}`)
      }

      let rect: VncRect
      switch (encoding) {
        case ENCODING.RAW:
          rect = await decodeRaw(stream, x, y, w, h, this.codec)
          break
        case ENCODING.COPY_RECT:
          rect = await decodeCopyRect(stream, x, y, w, h, fb)
          break
        case ENCODING.ZRLE: {
          // 长度前缀是 ZRLE 唯一「友好」的地方：解压失败也不会把后续字节吃掉
          const len = await stream.u32()
          if (len > fb.width * fb.height * 4 + 1024 * 1024) {
            throw new Error(`ZRLE 数据长度异常：${len}`)
          }
          const payload = await stream.read(len)
          try {
            rect = await this.zrleDecode(payload, x, y, w, h)
          } catch (err) {
            // 极少数服务端的 ZRLE 实现不严格，与其整屏花掉，不如退回 Raw
            this.dropZrle(err)
            return
          }
          break
        }
        default:
          throw new Error(`服务端使用了未协商的编码 ${encoding}`)
      }

      fb.blit(rect)
      rects.push(rect)
    }

    this.statsFrames++
    if (rects.length > 0) this.options.onRects?.(rects)
    this.requestUpdate(true)
  }

  private async zrleDecode(
    payload: Buffer,
    x: number,
    y: number,
    w: number,
    h: number
  ): Promise<VncRect> {
    if (!this.zrle) throw new Error('ZRLE 解码器未初始化')
    return this.zrle.decode(payload, x, y, w, h, this.codec)
  }

  private dropZrle(err: unknown): void {
    if (!this.useZrle) {
      throw err instanceof Error ? err : new Error(String(err))
    }
    this.useZrle = false
    console.warn('[vnc] ZRLE 解码失败，退回 Raw：', err instanceof Error ? err.message : err)
    this.sendEncodings()
    // 已经错过的画面不会再补，重新要一整帧
    this.requestUpdate(false)
  }

  /**
   * 排一个 FramebufferUpdateRequest。
   *
   * 同一时刻只允许一个请求在飞（协议要求，也是唯一不会把内存打满的做法），
   * 并且用 MIN_REQUEST_GAP_MS 兜住请求速率上限。整帧请求优先级更高：
   * 如果已经排着一个增量请求、这时又要求整帧（比如面板刚挂载），就把它升级成整帧，
   * 而不是让整帧请求被增量顶掉、白等一帧。
   */
  private requestUpdate(incremental: boolean): void {
    if (this.closed || !this.active) return
    if (!this.fb) return

    if (this.pendingIncremental === null || !incremental) this.pendingIncremental = incremental
    if (this.requestTimer) return

    const gap = MIN_REQUEST_GAP_MS - (Date.now() - this.lastRequestAt)
    this.requestTimer = setTimeout(() => {
      this.requestTimer = null
      const queued = this.pendingIncremental
      this.pendingIncremental = null
      if (queued === null) return
      this.sendRequest(queued)
    }, gap > 0 ? gap : 0)
  }

  private sendRequest(incremental: boolean): void {
    const fb = this.fb
    if (this.closed || !this.active || !fb) return

    const buf = Buffer.alloc(10)
    buf[0] = 3 // FramebufferUpdateRequest
    buf[1] = incremental ? 1 : 0
    buf.writeUInt16BE(0, 2)
    buf.writeUInt16BE(0, 4)
    buf.writeUInt16BE(fb.width, 6)
    buf.writeUInt16BE(fb.height, 8)
    this.write(buf)
    this.lastRequestAt = Date.now()
  }

  // ---------- 对外的输入接口 ----------

  pointer(x: number, y: number, mask: number): void {
    if (this.closed) return
    const buf = Buffer.alloc(6)
    buf[0] = 5 // PointerEvent
    buf[1] = mask & 0xff
    buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(x))), 2)
    buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(y))), 4)
    this.write(buf)
  }

  key(keysym: number, down: boolean): void {
    if (this.closed) return
    const buf = Buffer.alloc(8)
    buf[0] = 4 // KeyEvent
    buf[1] = down ? 1 : 0
    buf.writeUInt32BE(keysym >>> 0, 4)
    this.write(buf)
  }

  cutText(text: string): void {
    if (this.closed) return
    const body = Buffer.from(text, 'utf8').subarray(0, 1 << 20)
    const buf = Buffer.alloc(8)
    buf[0] = 6 // ClientCutText
    buf.writeUInt32BE(body.length, 4)
    this.write(Buffer.concat([buf, body]))
  }

  /** 主动要一整帧（面板刚挂载时用，否则错过首帧会一直白屏） */
  refresh(): void {
    this.requestUpdate(false)
  }

  /** 标签不在前台时停止拉帧：既省 CPU，也不让局域网白跑流量 */
  setActive(active: boolean): void {
    if (this.active === active) return
    this.active = active
    if (active) this.requestUpdate(false)
  }

  close(): void {
    this.finish()
  }

  private write(buf: Buffer): void {
    if (this.closed || !this.socket || this.socket.destroyed) return
    this.socket.write(buf)
  }

  private mustStream(): ByteStream {
    if (!this.stream) throw new Error('连接尚未建立')
    return this.stream
  }

  private finish(error?: Error): void {
    if (this.closed) return
    this.closed = true

    if (this.statsTimer) clearInterval(this.statsTimer)
    if (this.refreshTimer) clearInterval(this.refreshTimer)
    if (this.requestTimer) clearTimeout(this.requestTimer)
    this.statsTimer = null
    this.refreshTimer = null
    this.requestTimer = null
    this.pendingIncremental = null

    this.zrle?.dispose()
    this.zrle = null

    const socket = this.socket
    this.socket = null
    if (socket && !socket.destroyed) socket.destroy()
    this.stream?.fail(error ?? new Error('连接已关闭'))

    this.options.onClose?.(error)
  }
}

/** 把 socket 层的错误码翻成人话，直接展示在界面上 */
export function describeSocketError(err: NodeJS.ErrnoException, host: string, port: number): Error {
  switch (err.code) {
    case 'ECONNREFUSED':
      return new Error(
        `${host}:${port} 拒绝连接 —— 目标机器没开屏幕共享，或者端口不对（macOS 默认 5900，需在「系统设置 → 通用 → 共享 → 屏幕共享」里打开）`
      )
    case 'ETIMEDOUT':
      return new Error(`连接 ${host}:${port} 超时 —— 检查两台机器是否在同一网段、防火墙是否放行`)
    case 'ENOTFOUND':
    case 'EAI_AGAIN':
      return new Error(`主机名 ${host} 解析不了，直接填 IP 更稳`)
    case 'EHOSTUNREACH':
    case 'ENETUNREACH':
      return new Error(`${host} 不可达 —— 两台机器可能不在同一个局域网`)
    case 'ECONNRESET':
      return new Error('对端把连接断开了（可能是权限弹窗被拒绝，或对方已退出登录）')
    default:
      return new Error(`连接 ${host}:${port} 失败：${err.message}`)
  }
}

function unsupportedSecurity(types: number[]): Error {
  if (types.includes(SECURITY.ARD)) {
    return new Error(
      '对端只提供 Apple 远程管理认证（ARD）。请在 Mac 上打开「系统设置 → 通用 → 共享 → 屏幕共享 → 电脑设置」，' +
        '勾选「VNC 显示程序可使用密码控制屏幕」并设置一个密码'
    )
  }
  return new Error(`对端提供的认证方式不受支持：${types.join(', ') || '（空）'}`)
}

/** 供探测功能复用：把安全类型编号翻译成可读标签 */
export function securityLabel(types: number[]): VncSecurity {
  if (types.includes(SECURITY.VNC_AUTH)) return 'vnc-password'
  if (types.includes(SECURITY.NONE)) return 'none'
  if (types.includes(SECURITY.ARD)) return 'ard'
  return 'unknown'
}
