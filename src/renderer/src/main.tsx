import { createRoot } from 'react-dom/client'
import '@xterm/xterm/css/xterm.css'
import './styles.css'
import App from './App'
import { perfProbe } from './lib/perf-probe'

// 压测探针挂到 window，主进程用 executeJavaScript 读取
;(window as unknown as { __perf: typeof perfProbe }).__perf = perfProbe

// 不用 StrictMode：xterm 是命令式实例，双挂载会创建两份 term 并抢同一个 DOM 节点
createRoot(document.getElementById('root')!).render(<App />)
