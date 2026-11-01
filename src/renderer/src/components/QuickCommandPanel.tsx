import { useEffect, useMemo, useRef, useState } from 'react'
import type { QuickCommand, QuickCommandInput } from '../../../shared/types'
import { cleanError } from '../lib/ipc-error'

interface Props {
  commands: QuickCommand[]
  /** 当前是否有可以接收命令的会话 */
  canSend: boolean
  onClose: () => void
  /** insertOnly 由 Alt/Option + 点击触发：只填入不执行 */
  onSend: (cmd: QuickCommand, insertOnly: boolean) => void
  onReload: () => void
}

interface EditorState {
  id?: string
  label: string
  command: string
  group: string
  autoRun: boolean
  description: string
}

const EMPTY_EDITOR: EditorState = {
  label: '',
  command: '',
  group: '我的命令',
  autoRun: true,
  description: ''
}

export default function QuickCommandPanel({
  commands,
  canSend,
  onClose,
  onSend,
  onReload
}: Props) {
  const [query, setQuery] = useState('')
  const [editor, setEditor] = useState<EditorState | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const searchRef = useRef<HTMLInputElement>(null)

  // 打开面板即聚焦搜索框，键盘流可以一路走完
  useEffect(() => {
    if (!editor) searchRef.current?.focus()
  }, [editor])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return commands
    return commands.filter((c) =>
      [c.label, c.command, c.group, c.description ?? '']
        .join(' ')
        .toLowerCase()
        .includes(q)
    )
  }, [commands, query])

  // 按分组归拢，保持内置库里的原始顺序
  const groups = useMemo(() => {
    const map = new Map<string, QuickCommand[]>()
    for (const cmd of filtered) {
      const list = map.get(cmd.group) ?? []
      list.push(cmd)
      map.set(cmd.group, list)
    }
    return [...map.entries()]
  }, [filtered])

  const startNew = () => {
    setError(null)
    setEditor({ ...EMPTY_EDITOR })
  }

  const startEdit = (cmd: QuickCommand) => {
    setError(null)
    setEditor({
      id: cmd.id,
      label: cmd.label,
      command: cmd.command,
      group: cmd.group,
      autoRun: cmd.autoRun,
      description: cmd.description ?? ''
    })
  }

  const commit = async () => {
    if (!editor) return
    if (!editor.label.trim() || !editor.command.trim()) {
      setError('名称和命令内容都要填')
      return
    }
    setSaving(true)
    setError(null)
    try {
      const input: QuickCommandInput = {
        id: editor.id,
        label: editor.label,
        command: editor.command,
        group: editor.group,
        autoRun: editor.autoRun,
        description: editor.description
      }
      await window.api.quickCommands.save(input)
      setEditor(null)
      onReload()
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setSaving(false)
    }
  }

  const remove = async (cmd: QuickCommand) => {
    if (!window.confirm(`删除快捷命令「${cmd.label}」？`)) return
    try {
      await window.api.quickCommands.remove(cmd.id)
      onReload()
    } catch (err) {
      setError(cleanError(err))
    }
  }

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key !== 'Escape') return
    e.stopPropagation()
    if (editor) setEditor(null)
    else onClose()
  }

  return (
    <aside className="qc-panel" onKeyDown={onKeyDown}>
      <div className="qc-head">
        <span className="qc-title">快捷命令</span>
        <span className="qc-count">{commands.length}</span>
        <button className="icon-btn" title="关闭（Ctrl+Shift+K）" onClick={onClose}>
          <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round">
            <path d="M6 6l12 12M18 6L6 18" />
          </svg>
        </button>
      </div>

      {!editor && (
        <div className="qc-search">
          <input
            ref={searchRef}
            value={query}
            placeholder="搜索命令…"
            onChange={(e) => setQuery(e.target.value)}
          />
        </div>
      )}

      {error && <div className="qc-error">{error}</div>}

      {editor ? (
        <div className="qc-form">
          <div className="field">
            <label className="field-label">名称</label>
            <input
              value={editor.label}
              placeholder="例如：查看 nginx 错误日志"
              onChange={(e) => setEditor({ ...editor, label: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label">命令</label>
            <textarea
              className="qc-textarea"
              value={editor.command}
              rows={4}
              spellCheck={false}
              placeholder="tail -n 100 /var/log/nginx/error.log"
              onChange={(e) => setEditor({ ...editor, command: e.target.value })}
            />
          </div>
          <div className="field">
            <label className="field-label">分组</label>
            <input
              value={editor.group}
              placeholder="我的命令"
              onChange={(e) => setEditor({ ...editor, group: e.target.value })}
            />
          </div>
          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={editor.autoRun}
              onChange={(e) => setEditor({ ...editor, autoRun: e.target.checked })}
            />
            <span>
              点击后自动回车执行
              <br />
              <span className="hint">命令需要补参数时取消勾选，只填入命令行不执行</span>
            </span>
          </label>
          <div className="qc-form-foot">
            <button className="btn btn-primary" disabled={saving} onClick={() => void commit()}>
              {saving ? '保存中…' : '保存'}
            </button>
            <button className="btn btn-ghost" onClick={() => setEditor(null)}>
              取消
            </button>
          </div>
        </div>
      ) : (
        <>
          {!canSend && <div className="qc-tip">先连接一台服务器，命令才有地方执行</div>}

          <div className="qc-list">
            {filtered.length === 0 && <div className="qc-empty">没有匹配的命令</div>}

            {groups.map(([group, list]) => (
              <div key={group}>
                <div className="qc-group">{group}</div>
                {list.map((cmd) => (
                  <div
                    key={cmd.id}
                    className={`qc-item ${cmd.danger ? 'danger' : ''} ${
                      canSend ? '' : 'disabled'
                    }`}
                    title={`${cmd.command}\n${cmd.description ? cmd.description + '\n' : ''}\n点击执行${cmd.autoRun ? '' : '（仅填入）'} · Alt+点击只填入`}
                    onClick={(e) => {
                      if (!canSend) return
                      onSend(cmd, e.altKey || e.metaKey || !cmd.autoRun)
                    }}
                  >
                    <div className="qc-item-main">
                      <div className="qc-item-label">
                        <span className="qc-item-text">{cmd.label}</span>
                        {cmd.danger && <span className="qc-tag danger">慎用</span>}
                        {cmd.builtin === false && <span className="qc-tag">自定义</span>}
                      </div>
                      <div className="qc-item-cmd">{cmd.command.trim() || '—'}</div>
                    </div>
                    {cmd.builtin === false && (
                      <div className="qc-actions" onClick={(e) => e.stopPropagation()}>
                        <button title="编辑" onClick={() => startEdit(cmd)}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M4 20h4L19 9a2.5 2.5 0 0 0-3.5-3.5L4 16v4Z" />
                          </svg>
                        </button>
                        <button title="删除" onClick={() => void remove(cmd)}>
                          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round">
                            <path d="M5 7h14M9 7V5h6v2M7 7l1 13h8l1-13" />
                          </svg>
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            ))}
          </div>

          <div className="qc-foot">
            <button className="btn btn-ghost btn-full" onClick={startNew}>
              ＋ 新建命令
            </button>
          </div>
        </>
      )}
    </aside>
  )
}
