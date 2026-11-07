/**
 * RFB（VNC）协议的底层读写。
 *
 * 协议是纯二进制的流式格式，所有字段都按大端排列，而且没有长度前缀 ——
 * 只能顺序读、读到多少算多少。所以第一件事是把 TCP 的乱序到达包
 * 攒成一个「想读 n 字节就一定能读到 n 字节」的流。
 */

/** 编码编号（客户端在 SetEncodings 里声明自己会解哪些） */
export const ENCODING = {
  RAW: 0,
  COPY_RECT: 1,
  ZRLE: 16
} as const

/** 服务端 → 客户端的消息类型 */
export const SERVER_MSG = {
  FRAMEBUFFER_UPDATE: 0,
  SET_COLOUR_MAP: 1,
  BELL: 2,
  CUT_TEXT: 3
} as const

/** 安全类型 */
export const SECURITY = {
  NONE: 1,
  VNC_AUTH: 2,
  ARD: 30
} as const

export interface PixelFormat {
  bitsPerPixel: number
  depth: number
  bigEndian: boolean
  trueColor: boolean
  redMax: number
  greenMax: number
  blueMax: number
  redShift: number
  greenShift: number
  blueShift: number
}

/**
 * 我们主动要求的像素格式。
 *
 * 小端 + 32bpp + 各通道 8 位，且蓝绿红分别落在 0/8/16 位 —— 这样
 * 内存里的字节顺序正好是 B、G、R、X，解码时只需再补一个 0xFF 就是 RGBA，
 * 不用做任何位运算。depth 取 24 还有个副作用：ZRLE 的 CPIXEL 会退化成 3 字节，
 * 省掉 1/4 的传输量（规范规定 32bpp 且 depth<=24 时只发低 3 字节）。
 */
export const PIXEL_FORMAT_RGBA32: PixelFormat = {
  bitsPerPixel: 32,
  depth: 24,
  bigEndian: false,
  trueColor: true,
  redMax: 255,
  greenMax: 255,
  blueMax: 255,
  redShift: 16,
  greenShift: 8,
  blueShift: 0
}

export function readPixelFormat(buf: Buffer, offset: number): PixelFormat {
  return {
    bitsPerPixel: buf[offset],
    depth: buf[offset + 1],
    bigEndian: buf[offset + 2] !== 0,
    trueColor: buf[offset + 3] !== 0,
    redMax: buf.readUInt16BE(offset + 4),
    greenMax: buf.readUInt16BE(offset + 6),
    blueMax: buf.readUInt16BE(offset + 8),
    redShift: buf[offset + 10],
    greenShift: buf[offset + 11],
    blueShift: buf[offset + 12]
  }
}

export function writePixelFormat(buf: Buffer, offset: number, pf: PixelFormat): void {
  buf[offset] = pf.bitsPerPixel
  buf[offset + 1] = pf.depth
  buf[offset + 2] = pf.bigEndian ? 1 : 0
  buf[offset + 3] = pf.trueColor ? 1 : 0
  buf.writeUInt16BE(pf.redMax, offset + 4)
  buf.writeUInt16BE(pf.greenMax, offset + 6)
  buf.writeUInt16BE(pf.blueMax, offset + 8)
  buf[offset + 10] = pf.redShift
  buf[offset + 11] = pf.greenShift
  buf[offset + 12] = pf.blueShift
  // offset + 13..15 是 3 字节填充，保持 0
}

/**
 * 把 TCP 上陆续到达的字节攒成一个可按需读取的流。
 *
 * 同一时刻只有一个读者（客户端的消息循环），所以等待者只留一个就够；
 * 这样既省掉队列管理的复杂度，也不会出现多个读者抢字节的情况。
 */
export class ByteStream {
  private chunks: Buffer[] = []
  private size = 0
  private waiter: (() => void) | null = null
  private failure: Error | null = null
  private closed = false

  push(chunk: Buffer): void {
    if (this.closed) return
    this.chunks.push(chunk)
    this.size += chunk.length
    this.wake()
  }

  /** 对端关闭或有错误：正在等的读操作会立刻抛出，避免永久挂住 */
  fail(err: Error): void {
    if (this.failure) return
    this.failure = err
    this.closed = true
    this.wake()
  }

  private wake(): void {
    const w = this.waiter
    this.waiter = null
    w?.()
  }

  private drain(n: number): Buffer {
    if (this.chunks[0].length === n) {
      const only = this.chunks.shift() as Buffer
      this.size -= n
      return only
    }

    // 跨多个 chunk：先试着一块整拿，避免每次读 1 字节都拼一遍
    if (this.chunks[0].length > n) {
      const head = this.chunks[0]
      const out = head.subarray(0, n)
      this.chunks[0] = head.subarray(n)
      this.size -= n
      return out
    }

    const out = Buffer.allocUnsafe(n)
    let filled = 0
    while (filled < n) {
      const head = this.chunks[0]
      const need = n - filled
      if (head.length <= need) {
        head.copy(out, filled)
        filled += head.length
        this.chunks.shift()
      } else {
        head.copy(out, filled, 0, need)
        this.chunks[0] = head.subarray(need)
        filled += need
      }
    }
    this.size -= n
    return out
  }

  async read(n: number): Promise<Buffer> {
    while (this.size < n) {
      if (this.failure) throw this.failure
      await new Promise<void>((resolve) => {
        this.waiter = resolve
        // 极端情况下 push 发生在设置 waiter 之前，补一次检查
        if (this.size >= n || this.failure) {
          this.waiter = null
          resolve()
        }
      })
    }
    if (this.failure && this.size < n) throw this.failure
    return this.drain(n)
  }

  async skip(n: number): Promise<void> {
    if (n > 0) await this.read(n)
  }

  async u8(): Promise<number> {
    return (await this.read(1))[0]
  }

  async u16(): Promise<number> {
    return (await this.read(2)).readUInt16BE(0)
  }

  async u32(): Promise<number> {
    return (await this.read(4)).readUInt32BE(0)
  }

  async i32(): Promise<number> {
    return (await this.read(4)).readInt32BE(0)
  }
}

/** 读一张「类型 + 长度 + 内容」的字符串（ServerInit 里的桌面名、CutText 都是这个形状） */
export async function readU32String(stream: ByteStream): Promise<string> {
  const len = await stream.u32()
  if (len === 0) return ''
  if (len > 1 << 20) throw new Error(`字符串长度异常：${len}`)
  return (await stream.read(len)).toString('utf8')
}
