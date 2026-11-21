//! Pylon Stream — Windows 被控端发送器。
//!
//! DXGI 采集屏幕 → Media Foundation H.264 硬编码 → UDP 发给所有已登记的控制台。
//! 同时收 INPUT 包用 SendInput 注入本机。
//!
//! 用法：pylon-stream-sender.exe <控制台IP|any> [端口=48000] [帧率=60] [码率Mbps=40] [显示器=0]
//!   any = 不预设控制台，等对方点「串流」发 HELLO 时自动登记（多台控制台用这个）

mod capture;
mod encoder;
mod input;
mod protocol;

use std::collections::HashMap;
use std::net::{IpAddr, SocketAddr, UdpSocket};
use std::sync::mpsc::{channel, Receiver, Sender};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use capture::{Capture, CapturedFrame};
use encoder::{EncodeInput, Encoder};
use protocol::*;

fn main() {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 2 {
        eprintln!("用法: {} <控制台IP|any> [端口=48000] [帧率=60] [码率Mbps=40] [显示器=0] [ffmpeg.exe路径]", args[0]);
        eprintln!("  any = 等控制台发 HELLO 自动登记（支持多台同时连）");
        std::process::exit(2);
    }
    let console_ip = args[1].clone();
    let port: u16 = args.get(2).and_then(|s| s.parse().ok()).unwrap_or(48000);
    let fps: u32 = args.get(3).and_then(|s| s.parse().ok()).unwrap_or(60);
    let bitrate: u32 = args.get(4).and_then(|s| s.parse().ok()).unwrap_or(40);
    let monitor: u32 = args.get(5).and_then(|s| s.parse().ok()).unwrap_or(0);
    let ffmpeg_path = args.get(6).map(std::path::PathBuf::from);
    let target_port: u16 = args.get(7).and_then(|s| s.parse().ok()).unwrap_or(port);

    eprintln!("[sender] 目标={} 端口={} {}fps {}Mbps 显示器#{}", console_ip, port, fps, bitrate, monitor);

    // ---- 采集器
    let mut cap = match Capture::new(monitor) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[sender] 采集初始化失败: {e}");
            eprintln!("[sender] 常见原因：远程桌面会话(RDP)下 DXGI 不可用；或显示器索引不对");
            std::process::exit(3);
        }
    };

    // 先抓一帧拿到真实分辨率
    let first = match cap.grab(2000) {
        Ok(Some(f)) => f,
        Ok(None) => {
            eprintln!("[sender] 2 秒没抓到画面，显示器可能休眠或被全屏独占程序占用");
            std::process::exit(4);
        }
        Err(e) => {
            eprintln!("[sender] 首次采集失败: {e}");
            std::process::exit(4);
        }
    };
    let (width, height) = (first.width, first.height);
    let screen_id = 0x5059_u32; // Windows sender 标识，与 Mac 区分
    eprintln!("[sender] 采集就绪 {}×{}", width, height);

    // ---- 编码器：优先 NVENC 硬编码，失败回退 x264 软编码
    let exe = ffmpeg_path.clone().unwrap_or_else(|| std::path::PathBuf::from("ffmpeg.exe"));
    let mut enc = match Encoder::with_codec(exe.clone(), width, height, fps, bitrate, "h264_nvenc", true) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("[sender] NVENC 不可用（{}），回退 x264 软编码", e);
            match Encoder::with_codec(exe.clone(), width, height, fps, bitrate, "libx264", false) {
                Ok(e) => e,
                Err(e2) => {
                    eprintln!("[sender] 编码器初始化失败: {e2}");
                    eprintln!("[sender] 请把 ffmpeg.exe 路径作为第 6 个参数传入，或放到 PATH 里");
                    std::process::exit(5);
                }
            }
        }
    };

    // ---- UDP：一个 socket 双向收发
    let sock = match UdpSocket::bind(format!("0.0.0.0:{port}")) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[sender] UDP 绑定失败: {e}（端口可能被占用）");
            std::process::exit(6);
        }
    };
    sock.set_read_timeout(Some(Duration::from_millis(20))).ok();

    // 预登记控制台 IP（如果是具体 IP）
    let mut clients: HashMap<SocketAddr, Instant> = HashMap::new();
    if console_ip != "any" && console_ip != "0.0.0.0" {
        if let Ok(ip) = console_ip.parse::<IpAddr>() {
            clients.insert(SocketAddr::new(ip, target_port), Instant::now());
            eprintln!("[sender] 预登记控制台 {}", SocketAddr::new(ip, target_port));
        }
    }

    let (caps_tx, caps_rx): (Sender<SocketAddr>, Receiver<SocketAddr>) = channel();
    let sock_in = sock.try_clone().expect("clone socket");
    let input_w = width;
    let input_h = height;
    std::thread::spawn(move || {
        let mut buf = [0u8; 2048];
        let mut err_count = 0u32;
        let mut err_reported = false;
        loop {
            match sock_in.recv_from(&mut buf) {
                Ok((n, from)) if n >= HEADER => {
                    if u32::from_be_bytes([buf[0], buf[1], buf[2], buf[3]]) != MAGIC {
                        continue;
                    }
                    match buf[5] {
                        TYPE_INPUT => {
                            input::inject(&buf[HEADER..n], input_w, input_h);
                        }
                        TYPE_HELLO => {
                            let _ = caps_tx.send(from);
                        }
                        TYPE_PING => {
                            let mut out = Vec::with_capacity(HEADER + n - HEADER);
                            out.extend_from_slice(&header(TYPE_PING, 0, 0));
                            out.extend_from_slice(&buf[HEADER..n]);
                            let _ = sock_in.send_to(&out, from);
                        }
                        TYPE_GOODBYE => {
                            eprintln!("[sender] {} 断开", from);
                        }
                        TYPE_KEYREQ => {}
                        _ => {}
                    }
                }
                Ok(_) => {}
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    std::thread::sleep(Duration::from_millis(2));
                }
                Err(e) => {
                    // 客户端断开后 sendto 会触发 ICMP 错误，导致 recv 报 10060。
                    // 这是正常的，不能每帧刷日志（会拖垮主循环），限频报一次。
                    err_count += 1;
                    if !err_reported {
                        eprintln!("[sender] UDP 收包错误（已抑制后续）: {e}");
                        err_reported = true;
                    }
                    if err_count % 500 == 0 {
                        err_count = 0;
                        err_reported = false; // 每 500 次允许再报一次，便于发现持续故障
                    }
                    std::thread::sleep(Duration::from_millis(10));
                }
            }
        }
    });

    // ---- 主循环：采集 → 编码 → 群发
    let mut frame_id: u32 = 0;
    let mut seq: u32 = 0;
    let mut stats_at = Instant::now();
    let mut frames = 0u64;
    let mut frames_skipped = 0u64;
    let frame_interval = Duration::from_micros(1_000_000 / fps as u64);
    let mut next_frame = Instant::now();
    let mut current: Option<CapturedFrame> = Some(first);
    let caps_bytes = caps(width as u16, height as u16, fps as u16, screen_id);

    eprintln!("[sender] 开始推流");

    loop {
        // 处理新客户端的 HELLO → 回 CAPS + 登记
        while let Ok(from) = caps_rx.try_recv() {
            clients.insert(from, Instant::now());
            let mut pkt = Vec::with_capacity(HEADER + caps_bytes.len());
            pkt.extend_from_slice(&header(TYPE_CAPS, 0, seq));
            pkt.extend_from_slice(&caps_bytes);
            let _ = sock.send_to(&pkt, from);
            seq = seq.wrapping_add(1);
            eprintln!("[sender] 客户端 {} 加入（共 {} 台）", from, clients.len());
        }

        // 剔除 6 秒无流量的客户端
        let now = Instant::now();
        clients.retain(|addr, last| {
            let alive = now.duration_since(*last) < Duration::from_secs(6);
            if !alive {
                eprintln!("[sender] 客户端 {addr} 超时移除");
            }
            alive
        });

        // 到点抓下一帧（控制帧率，避免采集线程空转）
        if Instant::now() < next_frame {
            std::thread::sleep(Duration::from_millis(1));
            continue;
        }
        next_frame = Instant::now() + frame_interval;

        // 抓帧（超时 1ms，非阻塞）
        let frame = if let Some(f) = current.take() {
            f
        } else {
            match cap.grab(1) {
                Ok(Some(f)) => f,
                _ => {
                    frames_skipped += 1;
                    continue;
                }
            }
        };

        // 编码
        let result = enc.encode(&EncodeInput {
            bgra: &frame.bgra,
            width: frame.width,
            height: frame.height,
        });
        let h264 = match result {
            Ok(d) => d,
            Err(e) => {
                eprintln!("[sender] 编码失败: {e}");
                frames_skipped += 1;
                continue;
            }
        };
        if h264.is_empty() {
            frames_skipped += 1;
            continue;
        }

        // 群发给所有客户端（同一份 H.264，硬件编码只做一次）
        if !clients.is_empty() {
            frame_id = frame_id.wrapping_add(1);
            let ts_us = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .map(|d| d.as_micros() as u64)
                .unwrap_or(0);
            send_frame(&sock, &clients, &mut seq, frame_id, ts_us, h264);
            frames += 1;
        }

        // 编码器跑满 600 帧重建（避免临时文件无限增长）
        if enc.needs_restart() {
            eprintln!("[sender] 重建编码器");
            enc = match Encoder::with_codec(exe.clone(), frame.width, frame.height, fps, bitrate, "h264_nvenc", true) {
                Ok(e) => e,
                Err(_) => match Encoder::with_codec(exe.clone(), frame.width, frame.height, fps, bitrate, "libx264", false) {
                    Ok(e) => e,
                    Err(e) => { eprintln!("[sender] 编码器重建失败: {e}"); continue; }
                }
            };
        }

        // 每秒统计
        if stats_at.elapsed() >= Duration::from_secs(1) {
            let secs = stats_at.elapsed().as_secs_f64();
            eprintln!(
                "[sender] {} fps · {} 客户端 · 跳过 {} 帧",
                (frames as f64 / secs).round() as u64,
                clients.len(),
                frames_skipped
            );
            frames = 0;
            frames_skipped = 0;
            stats_at = Instant::now();
        }
    }
}

/// 把一帧 H.264 切成 UDP 包群发给所有客户端
fn send_frame(
    sock: &UdpSocket,
    clients: &HashMap<SocketAddr, Instant>,
    seq: &mut u32,
    frame_id: u32,
    ts_us: u64,
    h264: &[u8],
) {
    let chunk = MAX_PAYLOAD - HEADER - FRAME_HEADER;
    let total = ((h264.len() + chunk - 1) / chunk).min(u16::MAX as usize) as u16;
    let mut off = 0usize;
    for idx in 0..total {
        let n = chunk.min(h264.len() - off);
        // 首片标关键帧（每帧都是 IDR 的简化处理；实际应由编码器标记）
        let flags = if idx == 0 { FLAG_KEYFRAME } else { 0 };
        let flags = if idx == total - 1 { flags | FLAG_LAST } else { flags };
        let mut pkt = Vec::with_capacity(HEADER + FRAME_HEADER + n);
        pkt.extend_from_slice(&header(TYPE_VIDEO, flags, *seq));
        pkt.extend_from_slice(&frame_header(frame_id, ts_us, idx, total));
        pkt.extend_from_slice(&h264[off..off + n]);
        for addr in clients.keys() {
            let _ = sock.send_to(&pkt, addr);
        }
        *seq = seq.wrapping_add(1);
        off += n;
        if off >= h264.len() {
            break;
        }
    }
}
