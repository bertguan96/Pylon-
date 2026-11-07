import { useMemo } from 'react'
import type { ConnectionConfig } from '../../../shared/types'

interface Props {
  connections: ConnectionConfig[]
  activeConnectionId?: string
  /** 当前标签是否就是本机终端 */
  localActive: boolean
  onNew: () => void
  onConnect: (conn: ConnectionConfig) => void
  onConnectLocal: () => void
  onEdit: (conn: ConnectionConfig) => void
  onDelete: (conn: ConnectionConfig) => void
}

const DOT_COLORS = ['#185fa5', '#0f6e56', '#534ab7', '#993c1d', '#993556', '#639922', '#854f0b']

function dotColor(seed: string): string {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0
  return DOT_COLORS[h % DOT_COLORS.length]
}

export default function Sidebar({
  connections,
  activeConnectionId,
  localActive,
  onNew,
  onConnect,
  onConnectLocal,
  onEdit,
  onDelete
}: Props) {
  // 按分组归拢，未分组的归到最后一组，组内按名称排序
  const groups = useMemo(() => {
    const map = new Map<string, ConnectionConfig[]>()
    for (const conn of connections) {
      const key = conn.group?.trim() || ''
      const list = map.get(key) ?? []
      list.push(conn)
      map.set(key, list)
    }
    return [...map.entries()].sort((a, b) => {
      if (a[0] === '') return 1
      if (b[0] === '') return -1
      return a[0].localeCompare(b[0], 'zh-CN')
    })
  }, [connections])

  return (
    <aside className="sidebar">
      <div className="sidebar-head">
        <div className="brand">
          <span className="brand-mark">&gt;_</span>
          <span>Pylon</span>
        </div>
        <button className="icon-btn" title="新建连接" onClick={onNew}>
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      </div>

      <div className="conn-list">
        {/* 本机终端常驻在列表最上方：打开应用就能直接用，不依赖任何 SSH 配置 */}
        <div
          className={`local-item ${localActive ? 'active' : ''}`}
          onClick={onConnectLocal}
          title="本机终端（不经过 SSH，直接在本机开一个 shell）"
        >
          <span className="local-mark">&gt;_</span>
          <div className="conn-main">
            <div className="conn-name">本机终端</div>
            <div className="conn-sub">localhost · 本地进程</div>
          </div>
          <span className="local-tag">LOCAL</span>
        </div>

        {connections.length === 0 && (
          <div className="empty-hint">
            还没有连接
            <br />
            点击右上角 + 添加第一台服务器
          </div>
        )}

        {groups.map(([group, list]) => (
          <div key={group || '__ungrouped'}>
            {group && <div className="group-label">{group}</div>}
            {list.map((conn) => (
              <div
                key={conn.id}
                className="conn-item"
                style={
                  activeConnectionId === conn.id
                    ? { background: 'var(--accent-soft)' }
                    : undefined
                }
                onClick={() => onConnect(conn)}
                title={
                  conn.kind === 'vnc'
                    ? `${conn.host}:${conn.port} · 远程桌面`
                    : `${conn.username}@${conn.host}:${conn.port}`
                }
              >
                <span className="conn-dot" style={{ background: dotColor(conn.id) }} />
                <div className="conn-main">
                  <div className="conn-name">{conn.name}</div>
                  <div className="conn-sub">
                    {conn.kind === 'vnc' ? `${conn.host} · VNC` : `${conn.username}@${conn.host}`}
                  </div>
                </div>
                {conn.kind === 'vnc' && <span className="kind-tag">桌面</span>}
                <div className="conn-actions" onClick={(e) => e.stopPropagation()}>
                  <button
                    title="编辑"
                    onClick={() => onEdit(conn)}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4 16v4Z" />
                    </svg>
                  </button>
                  <button
                    title="删除"
                    onClick={() => onDelete(conn)}
                  >
                    <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                      <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" />
                    </svg>
                  </button>
                </div>
              </div>
            ))}
          </div>
        ))}
      </div>

      <div className="sidebar-foot">
        <button className="btn btn-ghost btn-full" onClick={onNew}>
          新建连接
        </button>
      </div>
    </aside>
  )
}
