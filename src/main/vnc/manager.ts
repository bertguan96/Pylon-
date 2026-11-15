/**
 * 远程桌面会话的登记处。
 *
 * 渲染进程只认 sessionId，不关心 TCP、解码、fb 这些东西；
 * 主进程这边一个 sessionId 对应一个 VncClient，关标签时必须能干净地拆掉。
 */

import { randomUUID } from 'node:crypto'
import { clipboard } from 'electron'
import type {
  ConnectionConfig,
  MainEvent,
  VncProbeInput,
  VncProbeResult,
  VncSessionInfo
} from '../../shared/types'
import { VncClient, securityLabel } from './client'
import type { VncEngine, VncEngineOptions } from './engine'
import { NativeVncClient, nativeEnginePath } from './native'

type EmitFn = (event: MainEvent) => void

interface Entry {
  client: VncEngine
  info: VncSessionInfo
}

/**
 * 选引擎。
 *
 * 默认优先原生：RFB 协议、ZRLE 解压、降采样、脏块比对全在独立进程里做，
 * 主进程只剩转发字节，画面再重也压不住 UI。原生 exe 缺失（或用户显式
 * 设了 PYLON_VNC_ENGINE_MODE=js）时退回 TS 实现 —— 两条路都能连通，
 * 区别只在同样一台 Mac 上客户端每帧多花几十毫秒。
 */
function createEngine(options: VncEngineOptions): VncEngine {
  const mode = process.env.PYLON_VNC_ENGINE_MODE
  if (mode !== 'js') {
    const exe = nativeEnginePath()
    if (exe) {
      console.log(`[vnc] 使用原生引擎：${exe}`)
      return new NativeVncClient(options, exe)
    }
    if (mode === 'native') {
      throw new Error('找不到原生引擎 pylon-vnc.exe，请先运行 npm run build:native')
    }
    console.warn('[vnc] 未找到原生引擎，退回 JS 实现（帧率会明显下降）')
  }
  return new VncClient(options)
}

export class VncManager {
  private readonly sessions = new Map<string, Entry>()

  constructor(private readonly emit: EmitFn) {}

  async open(conn: ConnectionConfig, password: string | undefined): Promise<VncSessionInfo> {
    const sessionId = randomUUID()
    this.emit({ type: 'vnc:status', sessionId, status: 'connecting' })

    const client: VncEngine = createEngine({
      host: conn.host,
      port: conn.port,
      password,
      timeout: conn.timeout,
      // 缺省走 16 位色：Retina 大屏上这是帧率与流量的最优解，色带在文字界面上基本看不出
      quality: conn.quality === 'sharp' ? 'sharp' : 'speed',
      onInit: (init) => {
        this.emit({
          type: 'vnc:init',
          sessionId,
          width: init.width,
          height: init.height,
          remoteWidth: init.remoteWidth,
          remoteHeight: init.remoteHeight,
          scale: init.scale,
          name: init.name
        })
      },
      onRects: (rects) => {
        this.emit({ type: 'vnc:rects', sessionId, rects })
      },
      onClipboard: (text) => {
        // 远端复制的内容直接进系统剪贴板，用户回到本地就能粘
        void Promise.resolve(clipboard.writeText(text)).catch(() => undefined)
        this.emit({ type: 'vnc:clipboard', sessionId, text })
      },
      onStats: (stats) => {
        this.emit({ type: 'vnc:stats', sessionId, stats })
      },
      onClose: (error) => {
        this.sessions.delete(sessionId)
        this.emit({
          type: 'vnc:status',
          sessionId,
          status: error ? 'error' : 'closed',
          error: error?.message
        })
      }
    })

    const init = await client.connect()
    const info: VncSessionInfo = {
      sessionId,
      connectionId: conn.id,
      title: conn.name,
      host: conn.host,
      port: conn.port,
      // 状态栏报远端真实分辨率：用户认的是 Mac 的屏幕尺寸，不是我们内部的降采样尺寸
      width: init.remoteWidth,
      height: init.remoteHeight,
      desktopName: init.name
    }
    this.sessions.set(sessionId, { client, info })
    this.emit({ type: 'vnc:status', sessionId, status: 'connected' })
    return info
  }

  pointer(sessionId: string, x: number, y: number, mask: number): void {
    this.sessions.get(sessionId)?.client.pointer(x, y, mask)
  }

  key(sessionId: string, keysym: number, down: boolean): void {
    this.sessions.get(sessionId)?.client.key(keysym, down)
  }

  clipboard(sessionId: string, text: string): void {
    this.sessions.get(sessionId)?.client.cutText(text)
  }

  refresh(sessionId: string): void {
    this.sessions.get(sessionId)?.client.refresh()
  }

  setActive(sessionId: string, active: boolean): void {
    this.sessions.get(sessionId)?.client.setActive(active)
  }

  close(sessionId: string): void {
    const entry = this.sessions.get(sessionId)
    if (!entry) return
    this.sessions.delete(sessionId)
    entry.client.close()
  }

  closeAll(): void {
    for (const entry of this.sessions.values()) entry.client.close()
    this.sessions.clear()
  }
}

/**
 * 探测：能不能连、对端报了多大的屏、用哪种认证。
 *
 * 这一步的价值在于把「Mac 那边到底开了没」变成一句明确的结论 ——
 * 连不上时的报错和真正连接时走的是同一套错误翻译，不会出现两边说法不一致。
 */
export async function probeVnc(input: VncProbeInput): Promise<VncProbeResult> {
  const started = Date.now()
  const client = new VncClient({
    host: input.host,
    port: input.port,
    password: input.password,
    timeout: 6000
  })

  try {
    const info = await client.connect()
    const latencyMs = Date.now() - started
    const security = securityLabel(client.securityTypes)
    client.close()
    return {
      ok: true,
      message: `握手成功：${info.name || '未命名桌面'} ${info.width}×${info.height}`,
      name: info.name,
      width: info.width,
      height: info.height,
      security,
      latencyMs
    }
  } catch (err) {
    return {
      ok: false,
      message: err instanceof Error ? err.message : String(err),
      security: securityLabel(client.securityTypes)
    }
  }
}
