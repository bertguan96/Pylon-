import { useCallback, useEffect, useRef, useState } from 'react'
import { RESERVED_HINT, keysymFor } from '../lib/keymap'
import { registerRemote } from '../lib/remote-registry'

interface Props {
  sessionId: string | null
  active: boolean
}

/** RFB 的鼠标按键掩码：bit0 左、bit1 中、bit2 右、bit3 滚轮上、bit4 滚轮下 */
const MASK = { left: 1, middle: 2, right: 4, wheelUp: 8, wheelDown: 16 }

function buttonMask(button: number): number {
  if (button === 0) return MASK.left
  if (button === 1) return MASK.middle
  if (button === 2) return MASK.right
  return 0
}

/**
 * 远程桌面画布。
 *
 * 帧在主进程解码成 RGBA，这里只做一件事：把矩形贴到 canvas 上。
 * 不缩放 canvas 的位图尺寸，等比缩放交给 CSS —— 这样坐标换算只有一处
 * （getBoundingClientRect 与远端分辨率的比例），不会因为 DPR 出偏差。
 */
export default function RemoteDesktopPane({ sessionId, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const ctxRef = useRef<CanvasRenderingContext2D | null>(null)
  const ctxSize = useRef({ width: 0, height: 0 })
  const maskRef = useRef(0)
  const pendingRef = useRef<{ x: number; y: number } | null>(null)
  const rafRef = useRef(0)
  const sidRef = useRef<string | null>(sessionId)

  const [info, setInfo] = useState<{ width: number; height: number; name: string } | null>(null)
  const [note, setNote] = useState('')

  useEffect(() => {
    sidRef.current = sessionId
  }, [sessionId])

  // ---- 帧接收
  useEffect(() => {
    if (!sessionId) return

    const off = registerRemote(sessionId, {
      init: (width, height, name) => {
        const canvas = canvasRef.current
        if (!canvas) return
        canvas.width = width
        canvas.height = height
        ctxSize.current = { width, height }
        const ctx = canvas.getContext('2d', { alpha: false })
        ctxRef.current = ctx
        if (ctx) {
          // 第一帧到达前先铺个底色，避免闪白
          ctx.fillStyle = '#141414'
          ctx.fillRect(0, 0, width, height)
        }
        setInfo({ width, height, name })
      },
      rects: (rects) => {
        const ctx = ctxRef.current
        if (!ctx) return
        const { width, height } = ctxSize.current
        for (const rect of rects) {
          if (rect.w <= 0 || rect.h <= 0) continue
          if (rect.x + rect.w > width || rect.y + rect.h > height) continue
          // 复制一份到独立的 ArrayBuffer：ImageData 的构造函数只接受非共享缓冲，
          // 直接复用 IPC 传过来的视图在类型上过不去，顺手也避免了视图生命周期问题
          const pixels = new Uint8ClampedArray(rect.w * rect.h * 4)
          pixels.set(rect.data)
          ctx.putImageData(new ImageData(pixels, rect.w, rect.h), rect.x, rect.y)
        }
      },
      clipboard: (text) => {
        // 写系统剪贴板由主进程做，这里只提示一下
        setNote(`已同步远端剪贴板：${text.length > 20 ? `${text.slice(0, 20)}…` : text}`)
      }
    })

    // 注册完成就要一整帧：建连时的首帧多半在面板挂载前就到了，已经被丢掉
    window.api.vnc.refresh(sessionId)

    return off
  }, [sessionId])

  useEffect(() => {
    if (!note) return
    const timer = setTimeout(() => setNote(''), 2200)
    return () => clearTimeout(timer)
  }, [note])

  // ---- 标签切换时暂停拉帧
  useEffect(() => {
    if (!sessionId) return
    window.api.vnc.setActive(sessionId, active)
  }, [sessionId, active])

  /** 屏幕坐标 → 远端像素坐标 */
  const toRemote = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current
    const size = ctxSize.current
    if (!canvas || size.width === 0) return null
    const rect = canvas.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return null
    const x = Math.floor(((clientX - rect.left) / rect.width) * size.width)
    const y = Math.floor(((clientY - rect.top) / rect.height) * size.height)
    return {
      x: Math.max(0, Math.min(size.width - 1, x)),
      y: Math.max(0, Math.min(size.height - 1, y))
    }
  }, [])

  const send = useCallback((x: number, y: number) => {
    const sid = sidRef.current
    if (sid) window.api.vnc.pointer(sid, x, y, maskRef.current)
  }, [])

  const handleMove = (e: React.PointerEvent<HTMLDivElement>) => {
    const point = toRemote(e.clientX, e.clientY)
    if (!point) return
    pendingRef.current = point
    // 指针事件频率远高于屏幕刷新，合并到下一帧再发，避免把小包打成洪水
    if (rafRef.current) return
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = 0
      const latest = pendingRef.current
      if (latest) send(latest.x, latest.y)
    })
  }

  const handleDown = (e: React.MouseEvent<HTMLDivElement>) => {
    hostRef.current?.focus()
    maskRef.current |= buttonMask(e.button)
    const point = toRemote(e.clientX, e.clientY)
    if (point) {
      send(point.x, point.y)
      pendingRef.current = point
    }
  }

  // 松手可能发生在画布外面，挂在 window 上才不会漏掉，否则远端会「一直按着」
  useEffect(() => {
    const onUp = (e: MouseEvent) => {
      const bit = buttonMask(e.button)
      if (!bit) return
      maskRef.current &= ~bit
      const point = pendingRef.current
      if (point) send(point.x, point.y)
    }
    window.addEventListener('mouseup', onUp)
    return () => window.removeEventListener('mouseup', onUp)
  }, [send])

  // 滚轮必须用原生监听：React 的 onWheel 是被动监听，preventDefault 不生效
  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const sid = sidRef.current
      const point = toRemote(e.clientX, e.clientY)
      if (!sid || !point) return
      const button = e.deltaY < 0 ? MASK.wheelUp : MASK.wheelDown
      const base = maskRef.current
      window.api.vnc.pointer(sid, point.x, point.y, base | button)
      window.api.vnc.pointer(sid, point.x, point.y, base)
    }
    host.addEventListener('wheel', onWheel, { passive: false })
    return () => host.removeEventListener('wheel', onWheel)
  }, [toRemote])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const sid = sidRef.current
    if (!sid) return
    // 本应用自己的粘贴快捷键：把本地剪贴板推给远端，而不是发 Ctrl+Shift+V
    if (e.ctrlKey && e.shiftKey && (e.key === 'v' || e.key === 'V')) {
      e.preventDefault()
      window.api.vnc.paste(sid)
      return
    }
    const keysym = keysymFor(e.nativeEvent)
    if (keysym === null) return
    e.preventDefault()
    e.stopPropagation()
    window.api.vnc.key(sid, keysym, true)
  }

  const handleKeyUp = (e: React.KeyboardEvent<HTMLDivElement>) => {
    const sid = sidRef.current
    if (!sid) return
    const keysym = keysymFor(e.nativeEvent)
    if (keysym === null) return
    e.preventDefault()
    e.stopPropagation()
    window.api.vnc.key(sid, keysym, false)
  }

  return (
    <div
      ref={hostRef}
      className="rd-host"
      tabIndex={0}
      onPointerMove={handleMove}
      onMouseDown={handleDown}
      onKeyDown={handleKeyDown}
      onKeyUp={handleKeyUp}
      onContextMenu={(e) => e.preventDefault()}
    >
      <canvas ref={canvasRef} className="rd-canvas" />

      {!info && <div className="rd-empty">正在连接…</div>}

      {info && (
        <div className="rd-foot">
          {info.name || '远程桌面'} · {info.width}×{info.height} · {RESERVED_HINT}
        </div>
      )}

      {note && <div className="rd-toast">{note}</div>}
    </div>
  )
}
