/**
 * 点击定位光标的自测（`npm run test:cursor`）。
 *
 * `planCursorMove` 是纯几何计算，只依赖 xterm 的 buffer，所以不需要开窗口：
 * 用 `@xterm/headless` 造一个真终端，往里写各种内容（ASCII / 中文 / 自动换行 / 滚动），
 * 再断言「点这一列应该发几次左右键」。
 *
 * 渲染层是 TSX，Node 直接跑不了，所以这里借 vite 自带的 oxc 现场转成 ESM 再 import。
 */
import { createRequire } from 'node:module'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { transformWithOxc } from 'vite'

const require = createRequire(import.meta.url)
const { Terminal } = require('@xterm/headless')

const SRC = 'src/renderer/src/lib/cursor-click.ts'
const { code } = await transformWithOxc(readFileSync(SRC, 'utf8'), SRC, { lang: 'ts' })

const dir = mkdtempSync(join(tmpdir(), 'pylon-cursor-'))
const compiled = join(dir, 'cursor-click.mjs')
writeFileSync(compiled, code)
const { planCursorMove } = await import(pathToFileURL(compiled).href)
rmSync(dir, { recursive: true, force: true })

const LEFT = '\x1b[D'
const RIGHT = '\x1b[C'
const LEFT_APP = '\x1bOD'
const RIGHT_APP = '\x1bOC'

let pass = 0
let fail = 0
function check(name, actual, expected) {
  const ok = actual === expected
  if (ok) pass++
  else fail++
  const show = (v) => (v === null ? 'null' : JSON.stringify(v))
  console.log(`[${ok ? '通过' : '失败'}] ${name}${ok ? '' : ` —— 期望 ${show(expected)}，实际 ${show(actual)}`}`)
}

/** 建一个 headless 终端并写入内容，等渲染完再取 buffer */
async function mk(cols, rows, text) {
  const t = new Terminal({ cols, rows, scrollback: 2000, allowProposedApi: true })
  await new Promise((r) => t.write(text, r))
  return t
}

const cur = (t) => ({ x: t.buffer.active.cursorX, y: t.buffer.active.cursorY })

console.log('===== 点击定位光标自测 =====')

// ---------------------------------------------------------------- 行内左右移动
{
  const t = await mk(40, 6, '$ echo hello')
  check('光标停在行尾第 12 列', JSON.stringify(cur(t)), JSON.stringify({ x: 12, y: 0 }))
  check('点第 5 列 → 左移 7 次', planCursorMove(t.buffer.active, 40, 6, 0, 5, false), LEFT.repeat(7))
  check('点第 0 列（提示符前面）→ 一路左移', planCursorMove(t.buffer.active, 40, 6, 0, 0, false), LEFT.repeat(12))
  check('点行尾右侧空白 → 不动', planCursorMove(t.buffer.active, 40, 6, 0, 30, false), null)
  check('点正落在光标上 → 不动', planCursorMove(t.buffer.active, 40, 6, 0, 12, false), null)
  check('点越界列 → 不动', planCursorMove(t.buffer.active, 40, 6, 0, 99, false), null)
}

{
  const t = await mk(40, 6, '$ echo hello')
  await new Promise((r) => t.write('\x1b[5D', r)) // 光标退到第 7 列
  check('光标退到第 7 列', cur(t).x, 7)
  check('点行尾 → 右移 5 次', planCursorMove(t.buffer.active, 40, 6, 0, 12, false), RIGHT.repeat(5))
}

// ---------------------------------------------------------------- 中文宽字符
{
  const t = await mk(40, 6, '$ 中文abc')
  // $=0 空格=1 中=2..3 文=4..5 a=6 b=7 c=8 → 光标落在第 9 列
  check('中文占两列，光标到第 9 列', cur(t).x, 9)
  // 方向键是按字符走的，所以「退几列」和「按几次」不是一回事，这里按字符数算
  check('点「文」起点 → 退 4 次（不是 5 次）', planCursorMove(t.buffer.active, 40, 6, 0, 4, false), LEFT.repeat(4))
  check('点「中」右半格 → 停在该字符之后', planCursorMove(t.buffer.active, 40, 6, 0, 3, false), LEFT.repeat(4))
  check('点「a」→ 退 3 次', planCursorMove(t.buffer.active, 40, 6, 0, 6, false), LEFT.repeat(3))
}

// ---------------------------------------------------------------- 历史输出行
{
  const t = await mk(40, 8, 'line one\r\nline two\r\n$ echo hi')
  check('光标在第 2 行', JSON.stringify(cur(t)), JSON.stringify({ x: 9, y: 2 }))
  check('点第 0 行（历史输出）→ 不动', planCursorMove(t.buffer.active, 40, 8, 0, 3, false), null)
  check('点第 1 行（历史输出）→ 不动', planCursorMove(t.buffer.active, 40, 8, 1, 3, false), null)
  check('点第 2 行（当前输入）→ 正常移动', planCursorMove(t.buffer.active, 40, 8, 2, 2, false), LEFT.repeat(7))
}

// ---------------------------------------------------------------- 长命令自动换行
{
  const t = await mk(10, 8, '$ ' + 'a'.repeat(23)) // 宽度 25 → 占 3 个视觉行
  check('换行后光标在第 2 行第 5 列', JSON.stringify(cur(t)), JSON.stringify({ x: 5, y: 2 }))
  check('点第一个视觉行第 5 列 → 退 20 次', planCursorMove(t.buffer.active, 10, 8, 0, 5, false), LEFT.repeat(20))
  check('点第二个视觉行第 9 列 → 退 6 次', planCursorMove(t.buffer.active, 10, 8, 1, 9, false), LEFT.repeat(6))
  check('点第三个视觉行第 0 列 → 退 5 次', planCursorMove(t.buffer.active, 10, 8, 2, 0, false), LEFT.repeat(5))
}

// ---------------------------------------------------------------- 应用光标键模式（DECCKM）
{
  const t = await mk(40, 6, '$ echo hello')
  check('DECCKM 开启时发 SS3 左键', planCursorMove(t.buffer.active, 40, 6, 0, 5, true), LEFT_APP.repeat(7))
  const t2 = await mk(40, 6, '$ echo hello')
  await new Promise((r) => t2.write('\x1b[5D', r))
  check('DECCKM 开启时发 SS3 右键', planCursorMove(t2.buffer.active, 40, 6, 0, 12, true), RIGHT_APP.repeat(5))
}

// ---------------------------------------------------------------- 屏幕滚动之后
{
  const lines = Array.from({ length: 20 }, (_, i) => `out ${i}`).join('\r\n')
  const t = await mk(40, 6, lines + '\r\n$ echo hi')
  check('确实滚动了', t.buffer.active.baseY > 0, true)
  const last = 5 // 光标就在屏幕最后一行
  check('滚动后：点当前行第 0 列 → 退 9 次', planCursorMove(t.buffer.active, 40, 6, last, 0, false), LEFT.repeat(9))
  check('滚动后：点上一行 → 不动', planCursorMove(t.buffer.active, 40, 6, last - 1, 0, false), null)
}

// ---------------------------------------------------------------- 越界保护
{
  const t = await mk(40, 6, '$ ls')
  check('负行号 → null', planCursorMove(t.buffer.active, 40, 6, -1, 0, false), null)
  check('超出屏幕行号 → null', planCursorMove(t.buffer.active, 40, 6, 6, 0, false), null)
}

console.log(`\n===== ${pass}/${pass + fail} 通过 =====`)
process.exit(fail === 0 ? 0 : 1)
