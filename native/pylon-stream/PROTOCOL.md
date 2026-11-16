# Pylon Stream 私有协议 v1

两端自研串流用的最小协议。设计目标：够简单（单文件能实现）、够健壮（局域网丢包可恢复）、
够低延迟（不做重排序等待）。所有多字节整数一律 **网络序（大端）**，避免两端字节序踩坑。

## 传输

- UDP，单端口双向（默认 48000）
- Mac 是发送端（画面）+ 接收端（输入）；Windows 反之
- 单个 UDP 包负载上限 1200 字节（避免广域网分片，局域网 MTU 通常 1500）
- 每个包前 12 字节是统一头，之后是类型专属负载

## 通用头（12 字节）

| 偏移 | 长度 | 字段 | 说明 |
|---|---|---|---|
| 0 | 4 | magic | `0x50535452` = "PSTR" |
| 4 | 1 | version | 固定 1 |
| 5 | 1 | type | 见下表 |
| 6 | 2 | flags | 类型专属标志 |
| 8 | 4 | seq | 包序号，单调递增，用于丢包统计 |

类型（type）：

| 值 | 名称 | 方向 | 说明 |
|---|---|---|---|
| 1 | HELLO | Win → Mac | 连接探测，Mac 回 CAPS |
| 2 | CAPS | Mac → Win | 能力通告：宽、高、帧率、编码格式 |
| 3 | VIDEO | Mac → Win | H.264 视频分片 |
| 4 | INPUT | Win → Mac | 鼠标/键盘输入 |
| 5 | KEYREQ | Win → Mac | 请求关键帧（解码器出错时） |
| 6 | PING | 双向 | 保活 + RTT 测量 |
| 7 | GOODBYE | 双向 | 优雅断开 |

## CAPS（负载 20 字节）

| 偏移 | 长度 | 字段 |
|---|---|---|
| 0 | 2 | width |
| 2 | 2 | height |
| 4 | 2 | fps |
| 6 | 2 | codec：1 = H.264/AVC |
| 8 | 4 | 屏幕唯一标识（用于换屏时重置解码器） |
| 12 | 8 | 保留 |

Mac 每收到 HELLO 回一个 CAPS。Win 收到 CAPS 后用宽高配置解码器。

## VIDEO（头 12 + 帧头 16 + 负载）

通用头之后紧跟帧头：

| 偏移 | 长度 | 字段 | 说明 |
|---|---|---|---|
| 0 | 4 | frame_id | 帧序号，单调递增 |
| 4 | 4 | timestamp_us | 采集时间戳（微秒，Mac 单调钟） |
| 8 | 2 | frag_index | 当前分片下标（从 0 开始） |
| 10 | 2 | frag_total | 本帧总分片数 |

flags 位定义：

- bit0：`0x0001` = 关键帧（IDR，含 SPS/PPS）
- bit1：`0x0002` = 本帧最后一包（用于无丢包时提前提交）

**负载是 H.264 Annex-B 格式**（`00 00 00 01` 起始码 + NALU）。
Mac 端 VideoToolbox 输出的是 AVCC（length-prefixed），发送前逐 NALU 转成 Annex-B。
这样 Windows 端 WebCodecs 可以直接从流里提取 SPS/PPS，不依赖外部配置。

### 收端重组规则

1. 按 `frame_id` 聚合分片；同一 frame_id 的 `frag_total` 必须一致
2. 收齐 `frag_total` 片，或最后一包已到且序号连续 → 按 frag_index 拼接提交
3. 一帧等待超过 50ms 仍未收齐 → 丢弃整帧，记一次丢帧，并发 KEYREQ
4. 收到 frame_id 跳变（中间整帧丢失）→ 立即发 KEYREQ
5. 解码器报错 → 发 KEYREQ

### 带宽估算

2940×1912 @ 60fps，H.264 高质量约 20~40 Mbps（2.5~5 MB/s）。
按 1200 字节分片，每帧约 40~80 包，每秒 2400~4800 包。
千兆有线完全够；5GHz Wi-Fi 够用但要留意丢包率。

## INPUT（头 12 + 负载变长）

flags 高 8 位（`(flags >> 8) & 0xff`）是输入子类型：

| 子类型 | 名称 | 负载 |
|---|---|---|
| 1 | MOUSE_MOVE | x:u16, y:u16（远端像素坐标） |
| 2 | MOUSE_BUTTON | button:u8（0左1右2中）, down:u8 |
| 3 | WHEEL | delta:i16 |
| 4 | KEY | keysym:u32, down:u8 |

Mac 端用 CGEvent 注入。坐标系：Windows 传的是**远端像素坐标**（CAPS 里的 width/height），
Mac 直接用，不做缩放——因为我们要的就是原生清晰度，不降采样。

## KEYREQ / PING / GOODBYE

- KEYREQ：负载 4 字节，请求从该 frame_id 之后发关键帧（0 = 立刻）
- PING：负载 8 字节，发送方单调时钟微秒；接收方原样回，用于算 RTT
- GOODBYE：无负载

## 安全

局域网私有协议，v1 **不加密**。靠路由器隔离。后续可加 DTLS，
但那样要引入 OpenSSL 依赖，违背「纯自研、单文件可编译」的初衷。

## 状态机

```
Win:   HELLO ──等待──> CAPS ──> VIDEO 流 + INPUT 回传 ──> GOODBYE
Mac:   等待 HELLO ──> 发 CAPS ──> 采集编码循环 ──> GOODBYE
```

任何一侧 3 秒收不到 PING/VIDEO/INPUT 视为超时断开。
