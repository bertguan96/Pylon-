#!/usr/bin/env node
/**
 * 准备打包用的 Electron 运行时目录（build/electron-dist）。
 *
 * 为什么不直接让 electron-builder 用 node_modules 里的 Electron：
 * 它会把 electron 解压到临时目录再改名，本机安全策略会拦截目录 rename 导致打包中断。
 * 这里提前复制好一份，electron-builder.yml 里用 electronDist 直接指向它。
 *
 * 顺手裁掉用不到的语言包（49MB → 1.2MB），只留英文和简体中文。
 *
 *   node scripts/prepare-electron-dist.mjs          # 已存在则跳过
 *   node scripts/prepare-electron-dist.mjs --force  # 重建
 */
import { cpSync, existsSync, readdirSync, rmSync, statSync } from 'node:fs'
import { join } from 'node:path'

const SRC = 'node_modules/electron/dist'
const DEST = 'build/electron-dist'
const KEEP_LOCALES = new Set(['en-US.pak', 'zh-CN.pak'])

const dirSize = (dir) => {
  let total = 0
  for (const name of readdirSync(dir)) {
    const p = join(dir, name)
    const st = statSync(p)
    total += st.isDirectory() ? dirSize(p) : st.size
  }
  return total
}

if (!existsSync(SRC)) {
  console.error(`[electron-dist] 找不到 ${SRC}，先执行 npm install`)
  process.exit(1)
}

if (existsSync(DEST)) {
  if (!process.argv.includes('--force')) {
    console.log(`[electron-dist] ${DEST} 已存在，跳过（--force 可重建）`)
    process.exit(0)
  }
  rmSync(DEST, { recursive: true, force: true })
}

console.log(`[electron-dist] 复制 ${SRC} -> ${DEST}`)
cpSync(SRC, DEST, { recursive: true })

const localesDir = join(DEST, 'locales')
if (existsSync(localesDir)) {
  let removed = 0
  for (const name of readdirSync(localesDir)) {
    if (KEEP_LOCALES.has(name)) continue
    rmSync(join(localesDir, name), { force: true })
    removed++
  }
  console.log(`[electron-dist] 裁剪语言包：删除 ${removed} 个，保留 ${[...KEEP_LOCALES].join(' / ')}`)
}

console.log(`[electron-dist] 完成，体积 ${(dirSize(DEST) / 1024 / 1024).toFixed(0)} MB`)
