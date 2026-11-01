# Pylon

一个为 Windows 写的桌面 SSH 客户端。终端、多标签、快捷命令都收在一个 1240×800 的窗口里，装完双击就能用。

用 Electron + React + xterm.js 构建，SSH 连接全部跑在主进程，渲染进程只能通过类型化 IPC 跟它说话。

## 功能

**连接**

- 密码 / 私钥 / ssh-agent / keyboard-interactive 四种认证方式，OTP 与密码二次验证都能弹窗接收
- 凭据用 Electron `safeStorage`（Windows 下是 DPAPI）加密落盘，绑定当前用户账户
- 可开关的旧算法白名单，兼容还在用 `ssh-rsa` / `diffie-hellman-group1-sha1` 的老设备
- 内置四阶段诊断：TCP 连通 → 握手 → 认证 → 打开 shell，卡在哪一步直接告诉你

**终端**

- 多标签，`Ctrl+Tab` 切换，`Ctrl+Shift+W` 关闭
- xterm.js 6 + WebGL 渲染，全程二进制透传，UTF-8 汉字被 TCP 分包切断也不会变成替换字符
- 512KB / 128KB 双水位背压：远端狂刷输出时暂停读取，界面不会被拖死
- 32KB 攒包合并出站，减少 IPC 消息条数（见下方性能一节，这是实测出来的拐点）

**文件传输（rz / sz）**

- 在终端里敲 `sz 文件名` 直接下载，敲 `rz` 弹框选本地文件上传，和 Xshell / SecureCRT 的用法一致
- 走标准 ZMODEM 协议，`zmodem2` 流式状态机实现，大文件不占内存
- 下载默认落到系统「下载」目录并弹保存框；上传支持多选，一个 `rz` 连着发多个文件
- 右下角悬浮进度卡片：方向、文件名、进度条、实时速度、取消按钮；`Ctrl+C` 也能中止，半截文件会被删掉
- 传输期间键盘输入被接管（避免误触把二进制流搅乱），传完自动交回终端

**快捷命令**

- 32 条内置命令，分 7 组：系统信息、磁盘与文件、网络、进程与服务、日志、Docker、维护（慎用）
- `Ctrl+Shift+K` 唤出面板，支持搜索过滤、自定义增删
- 危险命令（`rm -rf`、`reboot` 等）默认只填入终端不执行，`Alt+点击` 才会直接跑

**本机终端**

- 侧边栏顶部常驻「本机终端」，启动即自动连上本机 PowerShell，不需要装 sshd
- 没有 PTY，所以自实现了一个行编辑器：退格、左右移动、Home/End/Delete、`Ctrl+U/W/A/E/L`、↑↓ 翻 200 条历史
- 中文与全角字符按 2 列计算宽度，光标不会错位

## 技术栈

| 层 | 选型 |
|---|---|
| 运行时 | Electron 45 |
| 界面 | React 19 + TypeScript |
| 终端 | xterm.js 6（fit / webgl / web-links） |
| SSH | ssh2 1.17（纯 JS，无需原生编译） |
| 文件传输 | zmodem2 1.4（纯 TS，零运行时依赖） |
| 构建 | electron-vite 6 + Vite 8 |
| 打包 | electron-builder 26（NSIS） |

## 快速开始

```bash
npm install
npm run dev        # 开发模式，改动热更新
npm run build      # 构建三端产物到 out/
npm run start      # 用构建产物启动（preview）
npm run typecheck  # 类型检查
```

> 开发机上如果环境变量里带着 `ELECTRON_RUN_AS_NODE=1`，Electron 会退化成普通 Node 跑主脚本直接崩掉。`npm run dev` / `npm run start` 已经通过 `scripts/run.mjs` 自动清掉这个变量。

## 打包安装程序

```bash
node scripts/prepare-electron-dist.mjs   # 准备 Electron 运行时并裁剪语言包（首次，49MB → 1.2MB）
npm run package                          # 出 NSIS 安装包
```

产物在 `build-output-N/Pylon-0.1.0-Setup.exe`（N 自动递增，每次都是全新目录，避免清理旧输出时被打断）。

安装包约 110MB，安装后约 323MB，默认装在 `%LOCALAPPDATA%\Programs\Pylon`，装完桌面和开始菜单都有快捷方式。

## 开发工具脚本

```bash
node scripts/mock-sshd.mjs 2222        # 本地模拟 SSH 服务（密码 demo/demo1234），用来跑通链路
node scripts/probe.mjs 10.0.0.5 -u root  # 不启动 Electron，单独诊断某台机器能不能连
npm run perf -- 100 1                  # 压测：100MB 刷屏，1 轮
npm run perf -- 100 1 ansi             # 压测：彩色 ANSI 日志（转义序列解析更贵）
npm run perf -- 100 1 drop             # 压测：跳过终端渲染，只测 IPC 上限
npm run startup 3                      # 启动耗时，跑 3 次取中位数
ZMODEM_PROBE=1 npm run start           # rz/sz 协议自测：13 项断言，纯内存跑，不开窗口
ZMODEM_E2E=1 npm run start             # rz/sz 端到端：起一台假 lrzsz 主机，走真实 SSH 链路
```

`probe.mjs` 支持 `--legacy`（旧算法）、`-k <私钥>`、`-P <密码>`、`-p <端口>`，退出码 0/1 方便串批处理。

## 目录结构

```
src/
  main/                主进程（唯一能碰 Node 和网络的地方）
    ssh/               连接、认证、算法白名单、错误翻译、四阶段诊断
    zmodem/            rz/sz 文件传输：起始帧检测 + 协议引擎 + 对话框外壳
    local/             本机 PowerShell 会话（无 PTY，自带行编辑器）
    store/             连接与快捷命令的持久化，凭据加密
    dev/               冒烟截图、压测、本机终端自测
    ipc.ts             全部 IPC 通道，一处注册
  preload/             contextBridge 暴露的 window.api
  renderer/            React 界面
    components/        TerminalPane / Sidebar / ConnectionDialog / QuickCommandPanel / SecretPrompt
    lib/               终端注册表、IPC 错误清洗、性能探针
  shared/              主进程与渲染进程共用的类型和内置命令表
scripts/               打包、图标生成、模拟服务、压测、启动测量
```

进程隔离是硬约束：`contextIsolation: true`、`nodeIntegration: false`，渲染进程拿不到任何 Node 能力，连 ssh2 的引用都不存在。

## 性能实测

在 100MB 纯文本刷屏（loopback，模拟服务端）下的数据：

| 指标 | 结果 |
|---|---|
| 端到端吞吐 | 65 MB/s |
| 主进程吞吐（跳过终端） | 70 MB/s |
| ANSI 彩色日志 | 25 MB/s（转义序列解析开销） |
| 帧率 | 稳定 60fps，0 掉帧 |
| 启动到窗口出现 | 430 ms |
| 内存（空闲 / 连一个会话） | 360 MB / 420 MB |

几个量出来的结论，写进注释免得后人踩：

- **IPC 消息条数不是瓶颈**：5500 条消息砍到 778 条（合并 128KB），吞吐反而略降
- **攒包阈值有断崖**：32KB 以下无差别，超过约 50KB 每字节成本跳一档，吞吐掉 15%。默认值因此定在 32KB
- **按键延迟不受攒包影响**：p50 1.1ms、p95 2ms，四种配置一致
- **启动的地板**：Electron 自身 68ms + GPU 首帧合成 157ms，靠改代码压不下去，再快只能换运行时

真实网络换算：公网 20Mbps ≈ 2.5MB/s，千兆内网 SSH 实测 80–100MB/s。日常 `tail -f`、编译日志一般 1–5MB/s，离上限还有 10 倍以上余量。

## 已知限制

- **本机终端没有 PTY**：因为没有 sshd 也没有 MSVC 工具链（node-pty 编译不了），本机会话走管道直连 PowerShell。代价是 vim / htop 这类全屏程序不可用、Tab 无补全、无法给正在运行的命令发 `Ctrl+C`、窗口尺寸不下传给子进程。主机的 SSH 连接是完整 PTY，不受影响
- 只在 Windows 上验证过，macOS / Linux 未测试
- **rz / sz 的边界**：远端要装 `lrzsz`（`apt install lrzsz` / `yum install lrzsz`）；只挂在 SSH 会话上，「本机终端」那一路没有 ZMODEM（PowerShell 侧没有对端）；不支持断点续传，中断后重传整个文件；传输期间键盘被接管（连收尾握手那几毫秒也算），中途想中止按 `Ctrl+C`
- 没有代码签名，安装时 SmartScreen 可能提示未知发布者
- 不内置端口转发和 SFTP

## 许可

个人项目，未附开源协议。
