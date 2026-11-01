import { app, BrowserWindow, shell } from 'electron'
import { existsSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { ConnectionStore } from './store/connection-store'
import { QuickCommandStore } from './store/quick-command-store'
import { SessionManager } from './ssh/session-manager'
import { createEmitter, registerIpc } from './ipc'
import { forwardRendererConsole, maybeRunSmokeCapture } from './dev/smoke'
import { maybeRunPerf } from './dev/perf'
import { maybeRunLocalProbe } from './dev/local-probe'
import { maybeRunZmodemProbe } from './dev/zmodem-probe'
import { maybeRunZmodemE2E } from './dev/zmodem-e2e'
import type { MainEvent } from '../shared/types'

/**
 * 用户数据目录迁移。
 *
 * 应用改名（bash-client → Pylon）后 Electron 的 userData 路径跟着变了，
 * 用户已保存的连接配置与凭据还在旧目录里。首次启动时整体搬过来，
 * DPAPI 加密绑定的是 Windows 用户账户而非应用名，搬家后仍可正常解密。
 */
function migrateUserData(): void {
  const legacyDir = join(app.getPath('appData'), 'bash-client')
  const newDir = app.getPath('userData')
  if (!existsSync(legacyDir) || legacyDir === newDir) return

  let copied = 0
  for (const name of ['connections.json', 'secrets.json', 'quick-commands.json']) {
    const from = join(legacyDir, name)
    const to = join(newDir, name)
    if (existsSync(from) && !existsSync(to)) {
      copyFileSync(from, to)
      copied++
    }
  }
  if (copied > 0) console.log(`[migrate] 从旧目录迁移了 ${copied} 个数据文件`)
}

let mainWindow: BrowserWindow | null = null
let store!: ConnectionStore
let quickCommands!: QuickCommandStore
let sessions!: SessionManager

/**
 * 启动耗时打点（PERF_STARTUP=1 时输出）。
 *
 * bootAt 用 process.uptime() 反推进程真正启动的时刻，这样各阶段耗时都从「双击图标」算起，
 * 不受本文件被执行到的时间影响 —— 否则 Electron 自身的启动开销会被漏掉。
 */
const bootAt = Date.now() - Math.round(process.uptime() * 1000)
function markStartup(label: string): void {
  if (!process.env.PERF_STARTUP) return
  console.log(`[startup] ${label.padEnd(10)} +${Date.now() - bootAt}ms`)
}

const getWindow = () => mainWindow

/** 自测用的事件旁路：不影响正常推送给渲染进程，只是多接一份 */
let eventTap: ((evt: MainEvent) => void) | null = null
function setEventTap(fn: ((evt: MainEvent) => void) | null): void {
  eventTap = fn
}

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 940,
    minHeight: 560,
    show: false,
    backgroundColor: '#FAF9F5',
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      // 三件套：隔离上下文、禁用 Node 集成、preload 才能 require('electron')
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  // 首帧渲染完再显示，避免白屏闪一下
  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    markStartup('window')
    // 压测模式：窗口一出现就退出，把启动耗时留在日志里
    if (process.env.PERF_STARTUP) setTimeout(() => app.exit(0), 400)
  })

  mainWindow.webContents.once('did-finish-load', () => markStartup('loaded'))

  // 所有外链交给系统浏览器，不在应用内开新窗口
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  forwardRendererConsole(mainWindow)
  maybeRunPerf(mainWindow, sessions)
  maybeRunSmokeCapture(mainWindow, async () => {
    if (seededDemoId) await store.remove(seededDemoId)
    if (seededQuickId) await quickCommands.remove(seededQuickId)
  })
}

/** 冒烟测试时临时插入的示例数据，结束后清理 */
let seededDemoId: string | undefined
let seededQuickId: string | undefined

app.whenReady().then(async () => {
  markStartup('ready')
  migrateUserData()

  const send = createEmitter(getWindow)

  store = new ConnectionStore()
  await store.load()

  quickCommands = new QuickCommandStore()
  await quickCommands.load()
  markStartup('stores')

  sessions = new SessionManager(
    (evt) => {
      send(evt)
      eventTap?.(evt)
    },
    // 保存/选择文件的对话框要挂在主窗口上
    getWindow
  )
  registerIpc(store, quickCommands, sessions, getWindow)
  markStartup('ipc')

  // 本机终端自测：LOCAL_PROBE=1 时接管事件流，跑完自行退出
  maybeRunLocalProbe(sessions, (fn) => setEventTap(fn))
  // rz / sz 自测：ZMODEM_PROBE=1 时跑完退出，不开窗口
  maybeRunZmodemProbe()
  // rz / sz 端到端自测：ZMODEM_E2E=1 时起一个假 lrzsz 主机，跑完整条 SSH 链路
  maybeRunZmodemE2E()

  if (process.env.DEMO_SEED) {
    const exists = store.list().some((c) => c.host === '127.0.0.1' && c.port === 2222)
    if (!exists) {
      const created = await store.upsert({
        name: '本地模拟服务',
        host: '127.0.0.1',
        port: 2222,
        username: 'demo',
        authType: 'password',
        legacyAlgorithms: false,
        secret: 'demo1234',
        rememberSecret: true
      })
      seededDemoId = created.id
    }

    // 内置库都是真实 Linux 命令，模拟服务端只认 size/help/ls，这里补一条能跑通的
    const hasDemoCmd = quickCommands
      .list()
      .some((c) => !c.builtin && c.command === 'size')
    if (!hasDemoCmd) {
      const cmd = await quickCommands.upsert({
        label: '查看终端尺寸',
        command: 'size',
        group: '我的命令',
        autoRun: true
      })
      seededQuickId = cmd.id
    }
  }

  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  sessions?.closeAll()
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  sessions?.closeAll()
})
