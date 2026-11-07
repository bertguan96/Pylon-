/**
 * 浏览器键盘事件 → X11 keysym。
 *
 * VNC 的 KeyEvent 只认 keysym，不认「按了哪个物理键」，所以这里要做一层翻译。
 * 顺手把 e.code 里的特殊键（方向键、功能键、修饰键）映射成固定的 keysym 值，
 * 可打印字符直接用码点 —— 这正好是 X11 的约定：Latin-1 范围内 keysym 就等于码点。
 */

const NAMED: Record<string, number> = {
  Backspace: 0xff08,
  Tab: 0xff09,
  Enter: 0xff0d,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  // 修饰键单独发，远端才知道 Shift/Ctrl 是按下的状态
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  // Windows 的 Win 键 / Mac 的 Command 键在 X11 里都是 Meta，正好对上 macOS 的 Command
  Meta: 0xffe7,
  CapsLock: 0xffe5,
  NumLock: 0xff7f,
  ScrollLock: 0xff14,
  Pause: 0xff13,
  PrintScreen: 0xff61,
  ContextMenu: 0xff67
}

for (let i = 1; i <= 12; i++) NAMED[`F${i}`] = 0xffbe + (i - 1)

/** 返回 null 表示这个键不往远端发（输入法组字中间态、未知键等） */
export function keysymFor(e: KeyboardEvent): number | null {
  const named = NAMED[e.key]
  if (named !== undefined) return named

  // 可打印字符：长度 1 才是单字符，'Shift' 这种已经在上面处理掉了
  if (e.key.length === 1) {
    const cp = e.key.codePointAt(0)
    if (cp === undefined) return null
    if (cp < 0x20) return null
    // Latin-1 范围内 keysym == 码点
    if (cp < 0x100) return cp
    // 其余走 Unicode keysym 约定：0x01000000 + 码点
    return 0x01000000 + cp
  }

  // 输入法组字过程中的事件，发出去会打断远端输入
  if (e.key === 'Process' || e.key === 'Unidentified' || e.key === 'Dead') return null
  return null
}

/** 只用于 UI 提示：哪些组合键被本应用截胡了，不会传给远端 */
export const RESERVED_HINT = 'Ctrl+Shift+V 粘贴 · 鼠标右键可用 · Win 键 = Command'
