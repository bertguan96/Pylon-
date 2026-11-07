/**
 * VNC 认证用的 DES。
 *
 * RFB 规范里只有「VNC Authentication」（安全类型 2）这一种密码认证是绕不开 DES 的：
 * 服务端发 16 字节挑战，客户端用密码派生出的密钥做两轮 ECB 加密后回传。
 *
 * 密钥的派生有个反直觉的地方：密码每个字节都要**按位倒序**，不足 8 字节补 0。
 * 这是历史包袱（早期实现把字节当位流读），但不这么做认证一定失败。
 *
 * DES 本身用 Node/Electron 的 crypto 实现（Electron 的 BoringSSL 仍然保留 des-ecb，
 * 已用标准测试向量验证过）。不自己写 S 盒 —— 那是 512 个常量，抄错一个就是
 * 「密码明明对但连不上」，且极难排查。
 */

import { createCipheriv } from 'node:crypto'

/** 把一个字节的 8 个 bit 反转：0b10110001 -> 0b10001101 */
function reverseBits(byte: number): number {
  let out = 0
  for (let i = 0; i < 8; i++) {
    out = (out << 1) | ((byte >> i) & 1)
  }
  return out
}

/** 单块 DES-ECB 加密（8 字节进 8 字节出，不做填充） */
export function desEncryptBlock(key: Buffer, block: Buffer): Buffer {
  if (key.length !== 8) throw new Error('DES 密钥必须是 8 字节')
  if (block.length !== 8) throw new Error('DES 明文块必须是 8 字节')
  const cipher = createCipheriv('des-ecb', key, null)
  cipher.setAutoPadding(false)
  return Buffer.concat([cipher.update(block), cipher.final()])
}

/**
 * 由密码算出应答。
 *
 * @param challenge 服务端发来的 16 字节挑战
 * @param password  用户输入的密码，超过 8 字节的部分会被丢弃（协议限制，不是我们的选择）
 */
export function vncAuthResponse(challenge: Buffer, password: string): Buffer {
  if (challenge.length !== 16) throw new Error('VNC 挑战必须是 16 字节')

  // 8 字节以内有效；VNC 协议本身只认前 8 个字节
  const raw = Buffer.from(password, 'utf8').subarray(0, 8)
  const key = Buffer.alloc(16)
  for (let i = 0; i < 8; i++) {
    // 缺的位补 0，然后整字节倒序
    key[i] = reverseBits(i < raw.length ? raw[i] : 0)
  }

  return Buffer.concat([
    desEncryptBlock(key.subarray(0, 8), challenge.subarray(0, 8)),
    desEncryptBlock(key.subarray(8, 16), challenge.subarray(8, 16))
  ])
}

/**
 * 用 DES 标准测试向量自查一遍。
 *
 * 密钥 0123456789ABCDEF、明文 "Now is t" 的密文是公开标准值。
 * 换 Node / Electron 版本后如果底层把 DES 拿掉了，这里会第一个炸出来，
 * 而不是等到用户连 Mac 时看到一句「密码错误」。
 */
export function desSelfTest(): boolean {
  const key = Buffer.from('0123456789abcdef', 'hex')
  const plain = Buffer.from('4e6f772069732074', 'hex')
  const expected = '3fa40e8a984d4815'
  try {
    return desEncryptBlock(key, plain).toString('hex') === expected
  } catch {
    return false
  }
}
