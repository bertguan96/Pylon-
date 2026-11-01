#!/usr/bin/env node
/**
 * 启动耗时测量。
 *
 *   npm run build            # 先构建，preview 读的是 out/ 里的产物
 *   node scripts/startup.mjs [次数]
 *
 * 打点全部在主进程里，用 process.uptime() 把起点反推到进程真正启动的时刻，
 * 所以数字包含 Electron 自身的启动开销，口径和用户「双击图标到窗口出现」一致。
 * 注意 preview 会多套一层 node 进程，别把外部墙钟当结果，只看 [startup] 打点。
 */
import { spawn } from 'node:child_process'
import { join } from 'node:path'

const runs = Math.max(1, Number(process.argv[2] || 3))
const env = { ...process.env }
delete env.ELECTRON_RUN_AS_NODE // 宿主环境带着它会让 Electron 变成纯 Node
env.PERF_STARTUP = '1'

const bin = join(
  process.cwd(),
  'node_modules',
  '.bin',
  process.platform === 'win32' ? 'electron-vite.cmd' : 'electron-vite'
)

function runOnce() {
  return new Promise((resolve) => {
    const marks = {}
    const child = spawn(bin, ['preview'], { env, shell: process.platform === 'win32' })
    const scan = (buf) => {
      for (const line of buf.toString().split(/\r?\n/)) {
        const m = line.match(/\[startup\]\s+(\S+)\s+\+(\d+)ms/)
        if (m) marks[m[1]] = Number(m[2])
      }
    }
    child.stdout.on('data', scan)
    child.stderr.on('data', scan)
    // preview 万一没被 app.exit 带下去，兜底杀掉，别把脚本挂死
    const guard = setTimeout(() => child.kill(), 25000)
    child.on('exit', () => {
      clearTimeout(guard)
      resolve(marks)
    })
  })
}

const rows = []
for (let i = 0; i < runs; i++) {
  const marks = await runOnce()
  rows.push(marks)
  process.stdout.write(
    `第 ${i + 1} 次  ` +
      Object.entries(marks)
        .map(([k, v]) => `${k} +${v}ms`)
        .join('  ') +
      '\n'
  )
}

// 只统计跑到窗口出现的那些轮次
const valid = rows.filter((r) => r.window)
if (valid.length) {
  const med = (xs) => xs.sort((a, b) => a - b)[Math.floor(xs.length / 2)]
  const keys = Object.keys(valid[0]).filter((k) => k !== 'window')
  console.log('\n阶段中位数（ms）')
  for (const k of keys) {
    const xs = valid.map((r) => r[k]).filter((x) => typeof x === 'number')
    if (xs.length) console.log(`  ${k.padEnd(10)} +${med(xs)}`)
  }
  console.log(`  ${'window'.padEnd(10)} +${med(valid.map((r) => r.window))}   ← 窗口出现`)
}
