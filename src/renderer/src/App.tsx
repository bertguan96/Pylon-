import { useCallback, useEffect, useRef, useState } from 'react'
import type {
  ConnectionConfig,
  ConnectionKind,
  QuickCommand,
  SessionStatus,
  VncStats,
  ZmodemState
} from '../../shared/types'
import { LOCAL_CONNECTION_ID } from '../../shared/types'
import Sidebar from './components/Sidebar'
import ConnectionDialog from './components/ConnectionDialog'
import SecretPrompt from './components/SecretPrompt'
import QuickCommandPanel from './components/QuickCommandPanel'
import TransferStack from './components/TransferStack'
import {
  getTerminalSize,
  remapSession,
  sendText,
  writeToTerminal
} from './lib/terminal-registry'
import { cleanError } from './lib/ipc-error'

import TerminalPane from './components/TerminalPane'
import RemoteDesktopPane from './components/RemoteDesktopPane'
import { dispatchRemote } from './lib/remote-registry'

interface UiTab {
  tabId: string
  /** 建连成功前为 null；断线重连后会换新值，但 tabId 不变 */
  sessionId: string | null
  connectionId: string
  /** ssh = 终端；vnc = 远程桌面 */
  kind: ConnectionKind
  title: string
  host: string
  status: SessionStatus
  error?: string
}

const uid = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : `tab-${Math.random().toString(36).slice(2)}`

/** 等两帧：第一帧挂载终端，第二帧 fit 完成，此时才能读到真实行列数 */
const nextFrame = () =>
  new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve()))
  )

export default function App() {
  const [connections, setConnections] = useState<ConnectionConfig[]>([])
  const [tabs, setTabs] = useState<UiTab[]>([])
  const [activeTabId, setActiveTabId] = useState<string | null>(null)
  const [dialog, setDialog] = useState<{ conn: ConnectionConfig | null } | null>(null)
  const [secretPrompt, setSecretPrompt] = useState<{ conn: ConnectionConfig; tabId?: string } | null>(
    null
  )
  const [quickOpen, setQuickOpen] = useState(false)
  /** rz / sz 传输进度，按 sessionId 归类 */
  const [transfers, setTransfers] = useState<Record<string, ZmodemState>>({})
  /** 远程桌面的分辨率与实时帧率，按 sessionId 归类 */
  const [vncInfo, setVncInfo] = useState<Record<string, { width: number; height: number; name: string }>>({})
  const [vncStats, setVncStats] = useState<Record<string, VncStats>>({})
  const [quickCommands, setQuickCommands] = useState<QuickCommand[]>([])

  const tabsRef = useRef<UiTab[]>([])
  const activeTabIdRef = useRef<string | null>(null)
  const connectionsRef = useRef<ConnectionConfig[]>([])

  useEffect(() => {
    tabsRef.current = tabs
  }, [tabs])
  useEffect(() => {
    activeTabIdRef.current = activeTabId
  }, [activeTabId])
  useEffect(() => {
    connectionsRef.current = connections
  }, [connections])

  useEffect(() => {
    window.api.connections.list().then(setConnections).catch(() => setConnections([]))
  }, [])

  const reloadQuickCommands = useCallback(() => {
    window.api.quickCommands
      .list()
      .then(setQuickCommands)
      .catch(() => setQuickCommands([]))
  }, [])

  useEffect(() => {
    reloadQuickCommands()
  }, [reloadQuickCommands])

  const updateTab = useCallback((tabId: string, patch: Partial<UiTab>) => {
    setTabs((prev) => prev.map((t) => (t.tabId === tabId ? { ...t, ...patch } : t)))
  }, [])

  /** 建立会话。existingTabId 有值表示是重连，复用原标签与终端实例 */
  const startSession = useCallback(
    async (conn: ConnectionConfig, secret: string | undefined, existingTabId?: string) => {
      const tabId = existingTabId ?? uid()

      if (existingTabId) {
        updateTab(tabId, { status: 'connecting', error: undefined, sessionId: null })
      } else {
        setTabs((prev) => [
          ...prev,
          {
            tabId,
            sessionId: null,
            connectionId: conn.id,
            kind: 'ssh',
            title: conn.name,
            host: conn.host,
            status: 'connecting'
          }
        ])
        setActiveTabId(tabId)
        // 新建标签后才量得到尺寸
        await nextFrame()
      }

      const size = getTerminalSize(tabId) ?? { cols: 80, rows: 24 }

      try {
        const info = await window.api.session.open({
          connectionId: conn.id,
          secret,
          cols: size.cols,
          rows: size.rows
        })
        remapSession(tabId, info.sessionId)
        updateTab(tabId, {
          sessionId: info.sessionId,
          status: 'connected',
          title: info.title || conn.name
        })
      } catch (err) {
        updateTab(tabId, { status: 'error', error: cleanError(err) })
      }
    },
    [updateTab]
  )

  /** 远程桌面：走 VNC 通道，不涉及 PTY，也不需要终端尺寸 */
  const startVncSession = useCallback(
    async (conn: ConnectionConfig, password: string | undefined, existingTabId?: string) => {
      const tabId = existingTabId ?? uid()

      if (existingTabId) {
        updateTab(tabId, { status: 'connecting', error: undefined, sessionId: null })
      } else {
        setTabs((prev) => [
          ...prev,
          {
            tabId,
            sessionId: null,
            connectionId: conn.id,
            kind: 'vnc',
            title: conn.name,
            host: conn.host,
            status: 'connecting'
          }
        ])
        setActiveTabId(tabId)
      }

      try {
        const info = await window.api.vnc.open({ connectionId: conn.id, password })
        updateTab(tabId, { sessionId: info.sessionId, status: 'connected', title: conn.name })
      } catch (err) {
        updateTab(tabId, { status: 'error', error: cleanError(err) })
      }
    },
    [updateTab]
  )

  const handleConnect = useCallback(
    (conn: ConnectionConfig) => {
      const kind = conn.kind ?? 'ssh'
      // 远程桌面没有 agent 认证，只要有密码就能连
      const needSecret = kind === 'vnc' ? !conn.hasSecret : conn.authType !== 'agent' && !conn.hasSecret
      if (needSecret) {
        setSecretPrompt({ conn })
        return
      }
      if (kind === 'vnc') void startVncSession(conn, undefined)
      else void startSession(conn, undefined)
    },
    [startSession, startVncSession]
  )

  /** 本机终端：不查连接配置、不弹密码，直接开一个本地 shell 标签 */
  const startLocalSession = useCallback(
    async (existingTabId?: string) => {
      const tabId = existingTabId ?? uid()

      if (existingTabId) {
        updateTab(tabId, { status: 'connecting', error: undefined, sessionId: null })
      } else {
        setTabs((prev) => [
          ...prev,
          {
            tabId,
            sessionId: null,
            connectionId: LOCAL_CONNECTION_ID,
            kind: 'ssh',
            title: '本机终端',
            host: 'localhost',
            status: 'connecting'
          }
        ])
        setActiveTabId(tabId)
        await nextFrame()
      }

      const size = getTerminalSize(tabId) ?? { cols: 120, rows: 30 }

      try {
        const info = await window.api.session.openLocal({ cols: size.cols, rows: size.rows })
        remapSession(tabId, info.sessionId)
        updateTab(tabId, { sessionId: info.sessionId, status: 'connected', title: info.title })
      } catch (err) {
        updateTab(tabId, { status: 'error', error: cleanError(err) })
      }
    },
    [updateTab]
  )

  // 启动即开一个本机终端：应用打开就能敲命令，不用先配服务器
  const localBootRef = useRef(false)
  useEffect(() => {
    if (localBootRef.current) return
    localBootRef.current = true
    void startLocalSession()
  }, [startLocalSession])

  const handleReconnect = useCallback(
    (tab: UiTab) => {
      if (tab.connectionId === LOCAL_CONNECTION_ID) {
        void startLocalSession(tab.tabId)
        return
      }
      const conn = connectionsRef.current.find((c) => c.id === tab.connectionId)
      if (!conn) return
      const kind = conn.kind ?? 'ssh'
      const needSecret = kind === 'vnc' ? !conn.hasSecret : conn.authType !== 'agent' && !conn.hasSecret
      if (needSecret) {
        setSecretPrompt({ conn, tabId: tab.tabId })
        return
      }
      if (kind === 'vnc') void startVncSession(conn, undefined, tab.tabId)
      else void startSession(conn, undefined, tab.tabId)
    },
    [startSession, startLocalSession, startVncSession]
  )

  const closeTab = useCallback(async (tabId: string) => {
    const list = tabsRef.current
    const target = list.find((t) => t.tabId === tabId)
    if (target?.sessionId) {
      const closing =
        target.kind === 'vnc'
          ? window.api.vnc.close(target.sessionId)
          : window.api.session.close(target.sessionId)
      await closing.catch(() => undefined)
    }
    const idx = list.findIndex((t) => t.tabId === tabId)
    const next = list.filter((t) => t.tabId !== tabId)
    setTabs(next)
    if (activeTabIdRef.current === tabId) {
      setActiveTabId(next[Math.min(idx, next.length - 1)]?.tabId ?? null)
    }
  }, [])

  const handleDelete = useCallback(async (conn: ConnectionConfig) => {
    if (!window.confirm(`删除连接「${conn.name}」？已保存的凭据会一并清除。`)) return
    await window.api.connections.remove(conn.id)
    setConnections((prev) => prev.filter((c) => c.id !== conn.id))
  }, [])

  /**
   * 把快捷命令送到当前标签的终端。
   * insertOnly 为真时只填入不回车 —— 危险命令和需要补参数的命令都走这条路。
   */
  const handleQuickSend = useCallback((cmd: QuickCommand, insertOnly: boolean) => {
    const tab = tabsRef.current.find((t) => t.tabId === activeTabIdRef.current)
    if (!tab?.sessionId || tab.status !== 'connected') return
    sendText(tab.tabId, tab.sessionId, cmd.command, !insertOnly)
  }, [])

  const handleSaved = useCallback((conn: ConnectionConfig) => {
    setConnections((prev) => {
      const idx = prev.findIndex((c) => c.id === conn.id)
      if (idx < 0) return [...prev, conn]
      const next = [...prev]
      next[idx] = conn
      return next
    })
    setDialog(null)
  }, [])

  // 主进程事件订阅只注册一次
  useEffect(() => {
    return window.api.onEvent((evt) => {
      // ---- 远程桌面
      if (evt.type === 'vnc:init') {
        setVncInfo((prev) => ({
          ...prev,
          [evt.sessionId]: { width: evt.width, height: evt.height, name: evt.name }
        }))
        dispatchRemote(evt)
        return
      }
      if (evt.type === 'vnc:rects' || evt.type === 'vnc:clipboard') {
        dispatchRemote(evt)
        return
      }
      if (evt.type === 'vnc:stats') {
        setVncStats((prev) => ({ ...prev, [evt.sessionId]: evt.stats }))
        return
      }
      if (evt.type === 'vnc:status') {
        const tab = tabsRef.current.find((t) => t.sessionId === evt.sessionId)
        if (tab) updateTab(tab.tabId, { status: evt.status, error: evt.error })
        return
      }

      if (evt.type === 'zmodem:update') {
        const state = evt.state
        setTransfers((prev) => ({ ...prev, [state.sessionId]: state }))
        // 结束态停留几秒后自动消失
        if (state.status !== 'active') {
          const ttl = state.status === 'done' ? 4000 : 8000
          setTimeout(() => {
            setTransfers((prev) => {
              if (prev[state.sessionId]?.status !== state.status) return prev
              const next = { ...prev }
              delete next[state.sessionId]
              return next
            })
          }, ttl)
        }
        return
      }

      const tab = tabsRef.current.find((t) => t.sessionId === evt.sessionId)
      if (!tab) return

      if (evt.type === 'session:data') {
        writeToTerminal(tab.tabId, evt.sessionId, evt.data)
        return
      }
      if (evt.type === 'session:status') {
        updateTab(tab.tabId, { status: evt.status, error: evt.error })
      }
    })
  }, [updateTab])

  // Ctrl+Shift+W 关闭标签 / Ctrl+Tab 切换
  // 注意不能占用 Ctrl+W —— 那是终端里的「删除前一个单词」
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'w') {
        e.preventDefault()
        if (activeTabIdRef.current) void closeTab(activeTabIdRef.current)
        return
      }
      if (e.ctrlKey && e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        setQuickOpen((v) => !v)
        return
      }
      if (e.ctrlKey && e.key === 'Tab') {
        e.preventDefault()
        const list = tabsRef.current
        if (list.length < 2) return
        const idx = list.findIndex((t) => t.tabId === activeTabIdRef.current)
        const dir = e.shiftKey ? -1 : 1
        const next = list[(idx + dir + list.length) % list.length]
        setActiveTabId(next.tabId)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [closeTab])

  const activeTab = tabs.find((t) => t.tabId === activeTabId) ?? null
  const activeConnection = activeTab
    ? connections.find((c) => c.id === activeTab.connectionId)
    : undefined
  const activeVncInfo = activeTab?.sessionId ? vncInfo[activeTab.sessionId] : undefined
  const activeVncStats = activeTab?.sessionId ? vncStats[activeTab.sessionId] : undefined

  return (
    <div className="app">
      <div className="workspace">
        <Sidebar
          connections={connections}
          activeConnectionId={activeTab?.connectionId}
          localActive={activeTab?.connectionId === LOCAL_CONNECTION_ID}
          onNew={() => setDialog({ conn: null })}
          onConnect={handleConnect}
          onConnectLocal={() => {
            const open = tabs.find(
              (t) => t.connectionId === LOCAL_CONNECTION_ID && t.status !== 'closed' && t.status !== 'error'
            )
            if (open) {
              setActiveTabId(open.tabId)
              return
            }
            void startLocalSession()
          }}
          onEdit={(conn) => setDialog({ conn })}
          onDelete={handleDelete}
        />

        <div className="main">
          <div className="tabbar">
            {tabs.map((tab) => (
              <div
                key={tab.tabId}
                className={`tab ${tab.tabId === activeTabId ? 'active' : ''}`}
                onClick={() => setActiveTabId(tab.tabId)}
                onAuxClick={(e) => {
                  if (e.button === 1) void closeTab(tab.tabId)
                }}
              >
                <span
                  className="status-pip"
                  style={{ background: statusColor(tab.status) }}
                  title={statusText(tab.status)}
                />
                <span className="tab-title">{tab.title}</span>
                <button
                  className="tab-close"
                  title="关闭（Ctrl+Shift+W）"
                  onClick={(e) => {
                    e.stopPropagation()
                    void closeTab(tab.tabId)
                  }}
                >
                  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round">
                    <path d="M6 6l12 12M18 6L6 18" />
                  </svg>
                </button>
              </div>
            ))}

            <div className="tabbar-actions">
              <button
                className={`qc-toggle ${quickOpen ? 'active' : ''}`}
                title="快捷命令（Ctrl+Shift+K）"
                onClick={() => setQuickOpen((v) => !v)}
              >
                <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
                  <path d="M4 7h9M4 12h6M4 17h4" />
                  <path d="M15 11l2.6 3.2L15 17.5" />
                  <path d="M18.5 8.5l1.8 2.2-1.8 2.2" />
                </svg>
                快捷命令
              </button>
            </div>
          </div>

          <TransferStack
            transfers={Object.values(transfers)}
            onCancel={(sessionId) => window.api.session.cancelZmodem(sessionId)}
          />

          <div className="pane-wrap">
            {tabs.length === 0 && (
              <div className="welcome">
                <div>
                  从左侧选一台服务器开始
                  <br />
                  <br />
                  <kbd>Ctrl</kbd> + <kbd>Tab</kbd> 切换标签 &nbsp;·&nbsp; <kbd>Ctrl</kbd> +{' '}
                  <kbd>Shift</kbd> + <kbd>W</kbd> 关闭标签
                </div>
              </div>
            )}

            {tabs.map((tab) => (
              <div
                key={tab.tabId}
                className={`pane ${tab.tabId === activeTabId ? 'active' : ''}`}
              >
                {tab.kind === 'vnc' ? (
                  <RemoteDesktopPane
                    sessionId={tab.sessionId}
                    active={tab.tabId === activeTabId}
                  />
                ) : (
                  <TerminalPane
                    tabId={tab.tabId}
                    sessionId={tab.sessionId}
                    active={tab.tabId === activeTabId}
                  />
                )}
              </div>
            ))}

            {activeTab && (activeTab.status === 'closed' || activeTab.status === 'error') && (
              <div className={`reconnect-bar ${activeTab.status === 'error' ? 'error' : ''}`}>
                <span>
                  {activeTab.status === 'error'
                    ? activeTab.error || '连接失败'
                    : '连接已断开'}
                </span>
                <span className="spacer" />
                <button className="link-btn" onClick={() => handleReconnect(activeTab)}>
                  重新连接
                </button>
                <button className="link-btn" onClick={() => void closeTab(activeTab.tabId)}>
                  关闭标签
                </button>
              </div>
            )}
          </div>
        </div>

        {quickOpen && (
          <QuickCommandPanel
            commands={quickCommands}
            canSend={
              activeTab?.kind !== 'vnc' && !!activeTab?.sessionId && activeTab.status === 'connected'
            }
            onClose={() => setQuickOpen(false)}
            onSend={handleQuickSend}
            onReload={reloadQuickCommands}
          />
        )}
      </div>

      <div className="statusbar">
        <span>{activeTab ? activeTab.title : '就绪'}</span>
        {activeConnection && (
          <>
            <span className="sep" />
            {activeTab?.kind === 'vnc' ? (
              <>
                <span>
                  {activeConnection.host}:{activeConnection.port} · VNC
                </span>
                {activeVncInfo && (
                  <>
                    <span className="sep" />
                    <span>
                      {activeVncInfo.width}×{activeVncInfo.height}
                    </span>
                  </>
                )}
                {activeVncStats && (
                  <>
                    <span className="sep" />
                    <span>
                      {activeVncStats.fps} fps · {activeVncStats.kbps} kbps
                    </span>
                  </>
                )}
              </>
            ) : (
              <span>
                {activeConnection.username}@{activeConnection.host}:{activeConnection.port}
              </span>
            )}
            <span className="sep" />
            <span>{statusText(activeTab?.status)}</span>
          </>
        )}
        {activeTab?.connectionId === LOCAL_CONNECTION_ID && (
          <>
            <span className="sep" />
            <span>localhost · 本地进程</span>
            <span className="sep" />
            <span>{statusText(activeTab.status)}</span>
          </>
        )}
        <div style={{ flex: 1 }} />
        <span>{connections.length} 个连接</span>
        <span className="sep" />
        <span>{tabs.length} 个标签</span>
      </div>

      {dialog && (
        <ConnectionDialog
          key={dialog.conn?.id ?? 'new'}
          initial={dialog.conn}
          onClose={() => setDialog(null)}
          onSaved={handleSaved}
        />
      )}

      {secretPrompt && (
        <SecretPrompt
          connection={secretPrompt.conn}
          onClose={() => setSecretPrompt(null)}
          onSubmit={(secret) => {
            const pending = secretPrompt
            setSecretPrompt(null)
            if ((pending.conn.kind ?? 'ssh') === 'vnc') {
              void startVncSession(pending.conn, secret, pending.tabId)
            } else {
              void startSession(pending.conn, secret, pending.tabId)
            }
          }}
        />
      )}
    </div>
  )
}

function statusColor(status: SessionStatus): string {
  switch (status) {
    case 'connected':
      return '#639922'
    case 'connecting':
      return '#ef9f27'
    case 'error':
      return '#e24b4a'
    default:
      return '#b4b2a9'
  }
}

function statusText(status?: SessionStatus): string {
  switch (status) {
    case 'connected':
      return '已连接'
    case 'connecting':
      return '连接中'
    case 'error':
      return '连接失败'
    case 'closed':
      return '已断开'
    default:
      return '未连接'
  }
}
