# Mac 端编译与运行指南

Windows 端（Pylon）已经写好了串流接收器。你只需要在 Mac 上做三件事：
装编译工具、编译一个 Swift 文件、运行它。

## 1. 安装 Xcode 命令行工具（只需一次）

打开 Mac 上的「终端」，执行：

```bash
xcode-select --install
```

弹出对话框后点「安装」，等它装完（约几分钟）。

验证装好了：

```bash
swiftc --version
```

能看到版本号就行。要求 macOS 13+（Ventura 及以后）。

## 2. 把源码传到 Mac

Swift 源文件在这个目录：

```
native/pylon-stream/mac/StreamSender.swift
```

传到 Mac 的任意目录，比如 `~/pylon-stream/`。方式随你：
AirDrop、U 盘、scp、或者直接在 Mac 上从共享目录复制都行。

## 3. 编译

```bash
cd ~/pylon-stream
swiftc -O -o pylon-stream-sender StreamSender.swift
```

首次编译会链接 ScreenCaptureKit / VideoToolbox，约 10~30 秒。
没有任何输出就是成功了，会生成 `pylon-stream-sender` 可执行文件。

### 常见编译错误

- **`no such module 'ScreenCaptureKit'`** → macOS 版本太低，需要 13+；
  或者 Xcode CLT 没装好，重装一次。
- **`cannot find 'kVTEncodeFrameOptionKey_ForceKeyFrame' in scope`**
  → 这个常量在新 SDK 才有。把 `Sender.encode` 里这段删掉即可
  （只是无法主动请求关键帧，等自然关键帧也行）：
  ```swift
  var props: [CFString: Any]? = nil
  if forceKey { ... }
  ```
  改成直接 `frameProperties: nil`。
- **`result of call to 'bind' is unused`** 之类警告 → 忽略，不影响运行。

## 4. 授权（关键，不授权会黑屏）

首次运行前，给终端（或可执行文件）两个权限：

**系统设置 → 隐私与安全性**

1. **屏幕录制** → 点 `+` → 选中你运行命令的「终端」（Terminal / iTerm）
2. **辅助功能** → 同样加上终端

改完**完全退出终端再重新打开**（权限要重启进程才生效）。

## 5. 运行

先查 Windows 的局域网 IP（在 Windows 上 `ipconfig`，找 192.168.31.x 那个）。
假设是 `192.168.31.100`：

```bash
cd ~/pylon-stream
./pylon-stream-sender 192.168.31.100 48000 60 40
```

参数依次是：Windows IP、端口（默认 48000）、帧率（默认 60）、码率 Mbps（默认 40）。

看到这样的输出就成了：

```
[00:15:30.123] 目标 192.168.31.100:48000 60fps 40Mbps
[00:15:30.456] 显示器 1 2940×1912
[00:15:30.500] 编码器就绪 2940×1912 @ 60fps 40Mbps
[00:15:30.520] 采集已启动
```

## 6. Windows 端连接

1. 重启 Pylon（装了带串流功能的新版本）
2. 点顶部标签栏的「**串流**」按钮
3. 输入 Mac 的 IP（比如 `192.168.31.193`）
4. 应该立刻看到 Mac 画面，工具栏会显示 `60 fps · XX Mbps · RTT Xms`

## 调参建议

| 现象 | 调整 |
|---|---|
| 画面卡、码率高 | 码率从 40 降到 25：`./pylon-stream-sender <IP> 48000 60 25` |
| 画质不够锐 | 码率提到 60~80 |
| 风扇狂转 | 帧率降到 30（编码负载减半） |
| 想更低延迟 | 把码率调高、帧率保持 60 |

建议先用有线或 5GHz Wi-Fi。2.4GHz 可能因丢包频繁触发关键帧请求。

## 防火墙

Windows 第一次运行 Pylon 时可能弹出防火墙提示，**务必勾选「专用网络」允许**。
否则 UDP 48000 端口被挡，会一直连不上。

macOS 端首次运行 Swift 程序也可能弹「允许传入连接」，选允许。
