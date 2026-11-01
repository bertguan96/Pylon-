import { useEffect, useRef } from 'react'
import type { ZmodemState } from '../../../shared/types'

interface Props {
  transfers: ZmodemState[]
  onCancel: (sessionId: string) => void
}

/** rz / sz 传输的悬浮进度条 */
export default function TransferStack({ transfers, onCancel }: Props) {
  if (transfers.length === 0) return null

  return (
    <div className="transfer-stack">
      {transfers.map((t) => (
        <TransferCard key={t.sessionId} transfer={t} onCancel={onCancel} />
      ))}
    </div>
  )
}

function TransferCard({ transfer, onCancel }: { transfer: ZmodemState; onCancel: (id: string) => void }) {
  const lastSample = useRef<{ at: number; bytes: number }>({ at: 0, bytes: 0 })
  const speedRef = useRef(0)

  useEffect(() => {
    const now = performance.now()
    const prev = lastSample.current
    if (transfer.status === 'active' && prev.at > 0 && now - prev.at > 60) {
      const delta = transfer.transferred - prev.bytes
      speedRef.current = (delta / (now - prev.at)) * 1000
    }
    lastSample.current = { at: now, bytes: transfer.transferred }
  }, [transfer.transferred, transfer.status])

  const percent =
    transfer.total > 0 ? Math.min(100, (transfer.transferred / transfer.total) * 100) : 0
  const isDownload = transfer.direction === 'download'
  const done = transfer.status === 'done'
  const failed = transfer.status === 'error'

  return (
    <div className={`transfer-card ${transfer.status}`}>
      <div className="transfer-head">
        <span className="transfer-arrow">{isDownload ? '↓' : '↑'}</span>
        <span className="transfer-name" title={transfer.path ?? transfer.name}>
          {transfer.name || (isDownload ? '接收中' : '发送中')}
        </span>
        <span className="transfer-size">
          {done
            ? formatSize(transfer.transferred || transfer.total)
            : failed
              ? '失败'
              : `${formatSize(transfer.transferred)} / ${formatSize(transfer.total)}`}
        </span>
        {transfer.status === 'active' && (
          <button className="transfer-cancel" title="取消（终端里按 Ctrl+C 也可以）" onClick={() => onCancel(transfer.sessionId)}>
            取消
          </button>
        )}
      </div>

      {transfer.status === 'active' && (
        <>
          <div className="transfer-bar">
            <div className="transfer-bar-fill" style={{ width: `${percent}%` }} />
          </div>
          <div className="transfer-meta">
            <span>{percent.toFixed(0)}%</span>
            <span>{formatSpeed(speedRef.current)}</span>
          </div>
        </>
      )}

      {done && <div className="transfer-note">{transfer.path ? `已保存到 ${transfer.path}` : '传输完成'}</div>}
      {failed && <div className="transfer-note error">{transfer.message || '传输失败'}</div>}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B'
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

function formatSpeed(bytesPerSec: number): string {
  if (!Number.isFinite(bytesPerSec) || bytesPerSec <= 0) return '—'
  return `${formatSize(bytesPerSec)}/s`
}
