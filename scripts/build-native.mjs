/**
 * 编译原生 VNC 引擎（Rust），并把产物放到 native/pylon-vnc/bin/。
 *
 * 目标三元组是 x86_64-pc-windows-gnu：用 rustup 自带的 MinGW 链接器，
 * **不需要装 Visual Studio / MSVC**，所以任何一台干净的 Windows 机器都能打出这个 exe。
 * 依赖只有一个 flate2，而且显式关掉了 C 后端（用纯 Rust 的 miniz_oxide），
 * 因此整条链路没有 C 编译器参与。
 */

import { spawnSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const project = join(root, 'native', 'pylon-vnc')
const triple = 'x86_64-pc-windows-gnu'

function findCargo() {
  if (process.env.CARGO) return process.env.CARGO
  const exe = process.platform === 'win32' ? 'cargo.exe' : 'cargo'
  const local = join(homedir(), '.cargo', 'bin', exe)
  if (existsSync(local)) return local
  return 'cargo'
}

const cargo = findCargo()
const existing = join(project, 'bin', 'pylon-vnc.exe')

if (!existsSync(cargo)) {
  // 打包机上没装 Rust 时不该卡住整个发布流程：有现成产物就直接用
  if (existsSync(existing)) {
    console.warn(`[native] 没找到 cargo，直接使用现有产物 ${existing}`)
    process.exit(0)
  }
  console.error('[native] 没找到 cargo，也没有现成的 pylon-vnc.exe。安装：https://rsproxy.cn')
  process.exit(1)
}

console.log(`[native] 用 ${cargo} 编译 ${triple} …`)

const build = spawnSync(cargo, ['build', '--release', '--target', triple], {
  cwd: project,
  stdio: 'inherit',
  shell: false
})

if (build.status !== 0) {
  console.error('[native] 编译失败')
  process.exit(build.status ?? 1)
}

const built = join(project, 'target', triple, 'release', 'pylon-vnc.exe')
if (!existsSync(built)) {
  console.error(`[native] 没找到产物：${built}`)
  process.exit(1)
}

const outDir = join(project, 'bin')
mkdirSync(outDir, { recursive: true })
const out = join(outDir, 'pylon-vnc.exe')
copyFileSync(built, out)

const size = (statSync(out).size / 1024).toFixed(0)
console.log(`[native] 完成：${out}（${size} KB，静态链接，无需运行时依赖）`)
