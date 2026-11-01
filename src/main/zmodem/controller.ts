import { dialog, type BrowserWindow } from 'electron'
import { closeSync, openSync, readSync, statSync, unlinkSync, writeSync } from 'node:fs'
import { basename, join } from 'node:path'
import { app } from 'electron'
import type { MainEvent, ZmodemState } from '../../shared/types'
import { ZmodemScanner } from './detect'
import {
  ZmodemEngine,
  type ZmodemResult,
  type ZmodemSink,
  type ZmodemSource
} from './engine'

type EmitFn = (event: MainEvent) => void

/**
 * 弹窗行为抽成接口，只为一个目的：真实链路自测（ZMODEM_E2E=1）要能自动应答。
 * 生产路径永远走 electronDialogs，没有第二种实现。
 */
export interface ZmodemDialogs {
  /** 问接收的文件存哪儿；返回 null 表示用户取消 */
  save(win: BrowserWindow | null, name: string, size: number): Promise<string | null>
  /** 问要发哪些文件；返回 null 表示用户取消 */
  pick(win: BrowserWindow | null): Promise<string[] | null>
}

const electronDialogs: ZmodemDialogs = {
  async save(win, name, size) {
    const defaultPath = join(app.getPath('downloads'), safeName(name))
    const options = {
      title: `接收 ${name}（${formatSize(size)}）`,
      defaultPath,
      buttonLabel: '保存'
    }
    const res = win ? await dialog.showSaveDialog(win, options) : await dialog.showSaveDialog(options)
    return res.canceled || !res.filePath ? null : res.filePath
  },

  async pick(win) {
    const options = {
      title: '选择要发送的文件（可多选）',
      buttonLabel: '发送',
      properties: ['openFile', 'multiSelections'] as Array<'openFile' | 'multiSelections'>
    }
    const res = win
      ? await dialog.showOpenDialog(win, options)
      : await dialog.showOpenDialog(options)
    return res.canceled || res.filePaths.length === 0 ? null : res.filePaths
  }
}

/**
 * ZMODEM 检测与外壳。
 *
 * 远端敲 `sz` / `rz` 时，lrzsz 会先往终端吐一串控制序列，特征都是
 * `**` + ZDLE(0x18) + 'B' + 两字节十六进制帧类型：
 *
 *   `**\x18B00`  ZRQINIT  —— 远端要发文件给我们（sz，下载）
 *   `**\x18B01`  ZRINIT   —— 远端等着收文件（rz，上传）
 *
 * 命中后把后续字节全部交给协议引擎，不再往终端送，直到会话结束。
 * 检测不到就正常显示，对普通输出没有影响。
 */
export class ZmodemController {
  private readonly sessionId: string
  private readonly emit: EmitFn
  private readonly sendBytes: (bytes: Uint8Array) => void
  private readonly getWindow: () => BrowserWindow | null
  private readonly dialogs: ZmodemDialogs

  /** 控制序列可能被 TCP 切成两半，跨包拼接交给它 */
  private readonly scanner = new ZmodemScanner()
  private engine: ZmodemEngine | null = null
  private sources: ZmodemSource[] = []

  constructor(opts: {
    sessionId: string
    emit: EmitFn
    send: (bytes: Uint8Array) => void
    getWindow: () => BrowserWindow | null
    dialogs?: ZmodemDialogs
  }) {
    this.sessionId = opts.sessionId
    this.emit = opts.emit
    this.sendBytes = opts.send
    this.getWindow = opts.getWindow
    this.dialogs = opts.dialogs ?? electronDialogs
  }

  get busy(): boolean {
    return this.engine !== null && !this.engine.isFinished
  }

  /**
   * 返回应该送进终端的字节；返回 null 表示这段数据被传输吃掉了。
   */
  onData(chunk: Buffer): Uint8Array | null {
    if (this.engine) {
      if (!this.engine.isFinished) {
        this.engine.feed(chunk)
        return null
      }
      // 传输结束，引擎交回控制权，剩下的字节（比如远端跟着打印的提示符）照常显示
      this.engine = null
    }

    const { shown, hit } = this.scanner.push(chunk)
    if (!hit) return shown
    this.beginEngine(hit.direction, hit.rest)
    return shown
  }

  /** 传输期间吞掉键盘输入，只放行 Ctrl+C 作为中止 */
  onInput(data: string): boolean {
    if (!this.busy) return false
    if (data.includes('\u0003')) this.engine?.cancel()
    return true
  }

  cancel(): void {
    this.engine?.cancel()
  }

  /** 会话关闭时调用：半截文件要清掉 */
  dispose(): void {
    this.engine?.cancel()
    this.engine = null
    this.closeSources()
  }

  // ---------------------------------------------------------------- 内部

  private beginEngine(direction: 'download' | 'upload', initial: Buffer): void {
    const engine = new ZmodemEngine(
      {
        send: (bytes) => this.sendBytes(bytes),
        beginDownload: (name, size) => this.askSavePath(name, size),
        pickUpload: () => this.askUploadFiles(),
        onProgress: (p) => this.pushState({ status: 'active', ...p, sessionId: this.sessionId }),
        onDone: (r) => this.handleDone(r)
      },
      direction
    )

    this.engine = engine

    if (direction === 'upload') {
      // 顺序很重要：先把用户选文件这一步开起来（会立刻进入 awaiting），
      // 再把这帧 ZRINIT 交进去。否则状态机在「还没有文件」的状态下吃掉 ZRINIT，
      // 之后 startFile 时它已经错过握手，只能干等远端重发（lrzsz 是几秒一次），
      // 表现就是敲完 rz 之后要愣好几秒才开始传。
      void engine.startUpload()
      engine.feed(initial)
    } else {
      engine.feed(initial)
    }
  }

  private handleDone(result: ZmodemResult): void {
    this.pushState({
      sessionId: this.sessionId,
      direction: result.direction,
      name: result.name,
      transferred: 0,
      total: 0,
      status: result.ok ? 'done' : 'error',
      path: result.path,
      message: result.message
    })
    if (result.ok) this.closeSources()
  }

  private pushState(state: ZmodemState): void {
    this.emit({ type: 'zmodem:update', state })
  }

  private closeSources(): void {
    for (const src of this.sources) {
      if (src instanceof FileSource) src.close()
    }
    this.sources = []
  }

  /**
   * 弹保存对话框。
   *
   * 这里**不能**去 pause 底层 stream：ZMODEM 的发送方在拿到我们的 ZRINIT 之前不会发文件数据，
   * 弹窗期间本来就没有洪水；而 ssh2 的 Channel 一旦 pause，暂停期间到达的数据可能再也不投递，
   * 表现就是弹完窗传输卡死（踩过）。等待期间到达的零星字节由引擎的 pendingChunks 兜着。
   */
  private async askSavePath(name: string, size: number): Promise<ZmodemSink | null> {
    try {
      const path = await this.dialogs.save(this.getWindow(), name, size)
      if (!path) return null
      this.closeSources()
      return new FileSink(path)
    } catch (err) {
      this.pushState({
        sessionId: this.sessionId,
        direction: 'download',
        name,
        transferred: 0,
        total: size,
        status: 'error',
        message: (err as Error).message
      })
      return null
    }
  }

  /** 弹文件选择框，返回选中的本地文件 */
  private async askUploadFiles(): Promise<ZmodemSource[] | null> {
    try {
      const paths = await this.dialogs.pick(this.getWindow())
      if (!paths) return null

      const sources: ZmodemSource[] = []
      for (const filePath of paths) {
        const stat = statSync(filePath)
        sources.push(new FileSource(filePath, basename(filePath), stat.size, stat.mtimeMs))
      }
      this.closeSources()
      this.sources = sources
      return sources
    } catch (err) {
      this.pushState({
        sessionId: this.sessionId,
        direction: 'upload',
        name: '',
        transferred: 0,
        total: 0,
        status: 'error',
        message: (err as Error).message
      })
      return null
    }
  }
}

function safeName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/g, '_') || 'download.bin'
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  return `${(bytes / 1024 / 1024 / 1024).toFixed(2)} GB`
}

/** 落盘的接收端：同步写，保证顺序，8KB 级别的块开销可以忽略 */
class FileSink implements ZmodemSink {
  readonly path: string
  private fd: number

  constructor(path: string) {
    this.path = path
    this.fd = openSync(path, 'w')
  }

  write(chunk: Uint8Array): void {
    writeSync(this.fd, chunk)
  }

  close(): void {
    closeSync(this.fd)
  }

  abort(): void {
    try {
      closeSync(this.fd)
    } catch {
      // 已经关了
    }
    try {
      unlinkSync(this.path)
    } catch {
      // 文件可能根本没建起来
    }
  }
}

class FileSource implements ZmodemSource {
  readonly path: string
  readonly name: string
  readonly size: number
  readonly mtime: number
  private fd: number

  constructor(path: string, name: string, size: number, mtime: number) {
    this.path = path
    this.name = name
    this.size = size
    this.mtime = mtime
    this.fd = openSync(path, 'r')
  }

  read(offset: number, len: number): Uint8Array {
    const buf = Buffer.allocUnsafe(len)
    const read = readSync(this.fd, buf, 0, len, offset)
    return buf.subarray(0, read)
  }

  close(): void {
    try {
      closeSync(this.fd)
    } catch {
      // 已经关了
    }
  }
}
