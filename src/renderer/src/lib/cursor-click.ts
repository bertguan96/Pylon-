import type { IBuffer, IBufferLine, Terminal } from '@xterm/xterm'

/**
 * 点击定位光标（click-to-move-cursor）。
 *
 * 终端里的光标由**远端**决定位置，本地没法直接摆 —— 所以这里把「点击的列」换算成
 * 「按几次方向键」，作为普通按键发给会话。SSH 侧交给 readline（bash / zsh / PowerShell
 * 的 PSReadLine 都吃左右键），本机 PowerShell 侧交给 LocalSession 自己的行编辑器，两边都能处理。
 *
 * 只在「行内编辑」场景生效，几种情况一律放行给 xterm 原生行为：
 * - 全屏程序（alternate buffer，vim / htop）光标位置由程序控制，瞎发方向键会改坏内容
 * - 程序自己开了鼠标上报（mouseTrackingMode ≠ none），点击应该是「点给程序」，xterm 会发鼠标事件
 * - 双击 / 三击（选词 / 选行）、带修饰键的点击（Shift 是扩展选区）
 * - 点之前已有选区：这一下是用来清除选区的
 */

/**
 * 数一行里「方向键能落到的位置」有几个，并给出指定显示列落在第几个。
 *
 * 不能用字符串下标：下标和显示列在中文 / emoji 上对不上，而 buffer 的 cell 天然按显示列排列，
 * 宽度 0 的那格是宽字符的右半边 —— 方向键停不到那里，跳过。
 *
 * @param targetCol 要查的显示列；传 -1 表示只数个数
 * @param minEnd    至少数到第几个单元（光标行要传光标列，否则「尾随空格之后」的光标会被算到外面）
 * @returns [该列左侧的单元数, 可落点总数]
 */
function countUnits(line: IBufferLine, cols: number, targetCol: number, minEnd = 0): [number, number] {
  // 行尾可能残留 resize 之前的旧数据，卡在 cols 以内，别把看不见的旧字符算进来
  const max = Math.min(line.length, cols)
  const unitCols: number[] = []
  let lastContent = 0
  for (let c = 0; c < max; c++) {
    const cell = line.getCell(c)
    if (!cell) break
    // 0 表示这是上一个宽字符的右半格，方向键停不到这个位置
    if (cell.getWidth() === 0) continue
    const chars = cell.getChars()
    if (chars) {
      const blank = chars.trim() === ''
      // 行尾之后的空白是缓冲区的填充，不是内容 —— 不裁掉的话，点右边空白会一路右移
      if (!blank) lastContent = unitCols.length + 1
    }
    unitCols.push(c)
  }
  const end = Math.max(lastContent, Math.min(minEnd, unitCols.length))

  let index = 0
  // 落在宽字符的右半格时，索引停在该字符之后 —— 和「点右边就把光标放到后面」的直觉一致
  while (index < end && unitCols[index] < targetCol) index++
  return [index, end]
}

/** 长命令自动换行时，一个逻辑行会摊在多个 buffer 行上；找出这组行的首尾 */
function wrapRange(buffer: IBuffer, row: number): [number, number] {
  let start = row
  while (start > 0 && buffer.getLine(start)?.isWrapped) start--
  let end = row
  const last = buffer.length - 1
  while (end < last && buffer.getLine(end + 1)?.isWrapped) end++
  return [start, end]
}

/**
 * 把「第 row 行第 col 列」折算成「整个视觉行里的第几个单元」（从视觉行首开始数）。
 * @param minEnd 传 col 表示「这一行的光标就在 col 处」，别把光标所在的位置裁掉
 */
function unitIndex(
  buffer: IBuffer,
  range: [number, number],
  row: number,
  col: number,
  cols: number,
  minEnd = 0
): number {
  let base = 0
  for (let r = range[0]; r < row; r++) {
    const line = buffer.getLine(r)
    if (line) base += countUnits(line, cols, -1)[1]
  }
  const line = buffer.getLine(row)
  if (!line) return base
  return base + countUnits(line, cols, col, minEnd)[0]
}

/**
 * 算出「把光标挪到 (viewRow, viewCol) 要发哪串按键」。
 *
 * 纯几何计算，不碰 DOM、不碰事件，方便脱离界面验证。
 *
 * @param buffer  当前的活动缓冲区
 * @param viewRow 屏幕内的行号（0 = 屏幕最上面一行）
 * @param viewCol 屏幕内的列号
 * @returns 要发给会话的按键序列；返回 null 表示「不该动」（点到了历史输出、或本来就在那儿）
 */
export function planCursorMove(
  buffer: IBuffer,
  cols: number,
  rows: number,
  viewRow: number,
  viewCol: number,
  appCursorKeys: boolean
): string | null {
  if (viewRow < 0 || viewRow >= rows) return null
  const col = Math.max(0, Math.min(cols - 1, viewCol))

  const clickRow = buffer.baseY + viewRow
  const cursorRow = buffer.baseY + buffer.cursorY
  if (clickRow < 0 || cursorRow < 0) return null

  // 不在同一个视觉行：shell 是行式输入，没有按键序列能把光标移到历史输出里去
  const clickRange = wrapRange(buffer, clickRow)
  const cursorRange = wrapRange(buffer, cursorRow)
  if (clickRange[0] !== cursorRange[0]) return null

  const cursorIdx = unitIndex(buffer, cursorRange, cursorRow, buffer.cursorX, cols, buffer.cursorX)
  const clickIdx = unitIndex(buffer, clickRange, clickRow, col, cols)
  const delta = clickIdx - cursorIdx
  if (delta === 0) return null

  // 远端开了 DECCKM（应用光标键模式）时，方向键要发 SS3 形式，否则会触发别的功能
  const left = appCursorKeys ? '\x1bOD' : '\x1b[D'
  const right = appCursorKeys ? '\x1bOC' : '\x1b[C'
  return (delta > 0 ? right : left).repeat(Math.abs(delta))
}

/**
 * 给终端挂上「点击定位光标」。
 * @param send 把要发送的按键序列交给会话（和键盘输入走同一条路）
 * @returns 卸载函数
 */
export function attachClickToMove(term: Terminal, send: (data: string) => void): () => void {
  const host = term.element
  if (!host) return () => undefined

  const onMouseDown = (e: MouseEvent): void => {
    if (e.button !== 0) return
    // Shift 是 xterm 的「扩展选区」，Alt 是列选，带修饰键就别抢
    if (e.shiftKey || e.altKey || e.ctrlKey || e.metaKey) return
    // 第二次点击起是选词 / 选行，交给原生逻辑
    if (e.detail > 1) return
    if (term.hasSelection()) return
    if (term.buffer.active.type !== 'normal') return
    if (term.modes.mouseTrackingMode !== 'none') return

    const screen = host.querySelector('.xterm-screen') as HTMLElement | null
    if (!screen) return
    const rect = screen.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return

    const cellW = rect.width / term.cols
    const cellH = rect.height / term.rows
    if (!Number.isFinite(cellW) || !Number.isFinite(cellH) || cellW <= 0 || cellH <= 0) return

    const viewRow = Math.floor((e.clientY - rect.top) / cellH)
    const viewCol = Math.floor((e.clientX - rect.left) / cellW)

    const seq = planCursorMove(
      term.buffer.active,
      term.cols,
      term.rows,
      viewRow,
      viewCol,
      term.modes.applicationCursorKeysMode
    )
    if (!seq) return
    send(seq)
    term.focus()
  }

  // 捕获阶段：要在 xterm 自己处理 mousedown（清除选区）之前读到 hasSelection 的真实状态
  host.addEventListener('mousedown', onMouseDown, true)
  return () => host.removeEventListener('mousedown', onMouseDown, true)
}
