import { BrowserWindow, clipboard, dialog, ipcMain } from 'electron'
import type {
  ConnectionConfig,
  ConnectionInput,
  DiagnoseResult,
  MainEvent,
  OpenSessionRequest,
  QuickCommand,
  QuickCommandInput,
  SessionInfo
} from '../shared/types'
import type { ConnectionStore } from './store/connection-store'
import type { QuickCommandStore } from './store/quick-command-store'
import type { SessionManager } from './ssh/session-manager'
import type { VncManager } from './vnc/manager'
import { probeVnc } from './vnc/manager'
import type { VncOpenRequest, VncProbeInput, VncProbeResult, VncSessionInfo } from '../shared/types'
import { diagnose } from './ssh/diagnose'

/** 主进程事件统一从这里推给渲染进程，避免散落各处的 webContents.send */
export function createEmitter(getWindow: () => BrowserWindow | null) {
  return (event: MainEvent) => {
    getWindow()?.webContents.send('main:event', event)
  }
}

export function registerIpc(
  store: ConnectionStore,
  quick: QuickCommandStore,
  sessions: SessionManager,
  vnc: VncManager,
  getWindow: () => BrowserWindow | null
): void {
  ipcMain.handle('conn:list', (): ConnectionConfig[] => store.list())

  ipcMain.handle('conn:save', (_e, input: ConnectionInput): Promise<ConnectionConfig> => {
    if (!input.host?.trim()) throw new Error('主机地址不能为空')
    // 远程桌面不需要用户名，只有 SSH 才校验
    if ((input.kind ?? 'ssh') === 'ssh' && !input.username?.trim()) {
      throw new Error('用户名不能为空')
    }
    return store.upsert(input)
  })

  ipcMain.handle('conn:remove', (_e, id: string) => store.remove(id))

  ipcMain.handle(
    'conn:diagnose',
    async (_e, input: ConnectionInput, secret?: string): Promise<DiagnoseResult> => {
      // 优先用本次输入的密码；没输入则回退到已保存的凭据
      const effectiveSecret = secret ?? (input.id ? await store.getSecret(input.id) : undefined)
      return diagnose(
        {
          host: input.host,
          port: input.port || 22,
          username: input.username,
          authType: input.authType,
          privateKeyPath: input.privateKeyPath,
          legacyAlgorithms: input.legacyAlgorithms,
          timeout: input.timeout
        },
        effectiveSecret
      )
    }
  )

  ipcMain.handle('conn:pickPrivateKey', async (): Promise<string | null> => {
    const win = getWindow()
    if (!win) return null
    const result = await dialog.showOpenDialog(win, {
      title: '选择私钥文件',
      properties: ['openFile', 'showHiddenFiles'],
      filters: [
        { name: '私钥文件', extensions: ['pem', 'key', 'ppk', 'openssh'] },
        { name: '全部文件', extensions: ['*'] }
      ]
    })
    return result.canceled ? null : (result.filePaths[0] ?? null)
  })

  ipcMain.handle('session:open', async (_e, req: OpenSessionRequest): Promise<SessionInfo> => {
    const conn = store.get(req.connectionId)
    if (!conn) throw new Error('连接配置不存在，可能已被删除')
    if (!conn.hasSecret && req.secret === undefined && conn.authType !== 'agent') {
      throw new Error('该连接没有保存密码，请在弹出的窗口中输入')
    }
    const secret = req.secret ?? (await store.getSecret(conn.id))
    return sessions.open(conn, secret, req.cols, req.rows)
  })

  // 本机 shell：不查连接配置、不走 SSH，直接开一个本地进程
  ipcMain.handle(
    'session:openLocal',
    (_e, req: { cols: number; rows: number }): Promise<SessionInfo> =>
      sessions.openLocal(req.cols, req.rows)
  )

  // 高频调用走 send，不用 invoke，避免每次按键都等一次 Promise 往返
  ipcMain.on('session:write', (_e, sessionId: string, data: string) => {
    sessions.write(sessionId, data)
  })

  ipcMain.on('session:resize', (_e, sessionId: string, cols: number, rows: number) => {
    sessions.resize(sessionId, cols, rows)
  })

  ipcMain.on('session:ack', (_e, sessionId: string, bytes: number) => {
    sessions.ack(sessionId, bytes)
  })

  ipcMain.handle('session:close', (_e, sessionId: string) => {
    sessions.close(sessionId)
  })

  ipcMain.on('zmodem:cancel', (_e, sessionId: string) => {
    sessions.cancelZmodem(sessionId)
  })

  // ---------- 远程桌面（VNC） ----------

  ipcMain.handle('vnc:open', async (_e, req: VncOpenRequest): Promise<VncSessionInfo> => {
    const conn = store.get(req.connectionId)
    if (!conn) throw new Error('连接配置不存在，可能已被删除')
    const password = req.password ?? (await store.getSecret(conn.id))
    return vnc.open(conn, password)
  })

  ipcMain.handle('vnc:close', (_e, sessionId: string) => {
    vnc.close(sessionId)
  })

  ipcMain.on('vnc:pointer', (_e, sessionId: string, x: number, y: number, mask: number) => {
    vnc.pointer(sessionId, x, y, mask)
  })

  ipcMain.on('vnc:key', (_e, sessionId: string, keysym: number, down: boolean) => {
    vnc.key(sessionId, keysym, down)
  })

  ipcMain.on('vnc:clipboard', (_e, sessionId: string, text: string) => {
    vnc.clipboard(sessionId, text)
  })

  ipcMain.on('vnc:paste', (_e, sessionId: string) => {
    // Electron 45 起剪贴板读取是异步的，包一层并把异常吞掉（读不到就没什么可粘的）
    void Promise.resolve(clipboard.readText())
      .then((text) => vnc.clipboard(sessionId, text))
      .catch(() => undefined)
  })

  ipcMain.on('vnc:refresh', (_e, sessionId: string) => {
    vnc.refresh(sessionId)
  })

  ipcMain.on('vnc:active', (_e, sessionId: string, active: boolean) => {
    vnc.setActive(sessionId, active)
  })

  ipcMain.handle('vnc:probe', (_e, input: VncProbeInput): Promise<VncProbeResult> => probeVnc(input))

  // ---------- 快捷命令 ----------

  ipcMain.handle('quick:list', (): QuickCommand[] => quick.list())

  ipcMain.handle('quick:save', (_e, input: QuickCommandInput): Promise<QuickCommand> =>
    quick.upsert(input)
  )

  ipcMain.handle('quick:remove', (_e, id: string) => quick.remove(id))
}
