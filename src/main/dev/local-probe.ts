import { app } from 'electron'
import type { MainEvent } from '../../shared/types'
import type { SessionManager } from '../ssh/session-manager'

/**
 * 本机终端的无界面自测（LOCAL_PROBE=1 时运行）。
 *
 * 管道模式下没有 PTY，行编辑全靠 LocalSession 自己做，这部分最容易出错又最难在
 * 手点 UI 时稳定复现，所以单独跑一遍：输入 → 退格 → 历史 → 回车，
 * 逐项检查 PowerShell 那边到底收到了什么。
 */

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms))

export function maybeRunLocalProbe(
  sessions: SessionManager,
  tap: (fn: ((evt: MainEvent) => void) | null) => void
): void {
  if (!process.env.LOCAL_PROBE) return

  void (async () => {
    let buffer = ''
    tap((evt) => {
      if (evt.type === 'session:data') buffer += Buffer.from(evt.data).toString('utf8')
    })

    const checks: Array<[string, boolean]> = []
    try {
      const info = await sessions.openLocal(80, 24)
      await delay(900)

      // 1) 普通输入 + 中文
      sessions.write(info.sessionId, 'echo 中文 ABC')
      await delay(200)
      sessions.write(info.sessionId, '\r')
      await delay(700)
      checks.push(['执行中文命令', buffer.includes('中文 ABC')])

      // 2) 退格：echo 123 → 退两格 → 实际执行 echo 1
      buffer = ''
      sessions.write(info.sessionId, 'echo 123')
      await delay(150)
      sessions.write(info.sessionId, '\x7f\x7f')
      await delay(150)
      sessions.write(info.sessionId, '\r')
      await delay(700)
      checks.push(['退格改写命令', /echo 1\r?\n/.test(buffer) && !/echo 12\r?\n/.test(buffer)])

      // 3) 历史上翻：应该重新执行上一条 echo 1
      buffer = ''
      sessions.write(info.sessionId, '\x1b[A')
      await delay(200)
      sessions.write(info.sessionId, '\r')
      await delay(700)
      checks.push(['上翻历史命令', /echo 1\r?\n/.test(buffer)])

      // 4) Ctrl+C 取消：不应该执行未提交的内容
      buffer = ''
      sessions.write(info.sessionId, 'echo SHOULD_NOT_RUN')
      await delay(150)
      sessions.write(info.sessionId, '\x03')
      await delay(700)
      checks.push(['Ctrl+C 不执行', !buffer.includes('SHOULD_NOT_RUN\r\nSHOULD_NOT_RUN')])
    } catch (err) {
      checks.push([`会话异常：${(err as Error).message}`, false])
    }

    console.log('\n===== 本机终端自测 =====')
    for (const [name, ok] of checks) console.log(`${ok ? '通过' : '失败'}  ${name}`)
    console.log('========================\n')

    tap(null)
    sessions.closeAll()
    setTimeout(() => app.exit(checks.every(([, ok]) => ok) ? 0 : 1), 300)
  })()
}
