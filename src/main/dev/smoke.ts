import { app, type BrowserWindow } from 'electron'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

/**
 * 开发期冒烟截图：设置 SMOKE_CAPTURE=<目录> 时会自动走一遍界面并截图，然后退出。
 * 用来在无人值守的情况下确认界面真的渲染出来了，而不是「进程没崩就算过」。
 */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

async function shot(win: BrowserWindow, file: string): Promise<void> {
  const image = await win.webContents.capturePage()
  await writeFile(file, image.toPNG())
  console.log('[smoke] captured', file)
}

const js = (win: BrowserWindow, code: string) => win.webContents.executeJavaScript(code)

async function typeText(win: BrowserWindow, text: string): Promise<void> {
  for (const ch of text) {
    win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
    await delay(40)
  }
}

async function pressEnter(win: BrowserWindow): Promise<void> {
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })
  await delay(60)
}

/** 把渲染进程的 console 转发到终端，否则页面里的报错完全看不到 */
export function forwardRendererConsole(win: BrowserWindow): void {
  if (!process.env.SMOKE_CAPTURE && !process.env.DEBUG_RENDERER) return
  win.webContents.on('console-message', (...args: unknown[]) => {
    // Electron 37+ 改为 (event, details)，旧版是 (event, level, message, line, sourceId)
    const second = args[1] as { message?: string; level?: string } | number | undefined
    if (second && typeof second === 'object' && second.message) {
      console.log(`[renderer:${second.level ?? 'log'}] ${second.message}`)
    } else {
      console.log(`[renderer] ${String(args[2] ?? '')}`)
    }
  })
}

export function maybeRunSmokeCapture(
  win: BrowserWindow,
  cleanup?: () => Promise<void>
): void {
  const dir = process.env.SMOKE_CAPTURE
  if (!dir) return

  win.webContents.once('did-finish-load', async () => {
    try {
      await mkdir(dir, { recursive: true })
      await delay(1600)
      await shot(win, join(dir, '01-empty.png'))

      await js(win, `document.querySelector('.sidebar-foot button')?.click()`)
      await delay(700)
      await shot(win, join(dir, '02-dialog.png'))

      await js(win, `document.querySelectorAll('.modal-foot .btn-ghost')[1]?.click()`)
      await delay(400)

      // 连上预置的本地模拟服务
      await js(win, `document.querySelector('.conn-item')?.click()`)
      await delay(2600)
      await js(
        win,
        `document.querySelector('.pane.active .term-host')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`
      )
      await delay(300)
      await shot(win, join(dir, '03-connected.png'))

      await typeText(win, 'help')
      await pressEnter(win)
      await delay(700)
      await typeText(win, 'size')
      await pressEnter(win)
      await delay(700)
      await shot(win, join(dir, '04-commands.png'))

      // 快捷命令面板：打开 → 搜索过滤 → 点击执行
      await js(win, `document.querySelector('.qc-toggle')?.click()`)
      await delay(700)
      await shot(win, join(dir, '05-quick-panel.png'))

      // React 受控输入要用原生 setter 触发，直接改 value 不会通知 onChange
      await js(
        win,
        `(() => {
          const input = document.querySelector('.qc-search input')
          if (!input) return false
          const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
          setter.call(input, '尺寸')
          input.dispatchEvent(new Event('input', { bubbles: true }))
          return true
        })()`
      )
      await delay(500)
      await shot(win, join(dir, '06-quick-filter.png'))

      const clicked = await js(
        win,
        `(() => {
          const el = [...document.querySelectorAll('.qc-item')].find((i) =>
            i.textContent.includes('查看终端尺寸')
          )
          if (!el) return false
          el.click()
          return true
        })()`
      )
      console.log('[smoke] quick command clicked:', clicked)
      await delay(900)
      await shot(win, join(dir, '07-quick-run.png'))
    } catch (err) {
      console.error('[smoke] 截图失败', err)
    } finally {
      try {
        await cleanup?.()
      } catch {
        /* 清理失败不影响截图结果 */
      }
      app.exit(0)
    }
  })
}
