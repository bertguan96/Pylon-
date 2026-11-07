/**
 * 假的 VNC（RFB）服务端，用来在没有 Mac 的情况下调远程桌面界面。
 *
 *   node scripts/mock-rfb.mjs [端口] [宽] [高]
 *
 * 行为尽量贴近真实服务端：3.8 握手、VNC 密码认证（接受任意应答，本机调试不必真算 DES）、
 * SetPixelFormat / SetEncodings 都认，回了首帧之后按增量推一个移动的方块。
 * 收到的键鼠与剪贴板消息打成 JSON 打到 stdout，方便自动化里断言。
 *
 * 这只是一个调试工具，不做任何安全检查 —— 别拿它当真的服务端。
 */

import net from 'node:net'

const PORT = Number(process.argv[2] ?? 5911)
const W = Number(process.argv[3] ?? 1024)
const H = Number(process.argv[4] ?? 640)
const PASSWORD = process.env.RFB_PASSWORD ?? ''

function log(obj) {
  process.stdout.write(`${JSON.stringify(obj)}\n`)
}

/** 背景：斜向渐变，方便看出画面有没有错位 */
function bgAt(x, y) {
  return [(x * 255 / W) | 0, (y * 255 / H) | 0, ((x + y) * 255 / (W + H)) | 0]
}

function fillRect(buf, x, y, w, h, color) {
  for (let row = 0; row < h; row++) {
    for (let col = 0; col < w; col++) {
      const px = x + col
      const py = y + row
      if (px < 0 || py < 0 || px >= W || py >= H) continue
      const off = (py * W + px) * 4
      const [r, g, b] = typeof color === 'function' ? color(px, py) : color
      buf[off] = b
      buf[off + 1] = g
      buf[off + 2] = r
      buf[off + 3] = 0
    }
  }
}

const server = net.createServer((socket) => {
  log({ evt: 'client-connected', remote: `${socket.remoteAddress}:${socket.remotePort}` })

  let buffer = Buffer.alloc(0)
  const waiters = []
  const push = (chunk) => {
    buffer = Buffer.concat([buffer, chunk])
    while (waiters.length && buffer.length >= waiters[0].need) {
      const w = waiters.shift()
      const out = buffer.subarray(0, w.need)
      buffer = buffer.subarray(w.need)
      w.resolve(out)
    }
  }
  const read = (need) =>
    new Promise((resolve) => {
      if (buffer.length >= need) {
        const out = buffer.subarray(0, need)
        buffer = buffer.subarray(need)
        resolve(out)
        return
      }
      waiters.push({ need, resolve })
    })

  socket.on('data', push)
  socket.on('error', () => undefined)

  const stage = async () => {
    socket.write('RFB 003.008\n')
    const version = (await read(12)).toString('latin1')
    log({ evt: 'version', client: version.trim() })

    const secTypes = PASSWORD ? [2] : [1]
    socket.write(Buffer.from([secTypes.length, ...secTypes]))
    const chosen = (await read(1))[0]
    log({ evt: 'security', chosen })

    if (chosen === 2) {
      socket.write(Buffer.from('0123456789abcdef', 'latin1'))
      const response = await read(16)
      log({ evt: 'auth-response', len: response.length })
      socket.write(Buffer.from([0, 0, 0, 0]))
    } else {
      socket.write(Buffer.from([0, 0, 0, 0]))
    }

    const shared = (await read(1))[0]
    log({ evt: 'client-init', shared })

    const head = Buffer.alloc(24)
    head.writeUInt16BE(W, 0)
    head.writeUInt16BE(H, 2)
    head[4] = 32 // bpp
    head[5] = 24 // depth
    head[6] = 0 // little endian
    head[7] = 1 // true colour
    head.writeUInt16BE(255, 8)
    head.writeUInt16BE(255, 10)
    head.writeUInt16BE(255, 12)
    head[14] = 16 // red shift
    head[15] = 8 // green shift
    head[16] = 0 // blue shift
    const name = Buffer.from('Mock MacBook Pro', 'utf8')
    head.writeUInt32BE(name.length, 20)
    socket.write(Buffer.concat([head, name]))

    let frame = Buffer.alloc(W * H * 4)
    fillRect(frame, 0, 0, W, H, bgAt)

    const BOX = 80
    const BOX_COLOR = [255, 120, 40]
    const started = Date.now()

    /** 方块位置按「经过的时间」算，而不是按帧序号 ——
     *  请求节奏一变（客户端限速、链路抖动）方块速度就跟着变，看起来会很怪 */
    const boxAt = () => {
      const t = Date.now() - started
      return {
        x: Math.round(40 + ((Math.sin(t / 2600) + 1) / 2) * Math.max(0, W - 200)),
        y: Math.round(40 + ((1 - Math.cos(t / 3400)) / 2) * Math.max(0, H - 160))
      }
    }

    /** 当前画面上的方块位置（增量帧靠它算「擦哪里」） */
    let painted = boxAt()

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

    // 真实服务端不会对每个请求都全速回帧。不压这个节奏，客户端限速形同虚设：
    // 环回地址上能跑到几千 fps，测出来的 fps/kbps 完全没参考价值。
    const MIN_DELTA_MS = 33
    let lastDeltaAt = 0

    /** 矩形头：x/y/w/h + encoding，12 字节 */
    const rectHeader = (x, y, w, h, encoding) => {
      const b = Buffer.alloc(12)
      b.writeUInt16BE(x, 0)
      b.writeUInt16BE(y, 2)
      b.writeUInt16BE(w, 4)
      b.writeUInt16BE(h, 6)
      b.writeInt32BE(encoding, 8)
      return b
    }

    /** FramebufferUpdate 头：类型 + 1 字节填充 + 矩形个数 */
    const updateHeader = (count) => {
      const b = Buffer.alloc(4)
      b[0] = 0
      b.writeUInt16BE(count, 2)
      return b
    }

    /** 从整屏里抠一块像素出来（内存布局就是 RFB 要的 B、G、R） */
    const extract = (x, y, w, h) => {
      const out = Buffer.alloc(w * h * 4)
      for (let row = 0; row < h; row++) {
        for (let col = 0; col < w; col++) {
          const px = x + col
          const py = y + row
          if (px < 0 || py < 0 || px >= W || py >= H) continue
          const src = (py * W + px) * 4
          const dst = (row * w + col) * 4
          out[dst] = frame[src]
          out[dst + 1] = frame[src + 1]
          out[dst + 2] = frame[src + 2]
          out[dst + 3] = 0
        }
      }
      return out
    }

    /** 整帧：抹掉旧方块，把方块画到当前时间对应的位置，然后推整屏 */
    const sendFull = () => {
      fillRect(frame, painted.x, painted.y, BOX, BOX, bgAt)
      painted = boxAt()
      fillRect(frame, painted.x, painted.y, BOX, BOX, BOX_COLOR)
      socket.write(
        Buffer.concat([updateHeader(1), rectHeader(0, 0, W, H, 0), frame])
      )
    }

    /** 增量：擦掉旧方块 + 画到新位置，两块矩形放在同一条 FramebufferUpdate 里 */
    const sendDelta = async () => {
      const wait = MIN_DELTA_MS - (Date.now() - lastDeltaAt)
      if (wait > 0) await sleep(wait)
      lastDeltaAt = Date.now()

      const prevX = painted.x
      const prevY = painted.y
      const next = boxAt()

      fillRect(frame, prevX, prevY, BOX, BOX, bgAt)
      const erase = extract(prevX, prevY, BOX, BOX)

      fillRect(frame, next.x, next.y, BOX, BOX, BOX_COLOR)
      const draw = extract(next.x, next.y, BOX, BOX)
      painted = next

      socket.write(
        Buffer.concat([
          updateHeader(2),
          rectHeader(prevX, prevY, BOX, BOX, 0),
          erase,
          rectHeader(next.x, next.y, BOX, BOX, 0),
          draw
        ])
      )
    }

    // 首帧：先在初始位置画好方块，客户端要整帧时直接推上去
    fillRect(frame, painted.x, painted.y, BOX, BOX, BOX_COLOR)

    for (;;) {
      const type = (await read(1))[0]
      if (type === 3) {
        const incremental = (await read(9))[0]
        if (!incremental) sendFull()
        else await sendDelta()
      } else if (type === 0) {
        const fmt = await read(19)
        log({ evt: 'set-pixel-format', bpp: fmt[3], depth: fmt[4], bigEndian: fmt[5], trueColour: fmt[6] })
      } else if (type === 2) {
        await read(1)
        const count = (await read(2)).readUInt16BE(0)
        const encs = []
        for (let i = 0; i < count; i++) encs.push((await read(4)).readInt32BE(0))
        log({ evt: 'set-encodings', encodings: encs })
      } else if (type === 4) {
        const body = await read(7)
        log({ evt: 'key', down: body[0], keysym: body.readUInt32BE(3) })
      } else if (type === 5) {
        const body = await read(5)
        log({ evt: 'pointer', mask: body[0], x: body.readUInt16BE(1), y: body.readUInt16BE(3) })
      } else if (type === 6) {
        await read(3)
        const len = (await read(4)).readUInt32BE(0)
        const text = (await read(len)).toString('utf8')
        log({ evt: 'cut-text', text })

        // 收到本地剪贴板就回一段：一次把上行、下行、以及 UTF-8 编解码都测到
        const reply = Buffer.from(`Mac 收到：${text}`, 'utf8')
        const head = Buffer.alloc(8)
        head[0] = 3 // ServerCutText
        head.writeUInt32BE(reply.length, 4)
        socket.write(Buffer.concat([head, reply]))
      } else {
        log({ evt: 'unknown-message', type })
        socket.destroy()
        return
      }
    }
  }

  void stage().catch((err) => {
    log({ evt: 'error', message: String(err) })
    // 出错就断开：让客户端看到明确的连接关闭，而不是对着一条不响应的连接发呆
    socket.destroy()
  })
})

server.listen(PORT, '127.0.0.1', () => {
  log({ evt: 'listening', port: PORT, size: [W, H] })
})
