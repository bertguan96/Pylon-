import { useState } from 'react'
import type { AuthType, ConnectionConfig, ConnectionInput, DiagnoseResult } from '../../../shared/types'
import { cleanError } from '../lib/ipc-error'

interface Props {
  initial: ConnectionConfig | null
  onClose: () => void
  onSaved: (conn: ConnectionConfig) => void
}

interface FormState {
  name: string
  host: string
  port: string
  username: string
  authType: AuthType
  privateKeyPath: string
  secret: string
  remember: boolean
  legacy: boolean
  group: string
}

export default function ConnectionDialog({ initial, onClose, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(() => ({
    name: initial?.name ?? '',
    host: initial?.host ?? '',
    port: String(initial?.port ?? 22),
    username: initial?.username ?? '',
    authType: initial?.authType ?? 'password',
    privateKeyPath: initial?.privateKeyPath ?? '',
    secret: '',
    remember: true,
    legacy: initial?.legacyAlgorithms ?? false,
    group: initial?.group ?? ''
  }))

  const [busy, setBusy] = useState(false)
  const [diag, setDiag] = useState<DiagnoseResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const patch = (next: Partial<FormState>) => setForm((f) => ({ ...f, ...next }))

  /**
   * 组装提交数据。
   * secret 的三种语义必须区分清楚：
   *   有值        -> 用新密码
   *   空串        -> 明确清空（不保存密码）
   *   undefined   -> 沿用已保存的
   */
  const buildInput = (): ConnectionInput => ({
    id: initial?.id,
    name: form.name,
    host: form.host,
    port: Number(form.port) || 22,
    username: form.username,
    authType: form.authType,
    privateKeyPath: form.authType === 'privateKey' ? form.privateKeyPath || undefined : undefined,
    group: form.group || undefined,
    legacyAlgorithms: form.legacy,
    secret:
      form.authType === 'agent'
        ? undefined
        : form.secret === ''
          ? initial?.hasSecret
            ? undefined
            : ''
          : form.secret,
    rememberSecret: form.remember
  })

  const handlePick = async () => {
    const path = await window.api.connections.pickPrivateKey()
    if (path) patch({ privateKeyPath: path })
  }

  const handleDiagnose = async () => {
    setError(null)
    setDiag(null)
    setBusy(true)
    try {
      const result = await window.api.connections.diagnose(buildInput())
      setDiag(result)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  const handleSave = async () => {
    setError(null)
    setBusy(true)
    try {
      const saved = await window.api.connections.save(buildInput())
      onSaved(saved)
    } catch (err) {
      setError(cleanError(err))
    } finally {
      setBusy(false)
    }
  }

  const secretLabel =
    form.authType === 'privateKey' ? '私钥口令（可选）' : '密码'

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" onKeyDown={(e) => e.key === 'Enter' && !busy && handleSave()}>
        <div className="modal-head">{initial ? '编辑连接' : '新建连接'}</div>

        <div className="modal-body">
          <div className="field-row">
            <div className="field">
              <label className="field-label">名称</label>
              <input
                value={form.name}
                placeholder="如 家里 NAS"
                autoFocus
                onChange={(e) => patch({ name: e.target.value })}
              />
            </div>
            <div className="field shrink">
              <label className="field-label">端口</label>
              <input
                value={form.port}
                inputMode="numeric"
                onChange={(e) => patch({ port: e.target.value.replace(/\D/g, '') })}
              />
            </div>
          </div>

          <div className="field">
            <label className="field-label">主机</label>
            <input
              value={form.host}
              placeholder="192.168.1.199"
              onChange={(e) => patch({ host: e.target.value })}
            />
          </div>

          <div className="field">
            <label className="field-label">用户名</label>
            <input
              value={form.username}
              placeholder="root"
              onChange={(e) => patch({ username: e.target.value })}
            />
          </div>

          <div className="field">
            <label className="field-label">认证方式</label>
            <select
              value={form.authType}
              onChange={(e) => patch({ authType: e.target.value as AuthType })}
            >
              <option value="password">密码</option>
              <option value="privateKey">私钥文件</option>
              <option value="agent">SSH Agent</option>
            </select>
          </div>

          {form.authType === 'privateKey' && (
            <div className="field">
              <label className="field-label">私钥路径</label>
              <div style={{ display: 'flex', gap: 8 }}>
                <input
                  value={form.privateKeyPath}
                  placeholder="C:\Users\Administrator\.ssh\id_ed25519"
                  onChange={(e) => patch({ privateKeyPath: e.target.value })}
                />
                <button className="btn btn-ghost" onClick={handlePick} type="button">
                  选择
                </button>
              </div>
            </div>
          )}

          {form.authType !== 'agent' && (
            <div className="field">
              <label className="field-label">{secretLabel}</label>
              <input
                type="password"
                value={form.secret}
                placeholder={initial?.hasSecret ? '已保存，留空则不修改' : '连接时也可再输入'}
                onChange={(e) => patch({ secret: e.target.value })}
              />
            </div>
          )}

          {form.authType !== 'agent' && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.remember}
                onChange={(e) => patch({ remember: e.target.checked })}
              />
              <span>记住凭据（经系统密钥加密后存入本机，换用户账户后失效）</span>
            </label>
          )}

          <label className="checkbox-row">
            <input
              type="checkbox"
              checked={form.legacy}
              onChange={(e) => patch({ legacy: e.target.checked })}
            />
            <span>
              兼容老算法
              <br />
              <span style={{ color: 'var(--text-3)' }}>
                摄像头、老 NAS 等设备的握手失败时打开，会放开 sha1/CBC 系列算法
              </span>
            </span>
          </label>

          {error && <div className="diag-box fail">{error}</div>}

          {diag && (
            <div className={`diag-box ${diag.ok ? 'ok' : 'fail'}`}>
              {diag.message}
              {diag.latencyMs !== undefined && (
                <div className="diag-meta">握手耗时 {diag.latencyMs} ms</div>
              )}
              {diag.negotiated?.kex && (
                <div className="diag-meta">
                  KEX {diag.negotiated.kex}
                  {diag.negotiated.cipher ? ` · ${diag.negotiated.cipher}` : ''}
                </div>
              )}
            </div>
          )}
        </div>

        <div className="modal-foot">
          <button className="btn btn-ghost" onClick={handleDiagnose} disabled={busy || !form.host}>
            {busy ? '测试中…' : '测试连接'}
          </button>
          <div className="spacer" />
          <button className="btn btn-ghost" onClick={onClose} disabled={busy}>
            取消
          </button>
          <button className="btn btn-primary" onClick={handleSave} disabled={busy || !form.host}>
            保存
          </button>
        </div>
      </div>
    </div>
  )
}
