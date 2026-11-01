#!/usr/bin/env node
/**
 * 生成应用图标 build/icon.ico（多尺寸，内嵌 PNG）。
 *
 * 图形是 Pylon —— 格构式输电塔：两条外斜边收窄到塔顶，中间横撑与交叉斜撑，
 * 顶部一根横担。隐喻「把东西送到很远的地方」，正是 SSH 客户端做的事。
 *
 * 不引入任何图像库：手写 PNG 编码（zlib + CRC32）与 ICO 容器，
 * 图形用距离场绘制，带简单抗锯齿。改设计只需要调下面的几何参数。
 *
 *   node scripts/make-icon.mjs
 */
import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

const SIZES = [16, 32, 48, 64, 128, 256]

// 设计稿坐标系固定 256x256，其它尺寸按比例采样
const CANVAS = 256
const BG = [28, 27, 25, 255] // #1C1B19
const ACCENT = [159, 225, 203, 255] // #9FE1CB

// ---------- 塔身几何 ----------

const Y_TOP = 58 // 塔顶
const Y_BOT = 208 // 塔脚
const HALF_TOP = 23 // 塔顶半宽
const HALF_BOT = 66 // 塔脚半宽
const CX = 128 // 中轴

/** 某一高度上的塔身左右边缘 x 坐标 */
function edgeAt(y) {
  const t = (y - Y_TOP) / (Y_BOT - Y_TOP)
  const half = HALF_TOP + (HALF_BOT - HALF_TOP) * t
  return [CX - half, CX + half]
}

/**
 * 返回组成图形的线段：[x1, y1, x2, y2, 线宽]
 *
 * detail 为 'full' 时画出完整格构（含交叉斜撑），
 * 小尺寸下交叉线会糊成一团，所以 'simple' 只保留主结构。
 */
function towerSegments(detail) {
  const segs = []

  // 两条主斜边
  segs.push([CX - HALF_TOP, Y_TOP, CX - HALF_BOT, Y_BOT, 11])
  segs.push([CX + HALF_TOP, Y_TOP, CX + HALF_BOT, Y_BOT, 11])

  // 顶部横担（比塔顶略宽，像真塔的导线支架）
  segs.push([CX - HALF_TOP - 12, Y_TOP, CX + HALF_TOP + 12, Y_TOP, 11])

  // 横撑所在高度，从塔顶往下均分
  const levels = [Y_TOP, 96, 134, 172, Y_BOT]

  // 横撑
  for (let i = 1; i < levels.length - 1; i++) {
    const [l, r] = edgeAt(levels[i])
    segs.push([l, levels[i], r, levels[i], 7])
  }

  if (detail === 'full') {
    // 每个格子内画一组交叉斜撑，格构塔的标志性结构
    for (let i = 0; i < levels.length - 1; i++) {
      const [l1, r1] = edgeAt(levels[i])
      const [l2, r2] = edgeAt(levels[i + 1])
      segs.push([l1, levels[i], r2, levels[i + 1], 5.5])
      segs.push([r1, levels[i], l2, levels[i + 1], 5.5])
    }
  } else {
    // 小尺寸只留一道中部横撑，保证轮廓可辨
    const [l, r] = edgeAt(134)
    segs.push([l, 134, r, 134, 8])
  }

  // 塔脚基座，让塔"落地"而不是悬空
  segs.push([CX - HALF_BOT - 8, Y_BOT, CX + HALF_BOT + 8, Y_BOT, 9])

  return segs
}

// ---------- 几何工具 ----------

function roundedRectDistance(px, py, x, y, w, h, r) {
  const cx = x + w / 2
  const cy = y + h / 2
  const dx = Math.abs(px - cx) - (w / 2 - r)
  const dy = Math.abs(py - cy) - (h / 2 - r)
  const ax = Math.max(dx, 0)
  const ay = Math.max(dy, 0)
  return Math.sqrt(ax * ax + ay * ay) + Math.min(Math.max(dx, dy), 0) - r
}

function segmentDistance(px, py, x1, y1, x2, y2) {
  const vx = x2 - x1
  const vy = y2 - y1
  const wx = px - x1
  const wy = py - y1
  const len2 = vx * vx + vy * vy
  let t = len2 === 0 ? 0 : (wx * vx + wy * vy) / len2
  t = Math.max(0, Math.min(1, t))
  const qx = x1 + t * vx
  const qy = y1 + t * vy
  return Math.hypot(px - qx, py - qy)
}

// ---------- 绘制 ----------

function render(size) {
  const scale = size / CANVAS
  const out = Buffer.alloc(size * size * 4, 0)
  const segs = towerSegments(size >= 48 ? 'full' : 'simple')

  // 预计算每条线段到像素的距离，取最近的那条决定笔画的覆盖度
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const px = (x + 0.5) / scale
      const py = (y + 0.5) / scale

      // 背景圆角矩形，边缘 1px 抗锯齿
      const dBg = roundedRectDistance(px, py, 0, 0, CANVAS, CANVAS, 58)
      const bgAlpha = Math.max(0, Math.min(1, 0.5 - dBg))
      if (bgAlpha <= 0) continue

      let color = BG
      let alpha = bgAlpha

      // 笔画覆盖度 = 距离小于半线宽的部分，+0.5 做一像素羽化
      let strokeAlpha = 0
      for (const [x1, y1, x2, y2, w] of segs) {
        const d = segmentDistance(px, py, x1, y1, x2, y2)
        const a = Math.max(0, Math.min(1, w / 2 - d + 0.5))
        if (a > strokeAlpha) strokeAlpha = a
        if (strokeAlpha >= 1) break
      }

      if (strokeAlpha > 0) {
        color = ACCENT
        alpha = bgAlpha * strokeAlpha
      }

      const i = (y * size + x) * 4
      out[i] = color[0]
      out[i + 1] = color[1]
      out[i + 2] = color[2]
      out[i + 3] = Math.round(alpha * 255)
    }
  }
  return out
}

// ---------- PNG 编码 ----------

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const typeBuf = Buffer.from(type, 'ascii')
  const crcBuf = Buffer.alloc(4)
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])))
  return Buffer.concat([len, typeBuf, data, crcBuf])
}

function encodePNG(size, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(size, 0)
  ihdr.writeUInt32BE(size, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // color type: RGBA
  ihdr[10] = 0
  ihdr[11] = 0
  ihdr[12] = 0

  // 每行前面加一个 filter type 字节
  const raw = Buffer.alloc((size * 4 + 1) * size)
  for (let y = 0; y < size; y++) {
    raw[y * (size * 4 + 1)] = 0
    rgba.copy(raw, y * (size * 4 + 1) + 1, y * size * 4, (y + 1) * size * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0))
  ])
}

// ---------- ICO 容器 ----------

function encodeICO(images) {
  const count = images.length
  const header = Buffer.alloc(6)
  header.writeUInt16LE(0, 0)
  header.writeUInt16LE(1, 2) // 1 = icon
  header.writeUInt16LE(count, 4)

  const entries = []
  let offset = 6 + count * 16

  for (const { size, png } of images) {
    const entry = Buffer.alloc(16)
    entry[0] = size >= 256 ? 0 : size // 0 表示 256
    entry[1] = size >= 256 ? 0 : size
    entry[2] = 0 // 调色板数
    entry[3] = 0
    entry.writeUInt16LE(1, 4) // planes
    entry.writeUInt16LE(32, 6) // bpp
    entry.writeUInt32LE(png.length, 8)
    entry.writeUInt32LE(offset, 12)
    entries.push(entry)
    offset += png.length
  }

  return Buffer.concat([header, ...entries, ...images.map((i) => i.png)])
}

// ---------- 主流程 ----------

const images = SIZES.map((size) => ({ size, png: encodePNG(size, render(size)) }))
const ico = encodeICO(images)

const target = join(process.cwd(), 'build', 'icon.ico')
mkdirSync(dirname(target), { recursive: true })
writeFileSync(target, ico)

console.log(`已生成 ${target}（${SIZES.join('/')} px，共 ${(ico.length / 1024).toFixed(1)} KB）`)

// 同时输出一张 256 PNG，方便在文档或商店页面里预览
const previewPath = join(process.cwd(), 'build', 'icon.png')
writeFileSync(previewPath, images[images.length - 1].png)
console.log(`预览图 ${previewPath}`)
