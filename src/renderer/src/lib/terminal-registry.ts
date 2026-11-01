import type { Terminal } from '@xterm/xterm'
import { recordWrite } from './perf-probe'

/**
 * tabId -> Terminal 实例的注册表。
 *
 * 用 tabId 而不是 sessionId 作为 key：断线重连会换一个新 sessionId，
 * 但终端实例必须复用，否则滚动缓冲和屏幕上已有的输出会全部丢失。
 */

const terminals = new Map<string, Terminal>()

interface PendingChunk {
  sessionId: string
  data: Uint8Array
}

/** 终端还没挂载时先缓存数据，避免建连瞬间的 banner 被丢掉 */
const pending = new Map<string, PendingChunk[]>()

export function registerTerminal(tabId: string, term: Terminal): void {
  terminals.set(tabId, term)

  const buffered = pending.get(tabId)
  if (!buffered) return
  pending.delete(tabId)

  for (const chunk of buffered) {
    term.write(chunk.data, () => {
      recordWrite(chunk.data.byteLength)
      window.api.session.ack(chunk.sessionId, chunk.data.byteLength)
    })
  }
}

export function unregisterTerminal(tabId: string): void {
  terminals.delete(tabId)
  pending.delete(tabId)
}

/**
 * 把远端数据写进终端，写完再 ack。
 * ack 是主进程恢复读取的信号 —— 少了这一步，长时间刷屏后连接会一直停在暂停状态。
 */
export function writeToTerminal(tabId: string, sessionId: string, data: Uint8Array): void {
  // 压测用的旁路开关：跳过 xterm 直接 ack，用来测 IPC 链路的上限
  // （和正常模式对比，差值就是终端解析与渲染的成本）
  if ((window as unknown as { __perfDrop?: boolean }).__perfDrop) {
    recordWrite(data.byteLength)
    window.api.session.ack(sessionId, data.byteLength)
    return
  }

  const term = terminals.get(tabId)
  if (!term) {
    const queue = pending.get(tabId) ?? []
    queue.push({ sessionId, data })
    pending.set(tabId, queue)
    return
  }
  term.write(data, () => {
    recordWrite(data.byteLength)
    window.api.session.ack(sessionId, data.byteLength)
  })
}

/** 重连成功后把旧的 sessionId 换成新的，后续 ack/write 才能对上 */
export function remapSession(tabId: string, sessionId: string): void {
  const queue = pending.get(tabId)
  if (!queue) return
  for (const chunk of queue) chunk.sessionId = sessionId
}

/**
 * 读取终端当前的列数/行数。
 * 建连时先用它传初始尺寸，避免远端 PTY 以 80x24 起步导致 vim / htop 错位。
 */
export function getTerminalSize(tabId: string): { cols: number; rows: number } | null {
  const term = terminals.get(tabId)
  if (!term || term.cols <= 0 || term.rows <= 0) return null
  return { cols: term.cols, rows: term.rows }
}

/**
 * 把一段命令送进终端。
 *
 * submit = true：直接写会话通道并追加 \r，等价于"敲完就回车"。
 *   这里刻意不走 term.paste() —— 开启 bracketed paste 后，
 *   粘贴内容里的换行会被 shell 当成普通字符而不是"执行"，命令不会真的跑起来。
 *
 * submit = false：走 term.paste()，让 xterm 处理特殊字符转义，
 *   只把命令填在提示符后面，等用户补参数、确认后自己回车。
 */
export function sendText(
  tabId: string,
  sessionId: string,
  text: string,
  submit: boolean
): boolean {
  const term = terminals.get(tabId)
  if (!term) return false

  if (submit) {
    window.api.session.write(sessionId, `${text}\r`)
  } else {
    term.paste(text)
  }
  term.focus()
  return true
}
