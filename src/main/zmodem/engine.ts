import { Receiver, ReceiverEvent, Sender, SenderEvent } from 'zmodem2'

/**
 * ZMODEM 传输引擎。
 *
 * 只做协议本身：喂进去远端字节、把回包吐出来、按事件读写文件。
 * 不碰 Electron、不碰对话框、不碰 SSH —— 这样它可以脱离界面单独跑自测。
 *
 * 方向约定与 lrzsz 一致：
 * - 远端 `sz file` → 远端先发 ZRQINIT，我们做接收（download）
 * - 远端 `rz`      → 远端先发 ZRINIT ，我们做发送（upload）
 *
 * 两个坑（对照官方集成测试才定位到，别随手改）：
 * 1. 上传必须 `new Sender(false)`。远端 rz 已经发过 ZRINIT，我们不是发起方；
 *    用 new Sender() 会抢着发 ZRQINIT，握手错位后卡在「等 ACK」，只传得出一个子包。
 * 2. `feedIncoming` 可能只消费一部分（接收端缓冲区满），必须循环喂到它不再消费为止，
 *    否则剩余字节直接丢，表现为传到一半停住。
 */
export type ZmodemDirection = 'download' | 'upload'

export interface ZmodemProgress {
  direction: ZmodemDirection
  name: string
  transferred: number
  total: number
}

export interface ZmodemResult {
  direction: ZmodemDirection
  name: string
  ok: boolean
  path?: string
  message?: string
}

/** 接收方落盘的去处 */
export interface ZmodemSink {
  path: string
  write(chunk: Uint8Array): void
  /** 正常收完：落盘收尾 */
  close(): void
  /** 中断：清理半截文件 */
  abort(): void
}

/** 发送方的数据源 */
export interface ZmodemSource {
  name: string
  size: number
  mtime: number
  path: string
  read(offset: number, len: number): Uint8Array
}

export interface ZmodemHooks {
  /** 把协议回包写回远端 */
  send(bytes: Uint8Array): void
  /** 收到文件头，问用户存哪儿；返回 null 表示取消 */
  beginDownload(name: string, size: number): Promise<ZmodemSink | null>
  /** 远端在等我们发文件，问用户选哪些；返回 null 表示取消 */
  pickUpload(): Promise<ZmodemSource[] | null>
  onProgress(p: ZmodemProgress): void
  onDone(r: ZmodemResult): void
}

/** 协议无进展多久算卡死（远端拔网线、rz 异常退出等） */
const IDLE_TIMEOUT_MS = 60_000
/** 进度事件的最小间隔，避免几千个子包刷爆 IPC */
const PROGRESS_INTERVAL_MS = 120
/** 单次喂数据最多循环多少轮，防止状态机异常时空转 */
const MAX_FEED_LOOPS = 500
/**
 * 文件收完之后等远端 ZFIN 的宽限时间。
 *
 * 正常情况下 sz 收完文件会紧接着发 ZFIN，收到就自然结束。但有些实现（或网络抖动下丢包）
 * 迟迟不来，而「传输中」状态会一直吞键盘输入 —— 不能把用户锁死在终端里，
 * 所以超时就自己收尾（文件已经完整落盘，不算失败，也不给远端发 CAN）。
 */
const FINISH_GRACE_MS = 8_000

/** ZMODEM 的中止序列：连续 8 个 CAN，对端收到就停 */
const CANCEL_SEQUENCE = new Uint8Array(8).fill(0x18)

export class ZmodemEngine {
  private readonly hooks: ZmodemHooks
  private readonly direction: ZmodemDirection

  private rx: Receiver | null = null
  private sx: Sender | null = null

  private sink: ZmodemSink | null = null
  private sources: ZmodemSource[] = []
  private sourceIndex = 0
  private currentSource: ZmodemSource | null = null

  private name = ''
  private total = 0
  private transferred = 0

  /** 等用户选路径/选文件期间，进来的字节先攒着（协议不能因为弹窗而丢包） */
  private awaiting = false
  private pendingChunks: Uint8Array[] = []

  /** 当前这个文件是否已经完整收发（区分「真失败」和「完成后的 ZFIN 超时」） */
  private fileDone = false
  private finished = false
  /** 收完文件后等 ZFIN 的定时器，见 FINISH_GRACE_MS */
  private graceTimer: ReturnType<typeof setTimeout> | null = null
  private lastActivityAt = Date.now()
  private lastProgressAt = 0
  private lastProgressBytes = 0

  constructor(hooks: ZmodemHooks, direction: ZmodemDirection) {
    this.hooks = hooks
    this.direction = direction
    if (direction === 'download') {
      this.rx = new Receiver()
    } else {
      // false = 不主动发 ZRQINIT：远端 rz 已经发了 ZRINIT，我们是应答方
      this.sx = new Sender(false)
    }
  }

  get isFinished(): boolean {
    return this.finished
  }

  /** 远端字节入口 */
  feed(chunk: Uint8Array): void {
    if (this.finished) return
    this.lastActivityAt = Date.now()

    if (this.awaiting) {
      this.pendingChunks.push(chunk)
      return
    }
    this.consume(chunk)
  }

  /** 启动上传：先问用户选文件，再逐个发 */
  async startUpload(): Promise<void> {
    if (this.finished) return
    this.awaiting = true
    const files = await this.hooks.pickUpload()
    this.awaiting = false
    if (this.finished) return

    if (!files || files.length === 0) {
      this.abort('已取消发送')
      return
    }
    this.sources = files
    this.sourceIndex = 0
    this.beginNextFile()
    this.drainPending()
  }

  cancel(): void {
    if (this.finished) return
    this.abort('已取消')
  }

  // ---------------------------------------------------------------- 内部

  /** 循环喂到状态机不再消费，中间不断把输出和事件排空 */
  private consume(chunk: Uint8Array): void {
    const machine = this.rx ?? this.sx
    if (!machine) return

    let offset = 0
    for (let guard = 0; guard < MAX_FEED_LOOPS && offset < chunk.length; guard++) {
      if (this.finished) return
      if (this.awaiting) {
        this.pendingChunks.push(chunk.subarray(offset))
        return
      }

      let consumed = 0
      try {
        consumed = machine.feedIncoming(chunk.subarray(offset))
      } catch (err) {
        this.abort(`协议错误：${(err as Error).message}`)
        return
      }
      offset += consumed

      const didWork = this.pump()
      if (consumed === 0 && !didWork) break
    }

    if (this.finished || this.awaiting) return
    // 空数据也要推一次：最后一个 ZEOF / ZFIN 只翻状态、不发数据，
    // 不推就永远拿不到 FileComplete / SessionComplete 事件
    this.pump()
    if (this.finished) return
    this.checkTimeout()
    this.maybeEmitProgress()
  }

  private drainPending(): void {
    const queued = this.pendingChunks
    this.pendingChunks = []
    for (const chunk of queued) {
      if (this.finished) return
      this.consume(chunk)
    }
  }

  private checkTimeout(): void {
    if (Date.now() - this.lastActivityAt > IDLE_TIMEOUT_MS) {
      this.abort('传输超时：远端长时间没有响应')
    }
  }

  /** 排空一次状态机；返回是否有实质进展 */
  private pump(): boolean {
    try {
      return this.rx ? this.pumpReceiver() : this.pumpSender()
    } catch (err) {
      this.abort(`传输失败：${(err as Error).message}`)
      return false
    }
  }

  private pumpReceiver(): boolean {
    const rx = this.rx
    if (!rx) return false
    let didWork = false

    let out = rx.drainOutgoing()
    while (out.length) {
      this.hooks.send(out)
      didWork = true
      out = rx.drainOutgoing()
    }

    let ev = rx.pollEvent()
    while (ev) {
      didWork = true
      this.handleReceiverEvent(ev)
      if (this.finished || this.awaiting) return didWork
      ev = rx.pollEvent()
    }

    let data = rx.drainFile()
    while (data.length) {
      this.writeData(data)
      didWork = true
      data = rx.drainFile()
    }

    return didWork
  }

  private pumpSender(): boolean {
    const sx = this.sx
    if (!sx) return false
    let didWork = false

    for (;;) {
      let out = sx.drainOutgoing()
      while (out.length) {
        this.hooks.send(out)
        didWork = true
        out = sx.drainOutgoing()
      }
      if (this.finished) return didWork

      const req = sx.pollFile()
      if (!req) break

      const src = this.currentSource
      if (!src) {
        this.abort('内部状态异常：没有待发送文件')
        return didWork
      }
      const len = Math.min(req.len, src.size - req.offset)
      if (len <= 0) {
        this.abort(`读取失败：${src.name} 在传输中被截断`)
        return didWork
      }
      sx.feedFile(src.read(req.offset, len))
      this.transferred += len
      didWork = true
    }

    let ev = sx.pollEvent()
    while (ev) {
      didWork = true
      this.handleSenderEvent(ev)
      if (this.finished) return didWork
      ev = sx.pollEvent()
    }

    return didWork
  }

  private handleReceiverEvent(ev: ReceiverEvent): void {
    if (ev === ReceiverEvent.FileStart) {
      const rx = this.rx
      if (!rx) return
      const name = rx.getFileName()
      const size = rx.getFileSize()
      this.awaiting = true

      void (async () => {
        let sink: ZmodemSink | null = null
        try {
          sink = await this.hooks.beginDownload(name, size)
        } catch (err) {
          this.awaiting = false
          this.abort(`无法保存文件：${(err as Error).message}`)
          return
        }
        this.awaiting = false
        if (this.finished) {
          sink?.abort()
          return
        }
        if (!sink) {
          this.abort('已取消接收')
          return
        }

        this.sink = sink
        this.name = name
        this.total = size
        this.transferred = 0
        this.lastProgressBytes = 0
        this.emitProgress()
        this.drainPending()
      })()
      return
    }

    if (ev === ReceiverEvent.FileComplete) {
      this.sink?.close()
      this.fileDone = true
      this.hooks.onDone({
        direction: 'download',
        name: this.name,
        ok: true,
        path: this.sink?.path
      })
      this.sink = null
      // 不能在这里就收手：远端还有 ZFIN 握手，不回它的话 sz 会卡住等超时
      this.armGrace()
      return
    }

    if (ev === ReceiverEvent.SessionComplete) {
      // FileComplete 已经报过结果，这里只兜底关掉还没收尾的 sink
      if (this.sink) {
        this.sink.close()
        this.sink = null
      }
      this.finished = true
      this.clearGrace()
      // 最后一帧（对远端 ZFIN 的应答）还压在出站队列里，必须推出去：
      // 收手太早的话，远端的 sz 会一直等这个 ack 直到超时，终端看起来像卡住了
      this.flushOutgoing()
    }
  }

  private handleSenderEvent(ev: SenderEvent): void {
    if (ev === SenderEvent.FileComplete) {
      this.fileDone = true
      this.hooks.onDone({
        direction: 'upload',
        name: this.currentSource?.name ?? this.name,
        ok: true,
        path: this.currentSource?.path
      })
      this.sourceIndex++
      if (this.sourceIndex < this.sources.length) {
        this.beginNextFile()
        return
      }
      this.sx?.finishSession()
      return
    }

    if (ev === SenderEvent.SessionComplete) {
      this.finished = true
      this.flushOutgoing()
    }
  }

  /** 只排空出站队列，不碰事件与文件 */
  private flushOutgoing(): void {    const machine = this.rx ?? this.sx
    if (!machine) return
    try {
      let out = machine.drainOutgoing()
      while (out.length) {
        this.hooks.send(out)
        out = machine.drainOutgoing()
      }
    } catch {
      // 收尾阶段出错就算了，会话已经结束
    }
  }

  private beginNextFile(): void {
    const src = this.sources[this.sourceIndex]
    if (!src) return
    this.currentSource = src
    this.fileDone = false
    this.name = src.name
    this.total = src.size
    this.transferred = 0
    this.lastProgressBytes = 0
    this.emitProgress()
    this.sx?.startFile(src.name, src.size, src.mtime)
  }

  /** 文件已收完但还没等到 ZFIN：起个定时器兜底收尾，别把键盘一直锁着 */
  private armGrace(): void {
    this.clearGrace()
    this.graceTimer = setTimeout(() => {
      this.graceTimer = null
      if (!this.finished) this.finished = true
    }, FINISH_GRACE_MS)
  }

  private clearGrace(): void {
    if (this.graceTimer) {
      clearTimeout(this.graceTimer)
      this.graceTimer = null
    }
  }

  private writeData(chunk: Uint8Array): void {
    if (!this.sink) return
    this.sink.write(chunk)
    this.transferred += chunk.length
  }

  private maybeEmitProgress(): void {
    if (this.transferred === this.lastProgressBytes) return
    this.emitProgress()
  }

  private emitProgress(): void {
    const now = Date.now()
    if (now - this.lastProgressAt < PROGRESS_INTERVAL_MS && this.transferred < this.total) return
    this.lastProgressAt = now
    this.lastProgressBytes = this.transferred
    this.hooks.onProgress({
      direction: this.direction,
      name: this.name,
      transferred: this.transferred,
      total: this.total
    })
  }

  private abort(message: string): void {
    if (this.finished) return
    this.finished = true
    this.clearGrace()
    this.sink?.abort()
    this.sink = null
    try {
      this.hooks.send(CANCEL_SEQUENCE)
    } catch {
      // 通道已经断了算了
    }
    // 文件已经收完、只是 ZFIN 没等到，就不要报失败，否则用户会看到「成功」后紧跟一条报错
    if (!this.fileDone) {
      this.hooks.onDone({
        direction: this.direction,
        name: this.name,
        ok: false,
        message
      })
    }
  }
}
