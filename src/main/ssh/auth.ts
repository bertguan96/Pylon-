import { readFile } from 'node:fs/promises'
import type { Client, ConnectConfig } from 'ssh2'
import type { AuthType } from '../../shared/types'

/** ssh2 在 Windows 下只能通过 named pipe 访问 OpenSSH agent */
export function defaultAgentPath(): string | undefined {
  if (process.platform === 'win32') return '\\\\.\\pipe\\openssh-ssh-agent'
  return process.env.SSH_AUTH_SOCK
}

export interface AuthSource {
  authType: AuthType
  privateKeyPath?: string
}

export interface AuthResult {
  /** 直接展开进 client.connect() 的选项 */
  options: Partial<ConnectConfig>
  /**
   * keyboard-interactive 需要应答时用的密码。
   * ssh2 v1 没有 onKeyboardInteractive 连接选项，只能监听 client 的
   * 'keyboard-interactive' 事件来应答，所以这里把密码带给调用方。
   */
  keyboardSecret?: string
}

/**
 * 把认证配置翻译成 ssh2 的连接选项。
 * 会话层和诊断器共用这一份，避免两处逻辑不一致导致「能测通但连不上」。
 */
export async function buildAuthConfig(
  src: AuthSource,
  secret?: string
): Promise<AuthResult> {
  if (src.authType === 'privateKey') {
    if (!src.privateKeyPath) throw new Error('未指定私钥文件路径')
    const privateKey = await readFile(src.privateKeyPath)
    return { options: { privateKey, passphrase: secret } }
  }

  if (src.authType === 'agent') {
    const agent = defaultAgentPath()
    if (!agent) {
      throw new Error('未找到 SSH agent（Windows 需启用 OpenSSH Authentication Agent 服务）')
    }
    return { options: { agent } }
  }

  if (!secret) throw new Error('该连接未保存密码，请重新输入')

  // 同时开启 keyboard-interactive：部分云主机与老设备禁用了 password 方式，只认交互式
  return {
    options: { password: secret, tryKeyboard: true },
    keyboardSecret: secret
  }
}

/**
 * 为需要 keyboard-interactive 的连接挂上应答器。
 * 服务器可能一次给多个 prompt（如密码 + 动态验证码），这里统一用同一密码应答，
 * 对绝大多数单密码场景是正确的；带二次验证的服务器会明确失败而不是静默错连。
 */
export function attachKeyboardHandler(client: Client, result: AuthResult): void {
  if (!result.keyboardSecret) return
  const secret = result.keyboardSecret
  client.on(
    'keyboard-interactive',
    (_name: string, _instr: string, _lang: string, prompts: unknown[], finish: (r: string[]) => void) => {
      finish(prompts.map(() => secret))
    }
  )
}
