/**
 * 原生引擎的整链路诊断（含 Node 代理层 + 管道协议 + exe）。
 *
 * `VNC_NATIVE=主机:端口:密码` 时运行：完全走 app 里真实的那条路
 * （NativeVncClient → 管道 → Rust 进程 → RFB → Mac），采样 3 秒后退出。
 * 和 vnc-live.ts 的区别是那个走纯 TS 引擎，两个的帧率可以直接对着看。
 */

import type { VncInitInfo } from '../vnc/engine'
import { NativeVncClient, nativeEnginePath } from '../vnc/native'

const KIND = '[vnc-native]'

export function maybeRunNativeLive(): void {
  const raw = process.env.VNC_NATIVE
  if (!raw) return

  const [host, portRaw, ...rest] = raw.split(':')
  const port = Number(portRaw)
  const password = rest.join(':')
  if (!host || !Number.isInteger(port) || port <= 0) {
    console.error(`${KIND} 用法：VNC_NATIVE=主机:端口:密码 npm run start`)
    process.exit(1)
  }

  const exe = nativeEnginePath()
  if (!exe) {
    console.error(`${KIND} 找不到 pylon-vnc.exe，先跑 npm run build:native`)
    process.exit(1)
  }
  console.log(`${KIND} 引擎：${exe}`)

  void run(host, port, password, exe).then((code) => process.exit(code))
}

async function run(host: string, port: number, password: string, exe: string): Promise<number> {
  const t0 = Date.now()
  let tInit = 0
  let frames = 0
  let tiles = 0
  let pixels = 0
  let firstFrameAt = 0

  const client = new NativeVncClient(
    {
      host,
      port,
      password: password || undefined,
      quality: 'speed',
      onInit: (info: VncInitInfo) => {
        tInit = Date.now() - t0
        console.log(
          `${KIND} 握手成功（${tInit}ms）：远端 ${info.remoteWidth}×${info.remoteHeight}，` +
            `输出 ${info.width}×${info.height}（1/${info.scale}）"${info.name}"`
        )
      },
      onRects: (rects) => {
        frames++
        if (frames === 1) {
          firstFrameAt = Date.now() - t0
          console.log(`${KIND} 首帧到达（${firstFrameAt}ms）：${rects.length} 个块`)
        }
        tiles += rects.length
        for (const r of rects) pixels += r.w * r.h
      },
      onStats: (stats) => {
        console.log(
          `${KIND} 采样：${stats.fps} fps · ${stats.kbps} kbps · ` +
            `${tiles} 块/${pixels / 1e6 < 0.01 ? '≈0' : (pixels / 1e6).toFixed(2)}MP（本段累计）`
        )
        tiles = 0
        pixels = 0
      },
      onClose: (err) => {
        console.log(`${KIND} 关闭：${err ? err.message : '正常'}`)
      }
    },
    exe
  )

  try {
    await client.connect()
  } catch (err) {
    console.error(`${KIND} 失败：${err instanceof Error ? err.message : String(err)}`)
    return 1
  }

  // 让画面动起来：静态画面测不出真实帧率
  const timer = setInterval(() => {
    const t = Date.now()
    const a = (t / 700) * Math.PI * 2
    client.pointer(1470 + Math.cos(a) * 500, 956 + Math.sin(a) * 400, 0)
  }, 16)

  await new Promise((r) => setTimeout(r, 3000))
  clearInterval(timer)
  client.close()

  console.log(`${KIND} 完成：握手 ${tInit}ms · 首帧 ${firstFrameAt}ms · ${frames} 帧/3s`)
  return frames > 0 ? 0 : 1
}
