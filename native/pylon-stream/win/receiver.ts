/**
 * Pylon Stream — Windows 接收器（跑在 Electron 主进程）
 *
 * 职责只有三件：
 *   1. dgram 收 UDP 包，按 PROTOCOL.md 解包
 *   2. 按 frame_id 重组视频帧（乱序 + 丢包）
 *   3. 通过 IPC 把完整 H.264 帧和输入回传给渲染层
 *
 * 为什么不用 Rust：这里没有 CPU 密集工作，Node 的 dgram 收包 + Buffer 拼装
 * 足够快（60fps × 40Mbps ≈ 5MB/s，现代 CPU 上不占什么）。少一个进程 = 少一次
 * 拷贝、少一层协议、少一个要编译的二进制。真正吃 CPU 的 H.264 解码交给
 * WebCodecs 的 D3D11VA 硬件路径，那部分在渲染层。
 */

import dgram from 'node:dgram'
import type { Socket } from 'node:dgram'
import type { BrowserWindow } from 'electron'

// ---- 协议常量（与 Swift 端一致）

const MAGIC = 0x50535452 // "PSTR"
const VERSION = 1
const TYPE_HELLO = 1
const TYPE_CAPS = 2
const TYPE_VIDEO = 3
const TYPE_INPUT = 4
const TYPE_KEYREQ = 5
const TYPE_PING = 6
const TYPE_GOODBYE = 7
const FLAG_KEYFRAME = 0x0001
const FLAG_LAST = 0x0002

const HEADER = 12
const FRAME_HEADER = 16 // frame_id(4) + ts(8) + idx(2) + total(2)
const FRAME_TIMEOUT_MS = 50
const MAX_ASSEMBLY = 8 // 最多同时追几帧，防止内存堆积

export interface StreamCaps {
  width: number
  height: number
  fps: number
  codec: number
  screenId: number
}

export interface StreamStats {
  fps: number
  kbps: number
  lostFrames: number
  rttMs: number
  packets: number
}

interface PendingFrame {
  id: number
  timestampUs: bigint
  total: number
  key: boolean
  parts: (Buffer | undefined)[]
  received: number
  firstAt: number
}

export interface ReceiverOptions {
  port: number
  host: string // Mac 的 IP，用于主动发 HELLO
  onCaps: (caps: StreamCaps) => void
  onFrame: (frame: Buffer, timestampUs: bigint, key: boolean) => void
  onStats: (stats: StreamStats) => void
  onClose: (err?: Error) => void
}

export class StreamReceiver {
  private sock: Socket | null = null
  private readonly opts: ReceiverOptions
  private readonly frames = new Map<number, PendingFrame>()
  private caps: StreamCaps | null = null

  private lastFrameId = 0
  private packets = 0
  private framesDelivered = 0
  private lostFrames = 0
  private bytesWindow = 0
  private statsAt = 0
  private rttMs = 0
  private pingSent = new Map<bigint, number>()
  private timer: NodeJS.Timeout | null = null
  private lastPacketAt = 0
  private closed = false

  constructor(opts: ReceiverOptions) {
    this.opts = opts
  }

  start(): void {
    this.closed = false
    this.sock = dgram.createSocket('udp4')
    this.sock.on('message', (msg, rinfo) => this.onPacket(msg, rinfo.address, rinfo.port))
    this.sock.on('error', (e) => this.fail(e))
    this.sock.bind(this.opts.port, () => {
      console.log(`[stream] UDP 监听 ${this.opts.port}`)
      this.sendHello()
    })

    // 超时清理 + 统计 + 保活
    this.statsAt = Date.now()
    this.timer = setInterval(() => this.tick(), 100)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    if (this.timer) clearInterval(this.timer)
    this.timer = null
    this.send(TYPE_GOODBYE)
    try {
      this.sock?.close()
    } catch {
      // 已关闭
    }
    this.sock = null
    this.frames.clear()
  }

  /** 鼠标键盘回传：payload 已按协议打包好（子类型 + 数据） */
  sendInput(payload: Buffer): void {
    if (this.closed) return
    this.send(TYPE_INPUT, 0, payload)
  }

  /** 请求关键帧 */
  requestKeyframe(): void {
    if (this.closed) return
    const p = Buffer.alloc(4)
    p.writeUInt32BE(this.lastFrameId + 1, 0)
    this.send(TYPE_KEYREQ, 0, p)
  }

  // ---------- 内部

  private fail(e: Error): void {
    if (this.closed) return
    console.error('[stream] 接收器错误:', e.message)
    this.close()
    this.opts.onClose(e)
  }

  private send(type: number, flags = 0, payload: Buffer = Buffer.alloc(0)): void {
    const sock = this.sock
    if (!sock || this.closed) return
    const head = Buffer.alloc(HEADER)
    head.writeUInt32BE(MAGIC, 0)
    head[4] = VERSION
    head[5] = type
    head.writeUInt16BE(flags, 6)
    head.writeUInt32BE(1, 8) // seq，接收端不关心
    sock.send(Buffer.concat([head, payload]), this.opts.port, this.opts.host)
  }

  private onPacket(msg: Buffer, _from: string, _port: number): void {
    if (this.closed || msg.length < HEADER) return
    if (msg.readUInt32BE(0) !== MAGIC) return
    if (msg[4] !== VERSION) return

    this.packets++
    this.bytesWindow += msg.length
    this.lastPacketAt = Date.now()

    const type = msg[5]
    const flags = msg.readUInt16BE(6)
    const payload = msg.subarray(HEADER)

    switch (type) {
      case TYPE_CAPS:
        this.onCapsPacket(payload)
        break
      case TYPE_VIDEO:
        this.onVideoPacket(msg, flags)
        break
      case TYPE_PING:
        // PING 的 payload 是发送方时间戳，原样回送给对端算 RTT
        if (payload.length >= 8) {
          const ts = payload.readBigUInt64BE(0)
          const sent = this.pingSent.get(ts)
          if (sent !== undefined) {
            this.rttMs = Date.now() - sent
            this.pingSent.delete(ts)
          }
          this.send(TYPE_PING, 0, payload)
        }
        break
      case TYPE_GOODBYE:
        this.close()
        this.opts.onClose()
        break
      default:
        break
    }
  }

  private onCapsPacket(p: Buffer): void {
    if (p.length < 14) return
    const caps: StreamCaps = {
      width: p.readUInt16BE(0),
      height: p.readUInt16BE(2),
      fps: p.readUInt16BE(4),
      codec: p.readUInt16BE(6),
      screenId: p.readUInt32BE(8)
    }
    console.log(`[stream] CAPS ${caps.width}×${caps.height} @${caps.fps}fps codec=${caps.codec}`)
    const changed =
      !this.caps ||
      this.caps.width !== caps.width ||
      this.caps.height !== caps.height ||
      this.caps.screenId !== caps.screenId
    this.caps = caps
    if (changed) {
      this.frames.clear()
      this.lastFrameId = 0
    }
    this.opts.onCaps(caps)
  }

  private onVideoPacket(pkt: Buffer, flags: number): void {
    if (pkt.length < HEADER + FRAME_HEADER) return
    const id = pkt.readUInt32BE(HEADER)
    const timestampUs = pkt.readBigUInt64BE(HEADER + 4)
    const idx = pkt.readUInt16BE(HEADER + 12)
    const total = pkt.readUInt16BE(HEADER + 14)
    const data = pkt.subarray(HEADER + FRAME_HEADER)
    const key = (flags & FLAG_KEYFRAME) !== 0
    const last = (flags & FLAG_LAST) !== 0

    // 整帧跳变：中间帧丢了，立刻让对端补关键帧
    if (this.lastFrameId > 0 && id > this.lastFrameId + 1) {
      this.lostFrames += id - this.lastFrameId - 1
      this.requestKeyframe()
    }

    let f = this.frames.get(id)
    if (!f) {
      if (this.frames.size >= MAX_ASSEMBLY) {
        // 丢掉最老的一帧
        let oldest: number | undefined
        let oldestAt = Infinity
        for (const [k, v] of this.frames) {
          if (v.firstAt < oldestAt) { oldestAt = v.firstAt; oldest = k }
        }
        if (oldest !== undefined) this.frames.delete(oldest)
      }
      f = {
        id,
        timestampUs,
        total,
        key,
        parts: new Array(total),
        received: 0,
        firstAt: Date.now()
      }
      this.frames.set(id, f)
    }

    if (idx < f.parts.length && !f.parts[idx]) {
      f.parts[idx] = Buffer.from(data) // 复制：dgram buffer 会被复用
      f.received++
    }
    if (key) f.key = true
    // 用最后一包修正总数（防止首包丢失导致 total 不准）
    if (last && total > 0) {
      f.total = total
      while (f.parts.length < total) f.parts.push(undefined)
    }

    if (f.received >= f.total) this.deliver(f)
  }

  private deliver(f: PendingFrame): void {
    this.frames.delete(f.id)
    if (f.parts.some((p) => p === undefined)) return
    const frame = Buffer.concat(f.parts as Buffer[])
    this.lastFrameId = f.id
    this.framesDelivered++
    this.opts.onFrame(frame, f.timestampUs, f.key)
  }

  private tick(): void {
    const now = Date.now()

    // 超时未收齐的帧：丢弃并请求关键帧
    for (const [id, f] of this.frames) {
      if (now - f.firstAt > FRAME_TIMEOUT_MS) {
        this.frames.delete(id)
        this.lostFrames++
        this.requestKeyframe()
      }
    }

    // 每秒一份统计
    const dt = now - this.statsAt
    if (dt >= 1000) {
      const fps = Math.round((this.framesDelivered * 1000) / dt)
      const kbps = Math.round((this.bytesWindow * 8) / dt)
      this.opts.onStats({
        fps,
        kbps,
        lostFrames: this.lostFrames,
        rttMs: this.rttMs,
        packets: this.packets
      })
      this.framesDelivered = 0
      this.bytesWindow = 0
      this.statsAt = now
    }

    // 3 秒没任何包视为断开（Mac 每 2 秒发 PING）
    if (this.lastPacketAt > 0 && now - this.lastPacketAt > 3000) {
      this.fail(new Error('3 秒未收到对端数据，连接已断开'))
    }
  }

  private sendHello(): void {
    const p = Buffer.alloc(0)
    this.send(TYPE_HELLO, 0, p)
  }
}
