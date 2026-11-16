/**
 * Pylon Stream 的显示面板。
 *
 * 和 VNC 面板最大的区别：这里收到的是 H.264 压缩帧，解码由 WebCodecs 的
 * VideoDecoder 完成（Windows 上走 D3D11VA 硬件解码，RTX 4070 轻松跑满 60fps）。
 * 解码出来的 VideoFrame 直接 drawImage 到 canvas，不经过 ImageData，
 * 没有逐像素 JS 循环 —— 这是原生清晰度还能 60fps 的根本原因。
 */

import { useEffect, useRef, useState } from 'react'
import type { MainEvent, StreamStats } from '../../../shared/types'

interface Props {
  sessionId: string
  host: string
  onClose?: () => void
}

interface DecoderState {
  decoder: VideoDecoder
  width: number
  height: number
  screenId: number
}

export default function StreamPane({ sessionId, host, onClose }: Props) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const wrapRef = useRef<HTMLDivElement>(null)
  const decoderRef = useRef<DecoderState | null>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [stats, setStats] = useState<StreamStats | null>(null)
  const [error, setError] = useState('')
  const [connected, setConnected] = useState(false)
  const statsRef = useRef<HTMLSpanElement>(null)

  // ---- 解码器配置：从 Annex-B 里提取 SPS/PPS，构造 avcC description
  function configureDecoder(width: number, height: number, firstFrame: Uint8Array): VideoDecoder | null {
    if (typeof VideoDecoder === 'undefined') {
      setError('当前 Electron 不支持 WebCodecs，请升级到 Electron 45+')
      return null
    }

    const { sps, pps } = extractParams(firstFrame)
    const config: VideoDecoderConfig = {
      codec: 'avc1.640033', // High profile, level 5.1（2940×1912@60 够用）
      codedWidth: width,
      codedHeight: height,
      hardwareAcceleration: 'prefer-hardware',
      optimizeForLatency: true
    }
    if (sps && pps) {
      config.description = buildAvcC(sps, pps)
    }

    const decoder = new VideoDecoder({
      output: (frame) => {
        const canvas = canvasRef.current
        if (canvas && frame.displayWidth > 0) {
          const ctx = canvas.getContext('2d', { alpha: false })
          if (ctx) {
            // VideoFrame → canvas：GPU 到 GPU 的快路径，不碰 JS 像素
            ctx.drawImage(frame as CanvasImageSource, 0, 0, canvas.width, canvas.height)
          }
        }
        frame.close()
      },
      error: (e) => {
        setError(`解码失败：${e.message}`)
        window.api.stream.keyreq(sessionId)
      }
    })

    try {
      decoder.configure(config)
      return decoder
    } catch (e) {
      setError(`解码器配置失败：${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  // ---- 主效果：打开串流 + 收帧 + 输入
  useEffect(() => {
    let disposed = false

    // 接收主进程事件
    const off = window.api.onEvent((ev: MainEvent) => {
      if (disposed) return
      if (!('sessionId' in ev) || ev.sessionId !== sessionId) return

      if (ev.type === 'stream:init') {
        setSize({ width: ev.width, height: ev.height })
        const canvas = canvasRef.current
        if (canvas) {
          canvas.width = ev.width
          canvas.height = ev.height
          const ctx = canvas.getContext('2d', { alpha: false })
          if (ctx) {
            ctx.fillStyle = '#141414'
            ctx.fillRect(0, 0, ev.width, ev.height)
          }
        }
        setConnected(true)
        setError('')
        console.log(`[stream] init ${ev.width}×${ev.height} @${ev.fps}fps`)
      } else if (ev.type === 'stream:frame') {
        let dec = decoderRef.current
        if (!dec) {
          const canvas = canvasRef.current
          const w = canvas?.width || ev.data.length
          const h = canvas?.height || ev.data.length
          const d = configureDecoder(w, h, ev.data)
          if (!d) return
          dec = { decoder: d, width: w, height: h, screenId: 0 }
          decoderRef.current = dec
        }
        if (dec.decoder.state === 'closed') return
        const chunk = new EncodedVideoChunk({
          type: ev.key ? 'key' : 'delta',
          timestamp: ev.ts * 1000, // ms → us
          data: ev.data
        })
        try {
          dec.decoder.decode(chunk)
        } catch (e) {
          setError(`解码错误：${e instanceof Error ? e.message : String(e)}`)
          window.api.stream.keyreq(sessionId)
        }
      } else if (ev.type === 'stream:stats') {
        setStats(ev.stats)
      } else if (ev.type === 'stream:status') {
        if (ev.status === 'closed') {
          setConnected(false)
          if (ev.error) setError(ev.error)
        }
      }
    })

    // 打开串流
    void window.api.stream.open({ sessionId, host, port: 48000 }).catch((e: Error) => {
      setError(e.message)
    })

    return () => {
      disposed = true
      off()
      decoderRef.current?.decoder.close()
      decoderRef.current = null
      void window.api.stream.close(sessionId)
    }
  }, [sessionId, host])

  // ---- 输入事件（挂在 canvas 容器上）
  useEffect(() => {
    const el = wrapRef.current
    if (!el || !connected || size.width === 0) return

    const toRemote = (e: MouseEvent) => {
      const r = el.getBoundingClientRect()
      // 直接用远端像素坐标：不做缩放，保持原生清晰度
      const x = ((e.clientX - r.left) / r.width) * size.width
      const y = ((e.clientY - r.top) / r.height) * size.height
      return { x: Math.round(x), y: Math.round(y) }
    }

    const onMove = (e: MouseEvent) => {
      const p = toRemote(e)
      window.api.stream.pointer(sessionId, p.x, p.y, -1, false)
    }
    const onDown = (e: MouseEvent) => {
      e.preventDefault()
      const p = toRemote(e)
      window.api.stream.pointer(sessionId, p.x, p.y, e.button, true)
    }
    const onUp = (e: MouseEvent) => {
      const p = toRemote(e)
      window.api.stream.pointer(sessionId, p.x, p.y, e.button, false)
    }
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      window.api.stream.wheel(sessionId, Math.round(e.deltaY))
    }
    const onContext = (e: Event) => e.preventDefault()

    el.addEventListener('mousemove', onMove)
    el.addEventListener('mousedown', onDown)
    el.addEventListener('mouseup', onUp)
    el.addEventListener('wheel', onWheel, { passive: false })
    el.addEventListener('contextmenu', onContext)

    return () => {
      el.removeEventListener('mousemove', onMove)
      el.removeEventListener('mousedown', onDown)
      el.removeEventListener('mouseup', onUp)
      el.removeEventListener('wheel', onWheel)
      el.removeEventListener('contextmenu', onContext)
    }
  }, [sessionId, connected, size])

  // ---- 键盘：用 browser key → mac 虚拟键码映射
  useEffect(() => {
    if (!connected) return
    const onKeyDown = (e: KeyboardEvent) => {
      const vk = toMacKeyCode(e.code)
      if (vk !== undefined) window.api.stream.key(sessionId, vk, true)
    }
    const onKeyUp = (e: KeyboardEvent) => {
      const vk = toMacKeyCode(e.code)
      if (vk !== undefined) window.api.stream.key(sessionId, vk, false)
    }
    window.addEventListener('keydown', onKeyDown)
    window.addEventListener('keyup', onKeyUp)
    return () => {
      window.removeEventListener('keydown', onKeyDown)
      window.removeEventListener('keyup', onKeyUp)
    }
  }, [sessionId, connected])

  return (
    <div className="stream-pane">
      <div className="stream-toolbar">
        <span className="stream-title">串流 · {host}</span>
        {connected && <span className="stream-dot" />}
        <span ref={statsRef} className="stream-stats">
          {stats
            ? `${stats.fps} fps · ${Math.round(stats.kbps / 1000)} Mbps · RTT ${stats.rttMs}ms · 丢帧 ${stats.lostFrames}`
            : connected ? '连接中…' : '未连接'}
        </span>
        {size.width > 0 && <span className="stream-size">{size.width}×{size.height} 原生</span>}
        <button className="stream-close" onClick={() => { onClose?.(); void window.api.stream.close(sessionId) }}>
          断开
        </button>
      </div>
      {error && <div className="stream-error">{error}</div>}
      <div className="stream-canvas-wrap" ref={wrapRef} tabIndex={0}>
        <canvas ref={canvasRef} className="stream-canvas" />
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// H.264 工具

/** 从 Annex-B 流里找 SPS(type 7) 和 PPS(type 8) */
function extractParams(data: Uint8Array): { sps?: Uint8Array; pps?: Uint8Array } {
  const nals = splitAnnexB(data)
  let sps: Uint8Array | undefined
  let pps: Uint8Array | undefined
  for (const nal of nals) {
    if (nal.length === 0) continue
    const t = nal[0] & 0x1f
    if (t === 7) sps = nal
    if (t === 8) pps = nal
  }
  return { sps, pps }
}

function splitAnnexB(data: Uint8Array): Uint8Array[] {
  const out: Uint8Array[] = []
  let start = -1
  for (let i = 0; i < data.length - 3; i++) {
    if (data[i] === 0 && data[i + 1] === 0) {
      if (data[i + 2] === 1) {
        if (start >= 0) out.push(data.subarray(start, i))
        start = i + 3
        i += 2
      } else if (data[i + 2] === 0 && data[i + 3] === 1) {
        if (start >= 0) out.push(data.subarray(start, i))
        start = i + 4
        i += 3
      }
    }
  }
  if (start >= 0 && start < data.length) out.push(data.subarray(start))
  return out
}

/** 构造 AVCDecoderConfigurationRecord（WebCodecs 的 description） */
function buildAvcC(sps: Uint8Array, pps: Uint8Array): Uint8Array {
  const out = new Uint8Array(6 + 2 + sps.length + 1 + 2 + pps.length)
  let o = 0
  out[o++] = 1 // configurationVersion
  out[o++] = sps[1] // AVCProfileIndication
  out[o++] = sps[2] // profile_compatibility
  out[o++] = sps[3] // AVCLevelIndication
  out[o++] = 0xff // lengthSizeMinusOne = 3 (4 字节长度)
  out[o++] = 0xe1 // numOfSPS = 1
  out[o++] = (sps.length >> 8) & 0xff
  out[o++] = sps.length & 0xff
  out.set(sps, o); o += sps.length
  out[o++] = 1 // numOfPPS = 1
  out[o++] = (pps.length >> 8) & 0xff
  out[o++] = pps.length & 0xff
  out.set(pps, o)
  return out
}

/** browser KeyboardEvent.code → macOS 虚拟键码 */
function toMacKeyCode(code: string): number | undefined {
  const map: Record<string, number> = {
    KeyA: 0, KeyB: 11, KeyC: 8, KeyD: 2, KeyE: 14, KeyF: 3, KeyG: 5,
    KeyH: 4, KeyI: 34, KeyJ: 38, KeyK: 40, KeyL: 37, KeyM: 46, KeyN: 45,
    KeyO: 31, KeyP: 35, KeyQ: 12, KeyR: 15, KeyS: 1, KeyT: 16, KeyU: 32,
    KeyV: 9, KeyW: 13, KeyX: 7, KeyY: 6, KeyZ: 17,
    Digit0: 29, Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21,
    Digit5: 23, Digit6: 22, Digit7: 26, Digit8: 28, Digit9: 25,
    Space: 49, Return: 36, Escape: 53, Tab: 48, Backspace: 51,
    ShiftLeft: 56, ShiftRight: 60, ControlLeft: 59, ControlRight: 62,
    AltLeft: 58, AltRight: 61, MetaLeft: 55, MetaRight: 55,
    ArrowUp: 126, ArrowDown: 125, ArrowLeft: 123, ArrowRight: 124,
    F1: 122, F2: 120, F3: 99, F4: 118, F5: 96, F6: 97,
    F7: 98, F8: 100, F9: 101, F10: 109, F11: 103, F12: 111
  }
  return map[code]
}
