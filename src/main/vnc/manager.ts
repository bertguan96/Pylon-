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

type EmitFn = (event: MainEvent) => void

interface Entry {
  client: VncClient
  info: VncSessionInfo
}

export class VncManager {
  private readonly sessions = new Map<string, Entry>()

  constructor(private readonly emit: EmitFn) {}

  async open(conn: ConnectionConfig, password: string | undefined): Promise<VncSessionInfo> {
    const sessionId = randomUUID()
    this.emit({ type: 'vnc:status', sessionId, status: 'connecting' })

    const client: VncClient = new VncClient({
      host: conn.host,
      port: conn.port,
      password,
      timeout: conn.timeout,
      onInit: (init) => {
        this.emit({
          type: 'vnc:init',
          sessionId,
          width: init.width,
          height: init.height,
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
      width: init.width,
      height: init.height,
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
