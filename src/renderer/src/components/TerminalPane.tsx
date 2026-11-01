import { useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { WebglAddon } from '@xterm/addon-webgl'
import { registerTerminal, unregisterTerminal } from '../lib/terminal-registry'
import { markInput } from '../lib/perf-probe'

const THEME = {
  background: '#1c1b19',
  foreground: '#e6e3dc',
  cursor: '#9fe1cb',
  cursorAccent: '#1c1b19',
  selectionBackground: 'rgba(159, 225, 203, 0.25)',
  black: '#1c1b19',
  red: '#e24b4a',
  green: '#97c459',
  yellow: '#ef9f27',
  blue: '#85b7eb',
  magenta: '#afa9ec',
  cyan: '#5dcaa5',
  white: '#e6e3dc',
  brightBlack: '#5f5e5a',
  brightRed: '#f09595',
  brightGreen: '#c0dd97',
  brightYellow: '#fac775',
  brightBlue: '#b5d4f4',
  brightMagenta: '#cecbf6',
  brightCyan: '#9fe1cb',
  brightWhite: '#faf9f5'
}

interface Props {
  tabId: string
  sessionId: string | null
  active: boolean
}

export default function TerminalPane({ tabId, sessionId, active }: Props) {
  const hostRef = useRef<HTMLDivElement>(null)
  const termRef = useRef<Terminal | null>(null)
  const fitRef = useRef<FitAddon | null>(null)
  const sessionIdRef = useRef<string | null>(sessionId)

  useEffect(() => {
    sessionIdRef.current = sessionId
    // sessionId 从 null 变成实际值（或重连换新）时，立刻把真实尺寸同步给远端 PTY
    if (!sessionId) return
    const term = termRef.current
    if (term && term.cols > 0 && term.rows > 0) {
      window.api.session.resize(sessionId, term.cols, term.rows)
    }
  }, [sessionId])

  // 终端实例只在 tabId 变化时重建，重连不会销毁屏幕内容
  useEffect(() => {
    const host = hostRef.current
    if (!host) return

    const term = new Terminal({
      fontFamily: '"Cascadia Mono", "JetBrains Mono", Consolas, "Microsoft YaHei Mono", monospace',
      fontSize: 13,
      lineHeight: 1.35,
      letterSpacing: 0,
      cursorBlink: true,
      cursorStyle: 'bar',
      scrollback: 8000,
      allowProposedApi: true,
      theme: THEME
    })

    const fit = new FitAddon()
    term.loadAddon(fit)
    term.open(host)

    try {
      // 优先 GPU 渲染，长输出滚屏明显更顺；上下文丢失或环境不支持时静默回退
      const webgl = new WebglAddon()
      webgl.onContextLoss(() => webgl.dispose())
      term.loadAddon(webgl)
    } catch {
      /* 回退到默认渲染器，无需提示用户 */
    }

    termRef.current = term
    fitRef.current = fit
    registerTerminal(tabId, term)

    const fitNow = () => {
      // 隐藏的标签页尺寸为 0，此时 fit 会算出非法行列数，必须跳过
      if (host.clientWidth === 0 || host.clientHeight === 0) return
      try {
        fit.fit()
      } catch {
        /* 布局过渡期间可能失败，下一次 ResizeObserver 会再试 */
      }
    }

    requestAnimationFrame(fitNow)

    const dataSub = term.onData((input) => {
      const sid = sessionIdRef.current
      if (!sid) return
      // 打点留给压测算按键往返；只在有会话时记，成本是一次 performance.now()
      markInput()
      window.api.session.write(sid, input)
    })

    const resizeSub = term.onResize(({ cols, rows }) => {
      const sid = sessionIdRef.current
      // 同步给远端 PTY，否则 vim / htop / tmux 会错位
      if (sid) window.api.session.resize(sid, cols, rows)
    })

    const observer = new ResizeObserver(fitNow)
    observer.observe(host)

    return () => {
      observer.disconnect()
      dataSub.dispose()
      resizeSub.dispose()
      unregisterTerminal(tabId)
      term.dispose()
      termRef.current = null
    }
  }, [tabId])

  // 切换到该标签时重新适配尺寸并抢焦点
  useEffect(() => {
    if (!active) return
    const raf = requestAnimationFrame(() => {
      const host = hostRef.current
      if (!host || host.clientWidth === 0) return
      try {
        fitRef.current?.fit()
      } catch {
        /* ignore */
      }
      termRef.current?.focus()
    })
    return () => cancelAnimationFrame(raf)
  }, [active])

  return (
    <div
      className="term-host"
      ref={hostRef}
      onMouseDown={() => termRef.current?.focus()}
    />
  )
}
