import { app, type BrowserWindow } from 'electron'
import type { SessionManager } from '../ssh/session-manager'

/**
 * 终端吞吐压测。
 *
 *   PERF_RUN=<MB>     每轮灌多少兆数据
 *   PERF_ROUNDS=<N>   跑几轮（默认 1；>1 用来观察内存是否随轮次阶梯上涨 = 泄漏）
 *   PERF_ANSI=1       输出带 ANSI 颜色，更接近真实日志（解析成本高一截）
 *
 * 测的是完整链路：ssh2 解密 → 主进程 IPC 序列化 → 渲染进程 → xterm 解析 → WebGL 渲染。
 * 三个时间点很关键：
 *   t0 发出命令 / t1 主进程收完最后一个字节 / t2 终端消费完最后一个 chunk
 *   t1 是「网络 + 协议 + 解密」的能力，t2 是「渲染管线」的能力，两者之差由背压吸收
 */

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))
const js = (win: BrowserWindow, code: string) => win.webContents.executeJavaScript(code)
const MB = 1024 * 1024

interface RenderSummary {
  write: { bytes: number; chunks: number; firstAt: number; lastAt: number }
  frames: { count: number; avgMs: number; p95Ms: number; maxMs: number; over50ms: number; fps: number }
}

async function rendererSummary(win: BrowserWindow): Promise<RenderSummary | null> {
  try {
    return await js(win, `window.__perf ? window.__perf.summary() : null`)
  } catch {
    return null
  }
}

/** 当前所有进程的内存占用（MB）。getAppMetrics 的 workingSetSize 单位是 KB */
function memMB(): { total: number; renderer: number; procs: number } {
  const m = app.getAppMetrics()
  return {
    total: m.reduce((a, x) => a + (x.memory?.workingSetSize ?? 0), 0) / 1024,
    renderer:
      m.filter((x) => x.type === 'Tab').reduce((a, x) => a + (x.memory?.workingSetSize ?? 0), 0) / 1024,
    procs: m.length
  }
}

/** 轮询渲染侧已消费字节数，判断数据是否真的画完了 */
async function waitConsumed(win: BrowserWindow, target: number, timeoutMs: number): Promise<number> {
  const start = Date.now()
  let last = 0
  let stableFor = 0
  while (Date.now() - start < timeoutMs) {
    const s = await rendererSummary(win)
    const bytes = s?.write.bytes ?? 0
    if (bytes >= target) return bytes
    // 连续 1.5 秒没有新进展 = 卡住了，别空等到超时
    stableFor = bytes === last ? stableFor + 250 : 0
    last = bytes
    if (stableFor >= 1500) return bytes
    await delay(250)
  }
  return last
}

export function maybeRunPerf(win: BrowserWindow, sessions: SessionManager): void {
  const mb = Number(process.env.PERF_RUN || 0)
  if (!mb) return
  const rounds = Math.max(1, Number(process.env.PERF_ROUNDS || 1))

  win.webContents.once('did-finish-load', async () => {
    try {
      await delay(1600)
      // 连上预置的本地模拟服务（DEMO_SEED 会插入它）
      await js(win, `document.querySelector('.conn-item')?.click()`)
      await delay(2600)
      await js(
        win,
        `document.querySelector('.pane.active .term-host')?.dispatchEvent(new MouseEvent('mousedown',{bubbles:true}))`
      )
      await delay(400)

      const idle = memMB()
      console.log('\n========== 压测报告 ==========')
      console.log(`环境           ${mb} MB × ${rounds} 轮，${process.env.PERF_ANSI ? 'ANSI 彩色日志' : '纯文本'}，` +
        `攒包 ${process.env.PERF_COALESCE === undefined ? '128 KB' : `${process.env.PERF_COALESCE} B`}`)
      console.log(`空闲内存       ${idle.total.toFixed(0)} MB（${idle.procs} 进程，渲染进程 ${idle.renderer.toFixed(0)} MB）\n`)

      const cmd = process.env.PERF_ANSI ? 'floodc' : 'flood'

      // 交互延迟：攒包策略唯一可能伤害的指标，必须单独量一次
      await js(win, `window.__perf?.resetEcho(); true`)
      for (let i = 0; i < 20; i++) {
        win.webContents.sendInputEvent({ type: 'char', keyCode: 'x' })
        await delay(70)
      }
      const e = (await js(win, `window.__perf ? window.__perf.echoSummary() : null`)) as
        | { count: number; p50: number; p95: number; max: number }
        | null
      if (e?.count) {
        console.log(
          `按键往返       p50 ${e.p50.toFixed(1)} ms / p95 ${e.p95.toFixed(1)} ms / 最大 ${e.max.toFixed(1)} ms（${e.count} 次）\n`
        )
      }
      // 清掉这一串 x，Ctrl+C 让假 shell 丢弃当前行
      win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'c', modifiers: ['control'] })
      win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'c', modifiers: ['control'] })
      await delay(400)

      // PERF_DROP=1：渲染侧跳过 xterm 直接 ack，测 IPC 链路的上限
      if (process.env.PERF_DROP) {
        await js(win, `window.__perfDrop = true; true`)
        console.log('注意：PERF_DROP 已开启，数据不会进终端，测的是 IPC 上限\n')
      }

      for (let round = 1; round <= rounds; round++) {
        await js(win, `window.__perf?.reset(); window.__perf?.startFrames(30000); true`)
        // firstAt/lastAt 必须从本轮起点算，否则掺进连接 banner 的耗时
        sessions.resetTraffic()
        await delay(150)

        const memBase = memMB()
        const samples: number[] = []
        const memTimer = setInterval(() => samples.push(memMB().total), 120)

        const t0 = performance.now()
        const target = mb * MB

        // 键盘输入走真实路径，和用户敲回车等价
        await js(win, `document.querySelector('.pane.active .xterm-helper-textarea')?.focus()`)
        for (const ch of `${cmd} ${mb}`) {
          win.webContents.sendInputEvent({ type: 'char', keyCode: ch })
          await delay(18)
        }
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Enter' })
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Enter' })

        const consumed = await waitConsumed(win, target, Math.max(30000, mb * 4000))
        const elapsed = performance.now() - t0

        clearInterval(memTimer)
        const memPeak = samples.length ? Math.max(...samples) : memBase.total
        await js(win, `window.__perf?.stopFrames(); true`)
        const r = await rendererSummary(win)

        const t = sessions.traffic()[0]?.stats
        if (!t) throw new Error('没有活动会话，压测无效')

        const recvMs = t.lastAt - t.firstAt
        const mbRecv = t.bytesIn / MB
        const mbConsumed = (r?.write.bytes ?? 0) / MB

        console.log(`--- 第 ${round} 轮 ---`)
        console.log(`数据量         ${mbRecv.toFixed(2)} MB / ${t.chunks} chunk（平均 ${(t.bytesIn / t.chunks / 1024).toFixed(1)} KB）`)
        console.log(`IPC 消息       ${t.msgs} 条，合并 ${(t.chunks / t.msgs).toFixed(1)}x` +
          `（平均 ${(t.bytesIn / t.msgs / 1024).toFixed(1)} KB/条）`)
        console.log(`首块延迟       ${(t.firstAt - t0).toFixed(0)} ms`)
        console.log(`主进程吞吐     ${(mbRecv / (recvMs / 1000)).toFixed(1)} MB/s（收数据 ${recvMs.toFixed(0)} ms）`)
        console.log(`终端已消费     ${mbConsumed.toFixed(2)} MB / ${r?.write.chunks ?? 0} chunk`)
        console.log(`端到端         ${elapsed.toFixed(0)} ms → 综合 ${(mbConsumed / (elapsed / 1000)).toFixed(1)} MB/s`)
        console.log(`背压           ${t.pauses} 次，暂停 ${t.pausedMs.toFixed(0)} ms（占 ${((t.pausedMs / elapsed) * 100).toFixed(0)}%），` +
          `待确认峰值 ${(t.maxPending / 1024).toFixed(0)} KB`)
        if (r) {
          console.log(`帧间隔         平均 ${r.frames.avgMs.toFixed(1)} ms（${r.frames.fps.toFixed(0)} fps）` +
            ` / p95 ${r.frames.p95Ms.toFixed(0)} ms / 最大 ${r.frames.maxMs.toFixed(0)} ms / 掉帧(>50ms) ${r.frames.over50ms}`)
        }
        console.log(`内存           ${memBase.total.toFixed(0)} → 峰值 ${memPeak.toFixed(0)} MB（+${(memPeak - memBase.total).toFixed(0)}）`)

        if (consumed < target) {
          console.log(`⚠ 未跑完        只消费 ${(consumed / MB).toFixed(2)} MB / ${mb} MB`)
        }

        // 静置让 GC 跑一轮，再记录水位 —— 每轮结束的内存是判断泄漏的依据
        await delay(2500)
        const after = memMB()
        console.log(`静置后         ${after.total.toFixed(0)} MB（渲染 ${after.renderer.toFixed(0)} MB），` +
          `较本轮起点 ${(after.total - memBase.total > 0 ? '+' : '')}${(after.total - memBase.total).toFixed(0)} MB\n`)
      }

      console.log('==============================\n')
    } catch (err) {
      console.error('[perf] 压测失败', err)
    } finally {
      app.exit(0)
    }
  })
}
