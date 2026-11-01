#!/usr/bin/env node
/**
 * 打包包装器：自动选定一个全新的输出目录再调 electron-builder。
 *
 * 本机安全策略会拦截 electron-builder 的批量删除/目录改名，
 * 导致「清空旧输出目录」「解压后改名」两类标准步骤直接中断。
 * 解法：
 *   1. 输出目录每次自动换新（build-output-N 取第一个不存在的 N）
 *   2. electronDist 指向 build/electron-dist（由 scripts/prepare-electron-dist.mjs 生成）
 *
 *   node scripts/package.mjs
 */
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'

const YML = 'electron-builder.yml'

// ---------- 1. 选一个不存在的输出目录 ----------

let n = 1
while (existsSync(`build-output-${n}`)) n++
const outputDir = `build-output-${n}`

let yml = readFileSync(YML, 'utf8')
yml = yml.replace(/output: build-output-\d+/, `output: ${outputDir}`)
writeFileSync(YML, yml)
console.log(`[package] 输出目录 -> ${outputDir}`)

// ---------- 2. electron-vite 构建三端 ----------

const vite = spawnSync('npx', ['electron-vite', 'build'], { stdio: 'inherit', shell: true })
if (vite.status !== 0) {
  console.error('[package] electron-vite build 失败')
  process.exit(vite.status ?? 1)
}

// ---------- 3. electron-builder 出安装包 ----------

// 用国内镜像，避免下载 Electron / NSIS 二进制时卡死
const env = {
  ...process.env,
  ELECTRON_MIRROR: 'https://npmmirror.com/mirrors/electron/',
  ELECTRON_BUILDER_BINARIES_MIRROR: 'https://npmmirror.com/mirrors/electron-builder-binaries/'
}

const builder = spawnSync('npx', ['electron-builder', '--win'], { stdio: 'inherit', shell: true, env })
process.exit(builder.status ?? 1)
