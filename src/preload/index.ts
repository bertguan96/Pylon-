import { contextBridge, ipcRenderer } from 'electron'
import type { BridgeApi, MainEvent } from '../shared/types'

/**
 * 唯一的跨进程出口。
 * 不暴露 ipcRenderer 本身，只暴露白名单方法 —— 渲染进程即使被注入脚本，
 * 也只能调用这里定义的通道，拿不到任意调用能力。
 */
const api: BridgeApi = {
  connections: {
    list: () => ipcRenderer.invoke('conn:list'),
    save: (input) => ipcRenderer.invoke('conn:save', input),
    remove: (id) => ipcRenderer.invoke('conn:remove', id),
    diagnose: (input) => ipcRenderer.invoke('conn:diagnose', input),
    pickPrivateKey: () => ipcRenderer.invoke('conn:pickPrivateKey')
  },
  session: {
    open: (req) => ipcRenderer.invoke('session:open', req),
    openLocal: (req) => ipcRenderer.invoke('session:openLocal', req),
    write: (sessionId, data) => ipcRenderer.send('session:write', sessionId, data),
    resize: (sessionId, cols, rows) => ipcRenderer.send('session:resize', sessionId, cols, rows),
    close: (sessionId) => ipcRenderer.invoke('session:close', sessionId),
    ack: (sessionId, bytes) => ipcRenderer.send('session:ack', sessionId, bytes)
  },
  quickCommands: {
    list: () => ipcRenderer.invoke('quick:list'),
    save: (input) => ipcRenderer.invoke('quick:save', input),
    remove: (id) => ipcRenderer.invoke('quick:remove', id)
  },
  onEvent: (handler) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: MainEvent) => handler(payload)
    ipcRenderer.on('main:event', listener)
    return () => {
      ipcRenderer.off('main:event', listener)
    }
  }
}

contextBridge.exposeInMainWorld('api', api)
