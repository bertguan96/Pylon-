/**
 * 远程桌面真机诊断。
 *
 * `VNC_LIVE=主机:端口:密码` 时运行：对一台真实的服务端（通常是 Mac 的屏幕共享）
 * 做完整握手 → 认证 → 收首帧，把每一步的耗时和 3 秒的帧率/流量样本打到 stdout，
 * 跑完退出。和 VNC_PROBE 的区别：那个对的是自写假服务端（验证解码正确性），
 * 这个对的是真实实现（验证兼容性）—— 两者的价值不能互相替代。
 *
 * 密码允许包含冒号，所以只按前两个冒号切分。退出码 0 = 成功，1 = 失败。
 */

import { monitorEventLoopDelay } from 'node:perf_hooks'
import { securityLabel, VncClient } from '../vnc/client'

export function maybeRunVncLive(): void {
  const raw = process.env.VNC_LIVE
  if (!raw) return

  const [host, portRaw, ...rest] = raw.split(':')
  const port = Number(portRaw)
  const password = rest.join(':')
  if (!host || !Number.isInteger(port) || port <= 0) {
    console.error('[vnc-live] 用法：VNC_LIVE=主机:端口:密码 npm run start')
    // app 尚未 ready 也没关系，直接退
    process.exit(1)
  }

  void runLive(host, port, password).then((code) => process.exit(code))
}

async function runLive(host: string, port: number, password: string): Promise<number> {
  const t0 = Date.now()
  let tInit = 0
  let tFirstFrame = 0
  let frames = 0
  let lastError: Error | null = null

  // 事件循环延迟：卡顿的硬指标。主进程一旦被解码堵住，这个值会飙到几十上百毫秒，
  // 而 UI、IPC、SSH 心跳全排在它后面 —— 这就是用户说的「卡死」。
  const loopDelay = monitorEventLoopDelay({ resolution: 10 })
  loopDelay.enable()

  const client = new VncClient({
    host,
    port,
    password: password || undefined,
    quality: process.env.VNC_BPP === '32' ? 'sharp' : 'speed',
    onInit: (info) => {
      tInit = Date.now() - t0
      console.log(
        `[vnc-live] 握手成功（${tInit}ms）：${info.width}×${info.height} "${info.name}"`
      )
    },
    onRects: (rects) => {
      frames++
      if (frames === 1 && tInit > 0) {
        tFirstFrame = Date.now() - t0
        console.log(
          `[vnc-live] 首帧到达（${tFirstFrame}ms，自握手起 ${(Date.now() - t0) - tInit}ms）：` +
            `${rects.length} 个矩形`
        )
      }
    },
    onStats: ({ fps, kbps }) => {
      console.log(
        `[vnc-live] 采样：${fps} fps · ${kbps} kbps · 事件循环 p50 ` +
          `${(loopDelay.percentile(50) / 1e6).toFixed(1)}ms / p99 ` +
          `${(loopDelay.percentile(99) / 1e6).toFixed(1)}ms · 最长 ${(loopDelay.max / 1e6).toFixed(1)}ms`
      )
      loopDelay.reset()
    },
    onClose: (err) => {
      if (err) lastError = err
    }
  })

  try {
    await client.connect()
  } catch (err) {
    console.error(
      `[vnc-live] 失败：${err instanceof Error ? err.message : String(err)}`
    )
    return 1
  }

  console.log(`[vnc-live] 认证方式：${securityLabel(client.securityTypes)}`)

  // 让画面动起来：静态画面测不出卡顿，只有光标/动画才逼出服务端的实时编码路径
  let moveTimer: NodeJS.Timeout | null = null
  if (process.env.VNC_LIVE_MOVE) {
    const w = client.width
    const h = client.height
    let tick = 0
    moveTimer = setInterval(() => {
      tick++
      // 画一个顺时针椭圆轨迹，覆盖大面积的像素变化
      const a = (tick / 20) * Math.PI * 2
      const x = Math.round(w / 2 + Math.cos(a) * (w / 3))
      const y = Math.round(h / 2 + Math.sin(a) * (h / 3))
      client.pointer(x, y, tick % 40 === 0 ? 1 : 0)
    }, 16)
    console.log('[vnc-live] 已开启持续鼠标移动（约 60 次/秒）')
  }

  // 采 3 秒样本，够看清真实服务端的推帧节奏
  await new Promise((r) => setTimeout(r, 3000))
  if (moveTimer) clearInterval(moveTimer)
  client.close()
  loopDelay.disable()

  // onClose 是在回调里赋值的，TS 的控制流分析看不到，读的时候要显式放宽类型
  const closeErr = lastError as Error | null
  if (frames === 0) {
    console.error('[vnc-live] 握手成功但 3 秒内没收到任何帧')
    return 1
  }
  console.log(
    `[vnc-live] 完成：握手 ${tInit}ms · 首帧 ${tFirstFrame}ms · ${frames} 帧/3s · ` +
      `${closeErr ? `关闭时带错误：${closeErr.message}` : '正常关闭'}`
  )
  return 0
}
