import { app } from 'electron'
import { randomBytes } from 'node:crypto'
import { Receiver, Sender } from 'zmodem2'
import { ZmodemScanner } from '../zmodem/detect'
import { ZmodemEngine, type ZmodemResult, type ZmodemSink, type ZmodemSource } from '../zmodem/engine'

/**
 * rz / sz 的无界面自测（ZMODEM_PROBE=1 时运行）。
 *
 * 真实链路要一台装了 lrzsz 的 Linux 主机，开发机上没有，所以用同一套协议库
 * 在进程内扮演「远端」：
 *   - 远端 sz → 我们收（Receiver 侧）
 *   - 远端 rz → 我们发（Sender 侧）
 * 两边都是真协议字节，能覆盖握手、分包、CRC，以及我们自己的泵送顺序。
 *
 * 注意：模拟对端必须当真正的网络来用 —— 发送走队列延迟投递，
 * 并且尊重 feedIncoming 的「部分消费」返回值（接收端缓冲区满时它只吃一半）。
 * 一把喂进去而不看返回值，会把帧尾的 CRC 和 ZCRCW 丢掉，
 * 表现就是传完一个子包后双方都卡住（这个坑真踩过）。
 */

const checks: Array<[string, boolean, string?]> = []
const record = (name: string, ok: boolean, detail?: string) => checks.push([name, ok, detail])
const nextTick = () => new Promise((r) => setImmediate(r))

export function maybeRunZmodemProbe(): void {
  if (!process.env.ZMODEM_PROBE) return

  void (async () => {
    try {
      testDetection()
      await testDownload()
      await testUpload()
      await testCancel()
    } catch (err) {
      record('自测异常', false, (err as Error).message)
    }

    console.log('\n===== ZMODEM 自测 =====')
    for (const [name, ok, detail] of checks) {
      console.log(`${ok ? '[通过]' : '[失败]'} ${name}${detail ? ` —— ${detail}` : ''}`)
    }
    const failed = checks.filter(([, ok]) => !ok).length
    console.log(`===== ${checks.length - failed}/${checks.length} 通过 =====\n`)
    app.exit(failed === 0 ? 0 : 1)
  })()
}

// ---------------------------------------------------------------- 用例

function testDetection(): void {
  const preamble = (frame: string) =>
    Buffer.concat([Buffer.from([0x2a, 0x2a, 0x18, 0x42]), Buffer.from(frame, 'latin1')])

  const dl = new ZmodemScanner().push(Buffer.concat([Buffer.from('rz\r'), preamble('00'), Buffer.alloc(10)]))
  record('识别 sz（ZRQINIT → 下载）', dl.hit?.direction === 'download')

  const ul = new ZmodemScanner().push(Buffer.concat([preamble('01'), Buffer.alloc(10)]))
  record('识别 rz（ZRINIT → 上传）', ul.hit?.direction === 'upload')

  const scanner = new ZmodemScanner()
  const full = Buffer.concat([Buffer.from('abc'), preamble('00'), Buffer.alloc(20)])
  const first = scanner.push(full.subarray(0, 5))
  const second = scanner.push(full.subarray(5))
  record(
    '跨包切断仍能识别',
    first.hit === null && second.hit?.direction === 'download',
    `首包 shown=${first.shown?.length ?? 0} 字节`
  )

  const withText = new ZmodemScanner().push(
    Buffer.concat([Buffer.from('hello\nrz\r'), preamble('00')])
  )
  record(
    '保留正常输出并清掉 rz 碎屑',
    withText.shown?.toString('utf8') === 'hello\n',
    JSON.stringify(withText.shown?.toString('utf8'))
  )

  const noise = new ZmodemScanner().push(
    Buffer.concat([Buffer.from([0x2a, 0x2a, 0x18, 0x42]), Buffer.from('ZZ---', 'latin1')])
  )
  record('误判防护：非法帧类型不误触', noise.hit === null)
}

/** 把字节投递给模拟对端，尊重部分消费 */
function deliver(peer: Sender | Receiver, bytes: Uint8Array, onFileData?: (b: Buffer) => void): void {
  let offset = 0
  for (let guard = 0; guard < 500 && offset < bytes.length; guard++) {
    const consumed = peer.feedIncoming(bytes.subarray(offset))
    offset += consumed
    if (onFileData && peer instanceof Receiver) {
      let data = peer.drainFile()
      while (data.length) {
        onFileData(Buffer.from(data))
        data = peer.drainFile()
      }
    }
    if (consumed === 0) break
  }
}

async function testDownload(): Promise<void> {
  const payload = randomBytes(300_000)
  const remote = new Sender() // 远端 sz，发起方
  const chunks: Buffer[] = []
  let aborted = false
  const sink: ZmodemSink = {
    path: 'memory://download.bin',
    write: (c) => chunks.push(Buffer.from(c)),
    close: () => {},
    abort: () => {
      aborted = true
    }
  }

  const state: { result: ZmodemResult | null } = { result: null }
  /** 待投递给「远端」的字节，模拟网络延迟 */
  const wire: Uint8Array[] = []

  const engine = new ZmodemEngine(
    {
      send: (bytes) => wire.push(bytes),
      beginDownload: async () => sink,
      pickUpload: async () => null,
      onProgress: () => {},
      onDone: (r) => {
        if (!state.result) state.result = r
      }
    },
    'download'
  )

  remote.startFile('download.bin', payload.length, Date.now())

  for (let round = 0; round < 5000 && !state.result; round++) {
    while (wire.length) deliver(remote, wire.shift()!)

    const incoming = remote.drainOutgoing()
    if (incoming.length) engine.feed(incoming)

    const req = remote.pollFile()
    if (req) {
      const len = Math.min(req.len, payload.length - req.offset)
      remote.feedFile(new Uint8Array(payload.buffer, payload.byteOffset + req.offset, len))
    }
    while (remote.pollEvent()) {
      // 远端事件与断言无关
    }
    await nextTick()
  }

  const got = Buffer.concat(chunks)
  record('下载：300KB 字节完全一致', got.length === payload.length && got.equals(payload), `${got.length} 字节`)
  record('下载：回调报成功', state.result?.ok === true, JSON.stringify(state.result))
  record('下载：没有触发中断清理', !aborted)
}

async function testUpload(): Promise<void> {
  const payload = randomBytes(250_000)
  const remote = new Receiver() // 远端 rz
  const source: ZmodemSource = {
    name: 'upload.bin',
    size: payload.length,
    mtime: Date.now(),
    path: 'memory://upload.bin',
    read: (offset, len) =>
      new Uint8Array(payload.buffer, payload.byteOffset + offset, Math.min(len, payload.length - offset))
  }

  const chunks: Buffer[] = []
  const state: { result: ZmodemResult | null } = { result: null }
  const wire: Uint8Array[] = []
  const collect = (b: Buffer) => chunks.push(b)

  const engine = new ZmodemEngine(
    {
      send: (bytes) => wire.push(bytes),
      beginDownload: async () => null,
      pickUpload: async () => [source],
      onProgress: () => {},
      onDone: (r) => {
        if (!state.result) state.result = r
      }
    },
    'upload'
  )

  await engine.startUpload()

  for (let round = 0; round < 5000 && !state.result; round++) {
    while (wire.length) deliver(remote, wire.shift()!, collect)

    const incoming = remote.drainOutgoing()
    if (incoming.length) engine.feed(incoming)

    let data = remote.drainFile()
    while (data.length) {
      collect(Buffer.from(data))
      data = remote.drainFile()
    }
    while (remote.pollEvent()) {
      // 忽略远端事件
    }
    await nextTick()
  }

  const got = Buffer.concat(chunks)
  record('上传：250KB 字节完全一致', got.length === payload.length && got.equals(payload), `${got.length} 字节`)
  record('上传：回调报成功', state.result?.ok === true, JSON.stringify(state.result))
}

async function testCancel(): Promise<void> {
  const remote = new Sender()
  let aborted = false
  const state: { result: ZmodemResult | null } = { result: null }
  const sink: ZmodemSink = {
    path: 'memory://cancel.bin',
    write: () => {},
    close: () => {},
    abort: () => {
      aborted = true
    }
  }
  const wire: Uint8Array[] = []

  const engine = new ZmodemEngine(
    {
      send: (bytes) => wire.push(bytes),
      beginDownload: async () => sink,
      pickUpload: async () => null,
      onProgress: () => {},
      onDone: (r) => {
        if (!state.result) state.result = r
      }
    },
    'download'
  )

  remote.startFile('cancel.bin', 200_000, Date.now())

  // 先跑几轮把文件头和第一段数据走完，确保 sink 已经建好
  for (let round = 0; round < 6; round++) {
    while (wire.length) deliver(remote, wire.shift()!)
    const incoming = remote.drainOutgoing()
    if (incoming.length) engine.feed(incoming)
    const req = remote.pollFile()
    if (req) remote.feedFile(new Uint8Array(Math.min(req.len, 4096)))
    await nextTick()
  }

  engine.cancel()
  record('取消：回调报失败', state.result?.ok === false, state.result?.message)
  record('取消：半截文件被清理', Boolean(aborted))
  record('取消：引擎进入结束态', Boolean(engine.isFinished))
}
