/**
 * 远程桌面的帧分发。
 *
 * 和 terminal-registry 同样的思路：App 只负责把主进程事件转进来，
 * 具体哪个 sessionId 由哪个画布消费，由面板自己注册。
 * 这样切换标签、重连换 sessionId 都不需要 App 记住谁是谁。
 */

import type { MainEvent, VncRect } from '../../../shared/types'

export interface RemoteHandlers {
  /** 收到 ServerInit 或重连后的整屏尺寸 */
  init?: (width: number, height: number, name: string) => void
  /** 一次 FramebufferUpdate 里的所有矩形，已经解码成 RGBA */
  rects?: (rects: VncRect[]) => void
  /** 远端剪贴板 */
  clipboard?: (text: string) => void
}

const handlers = new Map<string, RemoteHandlers>()

/**
 * ServerInit 往往比面板挂载更早到（建连成功的那一刻就推过来了），
 * 那时候还没有谁认领这个 sessionId。尺寸信息很小，先存着，等面板注册时补发。
 * 帧数据不缓存 —— 面板注册后会主动向主进程要一整帧，比留一堆过期帧干净。
 */
const pendingInit = new Map<string, { width: number; height: number; name: string }>()

export function registerRemote(sessionId: string, handler: RemoteHandlers): () => void {
  handlers.set(sessionId, handler)
  const early = pendingInit.get(sessionId)
  if (early) {
    pendingInit.delete(sessionId)
    handler.init?.(early.width, early.height, early.name)
  }
  return () => {
    // 只有当前登记的还是自己时才删，避免重连后新面板的注册被旧面板的清理误删
    if (handlers.get(sessionId) === handler) handlers.delete(sessionId)
  }
}

/** @returns 是否被某个面板消费掉了 */
export function dispatchRemote(evt: MainEvent): boolean {
  if (evt.type === 'vnc:init') {
    const handler = handlers.get(evt.sessionId)
    if (handler?.init) handler.init(evt.width, evt.height, evt.name)
    else pendingInit.set(evt.sessionId, { width: evt.width, height: evt.height, name: evt.name })
    return true
  }
  if (evt.type === 'vnc:rects') {
    handlers.get(evt.sessionId)?.rects?.(evt.rects)
    return true
  }
  if (evt.type === 'vnc:clipboard') {
    handlers.get(evt.sessionId)?.clipboard?.(evt.text)
    return true
  }
  return false
}
