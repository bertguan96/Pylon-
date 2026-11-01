#!/usr/bin/env node
/**
 * 服务器 SSH 连通性探测 —— 开发期的独立诊断工具，不依赖 Electron。
 *
 * 用法：
 *   node scripts/probe.mjs 192.168.1.199 -u admin
 *   node scripts/probe.mjs nas.local -p 2222 -u root --legacy
 *   node scripts/probe.mjs 10.0.0.5 -u root -k ~/.ssh/id_ed25519
 *   node scripts/probe.mjs 10.0.0.5 -u root -P '密码'
 *
 * 退出码：0 成功，1 失败。方便串进批处理。
 */
import ssh2 from 'ssh2'

// ssh2 是 CommonJS 包，命名导出在 ESM 下不可靠，统一走默认导入
const { Client } = ssh2
import net from 'node:net'
import { readFileSync, existsSync } from 'node:fs'
import { homedir } from 'node:os'
import { resolve as resolvePath } from 'node:path'

const C = {
  reset: '\x1b[0m',
  dim: '\x1b[2m',
  bold: '\x1b[1m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[36m'
}

const LEGACY = {
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
}

function parseArgs(argv) {
  const opts = { host: '', port: 22, user: '', key: '', password: '', legacy: false, timeout: 12000 }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '-u' || a === '--user') opts.user = argv[++i]
    else if (a === '-p' || a === '--port') opts.port = Number(argv[++i])
    else if (a === '-k' || a === '--key') opts.key = argv[++i]
    else if (a === '-P' || a === '--password') opts.password = argv[++i]
    else if (a === '--legacy') opts.legacy = true
    else if (a === '-t' || a === '--timeout') opts.timeout = Number(argv[++i])
    else if (!a.startsWith('-')) opts.host = a
  }
  return opts
}

/** 关闭回显地读一行输入，用于密码 */
function askHidden(question) {
  return new Promise((resolve) => {
    process.stdout.write(question)
    const stdin = process.stdin
    const wasRaw = stdin.isRaw
    if (stdin.isTTY) stdin.setRawMode(true)
    stdin.resume()
    stdin.setEncoding('utf8')

    let value = ''
    const onData = (chunk) => {
      for (const ch of chunk) {
        if (ch === '\n' || ch === '\r' || ch === '\u0004') {
          cleanup()
          process.stdout.write('\n')
          resolve(value)
          return
        }
        if (ch === '\u0003') {
          cleanup()
          process.stdout.write('\n')
          process.exit(130)
        }
        if (ch === '\u007f' || ch === '\b') {
          value = value.slice(0, -1)
          continue
        }
        value += ch
      }
    }
    const cleanup = () => {
      stdin.removeListener('data', onData)
      if (stdin.isTTY) stdin.setRawMode(wasRaw ?? false)
      stdin.pause()
    }
    stdin.on('data', onData)
  })
}

function expandPath(p) {
  if (p.startsWith('~')) return resolvePath(homedir(), p.slice(1).replace(/^[\\/]/, ''))
  return resolvePath(p)
}

function probeTcp(host, port, timeout) {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    const socket = net.connect({ host, port })
    let settled = false
    const done = (err) => {
      if (settled) return
      settled = true
      socket.destroy()
      err ? reject(err) : resolve(Date.now() - started)
    }
    socket.setTimeout(timeout, () => done(new Error('TCP 连接超时')))
    socket.once('connect', () => done())
    socket.once('error', done)
  })
}

function tryAuth(opts, password, useLegacy) {
  return new Promise((resolve, reject) => {
    const client = new Client()
    let negotiated = null
    let stage = 'handshake'
    let settled = false

    const fail = (err) => {
      if (settled) return
      settled = true
      client.end()
      reject(Object.assign(err instanceof Error ? err : new Error(String(err)), { stage, negotiated }))
    }

    client.on('handshake', (n) => {
      stage = 'auth'
      negotiated = {
        kex: n.kex,
        cipher: n.cs?.cipher,
        mac: n.cs?.mac,
        hostKey: n.srvHostKey
      }
    })

    client.on('keyboard-interactive', (_n, _i, _l, prompts, finish) => {
      finish(prompts.map(() => password))
    })

    client.on('ready', () => {
      stage = 'shell'
      client.exec('echo __probe_ok__', (err, stream) => {
        if (err) return fail(new Error(`认证通过但无法执行命令：${err.message}`))
        let out = ''
        stream.on('data', (d) => (out += d.toString()))
        stream.stderr.on('data', () => undefined)
        stream.on('close', () => {
          if (settled) return
          settled = true
          client.end()
          resolve({ negotiated, output: out.trim() })
        })
      })
    })

    client.on('error', fail)

    const connectCfg = {
      host: opts.host,
      port: opts.port,
      username: opts.user,
      readyTimeout: opts.timeout,
      tryKeyboard: true
    }
    if (useLegacy) connectCfg.algorithms = LEGACY
    if (opts.key) {
      const keyPath = expandPath(opts.key)
      if (!existsSync(keyPath)) return fail(new Error(`私钥文件不存在：${keyPath}`))
      connectCfg.privateKey = readFileSync(keyPath)
      if (password) connectCfg.passphrase = password
    } else {
      connectCfg.password = password
    }

    try {
      client.connect(connectCfg)
    } catch (err) {
      fail(err)
    }
  })
}

function friendly(raw) {
  if (/All configured authentication methods failed/i.test(raw))
    return '认证失败：用户名或密码/密钥不正确'
  if (/no matching (key exchange|host key|cipher|mac)/i.test(raw))
    return '算法协商失败：服务器过旧，加 --legacy 再试'
  if (/ECONNREFUSED/.test(raw)) return '端口上没有 SSH 服务'
  if (/ETIMEDOUT/i.test(raw)) return '连接超时，检查 IP 与防火墙'
  if (/ENOTFOUND/i.test(raw)) return '主机名无法解析'
  if (/Cannot parse privateKey/i.test(raw)) return '私钥格式不支持或文件损坏'
  return raw
}

async function main() {
  const opts = parseArgs(process.argv.slice(2))

  if (!opts.host) {
    console.log(`${C.bold}用法${C.reset}  node scripts/probe.mjs <host> [-u 用户] [-p 端口] [-k 私钥] [-P 密码] [--legacy]`)
    process.exit(1)
  }

  const password = opts.password || opts.key || !process.stdin.isTTY
    ? opts.password
    : await askHidden(`密码（${opts.user}@${opts.host}）: `)

  console.log(`${C.dim}探测 ${opts.user}@${opts.host}:${opts.port}${C.reset}`)

  let latency
  try {
    latency = await probeTcp(opts.host, opts.port, Math.min(opts.timeout, 8000))
    console.log(`  ${C.green}✓${C.reset} TCP 连通 ${C.dim}(${latency}ms)${C.reset}`)
  } catch (err) {
    console.log(`  ${C.red}✗${C.reset} TCP 失败：${friendly(err.message)}`)
    process.exit(1)
  }

  const runAttempt = async (useLegacy) => tryAuth(opts, password, useLegacy)

  let result
  try {
    result = await runAttempt(opts.legacy)
  } catch (err) {
    const message = err.message || String(err)

    if (err.stage === 'handshake' && !opts.legacy && /no matching/i.test(message)) {
      console.log(`  ${C.yellow}!${C.reset} 默认算法协商失败，自动以 --legacy 重试…`)
      try {
        result = await runAttempt(true)
        console.log(`  ${C.green}✓${C.reset} 握手与认证通过 ${C.yellow}(需要兼容老算法)${C.reset}`)
      } catch (retryErr) {
        console.log(`  ${C.red}✗${C.reset} ${friendly(retryErr.message || String(retryErr))}`)
        process.exit(1)
      }
    } else {
      console.log(`  ${C.red}✗${C.reset} ${friendly(message)}`)
      if (err.negotiated) printNegotiated(err.negotiated)
      process.exit(1)
    }
  }

  if (result.negotiated) {
    console.log(`  ${C.green}✓${C.reset} 握手完成`)
    printNegotiated(result.negotiated)
  }
  console.log(`  ${C.green}✓${C.reset} 认证通过，命令执行正常`)

  if (result.output.includes('__probe_ok__')) {
    console.log(`\n${C.green}${C.bold}连接可用${C.reset} ${C.dim}${latency}ms${C.reset}`)
  }
  process.exit(0)
}

function printNegotiated(n) {
  const rows = [
    ['KEX', n.kex],
    ['Cipher', n.cipher],
    ['MAC', n.mac],
    ['HostKey', n.hostKey]
  ].filter(([, v]) => v)
  for (const [k, v] of rows) {
    console.log(`    ${C.dim}${k.padEnd(8)}${C.reset} ${v}`)
  }
}

main().catch((err) => {
  console.error(`${C.red}未预期错误${C.reset}`, err)
  process.exit(1)
})
