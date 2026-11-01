import { connect as netConnect } from 'node:net'
import { loadSsh2 } from './client'
import { LEGACY_ALGORITHMS, isAlgorithmMismatch } from './algorithms'
import { attachKeyboardHandler, buildAuthConfig, type AuthResult, type AuthSource } from './auth'
import { translateSshError } from './errors'
import type { DiagnoseResult } from '../../shared/types'

export interface DiagnoseSource extends AuthSource {
  host: string
  port: number
  username: string
  legacyAlgorithms: boolean
  timeout?: number
}

/** 带阶段标记的错误，用来区分到底卡在哪一步 */
class StageError extends Error {
  constructor(
    message: string,
    readonly stage: DiagnoseResult['stage'],
    readonly negotiated?: DiagnoseResult['negotiated']
  ) {
    super(message)
  }
}

/** 先单独探测 TCP，把「端口不通」和「SSH 协议问题」分开，避免混为一谈 */
function probeTcp(host: string, port: number, timeout: number): Promise<number> {
  return new Promise((resolve, reject) => {
    const started = Date.now()
    let settled = false
    const socket = netConnect({ host, port })

    const done = (err?: Error) => {
      if (settled) return
      settled = true
      socket.destroy()
      err ? reject(err) : resolve(Date.now() - started)
    }

    socket.setTimeout(timeout, () => done(new Error('TCP 连接超时')))
    socket.once('connect', () => done())
    socket.once('error', (err) => done(err))
  })
}

interface SshProbeResult {
  negotiated: DiagnoseResult['negotiated']
}

/** 完成握手 + 认证 + 打开 shell 三步验证 */
async function probeSsh(
  src: DiagnoseSource,
  auth: AuthResult,
  useLegacy: boolean,
  timeout: number
): Promise<SshProbeResult> {
  const { Client } = await loadSsh2()
  return new Promise((resolve, reject) => {
    const client = new Client()
    let stage: DiagnoseResult['stage'] = 'handshake'
    let negotiated: DiagnoseResult['negotiated'] = {}
    let settled = false

    const fail = (message: string, atStage: DiagnoseResult['stage']) => {
      if (settled) return
      settled = true
      client.end()
      reject(new StageError(message, atStage, negotiated))
    }

    client.on('handshake', (n) => {
      // 握手成功即说明算法协商通过，接下来只剩认证
      stage = 'auth'
      const info = n as unknown as {
        kex?: string
        srvHostKey?: string
        cs?: { cipher?: string; mac?: string }
      }
      negotiated = {
        kex: info.kex,
        serverHostKey: info.srvHostKey,
        cipher: info.cs?.cipher,
        mac: info.cs?.mac
      }
    })

    client.on('ready', () => {
      stage = 'shell'
      client.shell({ term: 'xterm-256color', cols: 80, rows: 24 }, (err, stream) => {
        if (err) {
          fail(`认证通过，但无法打开 shell：${err.message}`, 'shell')
          return
        }
        // 立刻关闭，诊断不需要占用会话
        stream.close()
        client.end()
        if (!settled) {
          settled = true
          resolve({ negotiated })
        }
      })
    })

    client.on('error', (err) => {
      fail(err.message || String(err), stage)
    })

    try {
      attachKeyboardHandler(client, auth)
      client.connect({
        host: src.host,
        port: src.port,
        username: src.username,
        readyTimeout: timeout,
        ...(useLegacy ? { algorithms: LEGACY_ALGORITHMS } : {}),
        ...auth.options
      })
    } catch (err) {
      fail((err as Error).message, stage)
    }
  })
}

/**
 * 分阶段诊断一条连接。
 * 若因算法协商失败、且用户没开兼容开关，会自动用老算法再试一次并如实告知，
 * 省得用户自己猜是不是设备太旧。
 */
export async function diagnose(src: DiagnoseSource, secret?: string): Promise<DiagnoseResult> {
  const timeout = src.timeout ?? 15000

  let latencyMs: number
  try {
    latencyMs = await probeTcp(src.host, src.port, Math.min(timeout, 8000))
  } catch (err) {
    return {
      ok: false,
      stage: 'tcp',
      message: translateSshError((err as Error).message, src)
    }
  }

  let auth: AuthResult
  try {
    auth = await buildAuthConfig(src, secret)
  } catch (err) {
    return { ok: false, stage: 'auth', message: (err as Error).message, latencyMs }
  }

  try {
    const result = await probeSsh(src, auth, src.legacyAlgorithms, timeout)
    return {
      ok: true,
      stage: 'done',
      message: '连接正常，认证通过',
      negotiated: result.negotiated,
      latencyMs
    }
  } catch (err) {
    const e = err as StageError

    // 算法协商失败且用户未开兼容 → 自动兜底重试一次
    if (e.stage === 'handshake' && isAlgorithmMismatch(e.message) && !src.legacyAlgorithms) {
      try {
        const result = await probeSsh(src, auth, true, timeout)
        return {
          ok: true,
          stage: 'done',
          message: '连接正常，但服务器要求兼容老算法（建议为该连接打开兼容开关）',
          negotiated: result.negotiated,
          latencyMs
        }
      } catch (retryErr) {
        const r = retryErr as StageError
        return {
          ok: false,
          stage: r.stage,
          message: translateSshError(r.message, src),
          negotiated: r.negotiated,
          latencyMs
        }
      }
    }

    return {
      ok: false,
      stage: e.stage,
      message: translateSshError(e.message, src),
      negotiated: e.negotiated,
      latencyMs
    }
  }
}
