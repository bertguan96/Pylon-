import { useState } from 'react'
import type {
  AuthType,
  ConnectionConfig,
  ConnectionInput,
  ConnectionKind,
  DiagnoseResult,
  VncProbeResult
} from '../../../shared/types'
import { cleanError } from '../lib/ipc-error'

interface Props {
  initial: ConnectionConfig | null
  onClose: () => void
  onSaved: (conn: ConnectionConfig) => void
}

interface FormState {
  kind: ConnectionKind
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

const DEFAULT_PORT: Record<ConnectionKind, number> = { ssh: 22, vnc: 5900 }

const SECURITY_TEXT: Record<string, string> = {
  'vnc-password': 'VNC 密码',
  none: '无认证',
  ard: 'Apple 远程管理（需改用 VNC 密码）',
  unknown: '未知'
}

export default function ConnectionDialog({ initial, onClose, onSaved }: Props) {
  const [form, setForm] = useState<FormState>(() => ({
    kind: initial?.kind ?? 'ssh',
    name: initial?.name ?? '',
    host: initial?.host ?? '',
    port: String(initial?.port ?? DEFAULT_PORT[initial?.kind ?? 'ssh']),
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
  const [vncProbe, setVncProbe] = useState<VncProbeResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const patch = (next: Partial<FormState>) => setForm((f) => ({ ...f, ...next }))

  /** 切类型时把端口跟着换掉，但只在用户没改过默认值的时候动 */
  const switchKind = (kind: ConnectionKind) => {
    const currentDefault = String(DEFAULT_PORT[form.kind])
    patch({
      kind,
      port: form.port === currentDefault ? String(DEFAULT_PORT[kind]) : form.port
    })
    setDiag(null)
    setVncProbe(null)
    setError(null)
  }

  /**
   * 组装提交数据。
   * secret 的三种语义必须区分清楚：
   *   有值        -> 用新密码
   *   空串        -> 明确清空（不保存密码）
   *   undefined   -> 沿用已保存的
   */
  const buildInput = (): ConnectionInput => ({
    id: initial?.id,
    kind: form.kind,
    name: form.name,
    host: form.host,
    port: Number(form.port) || DEFAULT_PORT[form.kind],
    username: form.kind === 'ssh' ? form.username : '',
    authType: form.kind === 'ssh' ? form.authType : 'password',
    privateKeyPath:
      form.kind === 'ssh' && form.authType === 'privateKey'
        ? form.privateKeyPath || undefined
        : undefined,
    group: form.group || undefined,
    legacyAlgorithms: form.kind === 'ssh' ? form.legacy : false,
    secret: form.secret === '' ? (initial?.hasSecret ? undefined : '') : form.secret,
    rememberSecret: form.remember
  })

  const handlePick = async () => {
    const path = await window.api.connections.pickPrivateKey()
    if (path) patch({ privateKeyPath: path })
  }

  const handleDiagnose = async () => {
    setError(null)
    setDiag(null)
    setVncProbe(null)
    setBusy(true)
    try {
      if (form.kind === 'vnc') {
        const result = await window.api.vnc.probe({
          host: form.host,
          port: Number(form.port) || 5900,
          // 测试连接要用这次输入的密码；没填就试一下无密码，能连上说明对端没设密码
          password: form.secret || undefined
        })
        setVncProbe(result)
      } else {
        setDiag(await window.api.connections.diagnose(buildInput()))
      }
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

  const isVnc = form.kind === 'vnc'
  const secretLabel = isVnc
    ? 'VNC 密码（协议限制，最多 8 位）'
    : form.authType === 'privateKey'
      ? '私钥口令（可选）'
      : '密码'

  return (
    <div className="overlay" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" onKeyDown={(e) => e.key === 'Enter' && !busy && handleSave()}>
        <div className="modal-head">{initial ? '编辑连接' : '新建连接'}</div>

        <div className="modal-body">
          <div className="kind-switch">
            <button
              type="button"
              className={isVnc ? '' : 'active'}
              onClick={() => switchKind('ssh')}
            >
              SSH 终端
            </button>
            <button
              type="button"
              className={isVnc ? 'active' : ''}
              onClick={() => switchKind('vnc')}
            >
              远程桌面（VNC）
            </button>
          </div>

          <div className="field-row">
            <div className="field">
              <label className="field-label">名称</label>
              <input
                value={form.name}
                placeholder={isVnc ? '如 我的 MacBook' : '如 家里 NAS'}
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
              placeholder="192.168.1.125"
              onChange={(e) => patch({ host: e.target.value })}
            />
          </div>

          {!isVnc && (
            <>
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
            </>
          )}

          {(!isVnc ? form.authType !== 'agent' : true) && (
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

          {(!isVnc ? form.authType !== 'agent' : true) && (
            <label className="checkbox-row">
              <input
                type="checkbox"
                checked={form.remember}
                onChange={(e) => patch({ remember: e.target.checked })}
              />
              <span>记住凭据（经系统密钥加密后存入本机，换用户账户后失效）</span>
            </label>
          )}

          {isVnc ? (
            <div className="hint">
              Mac 上打开「系统设置 → 通用 → 共享 → 屏幕共享」，再到「电脑设置」里勾选
              「VNC 显示程序可使用密码控制屏幕」并设置密码。端口默认 5900。
            </div>
          ) : (
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
          )}

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

          {vncProbe && (
            <div className={`diag-box ${vncProbe.ok ? 'ok' : 'fail'}`}>
              {vncProbe.message}
              {vncProbe.ok && (
                <div className="diag-meta">
                  认证：{SECURITY_TEXT[vncProbe.security ?? 'unknown']}
                  {vncProbe.latencyMs !== undefined ? ` · 握手 ${vncProbe.latencyMs} ms` : ''}
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
