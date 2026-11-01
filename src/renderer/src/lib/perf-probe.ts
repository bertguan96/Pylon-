/**
 * 渲染侧性能探针。压测时通过 window.__perf 从主进程读取结果。
 *
 * 两件事：
 * 1. 统计 xterm 实际消费了多少字节、分多少个 chunk、首末时间戳
 *    —— 和主进程收到的字节对比，差值就是「压在 IPC / 终端解析队列里还没消化」的量
 * 2. 采样帧间隔，用来判断刷屏时界面是否卡顿
 *    —— 主线程被解析任务占满时，requestAnimationFrame 的间隔会明显拉长
 *
 * 常驻但零成本：计数只是几个加法；帧采样默认不跑，需要时显式 startFrames()。
 */

export interface WriteStats {
  bytes: number
  chunks: number
  firstAt: number
  lastAt: number
}

export interface FrameStats {
  samples: number[]
  running: boolean
  rafId: number
  startAt: number
}

const write: WriteStats = { bytes: 0, chunks: 0, firstAt: 0, lastAt: 0 }
const frames: FrameStats = { samples: [], running: false, rafId: 0, startAt: 0 }
const echo = { samples: [] as number[], pendingAt: 0 }

/** 每个 chunk 被终端消费完时调用一次（writeToTerminal 的 ack 回调里） */
export function recordWrite(bytes: number): void {
  const now = performance.now()
  if (!write.firstAt) write.firstAt = now
  write.lastAt = now
  write.bytes += bytes
  write.chunks++

  // 空闲时第一段回显到达 = 「敲下去到屏幕出现字符」的往返耗时
  if (echo.pendingAt) {
    echo.samples.push(now - echo.pendingAt)
    echo.pendingAt = 0
  }
}

/**
 * 按键写在 onData 里调用。
 * 用来验证「攒包发送」没有把交互延迟拉长 —— 这是合并策略唯一可能伤害的指标。
 */
export function markInput(): void {
  echo.pendingAt = performance.now()
}

export const perfProbe = {
  write,
  frames,

  reset(): void {
    write.bytes = 0
    write.chunks = 0
    write.firstAt = 0
    write.lastAt = 0
    frames.samples = []
    frames.startAt = 0
  },

  resetEcho(): void {
    echo.samples = []
    echo.pendingAt = 0
  },

  /** 按键往返延迟分位值（敲键 → 回显进入终端） */
  echoSummary(): { count: number; p50: number; p95: number; max: number } {
    const sorted = [...echo.samples].sort((a, b) => a - b)
    const pick = (q: number) => (sorted.length ? sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] : 0)
    return {
      count: sorted.length,
      p50: pick(0.5),
      p95: pick(0.95),
      max: sorted.length ? sorted[sorted.length - 1] : 0
    }
  },

  /** 开始采样帧间隔，durationMs 后自动停 */
  startFrames(durationMs = 15000): void {
    if (frames.running) return
    frames.running = true
    frames.samples = []
    frames.startAt = performance.now()
    let last = frames.startAt

    const tick = () => {
      const now = performance.now()
      frames.samples.push(now - last)
      last = now
      if (!frames.running || now - frames.startAt > durationMs) {
        frames.running = false
        return
      }
      frames.rafId = requestAnimationFrame(tick)
    }
    frames.rafId = requestAnimationFrame(tick)
  },

  stopFrames(): void {
    frames.running = false
    if (frames.rafId) cancelAnimationFrame(frames.rafId)
  },

  /** 汇总成一份可直接打日志的画像 */
  summary(warmupMs = 300): {
    write: WriteStats
    frames: {
      count: number
      avgMs: number
      p95Ms: number
      maxMs: number
      over50ms: number
      fps: number
    }
  } {
    // 丢掉最开始那段：首帧和 xterm.open 的开销不算进稳态
    const cut = frames.startAt + warmupMs
    let elapsed = 0
    const usable: number[] = []
    // samples 只有间隔没有绝对时间，按累计推算每个样本的结束时刻
    for (const gap of frames.samples) {
      elapsed += gap
      if (frames.startAt + elapsed >= cut) usable.push(gap)
    }

    const sorted = [...usable].sort((a, b) => a - b)
    const sum = usable.reduce((a, b) => a + b, 0)
    const avg = usable.length ? sum / usable.length : 0

    return {
      write: { ...write },
      frames: {
        count: usable.length,
        avgMs: avg,
        p95Ms: sorted.length ? sorted[Math.floor(sorted.length * 0.95)] : 0,
        maxMs: sorted.length ? sorted[sorted.length - 1] : 0,
        over50ms: usable.filter((x) => x > 50).length,
        fps: avg > 0 ? 1000 / avg : 0
      }
    }
  }
}
