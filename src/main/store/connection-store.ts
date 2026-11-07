import { app, safeStorage } from 'electron'
import { readFile, writeFile, rename, mkdir } from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { dirname, join } from 'node:path'
import type { ConnectionConfig, ConnectionInput } from '../../shared/types'

interface StoreShape {
  version: 1
  connections: ConnectionConfig[]
}

const EMPTY: StoreShape = { version: 1, connections: [] }

interface SafeStorageLike {
  isAsyncEncryptionAvailable?: () => Promise<boolean>
  isEncryptionAvailable?: () => boolean
  encryptString?: (plain: string) => Buffer
  encryptStringAsync?: (plain: string) => Promise<Buffer>
  decryptString?: (buffer: Buffer) => string
  decryptStringAsync?: (buffer: Buffer) => Promise<string>
}

/**
 * Electron 45 起 safeStorage 的同步 API 已废弃，但异步 API 在旧版本上不存在。
 * 这里做一层兼容：优先异步，回退同步，两种运行时都能工作。
 */
const storage = () => safeStorage as unknown as SafeStorageLike

async function encryptionAvailable(): Promise<boolean> {
  const s = storage()
  if (typeof s.isAsyncEncryptionAvailable === 'function') return s.isAsyncEncryptionAvailable()
  return s.isEncryptionAvailable?.() ?? false
}

async function encrypt(plain: string): Promise<Buffer> {
  const s = storage()
  if (s.encryptStringAsync) return s.encryptStringAsync(plain)
  if (!s.encryptString) throw new Error('safeStorage 不可用')
  return s.encryptString(plain)
}

async function decrypt(cipher: Buffer): Promise<string> {
  const s = storage()
  if (s.decryptStringAsync) {
    const out = await s.decryptStringAsync(cipher)
    // Electron 45+ 返回 { shouldReEncrypt, result } 包装对象；旧版直接返回字符串
    if (typeof out === 'string') return out
    const unwrapped = out as { result?: string }
    if (typeof unwrapped?.result === 'string') return unwrapped.result
    throw new Error('safeStorage 解密结果格式未知')
  }
  if (!s.decryptString) throw new Error('safeStorage 不可用')
  return s.decryptString(cipher)
}

/**
 * 连接配置 + 凭据仓库。
 *
 * 安全约定：
 * 1. 配置文件（connections.json）永远不含密码/口令。
 * 2. 凭据单独存在 secrets.json，值经 safeStorage 加密（Windows 走 DPAPI，绑当前用户）。
 * 3. 若系统加密不可用，凭据只留在内存，进程退出即失效 —— 宁可让用户重输，也不写明文。
 */
export class ConnectionStore {
  private file: string
  private secretFile: string
  private data: StoreShape = EMPTY
  /** id -> base64(密文) */
  private secrets: Record<string, string> = {}
  /** 加密不可用时的降级容器，仅存活于本次运行 */
  private memorySecrets = new Map<string, string>()

  constructor() {
    const dir = app.getPath('userData')
    this.file = join(dir, 'connections.json')
    this.secretFile = join(dir, 'secrets.json')
  }

  async load(): Promise<void> {
    this.data = await this.readJson<StoreShape>(this.file, EMPTY)
    this.secrets = await this.readJson<Record<string, string>>(this.secretFile, {})
  }

  private async readJson<T>(path: string, fallback: T): Promise<T> {
    try {
      const raw = await readFile(path, 'utf8')
      return JSON.parse(raw) as T
    } catch {
      // 文件不存在 / JSON 损坏都退回初始值，不让应用起不来
      return fallback
    }
  }

  /** 先写临时文件再 rename，避免写一半断电导致配置全丢 */
  private async writeJsonAtomic(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true })
    const tmp = `${path}.tmp`
    await writeFile(tmp, JSON.stringify(value, null, 2), 'utf8')
    await rename(tmp, path)
  }

  list(): ConnectionConfig[] {
    return [...this.data.connections].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN'))
  }

  get(id: string): ConnectionConfig | undefined {
    return this.data.connections.find((c) => c.id === id)
  }

  async upsert(input: ConnectionInput): Promise<ConnectionConfig> {
    const now = Date.now()
    const existing = input.id ? this.get(input.id) : undefined

    const id = existing?.id ?? randomUUID()
    let hasSecret = existing?.hasSecret ?? false

    if (input.secret !== undefined) {
      if (input.secret === '') {
        await this.deleteSecret(id)
        hasSecret = false
      } else {
        await this.setSecret(id, input.secret, input.rememberSecret !== false)
        hasSecret = true
      }
    }

    const kind = input.kind === 'vnc' ? 'vnc' : 'ssh'
    const record: ConnectionConfig = {
      id,
      kind,
      name: input.name.trim() || input.host,
      host: input.host.trim(),
      port: input.port || (kind === 'vnc' ? 5900 : 22),
      // 远程桌面没有用户名这个概念，留着空串而不是 undefined，省得下游到处判空
      username: input.username?.trim() ?? '',
      authType: input.authType,
      privateKeyPath: input.privateKeyPath || undefined,
      group: input.group?.trim() || undefined,
      color: input.color || undefined,
      legacyAlgorithms: input.legacyAlgorithms,
      timeout: input.timeout ?? 15000,
      hasSecret,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now
    }

    const idx = this.data.connections.findIndex((c) => c.id === id)
    if (idx >= 0) this.data.connections[idx] = record
    else this.data.connections.push(record)

    await this.writeJsonAtomic(this.file, this.data)
    return record
  }

  async remove(id: string): Promise<void> {
    this.data.connections = this.data.connections.filter((c) => c.id !== id)
    await this.writeJsonAtomic(this.file, this.data)
    await this.deleteSecret(id)
  }

  private async setSecret(id: string, plain: string, persist: boolean): Promise<void> {
    if (!persist) {
      this.memorySecrets.set(id, plain)
      return
    }
    if (!(await encryptionAvailable())) {
      // 降级：不落盘，只保留在内存
      this.memorySecrets.set(id, plain)
      return
    }
    const encrypted = (await encrypt(plain)).toString('base64')
    this.secrets[id] = encrypted
    await this.writeJsonAtomic(this.secretFile, this.secrets)
    this.memorySecrets.delete(id)
  }

  private async deleteSecret(id: string): Promise<void> {
    this.memorySecrets.delete(id)
    if (this.secrets[id]) {
      delete this.secrets[id]
      await this.writeJsonAtomic(this.secretFile, this.secrets)
    }
  }

  /** 取出明文凭据供建连使用，调用方用完即弃，不要缓存到别处 */
  async getSecret(id: string): Promise<string | undefined> {
    if (this.memorySecrets.has(id)) return this.memorySecrets.get(id)
    const cipher = this.secrets[id]
    if (!cipher) return undefined
    if (!(await encryptionAvailable())) return undefined
    try {
      return await decrypt(Buffer.from(cipher, 'base64'))
    } catch {
      // 换机器 / 换用户后 DPAPI 解不开，属于正常情况
      return undefined
    }
  }
}
