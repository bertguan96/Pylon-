import type { ZmodemDirection } from './engine'

/**
 * ZMODEM 起始帧识别。
 *
 * lrzsz 打招呼时吐的序列都是 `**` + ZDLE(0x18) + 'B' + 两字节十六进制帧类型：
 *
 *   `**\x18B00`  ZRQINIT —— 远端要发文件过来（sz，我们收）
 *   `**\x18B01`  ZRINIT  —— 远端等着收文件（rz，我们发）
 *
 * 单独拎出来是为了能脱离 Electron 跑自测：这层最容易出错（TCP 分包会把
 * 控制序列切两半），出错的后果是把普通输出里的乱码当成传输。
 */
export interface ZmodemHit {
  direction: ZmodemDirection
  /** 控制序列起点之后的字节，原样交给协议引擎 */
  rest: Buffer
}

export interface ScanResult {
  /** 应该显示到终端的字节；null 表示这段全是控制序列 */
  shown: Buffer | null
  /** 命中起始帧时给出方向与剩余字节 */
  hit: ZmodemHit | null
}

/** 帧头长度：2 字节 ZPAD + ZDLE + 'B' + 2 字节十六进制 */
const FRAME_PREFIX = 6
/** 最多可能被切在末尾的字节数，留着等下一块 */
const TAIL_KEEP = FRAME_PREFIX - 1

export function findPreamble(buf: Buffer): { index: number; direction: ZmodemDirection } | null {
  for (let i = 0; i + FRAME_PREFIX <= buf.length; i++) {
    if (buf[i] !== 0x2a || buf[i + 1] !== 0x2a || buf[i + 2] !== 0x18) continue
    if (buf[i + 3] !== 0x42) continue // 'B'

    const hex = buf.subarray(i + 4, i + 6).toString('latin1')
    if (!/^[0-9a-fA-F]{2}$/.test(hex)) continue

    const frame = Number.parseInt(hex, 16)
    if (frame === 0x00) return { index: i, direction: 'download' }
    if (frame === 0x01) return { index: i, direction: 'upload' }
  }
  return null
}

/** 去掉控制序列前面的 "rz\r" / "rb\r"：那是 lrzsz 打招呼的碎屑，不该留在屏幕上 */
export function stripTrailingNoise(head: Buffer): Buffer {
  let end = head.length
  if (end >= 1 && head[end - 1] === 0x0d) end--
  if (end >= 2 && (head[end - 1] === 0x7a || head[end - 1] === 0x62) && head[end - 2] === 0x72) {
    end -= 2
  }
  return Buffer.from(head.subarray(0, end))
}

/** 有状态的扫描器：把跨包切断的控制序列拼回来 */
export class ZmodemScanner {
  private tail: Buffer = Buffer.alloc(0)

  push(chunk: Buffer): ScanResult {
    const buf = this.tail.length > 0 ? Buffer.concat([this.tail, chunk]) : chunk
    this.tail = Buffer.alloc(0)

    const found = findPreamble(buf)
    if (!found) {
      const cut = buf.length - Math.min(TAIL_KEEP, buf.length)
      if (cut <= 0) {
        this.tail = Buffer.from(buf)
        return { shown: null, hit: null }
      }
      this.tail = Buffer.from(buf.subarray(cut))
      return { shown: buf.subarray(0, cut), hit: null }
    }

    const head = stripTrailingNoise(buf.subarray(0, found.index))
    return {
      shown: head.length > 0 ? head : null,
      hit: { direction: found.direction, rest: buf.subarray(found.index) }
    }
  }

  reset(): void {
    this.tail = Buffer.alloc(0)
  }
}
