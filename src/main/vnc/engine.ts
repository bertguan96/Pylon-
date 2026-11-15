/**
 * 远程桌面引擎的统一接口。
 *
 * 有两套实现：
 *   - `native.ts`：Rust 写的独立进程（native/pylon-vnc），RFB 协议、ZRLE 解码、
 *     降采样、脏块比对全在那边做，主进程只负责转发字节；
 *   - `client.ts`：纯 TS 实现，作为引擎 exe 缺失或起不来时的兜底。
 *
 * 上层（manager）只依赖这个接口，所以换引擎不影响任何 IPC 与渲染逻辑。
 */

import type { VncRect } from '../../shared/types'

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

export interface VncEngineCallbacks {
  onInit?: (info: VncInitInfo) => void
  onRects?: (rects: VncRect[]) => void
  onClipboard?: (text: string) => void
  onStats?: (stats: { fps: number; kbps: number }) => void
  /** 只回调一次：正常情况下是用户关掉，异常时带一个可读的原因 */
  onClose?: (error?: Error) => void
}

export interface VncEngineOptions extends VncEngineCallbacks {
  host: string
  port: number
  password?: string
  /** TCP 建连超时，不含握手 */
  timeout?: number
  quality?: 'speed' | 'sharp'
}

export interface VncEngine {
  /** 建连 + 握手。失败时抛出可以直接展示给用户的原因 */
  connect(): Promise<VncInitInfo>
  pointer(x: number, y: number, mask: number): void
  key(keysym: number, down: boolean): void
  cutText(text: string): void
  refresh(): void
  setActive(active: boolean): void
  close(): void
  readonly securityTypes: number[]
  /** 引擎类型，日志里区分用 */
  readonly engine: 'native' | 'js'
}

export function securityLabel(types: number[]): string {
  if (types.length === 0) return '未知'
  if (types.includes(2)) return 'vnc-password'
  if (types.includes(1)) return 'none'
  if (types.includes(30)) return 'ard'
  return types.join(',')
}
