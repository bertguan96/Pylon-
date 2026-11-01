/**
 * electron-vite 启动包装器。
 *
 * 宿主的终端环境里带着 ELECTRON_RUN_AS_NODE=1，它会强制 Electron 以纯 Node 模式
 * 运行 —— 表现为 main 进程里 require('electron') 拿不到 app，直接崩在 whenReady。
 * 这里删掉该变量再拉起子进程。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

const binName = process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
const bin = join(process.cwd(), 'node_modules', '.bin', binName)

const child = spawn(bin, process.argv.slice(2), {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
})

child.on('error', (err) => {
  console.error('启动 electron-vite 失败:', err.message)
  process.exit(1)
})

child.on('exit', (code) => process.exit(code ?? 0))
