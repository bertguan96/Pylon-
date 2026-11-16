/**
 * Pylon Stream 的主进程管理器。
 *
 * 这是自研的低延迟串流通道，和 vnc/ 目录完全独立 —— VNC 走 RFB/ZRLE，
 * 这里走私有 UDP 协议 + H.264 硬件编码，目标是原生清晰度 60fps。
 *
 * 主进程只做 UDP 收发和帧重组（见 native/pylon-stream/win/receiver.ts），
 * 真正的 H.264 解码交给渲染层的 WebCodecs（D3D11VA 硬解），
 * 这样主进程永远不会被解码堵住。
 */

import type { BrowserWindow } from 'electron'
import {
  StreamReceiver,
  type StreamCaps,
  type StreamStats
} from '../../../native/pylon-stream/win/receiver'

type EmitFn = (channel: string, payload: unknown) => void

export interface StreamOpenInput {
  host: string
  port?: number
}

export interface StreamSessionInfo {
  width: number
  height: number
  fps: number
}

interface State {
  receiver: StreamReceiver
  host: string
  port: number
  caps: StreamCaps | null
}

const sessions = new Map<string, State>()
let seq = 0

/** 生成一个会话 ID，和 VNC 的 sessionId 区分开 */
export function nextStreamId(): string {
  seq += 1
  return `stream-${Date.now().toString(36)}-${seq}`
}

/**
 * 打开串流会话。
 *
 * @param sessionId 由调用方生成，便于和 UI 的标签页对应
 * @param input Mac 的 IP 和端口
 * @param emit 往渲染层推事件的回调
 */
export function openStream(
  sessionId: string,
  input: StreamOpenInput,
  emit: EmitFn
): StreamSessionInfo {
  if (sessions.has(sessionId)) closeStream(sessionId)

  const host = input.host.trim()
  if (!host) throw new Error('必须填写 Mac 的 IP 地址')
  const port = input.port ?? 48000

  let capsSent = false
  const state: State = {
    host,
    port,
    caps: null,
    receiver: new StreamReceiver({
      host,
      port,
      onCaps: (caps) => {
        state.caps = caps
        if (!capsSent) {
          emit('main:event', {
            type: 'stream:init',
            sessionId,
            width: caps.width,
            height: caps.height,
            fps: caps.fps
          })
          capsSent = true
        }
      },
      onFrame: (frame, timestampUs, key) => {
        // Buffer 走 structured clone 到渲染层会变成 Uint8Array，零拷贝由 Electron 处理
        emit('main:event', {
          type: 'stream:frame',
          sessionId,
          data: new Uint8Array(frame),
          ts: Number(timestampUs / 1000n), // 微秒 → 毫秒，足够同步用
          key
        })
      },
      onStats: (stats: StreamStats) => {
        emit('main:event', { type: 'stream:stats', sessionId, stats })
      },
      onClose: (err) => {
        emit('main:event', {
          type: 'stream:status',
          sessionId,
          status: 'closed',
          error: err?.message
        })
        sessions.delete(sessionId)
      }
    })
  }

  sessions.set(sessionId, state)
  state.receiver.start()
  emit('main:event', { type: 'stream:status', sessionId, status: 'connecting' })

  // CAPS 可能在 start 之前就到（UDP 很快），这里补一次兜底：
  // 实际上 onCaps 回调一定会触发（Mac 收到 HELLO 就回 CAPS），不需要额外处理。

  return { width: 0, height: 0, fps: 0 } // 真实尺寸随后由 stream:init 事件给出
}

export function closeStream(sessionId: string): void {
  const s = sessions.get(sessionId)
  if (!s) return
  s.receiver.close()
  sessions.delete(sessionId)
}

export function closeAllStreams(): void {
  for (const id of [...sessions.keys()]) closeStream(id)
}

/** 鼠标键盘回传 */
export function streamInput(sessionId: string, payload: Buffer): void {
  sessions.get(sessionId)?.receiver.sendInput(payload)
}

/** 解码器出错时请求关键帧 */
export function streamKeyreq(sessionId: string): void {
  sessions.get(sessionId)?.receiver.requestKeyframe()
}

/** 判断某个 sessionId 是不是串流（用于 UI 分发） */
export function isStreamSession(sessionId: string): boolean {
  return sessions.has(sessionId)
}
