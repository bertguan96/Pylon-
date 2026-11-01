import { isAlgorithmMismatch } from './algorithms'

export interface ErrorContext {
  host: string
  port: number
}

/**
 * 把 ssh2 / Node 的英文报错翻成能直接指导操作的中文，同时保留原文便于搜索。
 * 会话层和诊断器共用，保证同一问题在两处提示一致。
 */
export function translateSshError(raw: string, ctx: ErrorContext): string {
  if (/All configured authentication methods failed/i.test(raw)) {
    return `认证失败：用户名、密码或密钥不正确（${raw}）`
  }
  if (/Cannot parse privateKey/i.test(raw)) {
    return `私钥解析失败：文件格式不支持或已损坏（${raw}）`
  }
  if (/Encrypted private OpenSSH key detected, but no passphrase given/i.test(raw)) {
    return '私钥已加密，需要提供口令'
  }
  if (isAlgorithmMismatch(raw)) {
    return `算法协商失败，服务器版本过旧。请打开该连接的「兼容老算法」开关（${raw}）`
  }
  if (/ECONNREFUSED/.test(raw)) {
    return `连接被拒绝：${ctx.host}:${ctx.port} 上没有 SSH 服务`
  }
  if (/ETIMEDOUT|Timed out while waiting/i.test(raw)) {
    return `连接超时：${ctx.host} 无响应，检查 IP 与防火墙`
  }
  if (/ENOTFOUND|EAI_AGAIN/.test(raw)) {
    return `主机名无法解析：${ctx.host}`
  }
  if (/EHOSTUNREACH|ENETUNREACH/.test(raw)) {
    return `网络不可达：${ctx.host}，确认与该网段连通`
  }
  if (/EOF|ECONNRESET/i.test(raw)) {
    return `连接被对端中断，通常是同一 IP 密码错误次数过多触发封禁（${raw}）`
  }
  return raw
}
