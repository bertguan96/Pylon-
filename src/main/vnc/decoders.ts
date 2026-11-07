/**
 * RFB 的三种编码解码：Raw、CopyRect、ZRLE。
 *
 * 只做这三种是有意的：ZRLE 是主流服务端（含 macOS 屏幕共享、TigerVNC、RealVNC）
 * 最常支持的压缩编码，CopyRect 负责滚屏和窗口拖动（这两类操作占日常操作的绝大多数），
 * Raw 是保底 —— 有些老设备会无视 SetEncodings 直接发 Raw。
 *
 * 解码结果统一成 RGBA，写进主进程维护的一份 framebuffer 里：CopyRect 要从中取源像素，
 * 渲染端拿到的也是同一份数据，两边不会错位。
 */

import { createInflate, type Inflate } from 'node:zlib'
import { Buffer } from 'node:buffer'
import type { VncRect } from '../../shared/types'
import type { ByteStream, PixelFormat } from './rfb'

/** 主进程侧的完整屏幕位图，RGBA 排列 */
export class Framebuffer {
  readonly width: number
  readonly height: number
  readonly data: Uint8Array

  constructor(width: number, height: number) {
    this.width = width
    this.height = height
    // 1080p 约 8MB，一次分配长期持有，不做增量扩容
    this.data = new Uint8Array(width * height * 4)
  }

  /** 把一块矩形贴进整屏 */
  blit(rect: VncRect): void {
    const rowBytes = rect.w * 4
    for (let row = 0; row < rect.h; row++) {
      const dst = ((rect.y + row) * this.width + rect.x) * 4
      const src = row * rowBytes
      this.data.set(rect.data.subarray(src, src + rowBytes), dst)
    }
  }

  /** 取出一块矩形（CopyRect 的源区域） */
  extract(x: number, y: number, w: number, h: number): Uint8Array {
    const out = new Uint8Array(w * h * 4)
    const rowBytes = w * 4
    for (let row = 0; row < h; row++) {
      const src = ((y + row) * this.width + x) * 4
      out.set(this.data.subarray(src, src + rowBytes), row * rowBytes)
    }
    return out
  }
}

/**
 * 像素 → RGBA 的搬运工。
 *
 * 绝大多数情况走 fastPath：服务端按我们要求的格式（32bpp / 小端 / R 在 16 位）
 * 发数据，字节序正好是 B、G、R，直接抄三个字节加个 0xFF 就完事，一次位运算都不用。
 * 只有对端不听话、坚持用别的像素格式时才走通用路径。
 */
export class PixelCodec {
  /** ZRLE 压缩流里单个 CPIXEL 占几个字节 */
  readonly cpixelBytes: number
  private readonly fast: boolean
  private readonly pf: PixelFormat

  constructor(pf: PixelFormat) {
    this.pf = pf
    // 规范：32bpp 且 depth<=24 时 CPIXEL 只发低 3 字节
    this.cpixelBytes = pf.bitsPerPixel === 32 && pf.depth <= 24 ? 3 : pf.bitsPerPixel / 8
    this.fast =
      pf.bitsPerPixel === 32 &&
      pf.depth <= 24 &&
      !pf.bigEndian &&
      pf.trueColor &&
      pf.redMax === 255 &&
      pf.greenMax === 255 &&
      pf.blueMax === 255 &&
      pf.redShift === 16 &&
      pf.greenShift === 8 &&
      pf.blueShift === 0
  }

  /** 取一个 CPIXEL（ZRLE 用，长度可能比 PIXEL 短） */
  readCpixel(src: Buffer, off: number, dst: Uint8Array, dstOff: number): void {
    if (this.fast) {
      dst[dstOff] = src[off + 2]
      dst[dstOff + 1] = src[off + 1]
      dst[dstOff + 2] = src[off]
      dst[dstOff + 3] = 255
      return
    }
    this.readGeneric(src, off, this.cpixelBytes, dst, dstOff)
  }

  /** 取一个完整 PIXEL（Raw 用，长度总是 bpp/8） */
  readPixel(src: Buffer, off: number, dst: Uint8Array, dstOff: number): void {
    if (this.fast) {
      dst[dstOff] = src[off + 2]
      dst[dstOff + 1] = src[off + 1]
      dst[dstOff + 2] = src[off]
      dst[dstOff + 3] = 255
      return
    }
    this.readGeneric(src, off, this.pixelBytes(), dst, dstOff)
  }

  /** 完整 PIXEL 的字节数 */
  pixelBytes(): number {
    return this.pf.bitsPerPixel / 8
  }

  /** 把 CPIXEL 转成 32 位整数，便于做调色板比较 */
  cpixelValue(src: Buffer, off: number): number {
    return readValue(src, off, this.cpixelBytes, this.pf.bigEndian)
  }

  private readGeneric(
    src: Buffer,
    off: number,
    bytes: number,
    dst: Uint8Array,
    dstOff: number
  ): void {
    const pf = this.pf
    const value = readValue(src, off, bytes, pf.bigEndian)
    if (!pf.trueColor) {
      // 调色板模式：理论上不会出现（我们请求的是真彩），给个不刺眼的灰色兜底
      dst[dstOff] = 128
      dst[dstOff + 1] = 128
      dst[dstOff + 2] = 128
      dst[dstOff + 3] = 255
      return
    }
    const scale = (raw: number, max: number): number =>
      max === 0 ? 0 : Math.round((raw * 255) / max)
    dst[dstOff] = scale((value >> pf.redShift) & pf.redMax, pf.redMax)
    dst[dstOff + 1] = scale((value >> pf.greenShift) & pf.greenMax, pf.greenMax)
    dst[dstOff + 2] = scale((value >> pf.blueShift) & pf.blueMax, pf.blueMax)
    dst[dstOff + 3] = 255
  }
}

/** 按字节序把 n 字节读成无符号整数 */
function readValue(src: Buffer, off: number, bytes: number, bigEndian: boolean): number {
  let v = 0
  if (bigEndian) {
    for (let i = 0; i < bytes; i++) v = v * 256 + src[off + i]
  } else {
    for (let i = bytes - 1; i >= 0; i--) v = v * 256 + src[off + i]
  }
  return v >>> 0
}

/** Raw：直接跟 w*h 个 PIXEL，没有任何压缩 */
export async function decodeRaw(
  stream: ByteStream,
  x: number,
  y: number,
  w: number,
  h: number,
  codec: PixelCodec
): Promise<VncRect> {
  const bytes = await stream.read(w * h * (codec.pixelBytes()))
  const data = new Uint8Array(w * h * 4)
  const step = codec.pixelBytes()
  for (let i = 0, off = 0; i < w * h; i++, off += step) {
    codec.readPixel(bytes, off, data, i * 4)
  }
  return { x, y, w, h, data }
}

/**
 * ZRLE：矩形切成 64×64 的 tile，整条连接共用一个 zlib 流。
 *
 * 「共用」这点是关键：每帧的数据只是同一个 deflate 流的一段，脱离前面的历史解不出来，
 * 所以不能每帧 new 一个 inflater，也不能用 inflateSync 一次性解。
 * Node 的 _processChunk 虽然能同步拿结果，但它调用一次就会关掉句柄（等同于一次性用法），
 * 所以这里老老实实用流式 Inflate：写入一帧压缩数据，等 write 回调（此时输出已经全部 push），
 * 再把这一轮收到的 data 拼起来。
 *
 * 服务端在每块 ZRLE 矩形末尾都会 Z_SYNC_FLUSH，所以一次写入必然对应一批完整输出，
 * 不会出现「数据还在 zlib 内部缓冲」的情况。
 */
export class ZrleDecoder {
  private readonly inflate: Inflate
  private output: Buffer[] = []

  constructor() {
    this.inflate = createInflate({ chunkSize: 128 * 1024 })
    this.inflate.on('data', (chunk: Buffer) => this.output.push(chunk))
  }

  async decode(
    compressed: Buffer,
    x: number,
    y: number,
    w: number,
    h: number,
    codec: PixelCodec
  ): Promise<VncRect> {
    this.output = []
    await new Promise<void>((resolve, reject) => {
      this.inflate.write(compressed, (err) => {
        if (err) reject(err)
        else resolve()
      })
    })
    // write 回调返回时输出已经 push，但 data 事件可能还排在下一轮事件循环
    await new Promise<void>((resolve) => setImmediate(resolve))

    const raw = this.output.length === 1 ? this.output[0] : Buffer.concat(this.output)
    this.output = []
    return decodeZrleTiles(raw, x, y, w, h, codec)
  }

  dispose(): void {
    this.output = []
    this.inflate.close()
  }
}

/** 单独拆出来，纯内存函数，方便脱离网络单测 */
export function decodeZrleTiles(
  raw: Buffer,
  x: number,
  y: number,
  w: number,
  h: number,
  codec: PixelCodec
): VncRect {
  const data = new Uint8Array(w * h * 4)
  const cp = codec.cpixelBytes
  const tileColor = new Uint8Array(4)
  let p = 0

  for (let ty = 0; ty < h; ty += 64) {
    const tileH = Math.min(64, h - ty)
    for (let tx = 0; tx < w; tx += 64) {
      const tileW = Math.min(64, w - tx)
      if (p >= raw.length) throw new Error('ZRLE 数据提前结束：tile 头缺失')
      const sub = raw[p++]

      if (sub === 0) {
        // 原始 tile
        for (let row = 0; row < tileH; row++) {
          for (let col = 0; col < tileW; col++) {
            const dst = ((ty + row) * w + tx + col) * 4
            codec.readCpixel(raw, p, data, dst)
            p += cp
          }
        }
        continue
      }

      if (sub === 1) {
        // 纯色 tile：一个像素铺满
        codec.readCpixel(raw, p, tileColor, 0)
        p += cp
        fillTile(data, w, tx, ty, tileW, tileH, tileColor)
        continue
      }

      if (sub >= 2 && sub <= 16) {
        // 打包调色板：先读调色板，再按位读索引
        const palette = readPalette(raw, p, sub, codec)
        p += sub * cp
        const bits = bitsFor(sub)
        p = decodePackedIndices(raw, p, palette, bits, data, w, tx, ty, tileW, tileH)
        continue
      }

      if (sub === 128) {
        // 纯 RLE：颜色 + 重复次数，运行段可以跨行
        p = decodePlainRle(raw, p, codec, data, w, tx, ty, tileW, tileH)
        continue
      }

      if (sub >= 130) {
        // 调色板 RLE：paletteSize = sub - 128，索引是整字节（不是位域）
        const paletteSize = sub - 128
        const palette = readPalette(raw, p, paletteSize, codec)
        p += paletteSize * cp
        p = decodePaletteRle(raw, p, palette, data, w, tx, ty, tileW, tileH)
        continue
      }

      // 127 / 129 是「复用上一块 tile 的调色板」，ZRLE 明确禁用了这两个值；
      // 17..126 是保留区。真遇到说明对端的实现不对，与其静默画错不如报错。
      throw new Error(`ZRLE 不支持的子编码：${sub}`)
    }
  }

  return { x, y, w, h, data }
}

/** 调色板大小 → 每个索引占几位 */
function bitsFor(size: number): number {
  if (size <= 2) return 1
  if (size <= 4) return 2
  return 4
}

function readPalette(raw: Buffer, p: number, size: number, codec: PixelCodec): Uint8Array[] {
  const palette: Uint8Array[] = []
  for (let i = 0; i < size; i++) {
    const rgba = new Uint8Array(4)
    codec.readCpixel(raw, p + i * codec.cpixelBytes, rgba, 0)
    palette.push(rgba)
  }
  return palette
}

function fillTile(
  data: Uint8Array,
  stride: number,
  tx: number,
  ty: number,
  w: number,
  h: number,
  rgba: Uint8Array
): void {
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const dst = ((ty + row) * stride + tx + col) * 4
      data[dst] = rgba[0]
      data[dst + 1] = rgba[1]
      data[dst + 2] = rgba[2]
      data[dst + 3] = 255
    }
  }
}

/** 打包调色板（子编码 2..16）：每行索引都要对齐到字节边界，行尾会补几 bit */
function decodePackedIndices(
  raw: Buffer,
  p: number,
  palette: Uint8Array[],
  bits: number,
  data: Uint8Array,
  stride: number,
  tx: number,
  ty: number,
  w: number,
  h: number
): number {
  for (let row = 0; row < h; row++) {
    // 每一行都从字节边界重新开始 —— 行尾那半个字节是填充，不能带到下一行
    let bitPos = 0
    let byte = 0
    for (let col = 0; col < w; col++) {
      if (bitPos === 0) byte = raw[p++]
      // MSB 优先：第一个像素在最高位。游标每次前进 bits 位，不是 1 位
      const shift = 8 - bits - bitPos
      const index = (byte >> shift) & ((1 << bits) - 1)
      const rgba = palette[index] ?? palette[0]
      const dst = ((ty + row) * stride + tx + col) * 4
      data[dst] = rgba[0]
      data[dst + 1] = rgba[1]
      data[dst + 2] = rgba[2]
      data[dst + 3] = 255
      bitPos = (bitPos + bits) % 8
    }
  }
  return p
}

/** 纯 RLE（子编码 128）：颜色 + 长度，长度按「1 + 各字节之和」计算，255 表示继续 */
function decodePlainRle(
  raw: Buffer,
  p: number,
  codec: PixelCodec,
  data: Uint8Array,
  stride: number,
  tx: number,
  ty: number,
  w: number,
  h: number
): number {
  const total = w * h
  const rgba = new Uint8Array(4)
  let written = 0
  while (written < total) {
    codec.readCpixel(raw, p, rgba, 0)
    p += codec.cpixelBytes
    let run = 1
    for (;;) {
      const b = raw[p++]
      run += b
      if (b !== 255) break
    }
    for (let i = 0; i < run && written < total; i++, written++) {
      const row = Math.floor(written / w)
      const col = written % w
      const dst = ((ty + row) * stride + tx + col) * 4
      data[dst] = rgba[0]
      data[dst + 1] = rgba[1]
      data[dst + 2] = rgba[2]
      data[dst + 3] = 255
    }
  }
  return p
}

/**
 * 调色板 RLE（子编码 130..255）。
 *
 * 这里最容易搞错的一点：索引**不是**按位打包的，而是一个整字节；
 * 且长度大于 1 时用「索引 | 0x80」标记，后面才跟变长的长度字节。
 * （打包位域只属于 2..16 那档 packed palette，两者别混。）
 */
function decodePaletteRle(
  raw: Buffer,
  p: number,
  palette: Uint8Array[],
  data: Uint8Array,
  stride: number,
  tx: number,
  ty: number,
  w: number,
  h: number
): number {
  const total = w * h
  let written = 0
  while (written < total) {
    const head = raw[p++]
    let index = head
    let run = 1
    if ((head & 0x80) !== 0) {
      index = head & 0x7f
      for (;;) {
        const b = raw[p++]
        run += b
        if (b !== 255) break
      }
    }
    const rgba = palette[index] ?? palette[0]
    for (let i = 0; i < run && written < total; i++, written++) {
      const row = Math.floor(written / w)
      const col = written % w
      const dst = ((ty + row) * stride + tx + col) * 4
      data[dst] = rgba[0]
      data[dst + 1] = rgba[1]
      data[dst + 2] = rgba[2]
      data[dst + 3] = 255
    }
  }
  return p
}

/** CopyRect：源区域已经在 framebuffer 里，直接从本地复制 */
export async function decodeCopyRect(
  stream: ByteStream,
  x: number,
  y: number,
  w: number,
  h: number,
  fb: Framebuffer
): Promise<VncRect> {
  const srcX = await stream.u16()
  const srcY = await stream.u16()
  const data = fb.extract(srcX, srcY, w, h)
  return { x, y, w, h, data }
}
