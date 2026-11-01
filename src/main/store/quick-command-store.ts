import { app } from 'electron'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { QuickCommand, QuickCommandInput } from '../../shared/types'
import { BUILTIN_QUICK_COMMANDS } from '../../shared/quick-commands'

interface StoreShape {
  version: 1
  commands: QuickCommand[]
}

const EMPTY: StoreShape = { version: 1, commands: [] }

/**
 * 自定义快捷命令仓库。
 *
 * 这里存的是命令文本，没有密钥，所以直接写明文 JSON —— 与 connections.json 一致。
 * 内置命令不落盘，每次从 shared/quick-commands.ts 读取，
 * 这样版本升级后内置库的修正能直接生效，不会被旧快照覆盖。
 */
export class QuickCommandStore {
  private file: string
  private data: StoreShape = EMPTY

  constructor() {
    this.file = join(app.getPath('userData'), 'quick-commands.json')
  }

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.file, 'utf8')
      const parsed = JSON.parse(raw) as StoreShape
      this.data = Array.isArray(parsed?.commands) ? parsed : EMPTY
    } catch {
      // 文件不存在或 JSON 损坏都退回空列表，不影响启动
      this.data = EMPTY
    }
  }

  /** 先写临时文件再改名，避免写一半断电把命令库写坏 */
  private async persist(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    const tmp = `${this.file}.tmp`
    await writeFile(tmp, JSON.stringify(this.data, null, 2), 'utf8')
    await rename(tmp, this.file)
  }

  /** 内置在前、自定义在后，各自按分组顺序排列，渲染端直接遍历即可 */
  list(): QuickCommand[] {
    return [
      ...BUILTIN_QUICK_COMMANDS,
      ...this.data.commands.map((c) => ({ ...c, builtin: false }))
    ]
  }

  async upsert(input: QuickCommandInput): Promise<QuickCommand> {
    const label = input.label?.trim()
    const command = input.command?.trim()
    if (!label) throw new Error('命令名称不能为空')
    if (!command) throw new Error('命令内容不能为空')

    const existing = input.id ? this.data.commands.find((c) => c.id === input.id) : undefined

    // 内置命令是只读的，不允许通过 save 覆盖同名 id
    if (input.id?.startsWith('builtin:') && !existing) {
      throw new Error('内置命令不可修改')
    }

    const record: QuickCommand = {
      id: existing?.id ?? randomUUID(),
      label,
      command,
      group: input.group?.trim() || '我的命令',
      autoRun: input.autoRun,
      builtin: false,
      description: input.description?.trim() || undefined
    }

    const idx = this.data.commands.findIndex((c) => c.id === record.id)
    if (idx >= 0) this.data.commands[idx] = record
    else this.data.commands.push(record)

    await this.persist()
    return record
  }

  async remove(id: string): Promise<void> {
    if (id.startsWith('builtin:')) throw new Error('内置命令不可删除')
    this.data.commands = this.data.commands.filter((c) => c.id !== id)
    await this.persist()
  }
}
