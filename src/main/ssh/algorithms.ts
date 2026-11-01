import type { Algorithms } from 'ssh2'

/**
 * 老设备兼容算法白名单。
 *
 * 现代 OpenSSH 已经默认移除了 sha1 系列 KEX、CBC 模式和 3des，
 * 但一批摄像头、老 NAS、老交换机仍在用它们。开启后把这些算法追加回协商列表。
 *
 * 注意：这是「兼容」不是「降级加密」。只在用户显式打开开关时生效。
 */
export const LEGACY_ALGORITHMS = {
  kex: [
    'curve25519-sha256',
    'curve25519-sha256@libssh.org',
    'ecdh-sha2-nistp256',
    'ecdh-sha2-nistp384',
    'ecdh-sha2-nistp521',
    'diffie-hellman-group-exchange-sha256',
    'diffie-hellman-group14-sha256',
    'diffie-hellman-group16-sha512',
    'diffie-hellman-group18-sha512',
    'diffie-hellman-group14-sha1',
    'diffie-hellman-group-exchange-sha1',
    'diffie-hellman-group1-sha1'
  ],
  cipher: [
    'aes128-gcm@openssh.com',
    'aes256-gcm@openssh.com',
    'aes128-ctr',
    'aes192-ctr',
    'aes256-ctr',
    'aes128-cbc',
    'aes192-cbc',
    'aes256-cbc',
    '3des-cbc'
  ],
  serverHostKey: [
    'ssh-ed25519',
    'ecdsa-sha2-nistp256',
    'ecdsa-sha2-nistp384',
    'ecdsa-sha2-nistp521',
    'rsa-sha2-512',
    'rsa-sha2-256',
    'ssh-rsa',
    'ssh-dss'
  ],
  hmac: [
    'hmac-sha2-256-etm@openssh.com',
    'hmac-sha2-512-etm@openssh.com',
    'hmac-sha1-etm@openssh.com',
    'hmac-sha2-256',
    'hmac-sha2-512',
    'hmac-sha1',
    'hmac-md5'
  ]
} as unknown as Algorithms

/** 判断报错是否属于「算法协商失败」，这类问题可以靠兼容开关解决 */
export function isAlgorithmMismatch(message: string): boolean {
  return /no matching (key exchange|host key|cipher|mac|compression) algorithm/i.test(message)
}
