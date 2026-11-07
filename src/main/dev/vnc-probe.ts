/**
 * 远程桌面（RFB）自测。
 *
 * `VNC_PROBE=1` 时运行：在进程内起一台假 RFB 服务端，用真的 socket 走完
 * 握手 → 认证 → 帧传输 → 键鼠回传 全流程，跑完打印结果并退出。
 *
 * 为什么要自己写服务端：本机没有 Mac，也没有任何 VNC 服务。假服务端是照着
 * RFC 6143 逐字节拼的（不是拿现成库），所以至少能验证「我们解出来的像素
 * 和规范编码出来的字节是一致的」这一条；真实 macOS 的兼容性留待实机验证。
 */

import { app } from 'electron'
import { createServer, type AddressInfo, type Socket } from 'node:net'
import { constants as zlibConstants, createDeflate } from 'node:zlib'
import type { VncRect } from '../../shared/types'
import { PIXEL_FORMAT_RGBA32, ByteStream, writePixelFormat } from '../vnc/rfb'
import { VncClient } from '../vnc/client'
import { desSelfTest, vncAuthResponse } from '../vnc/des'

const W = 200
const H = 100
const PASSWORD = 'demo1234'
const CHALLENGE = Buffer.from('0123456789abcdef', 'latin1')

// ---------------------------------------------------------------- 断言收集

let passed = 0
let failed = 0

function check(name: string, ok: boolean, detail = ''): void {
  if (ok) {
    passed++
    console.log(`[通过] ${name}${detail ? ` —— ${detail}` : ''}`)
  } else {
    failed++
    console.log(`[失败] ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms))

async function waitFor(cond: () => boolean, timeout = 4000): Promise<boolean> {
  const started = Date.now()
  while (Date.now() - started < timeout) {
    if (cond()) return true
    await sleep(20)
  }
  return cond()
}

// ---------------------------------------------------------------- 像素工具

/** CPIXEL：我们协商的格式是 32bpp 小端、R 在高位，所以 3 字节依次是 B、G、R */
function cpixel(rgb: [number, number, number]): Buffer {
  return Buffer.from([rgb[2], rgb[1], rgb[0]])
}

function paint(
  target: Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number,
  colorAt: (col: number, row: number) => [number, number, number]
): void {
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const [r, g, b] = colorAt(col, row)
      const dst = ((y + row) * W + x + col) * 4
      target[dst] = r
      target[dst + 1] = g
      target[dst + 2] = b
      target[dst + 3] = 255
    }
  }
}

/** 把客户端收到的矩形拼成整屏，渲染进程也是这么干的 */
function compose(rects: VncRect[]): Uint8Array {
  const out = new Uint8Array(W * H * 4)
  for (const rect of rects) {
    for (let row = 0; row < rect.h; row++) {
      const src = row * rect.w * 4
      const dst = ((rect.y + row) * W + rect.x) * 4
      out.set(rect.data.subarray(src, src + rect.w * 4), dst)
    }
  }
  return out
}

function diffCount(a: Uint8Array, b: Uint8Array): number {
  let n = 0
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) n++
  }
  return n
}

function firstDiff(a: Uint8Array, b: Uint8Array): string {
  for (let i = 0; i < a.length; i += 4) {
    if (a[i] !== b[i] || a[i + 1] !== b[i + 1] || a[i + 2] !== b[i + 2]) {
      const px = i / 4
      return `首个不一致在 (${px % W},${Math.floor(px / W)})：期望 ${a[i]},${a[i + 1]},${a[i + 2]}，实际 ${b[i]},${b[i + 1]},${b[i + 2]}`
    }
  }
  return ''
}

// ---------------------------------------------------------------- ZRLE 编码

/**
 * 常驻的 deflate 流：ZRLE 整条连接只有一个 zlib 流，服务端每块矩形 flush 一次。
 * 这里照做（写入 + Z_SYNC_FLUSH），客户端才可能用同一个流解出来。
 */
const deflate = createDeflate()
const deflateParts: Buffer[] = []
deflate.on('data', (chunk: Buffer) => deflateParts.push(chunk))

async function deflateChunk(input: Buffer): Promise<Buffer> {
  deflateParts.length = 0
  await new Promise<void>((resolve, reject) => {
    const done = (err?: Error | null): void => (err ? reject(err) : resolve())
    deflate.write(input)
    // flush 的类型签名只声明了无参回调，实际会带 err，这里显式放宽
    const flush = deflate.flush as unknown as (kind: number, cb: (err?: Error | null) => void) => void
    flush.call(deflate, zlibConstants.Z_SYNC_FLUSH, done)
  })
  await new Promise<void>((resolve) => setImmediate(resolve))
  return Buffer.concat(deflateParts)
}

/** 打包整块 ZRLE 数据（长度前缀 + 压缩体） */
async function zrlePayload(tiles: Buffer[]): Promise<Buffer> {
  const compressed = await deflateChunk(Buffer.concat(tiles))
  const header = Buffer.alloc(4)
  header.writeUInt32BE(compressed.length, 0)
  return Buffer.concat([header, compressed])
}

function tileSolid(rgb: [number, number, number]): Buffer {
  return Buffer.concat([Buffer.from([1]), cpixel(rgb)])
}

function tileRaw(w: number, h: number, colorAt: (c: number, r: number) => [number, number, number]): Buffer {
  const parts: Buffer[] = [Buffer.from([0])]
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) parts.push(cpixel(colorAt(col, row)))
  }
  return Buffer.concat(parts)
}

/** 打包调色板（2..16）：MSB 优先，每行补齐到整字节 */
function tilePacked(
  colors: Array<[number, number, number]>,
  w: number,
  h: number,
  indexAt: (c: number, r: number) => number
): Buffer {
  const bits = colors.length <= 2 ? 1 : colors.length <= 4 ? 2 : 4
  const rowBytes = Math.ceil((w * bits) / 8)
  const out = Buffer.alloc(1 + colors.length * 3 + rowBytes * h)
  out[0] = colors.length
  colors.forEach((c, i) => cpixel(c).copy(out, 1 + i * 3))
  let p = 1 + colors.length * 3
  for (let row = 0; row < h; row++) {
    const line = Buffer.alloc(rowBytes)
    for (let col = 0; col < w; col++) {
      const bit = col * bits
      const shift = 8 - bits - (bit % 8)
      line[bit >> 3] |= indexAt(col, row) << shift
    }
    line.copy(out, p)
    p += rowBytes
  }
  return out
}

/** 纯 RLE（128） */
function tilePlainRle(runs: Array<{ color: [number, number, number]; len: number }>): Buffer {
  const parts: Buffer[] = [Buffer.from([128])]
  for (const run of runs) {
    parts.push(cpixel(run.color))
    let rem = run.len - 1
    while (rem >= 255) {
      parts.push(Buffer.from([255]))
      rem -= 255
    }
    parts.push(Buffer.from([rem]))
  }
  return Buffer.concat(parts)
}

/** 调色板 RLE（130..255）：索引是整字节，长度>1 时置最高位 */
function tilePaletteRle(
  colors: Array<[number, number, number]>,
  runs: Array<{ index: number; len: number }>
): Buffer {
  const parts: Buffer[] = [Buffer.from([128 + colors.length])]
  for (const c of colors) parts.push(cpixel(c))
  for (const run of runs) {
    if (run.len === 1) {
      parts.push(Buffer.from([run.index]))
      continue
    }
    parts.push(Buffer.from([run.index | 0x80]))
    let rem = run.len - 1
    while (rem >= 255) {
      parts.push(Buffer.from([255]))
      rem -= 255
    }
    parts.push(Buffer.from([rem]))
  }
  return Buffer.concat(parts)
}

// ---------------------------------------------------------------- 假服务端

class MockRfbServer {
  readonly requests: Array<{ incremental: number }> = []
  readonly keys: Array<{ keysym: number; down: number }> = []
  readonly pointers: Array<{ x: number; y: number; mask: number }> = []
  readonly cutTexts: string[] = []
  pixFmt: Buffer | null = null
  encodings: number[] = []
  authOk = false
  clientVersion = ''

  private readonly server = createServer()
  private socket: Socket | null = null
  private stream: ByteStream | null = null
  private frame = 0

  constructor(private readonly securityTypes: number[] = [2, 1]) {}

  async start(): Promise<number> {
    this.server.on('connection', (socket) => {
      void this.handle(socket).catch((err: unknown) => {
        console.log('[服务端] 处理异常', err instanceof Error ? err.message : err)
      })
    })
    await new Promise<void>((resolve) => this.server.listen(0, '127.0.0.1', resolve))
    return (this.server.address() as AddressInfo).port
  }

  async stop(): Promise<void> {
    this.socket?.destroy()
    await new Promise<void>((resolve) => this.server.close(() => resolve()))
  }

  private async handle(socket: Socket): Promise<void> {
    this.socket = socket
    const stream = new ByteStream()
    this.stream = stream
    socket.on('data', (chunk: Buffer) => stream.push(chunk))
    socket.on('error', () => undefined)

    socket.write('RFB 003.008\n')
    this.clientVersion = (await stream.read(12)).toString('latin1')

    socket.write(Buffer.from([this.securityTypes.length, ...this.securityTypes]))
    const chosen = await stream.u8()
    if (chosen === 2) {
      socket.write(CHALLENGE)
      const response = await stream.read(16)
      this.authOk = response.equals(vncAuthResponse(CHALLENGE, PASSWORD))
      socket.write(Buffer.from([0, 0, 0, 0]))
    } else {
      this.authOk = true
      socket.write(Buffer.from([0, 0, 0, 0]))
    }

    await stream.read(1) // ClientInit

    const head = Buffer.alloc(24)
    head.writeUInt16BE(W, 0)
    head.writeUInt16BE(H, 2)
    writePixelFormat(head, 4, PIXEL_FORMAT_RGBA32)
    const name = Buffer.from('Pylon 测试桌面', 'utf8')
    head.writeUInt32BE(name.length, 20)
    socket.write(Buffer.concat([head, name]))

    await this.loop()
  }

  private async loop(): Promise<void> {
    const stream = this.stream as ByteStream
    for (;;) {
      let type: number
      try {
        type = await stream.u8()
      } catch {
        return // 客户端断开
      }

      if (type === 0) {
        // 3 字节 padding + 16 字节像素格式，只留后面那段
        this.pixFmt = (await stream.read(19)).subarray(3)
      } else if (type === 2) {
        await stream.skip(1)
        const count = await stream.u16()
        const list: number[] = []
        for (let i = 0; i < count; i++) list.push(await stream.i32())
        this.encodings = list
      } else if (type === 3) {
        const incremental = await stream.u8()
        await stream.skip(8)
        this.requests.push({ incremental })
        void this.respond()
      } else if (type === 4) {
        const down = await stream.u8()
        await stream.skip(2)
        const keysym = await stream.u32()
        this.keys.push({ keysym, down })
      } else if (type === 5) {
        const mask = await stream.u8()
        const x = await stream.u16()
        const y = await stream.u16()
        this.pointers.push({ x, y, mask })
      } else if (type === 6) {
        await stream.skip(3)
        const len = await stream.u32()
        this.cutTexts.push((await stream.read(len)).toString('utf8'))
      } else {
        return
      }
    }
  }

  /** 前三次请求各回一种帧，之后不再主动推（客户端会继续请求，正好验证幂等） */
  private async respond(): Promise<void> {
    const socket = this.socket
    if (!socket) return
    if (this.frame === 0) socket.write(rawFrame())
    else if (this.frame === 1) socket.write((await zrleFrame()).bytes)
    else if (this.frame === 2) {
      // CopyRect + 一条 ServerCutText，顺便验证剪贴板回传
      socket.write(copyRectFrame())
      const text = Buffer.from('来自 Mac 的剪贴板', 'utf8')
      const head = Buffer.alloc(8)
      head[0] = 3
      head.writeUInt32BE(text.length, 4)
      socket.write(Buffer.concat([head, text]))
    }
    if (this.frame < 3) this.frame++
  }
}

// ---------------------------------------------------------------- 三种帧

function patternAt(col: number, row: number): [number, number, number] {
  return [col % 256, row % 256, (col + row) % 256]
}

/** 第一帧：整屏 Raw */
function rawFrame(): Buffer {
  const head = Buffer.alloc(12)
  head[0] = 0 // FramebufferUpdate
  head.writeUInt16BE(1, 2) // 1 个矩形
  head.writeUInt16BE(0, 4)
  head.writeUInt16BE(0, 6)
  head.writeUInt16BE(W, 8)
  head.writeUInt16BE(H, 10)
  const tail = Buffer.alloc(4)
  tail.writeInt32BE(0, 0) // Raw
  const pixels = Buffer.alloc(W * H * 4)
  for (let row = 0; row < H; row++) {
    for (let col = 0; col < W; col++) {
      const [r, g, b] = patternAt(col, row)
      const off = (row * W + col) * 4
      pixels[off] = b
      pixels[off + 1] = g
      pixels[off + 2] = r
    }
  }
  return Buffer.concat([head, tail, pixels])
}

interface ZrleSpec {
  x: number
  y: number
  w: number
  h: number
  /** 生成 tile 字节 + 同时把期望像素画进 expected */
  build: (expected: Uint8Array) => Buffer
}

/** 第二帧：整屏 ZRLE，八块 tile 覆盖所有子编码分支 */
async function zrleFrame(): Promise<{ bytes: Buffer; expected: Uint8Array }> {
  const expected = new Uint8Array(W * H * 4)
  const c1: [number, number, number] = [255, 0, 0]
  const c2: [number, number, number] = [0, 255, 0]
  const c3: [number, number, number] = [0, 0, 255]
  const c4: [number, number, number] = [255, 255, 0]
  const c5: [number, number, number] = [0, 255, 255]
  const palette4 = [c1, c2, c3, c4]

  const specs: ZrleSpec[] = [
    {
      x: 0,
      y: 0,
      w: 64,
      h: 64,
      build: (exp) => {
        paint(exp, 0, 0, 64, 64, () => c1)
        return tileSolid(c1)
      }
    },
    {
      x: 64,
      y: 0,
      w: 64,
      h: 64,
      build: (exp) => {
        const indexAt = (c: number, r: number) => (c + r) % 4
        paint(exp, 64, 0, 64, 64, (c, r) => palette4[indexAt(c, r)])
        return tilePacked(palette4, 64, 64, indexAt)
      }
    },
    {
      x: 128,
      y: 0,
      w: 64,
      h: 64,
      build: (exp) => {
        const colors: Array<[number, number, number]> = [c5, [10, 20, 30]]
        paint(exp, 128, 0, 64, 64, (c) => colors[c % 2])
        return tilePacked(colors, 64, 64, (c) => c % 2)
      }
    },
    {
      x: 192,
      y: 0,
      w: 8,
      h: 64,
      build: (exp) => {
        // 512 像素拆成 6 段跑，跨越行边界
        const runs = [
          { color: c2, len: 100 },
          { color: c3, len: 100 },
          { color: c4, len: 100 },
          { color: c2, len: 100 },
          { color: c3, len: 100 },
          { color: c4, len: 12 }
        ]
        paint(exp, 192, 0, 8, 64, (c, r) => {
          const idx = r * 8 + c
          let acc = 0
          for (const run of runs) {
            if (idx < acc + run.len) return run.color
            acc += run.len
          }
          return c4
        })
        return tilePlainRle(runs)
      }
    },
    {
      x: 0,
      y: 64,
      w: 64,
      h: 36,
      build: (exp) => {
        paint(exp, 0, 64, 64, 36, (c, r) => [(c * 3) % 256, (r * 5) % 256, 128])
        return tileRaw(64, 36, (c, r) => [(c * 3) % 256, (r * 5) % 256, 128])
      }
    },
    {
      x: 64,
      y: 64,
      w: 64,
      h: 36,
      build: (exp) => {
        const colors: Array<[number, number, number]> = [[9, 9, 9], [90, 90, 90], [200, 200, 200]]
        const runs = [
          { index: 0, len: 700 },
          { index: 1, len: 400 },
          { index: 2, len: 300 },
          { index: 0, len: 64 * 36 - 1400 }
        ]
        paint(exp, 64, 64, 64, 36, (c, r) => {
          const idx = r * 64 + c
          let acc = 0
          for (const run of runs) {
            if (idx < acc + run.len) return colors[run.index]
            acc += run.len
          }
          return colors[0]
        })
        return tilePaletteRle(colors, runs)
      }
    },
    {
      x: 128,
      y: 64,
      w: 64,
      h: 36,
      build: (exp) => {
        const colors: Array<[number, number, number]> = [[1, 2, 3], [250, 240, 230]]
        // 大量单像素 run，专门压 0x80 标志位这条分支
        const runs: Array<{ index: number; len: number }> = []
        const total = 64 * 36
        for (let i = 0; i < total; i += 3) {
          runs.push({ index: i % 2, len: 1 })
          runs.push({ index: (i + 1) % 2, len: 2 })
        }
        paint(exp, 128, 64, 64, 36, (c, r) => {
          const idx = r * 64 + c
          let acc = 0
          for (const run of runs) {
            if (idx < acc + run.len) return colors[run.index]
            acc += run.len
          }
          return colors[0]
        })
        return tilePaletteRle(colors, runs)
      }
    },
    {
      x: 192,
      y: 64,
      w: 8,
      h: 36,
      build: (exp) => {
        paint(exp, 192, 64, 8, 36, () => c3)
        return tileSolid(c3)
      }
    }
  ]

  const tiles = specs.map((spec) => spec.build(expected))

  const head = Buffer.alloc(12)
  head[0] = 0
  head.writeUInt16BE(1, 2)
  head.writeUInt16BE(0, 4)
  head.writeUInt16BE(0, 6)
  head.writeUInt16BE(W, 8)
  head.writeUInt16BE(H, 10)
  const tail = Buffer.alloc(4)
  tail.writeInt32BE(16, 0) // ZRLE

  return { bytes: Buffer.concat([head, tail, await zrlePayload(tiles)]), expected }
}

/** 第三帧：把右上角那块搬到左上角 */
function copyRectFrame(): Buffer {
  const head = Buffer.alloc(12)
  head[0] = 0
  head.writeUInt16BE(1, 2)
  head.writeUInt16BE(0, 4) // x
  head.writeUInt16BE(0, 6) // y
  head.writeUInt16BE(64, 8) // w
  head.writeUInt16BE(64, 10) // h
  const tail = Buffer.alloc(8)
  tail.writeInt32BE(1, 0) // CopyRect
  tail.writeUInt16BE(128, 4) // srcX
  tail.writeUInt16BE(0, 6) // srcY
  return Buffer.concat([head, tail])
}

// ---------------------------------------------------------------- 主流程

async function run(): Promise<void> {
  console.log('===== 远程桌面（RFB）自测 =====')

  // 1. DES 标准向量：底层把 DES 拿掉时这里第一个炸
  check('DES 标准测试向量一致', desSelfTest(), '0123456789ABCDEF / "Now is t"')

  const server = new MockRfbServer()
  const port = await server.start()

  // 一次 FramebufferUpdate 就是一组矩形，按帧存起来，断言时才能只比对到当前帧
  const frames: VncRect[][] = []
  // 闭包里的赋值对 TS 的控制流分析不可见，用对象包一层才不会把类型收窄成 never
  const seen: { init: { width: number; height: number; name: string } | null } = { init: null }
  let clipboard = ''
  let closeReason = ''
  const stats: Array<{ fps: number; kbps: number }> = []

  const client = new VncClient({
    host: '127.0.0.1',
    port,
    password: PASSWORD,
    onInit: (i) => {
      seen.init = i
    },
    onRects: (r) => {
      frames.push(r)
    },
    onClipboard: (t) => {
      clipboard = t
    },
    onStats: (s) => {
      stats.push(s)
    },
    onClose: (err) => {
      closeReason = err?.message ?? ''
    }
  })

  try {
    const info = await client.connect()

    check('握手成功并读到桌面信息', info.width === W && info.height === H, `${info.width}×${info.height} "${info.name}"`)
    check(
      'onInit 回调与返回值一致',
      seen.init?.width === info.width && seen.init?.name === info.name,
      JSON.stringify(seen.init)
    )
    check('认证：服务端校验应答通过', server.authOk)
    check('协议版本按 3.8 协商', server.clientVersion === 'RFB 003.008\n', JSON.stringify(server.clientVersion))
    await waitFor(() => server.pixFmt !== null && server.encodings.length > 0, 2000)
    check(
      'SetEncodings 声明了 ZRLE / CopyRect / Raw',
      server.encodings[0] === 16 && server.encodings[1] === 1 && server.encodings[2] === 0,
      server.encodings.join(',')
    )

    const fmt = server.pixFmt
    check(
      'SetPixelFormat 与请求一致（32bpp / 深度24 / 小端）',
      !!fmt && fmt[0] === 32 && fmt[1] === 24 && fmt[2] === 0 && fmt[3] === 1,
      fmt ? `${fmt[0]}bpp 深度${fmt[1]} 大端=${fmt[2]} 真彩=${fmt[3]}` : '未收到'
    )

    // ---- 第一帧：Raw
    const gotRaw = await waitFor(() => frames.length >= 1)
    check('收到第一帧（Raw）', gotRaw, `${frames[0]?.length ?? 0} 个矩形`)
    if (gotRaw) {
      const expected = new Uint8Array(W * H * 4)
      paint(expected, 0, 0, W, H, patternAt)
      const actual = compose(frames[0])
      const bad = diffCount(expected, actual)
      check('Raw 解码像素完全一致', bad === 0, bad === 0 ? `${W}×${H} 全像素吻合` : firstDiff(expected, actual))
    }

    // ---- 第二帧：ZRLE（八块 tile，五种分支）
    const zrle = await zrleFrame()
    const gotZrle = await waitFor(() => frames.length >= 2)
    check('收到第二帧（ZRLE）', gotZrle, `${frames[1]?.length ?? 0} 个矩形`)
    if (gotZrle) {
      const actual = compose([...frames[0], ...frames[1]])
      const bad = diffCount(zrle.expected, actual)
      check(
        'ZRLE 八块 tile 解码一致（纯色/4色调色板/2色调色板/纯RLE/原样/两种调色板RLE）',
        bad === 0,
        bad === 0 ? '全像素吻合' : firstDiff(zrle.expected, actual)
      )
    }

    // ---- 第三帧：CopyRect
    const gotCopy = await waitFor(() => frames.length >= 3)
    check('收到第三帧（CopyRect）', gotCopy, `${frames[2]?.length ?? 0} 个矩形`)
    if (gotCopy) {
      const before = compose([...frames[0], ...frames[1]])
      const after = compose([...frames[0], ...frames[1], ...frames[2]])
      let bad = 0
      for (let row = 0; row < 64; row++) {
        for (let col = 0; col < 64; col++) {
          const a = ((row + 0) * W + col) * 4
          const b = ((row + 0) * W + col + 128) * 4
          if (after[a] !== before[b] || after[a + 1] !== before[b + 1] || after[a + 2] !== before[b + 2]) bad++
        }
      }
      check('CopyRect 搬过去的内容与源区域一致', bad === 0, bad === 0 ? '4096 像素' : `${bad} 个像素不一致`)
    }

    // ---- 剪贴板：服务端 → 客户端
    await waitFor(() => clipboard !== '')
    check('剪贴板回落（ServerCutText）', clipboard === '来自 Mac 的剪贴板', JSON.stringify(clipboard))

    // ---- 输入：客户端 → 服务端
    client.pointer(37, 61, 1)
    client.key(0x41, true)
    client.key(0x41, false)
    client.cutText('本地剪贴板内容')
    await waitFor(() => server.pointers.length > 0 && server.keys.length >= 2 && server.cutTexts.length > 0)

    const ptr = server.pointers[0]
    check('鼠标事件格式正确', !!ptr && ptr.x === 37 && ptr.y === 61 && ptr.mask === 1, ptr ? `(${ptr.x},${ptr.y}) mask=${ptr.mask}` : '无')
    const k1 = server.keys[0]
    const k2 = server.keys[1]
    check(
      '键盘事件成对下发（keysym 0x41 按下/抬起）',
      !!k1 && !!k2 && k1.keysym === 0x41 && k1.down === 1 && k2.down === 0,
      JSON.stringify(server.keys.slice(0, 2))
    )
    check('本地剪贴板上行（ClientCutText）', server.cutTexts[0] === '本地剪贴板内容', JSON.stringify(server.cutTexts))

    // ---- 暂停 / 恢复：不在前台时不该继续拉帧
    client.setActive(false)
    // 先让可能已经在路上的那个请求落地，再取基线，否则偶发多一条就算失败
    await sleep(60)
    const beforePause = server.requests.length
    await sleep(700)
    const duringPause = server.requests.length
    client.setActive(true)
    await sleep(300)
    check(
      '暂停后不再请求新帧，恢复后补一整帧',
      duringPause === beforePause && server.requests.length > duringPause,
      `暂停前 ${beforePause} → 暂停中 ${duringPause} → 恢复后 ${server.requests.length}`
    )
    const lastReq = server.requests[server.requests.length - 1]
    check('恢复时请求的是整帧（incremental=0）', lastReq?.incremental === 0)

    // ---- 帧率统计
    check('每秒统计有输出', stats.length > 0, stats.length ? `${stats[stats.length - 1].fps}fps ${stats[stats.length - 1].kbps}kbps` : '无')

    client.close()
    await sleep(100)
    check('主动关闭不报错', closeReason === '', closeReason)
  } finally {
    client.close()
    await server.stop()
  }

  // ---- 错误路径 1：对端只给 Apple 认证
  const ardServer = new MockRfbServer([30])
  const ardPort = await ardServer.start()
  const ardClient = new VncClient({ host: '127.0.0.1', port: ardPort, password: PASSWORD })
  try {
    await ardClient.connect()
    check('ARD-only 服务端应当拒绝连接', false, '居然连上了')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    check('ARD-only 时给出可操作的提示', msg.includes('Apple 远程管理'), msg.slice(0, 60))
  } finally {
    ardClient.close()
    await ardServer.stop()
  }

  // ---- 错误路径 2：端口没人监听
  const tmp = new MockRfbServer()
  const deadPort = await tmp.start()
  await tmp.stop()
  const deadClient = new VncClient({ host: '127.0.0.1', port: deadPort })
  try {
    await deadClient.connect()
    check('空端口应当报错', false, '居然连上了')
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    check('空端口给出「拒绝连接」提示', msg.includes('拒绝连接'), msg.slice(0, 50))
  }

  console.log(`===== ${passed}/${passed + failed} 通过 =====`)
  app.exit(failed === 0 ? 0 : 1)
}

/** 入口：环境变量开着才跑，避免影响正常启动 */
export function maybeRunVncProbe(): void {
  if (!process.env.VNC_PROBE) return
  void run().catch((err: unknown) => {
    console.log('[失败] 自测崩溃：', err instanceof Error ? err.stack : err)
    app.exit(1)
  })
}
