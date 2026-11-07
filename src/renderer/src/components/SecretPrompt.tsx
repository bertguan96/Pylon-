import { useState } from 'react'
import type { ConnectionConfig } from '../../../shared/types'

interface Props {
  connection: ConnectionConfig
  onSubmit: (secret: string) => void
  onClose: () => void
}

/** 未保存密码的连接，在建立会话前向用户索取凭据；只在内存中传递，不落盘 */
export default function SecretPrompt({ connection, onSubmit, onClose }: Props) {
  const [secret, setSecret] = useState('')

  const submit = () => {
    if (!secret) return
    onSubmit(secret)
  }

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 380 }}>
        <div className="modal-head">连接到 {connection.name}</div>
        <div className="modal-body">
          <div className="hint">
            {connection.kind === 'vnc'
              ? `${connection.host}:${connection.port} · 远程桌面`
              : `${connection.username}@${connection.host}:${connection.port}`}
          </div>
          <div className="field">
            <label className="field-label">
              {connection.kind === 'vnc'
                ? 'VNC 密码'
                : connection.authType === 'privateKey'
                  ? '私钥口令'
                  : '密码'}
            </label>
            <input
              type="password"
              value={secret}
              autoFocus
              onChange={(e) => setSecret(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && submit()}
            />
          </div>
          <div className="hint">该连接没有保存凭据，本次输入仅在当前会话使用。</div>
        </div>
        <div className="modal-foot">
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose}>
            取消
          </button>
          <button className="btn btn-primary" onClick={submit} disabled={!secret}>
            连接
          </button>
        </div>
      </div>
    </div>
  )
}
