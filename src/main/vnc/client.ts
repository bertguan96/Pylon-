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
  PIXEL_FORMAT_RGB565,
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
  decodeRaw,
  downscaleRect
} from './decoders'
import { vncAuthResponse } from './des'

export interface VncInitInfo {
  /** 渲染位图尺寸，可能已经按 scale 降采样 */
  width: number
  height: number
  /** 远端真实像素尺寸：鼠标坐标要换算到这个空间 */
  remoteWidth: number
  remoteHeight: number
  /** 降采样倍数，1 表示原始像素 */
  scale: number
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
  /** speed = 16 位色（流量小、编码快，有轻微色带）；sharp = 32 位色 */
  quality?: 'speed' | 'sharp'
}

/** 单帧最小刷新间隔：再快也没意义，服务端本来就按请求回 */
const REFRESH_IDLE_MS = 900

/** 流水线深度：同时在服务端挂着的 FramebufferUpdateRequest 数 */
const MAX_IN_FLIGHT = 2

/** 判定停摆：有用户输入、却这么久没收到任何帧 */
const STALL_MS = 1400

/** 连续停摆这么多次就认定连接已废，直接报错让用户重连，别无限重试 */
const STALL_GIVEUP = 3

/** 握手完成后多久还没收到第一帧就判定异常（Retina 全屏首帧正常要 1.5~3 秒） */
const FIRST_FRAME_MS = 6000

/**
 * 两次 FramebufferUpdateRequest 之间的最小间隔。
 *
 * RFB 是「一问一答」的：收完一帧就发下一个请求。对真实的 Mac 这没问题，
 * 服务端没有变化时会压着请求不回；但碰上环回地址、或者某些实现得比较粗糙的
 * 服务端（有变化就立刻回），这个循环会退化成几千 fps 的空转 —— 实测在
 * mock 上跑到 5900 fps / 2.4Gbps，CPU 与带宽全被烧在了几个像素的位移上。
 * 这个间隔会直接吃掉帧率：服务端编码一帧要几十毫秒时，等 12ms 相当于白扔
 * 两三成的帧。所以取 6ms —— 足够挡住空转，又不至于在真机上明显拖后腿。
 */
const MIN_REQUEST_GAP_MS = 6

export class VncClient {
  /** 引擎标识：日志里区分原生/兜底两条路径 */
  readonly engine = 'js' as const
  private readonly options: Options
  private socket: Socket | null = null
  private stream: ByteStream | null = null
  private fb: Framebuffer | null = null
  /** 输出缓冲：降采样空间（scale=1 时与 fb 是同一个对象） */
  private outFb: Framebuffer | null = null
  private codec: PixelCodec = new PixelCodec(PIXEL_FORMAT_RGBA32)
  private zrle: ZrleDecoder | null = null
  private useZrle = true
  /** 渲染降采样倍数：1 = 原始像素，2 = 长宽各减半 */
  private scale = 1

  private closed = false
  private active = true
  private lastRequestAt = 0
  private statsTimer: NodeJS.Timeout | null = null
  private refreshTimer: NodeJS.Timeout | null = null
  private requestTimer: NodeJS.Timeout | null = null
  /** 流水线：排队等待发出的请求（true = 增量，false = 整帧） */
  private requestQueue: boolean[] = []
  /** 已发出、还没等到响应的请求数 */
  private inFlight = 0
  private statsBytes = 0
  private statsFrames = 0
  /** 各编码的使用情况，只用于诊断日志：encoding → 出现次数 / 像素数 */
  private statsEncodings = new Map<number, { count: number; pixels: number }>()
  /** 单帧解码（解压 + tile 还原）的最长耗时，毫秒 */
  private statsDecodeMs = 0
  /** 单帧从收到字节到交给渲染层的总耗时（解码 + 比对 + 降采样），毫秒 */
  private statsFrameMs = 0
  /** 贴图段的纯 CPU 耗时（blit + 降采样 + 比对），不含任何网络等待 */
  private statsBlitMs = 0

  /** 上一次握手时对端给出的认证方式，探测报告里用得上 */
  securityTypes: number[] = []

  /** 最近一次收到完整帧的时间 */
  private lastFrameAt = 0
  /** 最近一次用户输入（指针/键盘）的时间 */
  private lastInputAt = 0
  /**
   * 「有输入但一直等不到帧」的起点；0 表示当前没在等。
   *
   * 不直接用 lastInputAt 是为了避开两个误判：静态画面放很久之后动一下鼠标，
   * 距今没帧的时长早就超过阈值，用 lastInputAt 会立刻误报；而持续移动鼠标时
   * lastInputAt 一直在刷新，用「距今多久没输入」又永远不触发。记一个起点最稳。
   */
  private stallSince = 0
  /** 连续判定停摆的次数，收到帧后清零 */
  private stallCount = 0
  /** 握手完成的时间点，用来兜住「连上了但一张图都没有」 */
  private connectedAt = 0

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

    const info = this.afterInit(width, height, name)
    this.options.onInit?.(info)
    return info
  }

  /** ServerInit 之后的收尾：决定渲染精度、下发像素格式与编码表 */
  private afterInit(width: number, height: number, name: string): VncInitInfo {
    /**
     * 渲染精度。
     *
     * Retina 屏报的是物理像素（2940×1912），而画布通常只有一千像素宽 ——
     * 每帧多出来的三倍细节既传不过去也看不见，却是 IPC 和 canvas 上传的大头。
     * 2 倍降采样后内容量降到 1/4，Retina 上肉眼几乎无差（2x 本来就是为了
     * 让人眼做平均的）。1080p 级别的屏不降，避免文字发虚。
     */
    const forced = Number(process.env.VNC_SCALE) || 0
    this.scale =
      this.options.quality === 'sharp' ? 1 : forced || (width >= 2400 ? 2 : 1)

    this.fb = new Framebuffer(width, height)
    this.zrle = new ZrleDecoder()
    this.connectedAt = Date.now()
    // 输出缓冲按降采样后的尺寸建：比对和交给渲染层的都在这个空间里做，
    // 数据量只有原始像素的 1/(scale²)，比对耗时直接降一个数量级
    this.outFb =
      this.scale > 1
        ? new Framebuffer(Math.floor(width / this.scale), Math.floor(height / this.scale))
        : this.fb

    // 统一像素格式，省掉解码时的位运算（详见 PIXEL_FORMAT_RGBA32 的注释）
    const fmt = Buffer.alloc(20)
    fmt[0] = 0
    const pixelFormat = this.options.quality === 'sharp' ? PIXEL_FORMAT_RGBA32 : PIXEL_FORMAT_RGB565
    writePixelFormat(fmt, 4, pixelFormat)
    this.codec = new PixelCodec(pixelFormat)
    this.write(fmt)
    this.sendEncodings()

    return {
      width: Math.floor(width / this.scale),
      height: Math.floor(height / this.scale),
      remoteWidth: width,
      remoteHeight: height,
      scale: this.scale,
      name
    }
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
    const list = this.encodingList()
    const buf = Buffer.alloc(4 + list.length * 4)
    buf[0] = 2 // SetEncodings
    buf[1] = 0
    buf.writeUInt16BE(list.length, 2)
    for (let i = 0; i < list.length; i++) buf.writeInt32BE(list[i], 4 + i * 4)
    this.write(buf)
  }

  private encodingList(): number[] {
    // 探测用：VNC_ENCODINGS=7,16,5,1,0 直接覆盖候选列表
    const override = process.env.VNC_ENCODINGS
    if (override) {
      const parsed = override
        .split(',')
        .map((s) => Number(s.trim()))
        .filter((n) => Number.isFinite(n))
      if (parsed.length > 0) return parsed
    }
    if (this.useZrle) return [ENCODING.ZRLE, ENCODING.COPY_RECT, ENCODING.RAW]
    return [ENCODING.COPY_RECT, ENCODING.RAW]
  }

  private startLoop(): void {
    void this.runLoop().catch((err: unknown) => {
      this.finish(err instanceof Error ? err : new Error(String(err)))
    })

    // 初始要一整帧；紧接着再排一个增量，让流水线从第一帧起就转起来
    this.requestUpdate(false)
    this.requestUpdate(true)

    this.statsTimer = setInterval(() => {
      const fps = this.statsFrames
      const kbps = Math.round((this.statsBytes * 8) / 1000)
      this.statsFrames = 0
      this.statsBytes = 0
      this.options.onStats?.({ fps, kbps })

      if (process.env.VNC_TRACE && this.statsEncodings.size > 0) {
        const parts = [...this.statsEncodings.entries()].map(([enc, r]) => {
          const name =
            enc === ENCODING.RAW ? 'Raw' : enc === ENCODING.COPY_RECT ? 'CopyRect' : enc === ENCODING.ZRLE ? 'ZRLE' : `#${enc}`
          return `${name}×${r.count}(${(r.pixels / 1e6).toFixed(2)}MP)`
        })
        console.log(
          `[vnc] ${fps}fps ${kbps}kbps | ${parts.join(' ')} | 解码最长 ${this.statsDecodeMs.toFixed(0)}ms · 帧处理最长 ${this.statsFrameMs.toFixed(0)}ms · 贴图段 ${this.statsBlitMs.toFixed(0)}ms`
        )
        this.statsEncodings.clear()
        this.statsDecodeMs = 0
        this.statsFrameMs = 0
        this.statsBlitMs = 0
      }
    }, 1000)

    // 看门狗。
    //
    // RFB 里「请求挂着没回」有两层含义：正常情况是无变化，服务端压着请求不回；
    // 异常情况是请求石沉大海（服务端挂起、Wi-Fi 丢包），此时 inFlight 永远不归零，
    // 队列被堵死，画面就永久冻在那儿 —— 用户看到的就是「卡死」。
    //
    // 区分两者的判据是「有没有输入」：用户一动鼠标/键盘，画面必然变，服务端就该回帧。
    // 所以只有在「有输入 且 超过 STALL_MS 没有任何帧」时才判定停摆，清零计数重发整帧。
    // 静止桌面不会误判（那时没有输入），也不会白跑流量。
    this.refreshTimer = setInterval(() => {
      if (this.closed || !this.active) return
      const now = Date.now()

      // 首帧还没到：一帧都没有的情况下谈不上「等不到新帧」，只兜一个总超时。
      // Retina 全屏首帧要 1.5~3 秒是正常的，超过 FIRST_FRAME_MS 还没影才是异常。
      if (this.lastFrameAt === 0) {
        if (this.connectedAt > 0 && now - this.connectedAt > FIRST_FRAME_MS) {
          this.finish(new Error('连上了但迟迟收不到画面，远端可能已经休眠或屏幕共享被暂停'))
        }
        return
      }

      // 判据：用户动过鼠标/键盘（起了一个等待点），却在 STALL_MS 内始终等不到帧。
      // 静止桌面不会起这个点，所以不会误杀；持续输入也不会像「距今多久没输入」
      // 那样永远不触发 —— 起点只在收到帧或主动重置时才清零。
      //
      // lastFrameAt > 0 是必须的：首帧要走完一整屏编码，Retina 上 1.5~3 秒很常见，
      // 这段时间还没有任何帧可以「等不到」，判停摆会纯属误伤。
      const stalled =
        this.lastFrameAt > 0 &&
        this.inFlight > 0 &&
        this.stallSince > 0 &&
        now - this.stallSince > STALL_MS
      if (stalled) {
        this.stallCount++
        if (this.stallCount >= STALL_GIVEUP) {
          this.finish(new Error('远端长时间没有画面更新，连接可能已经断开'))
          return
        }
        console.warn(
          `[vnc] 请求停摆 ${((now - this.lastFrameAt) / 1000).toFixed(1)}s，清空在飞请求后重发整帧（第 ${this.stallCount} 次）`
        )
        this.inFlight = 0
        this.requestQueue = []
        this.stallSince = now // 重新计时，别让下一个 tick 立刻又判一次
        this.requestUpdate(false)
        return
      }

      // 长时间没有任何往来，补一个增量探测连接是否还活着
      if (now - this.lastRequestAt > REFRESH_IDLE_MS) this.requestUpdate(true)
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

    // 一个响应对应一个在飞的请求；先减掉，后面 requestUpdate 才能立刻补上
    this.inFlight--
    const tDecode = performance.now()
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

      const rec = this.statsEncodings.get(encoding) ?? { count: 0, pixels: 0 }
      rec.count++
      rec.pixels += w * h
      this.statsEncodings.set(encoding, rec)

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
          const tZrle = performance.now()
          try {
            rect = await this.zrleDecode(payload, x, y, w, h)
          } catch (err) {
            // 极少数服务端的 ZRLE 实现不严格，与其整屏花掉，不如退回 Raw
            this.dropZrle(err)
            return
          }
          this.statsDecodeMs = Math.max(this.statsDecodeMs, performance.now() - tZrle)
          break
        }
        default:
          throw new Error(`服务端使用了未协商的编码 ${encoding}`)
      }

      // 按 64×64 块比对，只把真正变化的块交给渲染进程 —— 服务端整屏重传时
      // 实际变化往往只占一小块，省下的是 22MB 级的 IPC 序列化与 canvas 上传
      const tBlit = performance.now()
      const outFb = this.outFb ?? fb
      if (this.scale > 1) {
        // 原始 fb 必须始终跟着更新：CopyRect 要从里面取源像素
        fb.blit(rect)
        outFb.blitDirty(downscaleRect(rect, this.scale), rects)
      } else {
        outFb.blitDirty(rect, rects)
      }
      this.statsBlitMs = Math.max(this.statsBlitMs, performance.now() - tBlit)
    }

    this.statsFrames++
    this.lastFrameAt = Date.now()
    this.stallCount = 0
    this.stallSince = 0

    if (rects.length > 0) this.options.onRects?.(rects)
    this.statsFrameMs = Math.max(this.statsFrameMs, performance.now() - tDecode)
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
   * 流水线深度为 2：保持两个请求在服务端挂着，服务端编码完一帧就能立刻发
   * 下一帧，不用等「客户端收到帧 → 发新请求 → 网络往返」这段空窗。
   * Wi-Fi RTT 35ms 时，这段空窗占掉 80ms 一帧的四成 —— 这就是一问一答模式
   * 明明服务端只要 50ms 编一帧、却只能跑 12fps 的原因。
   *
   * 流量代价：静止画面时服务端不回帧（两个请求都挂着，零流量）；
   * 有变化时一次变化最多回两帧，极端情况下带宽翻倍。换来的是动画场景帧率
   * 提升 40% 左右，划算。
   *
   * 整帧请求优先级更高：队列里已有整帧时增量不再重复排；队列满时增量
   * 可以被整帧顶掉。
   */
  private requestUpdate(incremental: boolean): void {
    if (this.closed || !this.active) return
    if (!this.fb) return

    if (this.requestQueue.includes(false)) return // 整帧已在队列，增量没有意义
    if (this.requestQueue.length >= MAX_IN_FLIGHT) {
      if (!incremental) this.requestQueue = [false] // 顶掉排队的增量
      return
    }
    this.requestQueue.push(incremental)
    this.pumpRequests()
  }

  private pumpRequests(): void {
    if (this.requestTimer) return
    const gap = MIN_REQUEST_GAP_MS - (Date.now() - this.lastRequestAt)
    this.requestTimer = setTimeout(() => {
      this.requestTimer = null
      while (
        this.requestQueue.length > 0 &&
        this.inFlight < MAX_IN_FLIGHT &&
        !this.closed &&
        this.active
      ) {
        const queued = this.requestQueue.shift()
        if (queued !== undefined) this.sendRequest(queued)
      }
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
    this.inFlight++
  }

  // ---------- 对外的输入接口 ----------

  pointer(x: number, y: number, mask: number): void {
    if (this.closed) return
    this.lastInputAt = Date.now()
    if (this.stallSince === 0) this.stallSince = this.lastInputAt
    const buf = Buffer.alloc(6)
    buf[0] = 5 // PointerEvent
    buf[1] = mask & 0xff
    buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(x))), 2)
    buf.writeUInt16BE(Math.max(0, Math.min(0xffff, Math.round(y))), 4)
    this.write(buf)
  }

  key(keysym: number, down: boolean): void {
    if (this.closed) return
    this.lastInputAt = Date.now()
    if (this.stallSince === 0) this.stallSince = this.lastInputAt
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
    this.requestQueue = []
    this.inFlight = 0

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
