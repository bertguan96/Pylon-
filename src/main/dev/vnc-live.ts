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

  const client = new VncClient({
    host,
    port,
    password: password || undefined,
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
      console.log(`[vnc-live] 采样：${fps} fps · ${kbps} kbps`)
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

  // 采 3 秒样本，够看清真实服务端的推帧节奏
  await new Promise((r) => setTimeout(r, 3000))
  client.close()

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
