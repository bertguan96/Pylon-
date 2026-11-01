#!/usr/bin/env node
/**
 * 本地模拟 SSH 服务端 —— 只用于验证客户端链路，不是真实主机。
 *
 *   node scripts/mock-sshd.mjs [端口]
 *
 * 账号：demo / demo1234 （密码认证，也接受 keyboard-interactive）
 * 支持的命令：help / size / ls / date / clear / exit
 *
 * 它实现了一个极简的假 shell，会回显输入并响应窗口尺寸变化，
 * 方便在没有任何真实服务器可用时验证：认证、PTY、resize、双向数据流。
 */
import ssh2 from 'ssh2'

// ssh2 是 CommonJS 包，命名导出在 ESM 下不可靠，统一走默认导入
const { Server, utils } = ssh2

const PORT = Number(process.argv[2] || 2222)
const USER = 'demo'
const PASS = 'demo1234'

const hostKey = utils.generateKeyPairSync('ed25519')

const server = new Server({ hostKeys: [hostKey.private] }, (client) => {
  client.on('authentication', (ctx) => {
    if (ctx.method === 'password' && ctx.username === USER && ctx.password === PASS) {
      return ctx.accept()
    }
    if (ctx.method === 'keyboard-interactive') {
      return ctx.prompt([{ prompt: 'Password: ', echo: false }], (answers) => {
        if (answers[0] === PASS) ctx.accept()
        else ctx.reject(['password', 'keyboard-interactive'])
      })
    }
    if (ctx.method === 'none') return ctx.reject(['password', 'keyboard-interactive'])
    ctx.reject(['password', 'keyboard-interactive'])
  })

  client.on('ready', () => {
    client.on('session', (accept) => {
      const session = accept()
      let size = { cols: 80, rows: 24 }

      session.on('pty', (acceptPty, _reject, info) => {
        size = { cols: info.cols, rows: info.rows }
        acceptPty?.()
      })

      session.on('window-change', (acceptResize, _reject, info) => {
        if (info) size = { cols: info.cols, rows: info.rows }
        acceptResize?.()
      })

      // 支持 exec：诊断脚本和自动化都会用「执行一条命令」来确认认证是否真的生效
      session.on('exec', (acceptExec, _rejectExec, info) => {
        const stream = acceptExec()
        const cmd = info?.command ?? ''
        const output = cmd.includes('__probe_ok__') ? '__probe_ok__' : `mock exec: ${cmd}`
        stream.write(`${output}\n`)
        stream.exit(0)
        stream.end()
      })

      session.on('shell', (acceptShell) => {
        const stream = acceptShell()
        let line = ''

        const prompt = () => stream.write(`\r\n\x1b[36m${USER}@mock\x1b[0m:\x1b[34m~\x1b[0m$ `)

        stream.write('\x1b[1;32m本地模拟 SSH 服务\x1b[0m —— 用于验证客户端，非真实主机\r\n')
        stream.write('\x1b[2m输入 help 查看可用命令，exit 断开\x1b[0m')
        prompt()

        /**
         * 输出 mb 兆字节，用 drain 控制发送节奏（和真实 sshd 受内核缓冲区限制一样）。
         * 末尾写 FLOOD_END 标记，客户端据此判断"数据已全部到达"。
         */
        function flood(s, mb, colored) {
          const pad = 'x'.repeat(60)
          const plain = Buffer.from(
            Array.from({ length: 512 }, (_, i) => `log line ${i} ${pad}\r\n`).join('')
          )
          const ansi = Buffer.from(
            Array.from(
              { length: 512 },
              (_, i) => `\x1b[32mINFO\x1b[0m  \x1b[2m${i}\x1b[0m  request handled in ${i % 90}ms ${pad}\r\n`
            ).join('')
          )
          const chunk = colored ? ansi : plain
          let remaining = Math.floor(mb * 1024 * 1024)
          const total = remaining

          const pump = () => {
            while (remaining > 0) {
              const n = Math.min(chunk.length, remaining)
              const ok = s.write(n === chunk.length ? chunk : chunk.subarray(0, n))
              remaining -= n
              if (!ok) {
                s.once('drain', pump) // 缓冲满，等对端消费
                return
              }
            }
            s.write(`\r\nFLOOD_END ${total} bytes\r\n`)
            prompt()
          }
          pump()
        }

        const run = (cmd) => {
          const [name, ...args] = cmd.split(/\s+/)

          // 压测用：快速吐出海量数据，模拟 cat 大文件 / 日志刷屏
          // flood <MB> 纯文本；floodc <MB> 每行带 ANSI 颜色（更接近真实日志）
          if (name === 'flood' || name === 'floodc') {
            const mb = Math.min(Number(args[0]) || 10, 500)
            const colored = name === 'floodc'
            flood(stream, mb, colored)
            return false // 异步输出，结束时自己 prompt，这里不再补
          }

          switch (cmd) {
            case '':
              break
            case 'help':
              stream.write(
                '可用命令: help / size / ls / date / clear / exit / flood <MB> / floodc <MB>'
              )
              break
            case 'size':
              stream.write(`当前终端尺寸: ${size.cols} x ${size.rows}`)
              break
            case 'ls':
              stream.write(
                '\x1b[34mprojects\x1b[0m  \x1b[34mbackups\x1b[0m  notes.md  docker-compose.yml'
              )
              break
            case 'date':
              stream.write(new Date().toLocaleString('zh-CN'))
              break
            case 'clear':
              stream.write('\x1b[2J\x1b[H')
              break
            case 'exit':
              stream.write('bye\r\n')
              stream.exit(0)
              return false
            default:
              stream.write(`\x1b[31mmock: command not found: ${cmd}\x1b[0m`)
          }
          return true
        }

        stream.on('data', (chunk) => {
          for (const ch of chunk.toString('utf8')) {
            if (ch === '\r' || ch === '\n') {
              stream.write('\r\n')
              const keep = run(line.trim())
              line = ''
              if (keep === false) return
              prompt()
            } else if (ch === '\u007f' || ch === '\b') {
              if (line.length > 0) {
                line = line.slice(0, -1)
                stream.write('\b \b')
              }
            } else if (ch === '\u0003') {
              stream.write('^C')
              line = ''
              prompt()
            } else if (ch === '\t') {
              // 忽略补全
            } else {
              line += ch
              stream.write(ch)
            }
          }
        })

        stream.on('close', () => client.end())
      })
    })
  })

  client.on('error', () => undefined)
})

server.listen(PORT, '127.0.0.1', () => {
  console.log(`mock sshd 监听 127.0.0.1:${PORT}`)
  console.log(`账号 ${USER} / ${PASS}`)
})
