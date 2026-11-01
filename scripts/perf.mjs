#!/usr/bin/env node
/**
 * 压测入口，省去记环境变量的麻烦。
 *
 *   npm run perf               # 100 MB 单轮
 *   npm run perf -- 50         # 50 MB 单轮
 *   npm run perf -- 100 3      # 100 MB 连跑 3 轮（观察内存是否阶梯上涨）
 *   npm run perf -- 20 1 ansi  # 带 ANSI 颜色的日志，解析成本更高
 *   npm run perf -- 100 1 drop # 跳过终端渲染，只测 IPC 上限
 *   npm run perf -- 100 1 raw  # 关掉攒包，每包一发（A/B 对照）
 *
 * 前置：先起本地模拟服务 `node scripts/mock-sshd.mjs 2222`
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const [mb = '100', rounds = '1', mode = ''] = process.argv.slice(2)

const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE

env.PERF_RUN = mb
env.PERF_ROUNDS = rounds
env.DEMO_SEED = '1' // 让应用自动插入指向本地模拟服务的连接
if (mode === 'ansi') env.PERF_ANSI = '1'
if (mode === 'drop') env.PERF_DROP = '1'
if (mode === 'raw') env.PERF_COALESCE = '0'

const binName = process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
const bin = join(process.cwd(), 'node_modules', '.bin', binName)

const child = spawn(bin, ['dev'], {
  stdio: 'inherit',
  env,
  shell: process.platform === 'win32'
})

child.on('exit', (code) => process.exit(code ?? 0))
