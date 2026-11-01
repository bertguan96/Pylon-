import type { Client as SshClient } from 'ssh2'

export interface Ssh2Module {
  Client: new () => SshClient
}

let pending: Promise<Ssh2Module> | null = null

/**
 * 延迟加载 ssh2。
 *
 * 它连带 asn1、bcrypt-pbkdf 等依赖，实测 require 一次要 38ms，而且全部压在启动关键路径上
 * （主进程入口 → session-manager → ssh2）。用户打开窗口、连上第一台机器之前一行代码都用不到它，
 * 所以改成首次建连/首次诊断时才加载，把这段时间从启动里摘出去。
 *
 * ssh2 是 CommonJS 包，动态 import 后既可能拿到命名导出也可能只拿到 default，两种都兼容。
 */
export function loadSsh2(): Promise<Ssh2Module> {
  if (!pending) {
    pending = import('ssh2').then((m) => {
      const mod = m as unknown as Ssh2Module & { default?: Ssh2Module }
      const resolved = mod.Client ? mod : mod.default
      if (!resolved?.Client) throw new Error('ssh2 加载失败：找不到 Client 导出')
      return resolved
    })
    // 加载失败时清空缓存，下次重试还能再来一遍
    pending.catch(() => {
      pending = null
    })
  }
  return pending
}
