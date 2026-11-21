# Pylon Stream — Windows 被控端部署指南

这台 Windows 装了发送器后，**控制台那台 Pylon 点「串流」输入它的 IP 就能看到画面并操作**。
两台被控 Windows 各装一份，控制台可以同时连两个。

## 文件清单

部署需要两个文件（都在本机编译/下载好了）：

1. `pylon-stream-sender.exe` — 我们自研的发送器（DXGI 采集 + 协议 + 输入注入）
2. `ffmpeg.exe` — 只负责 H.264 编码（NVENC 硬件编码；这台机器有 RTX 4070）

> 为什么要 ffmpeg：Media Foundation 的 Rust 绑定在这台环境反复报参数错误，
> 编码这一步借用成熟的 ffmpeg 命令行；采集、协议、传输、输入全是我们自己的代码。

## 部署到一台被控 Windows

### 1. 复制文件

在目标 Windows 上建个目录，比如 `C:\pylon-stream\`，把两个 exe 放进去：

```
C:\pylon-stream\
  pylon-stream-sender.exe
  ffmpeg.exe
```

### 2. 防火墙放行（关键）

UDP 48000 端口必须放行，否则控制台连不上。用管理员 PowerShell 执行：

```powershell
netsh advfirewall firewall add rule name="PylonStream" dir=in action=allow protocol=UDP localport=48000
```

### 3. 运行

双击不方便看日志，建议用命令行（cmd 或 PowerShell）：

```cmd
cd C:\pylon-stream
pylon-stream-sender.exe any 48000 60 40 0 C:\pylon-stream\ffmpeg.exe
```

参数依次是：

| 参数 | 含义 | 示例 |
|---|---|---|
| 1 | 控制台 IP，或 `any`（自动发现，多台控制台用这个） | `any` |
| 2 | UDP 端口 | `48000` |
| 3 | 帧率 | `60` |
| 4 | 码率 Mbps | `40` |
| 5 | 显示器序号（0 = 主屏） | `0` |
| 6 | ffmpeg.exe 路径 | `C:\pylon-stream\ffmpeg.exe` |

看到这样的输出就成了：

```
[sender] 采集就绪 3840×2160
[encoder] ffmpeg h264_nvenc 就绪 3840×2160 @60fps 40Mbps
[sender] 开始推流
[sender] 客户端 192.168.31.211:48000 加入（共 1 台）
[sender] 60 fps · 1 客户端 · 跳过 0 帧
```

### 4. 控制台连接

在控制台的 Pylon 上点标签栏「串流」→ 输入这台被控 Windows 的 IP。
两台被控机分别输各自的 IP，就能同时看、同时控制。

## 常见问题

**`采集初始化失败`**
- 如果被控机当前在远程桌面（RDP）会话里，DXGI Desktop Duplication 不可用。
  要在被控机的物理控制台会话运行（或用 Parsec/TeamViewer 这类不锁 DXGI 的方式连入）。
- 显示器序号不对：改第 5 个参数为 `1` 试试。

**`NVENC 不可用，回退 x264 软编码`**
- 显卡驱动太旧或这张卡不支持 NVENC。软编码 4K 会很吃 CPU，帧率可能到不了 60。
- 更新 NVIDIA 驱动到最新。

**`启动 ffmpeg 失败`**
- 第 6 个参数路径写错，或 ffmpeg.exe 不在 PATH。用绝对路径。

**控制台显示黑屏**
- 防火墙没放行 UDP 48000。
- 被控机 IP 写错（在被控机上 `ipconfig` 确认）。

**帧率低**
- 码率从 40 降到 25：`... 25 0 ...`
- 帧率降到 30：`... 40 30 0 ...`
- 4K 软编码很重，尽量走 NVENC。

## 自启动（可选）

要让被控机开机自动运行，放一个快捷方式到启动目录：

```
%APPDATA%\Microsoft\Windows\Start Menu\Programs\Startup\
```

快捷方式目标：

```
C:\pylon-stream\pylon-stream-sender.exe any 48000 60 40 0 C:\pylon-stream\ffmpeg.exe
```
