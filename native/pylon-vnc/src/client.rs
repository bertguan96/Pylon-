//! 会话：握手、认证、消息循环、请求流水线、看门狗。
//!
//! 线程划分（全部阻塞 IO，没有事件循环）：
//!   * 主线程：阻塞读 TCP，解帧、贴图、只把变化的块吐给上层；
//!   * 输入线程：阻塞读 stdin（Node 发来的指针/键盘），拿到就直接写 socket；
//!   * 看门狗线程：只做「有输入却长时间收不到帧」的判定与纠偏。
//!
//! 三个线程共享一个 `Shared`：socket 的写句柄（Mutex 保护，争用极低）和几个原子量。
//! 这样输入永远不会被解码阻塞 —— JS 版最要命的问题就是这两件事挤在一个事件循环里。

use std::io::{self, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use crate::des::vnc_auth_response;
use crate::fb::{Dirty, DirtyTile, Surface};
use crate::pipe::Out;
use crate::rfb::{
    PixelFormat, Reader, ENC_COPY_RECT, ENC_RAW, ENC_ZRLE, MSG_BELL, MSG_CUT_TEXT, MSG_FB_UPDATE,
    MSG_SET_COLOUR_MAP, PF_RGB565, PF_RGBA32, SEC_NONE, SEC_VNC_AUTH,
};
use crate::zrle::{Codec, Zrle};

/// 流水线深度：同时在服务端挂着的更新请求数。
/// 深度 2 的意义是服务端编码完一帧就能接着编下一帧，省掉「收到帧 → 发请求 → 等往返」的空窗。
const MAX_IN_FLIGHT: i32 = 2;

/// 有输入、却这么久没收到任何帧 → 判定停摆
const STALL_MS: u64 = 1400;

/// 连续停摆这么多次就认定连接已废
const STALL_GIVEUP: u32 = 3;

/// 握手完成后多久还没收到第一帧就判异常（Retina 全屏首帧正常要 1~3 秒）
const FIRST_FRAME_MS: u64 = 6000;

/// 两次更新请求的最小间隔。
/// 服务端没变化时会压着请求不回，但碰上环回地址或实现粗糙的服务端会退化成空转，
/// 把 CPU 和带宽全烧在几个像素的位移上。4ms 足够挡住空转，又不至于吃掉帧率。
const MIN_REQUEST_GAP: Duration = Duration::from_millis(4);

#[derive(Clone, Copy, PartialEq)]
pub enum Quality {
    /// 16 位色：流量小、编码快，有轻微色带
    Speed,
    /// 32 位色
    Sharp,
}

pub struct Config {
    pub host: String,
    pub port: u16,
    pub password: Option<String>,
    pub quality: Quality,
    pub scale: Option<usize>,
    pub timeout: Duration,
}

#[derive(Clone)]
pub struct Info {
    pub name: String,
    pub remote_w: usize,
    pub remote_h: usize,
    pub out_w: usize,
    pub out_h: usize,
    pub scale: usize,
}

/// 上层接收帧的出口：pipe 模式写二进制管道，live 模式打到终端
pub trait FrameSink {
    fn init(&mut self, info: &Info) -> io::Result<()>;
    fn frames(&mut self, tiles: &[DirtyTile], px: &[u32]) -> io::Result<()>;
    fn stats(&mut self, fps: u16, kbps: u32, decode_ms: u32, total_ms: u32) -> io::Result<()>;
    fn clipboard(&mut self, text: &str) -> io::Result<()>;
    fn closed(&mut self) -> io::Result<()>;
}

impl<W: Write> FrameSink for Out<W> {
    fn init(&mut self, info: &Info) -> io::Result<()> {
        Out::init(
            self,
            info.out_w as u16,
            info.out_h as u16,
            info.remote_w as u16,
            info.remote_h as u16,
            info.scale as u16,
            &info.name,
        )
    }
    fn frames(&mut self, tiles: &[DirtyTile], px: &[u32]) -> io::Result<()> {
        Out::frames(self, tiles, px)
    }
    fn stats(&mut self, fps: u16, kbps: u32, decode_ms: u32, total_ms: u32) -> io::Result<()> {
        Out::stats(self, fps, kbps, decode_ms * 1000, total_ms)
    }
    fn clipboard(&mut self, text: &str) -> io::Result<()> {
        Out::clipboard(self, text)
    }
    fn closed(&mut self) -> io::Result<()> {
        Out::closed(self)
    }
}

/// 三个线程共享的状态
pub struct Shared {
    sock: Mutex<TcpStream>,
    pub last_frame: AtomicU64,
    pub last_input: AtomicU64,
    pub stall_since: AtomicU64,
    pub stall_count: AtomicU32,
    pub handshake_at: AtomicU64,
    pub closed: AtomicBool,
    /// 远端像素尺寸：更新请求要填真实宽高。
    /// 用 0xffff 表示「整屏」在规范里合法，但 Apple 的实现会把它算成 2×2，
    /// 结果就是整屏请求换来一个 2×2 的小方块 —— 实测踩过。
    pub fb_w: AtomicU32,
    pub fb_h: AtomicU32,
    /// 是否已经拿到过「像样的整屏」。Apple 对第一条整帧请求会先回一个 2×2 的空更新
    /// 当占位，真正的内容要等它算完初始 damage 才推 —— 所以不能拿「收到过帧」当
    /// 首帧到位的判据，否则会一直显示半张黑屏。
    pub full_seen: AtomicBool,
    /// 下一次补发整帧请求的时间点（毫秒）
    pub next_full_at: AtomicU64,
    error: Mutex<Option<String>>,
    t0: Instant,
}

impl Shared {
    fn new(sock: TcpStream) -> Shared {
        Shared {
            sock: Mutex::new(sock),
            last_frame: AtomicU64::new(0),
            last_input: AtomicU64::new(0),
            stall_since: AtomicU64::new(0),
            stall_count: AtomicU32::new(0),
            handshake_at: AtomicU64::new(0),
            closed: AtomicBool::new(false),
            fb_w: AtomicU32::new(0),
            fb_h: AtomicU32::new(0),
            full_seen: AtomicBool::new(false),
            next_full_at: AtomicU64::new(0),
            error: Mutex::new(None),
            t0: Instant::now(),
        }
    }

    pub fn now_ms(&self) -> u64 {
        self.t0.elapsed().as_millis() as u64
    }

    fn write(&self, data: &[u8]) {
        if let Ok(mut s) = self.sock.lock() {
            if s.write_all(data).is_err() {
                self.fail("写 socket 失败，连接可能已断开");
            }
        }
    }

    fn note_input(&self) {
        let now = self.now_ms();
        self.last_input.store(now, Ordering::Relaxed);
        let _ = self
            .stall_since
            .compare_exchange(0, now, Ordering::Relaxed, Ordering::Relaxed);
    }

    pub fn pointer(&self, mask: u8, x: u16, y: u16) {
        let mut b = [0u8; 6];
        b[0] = 5;
        b[1] = mask;
        b[2..4].copy_from_slice(&x.to_be_bytes());
        b[4..6].copy_from_slice(&y.to_be_bytes());
        self.write(&b);
        self.note_input();
    }

    pub fn key(&self, down: bool, keysym: u32) {
        let mut b = [0u8; 8];
        b[0] = 4;
        b[1] = down as u8;
        b[4..8].copy_from_slice(&keysym.to_be_bytes());
        self.write(&b);
        self.note_input();
    }

    /// 把本地剪贴板推给远端（ClientCutText）
    pub fn cut_text(&self, text: &str) {
        let body = text.as_bytes();
        if body.len() > 1 << 20 {
            return;
        }
        let mut b = Vec::with_capacity(8 + body.len());
        b.push(6);
        b.extend_from_slice(&[0, 0, 0]);
        b.extend_from_slice(&(body.len() as u32).to_be_bytes());
        b.extend_from_slice(body);
        self.write(&b);
    }

    pub fn request(&self, incremental: bool) {
        let mut b = [0u8; 10];
        b[0] = 3;
        b[1] = incremental as u8;
        let w = self.fb_w.load(Ordering::Relaxed).min(u16::MAX as u32) as u16;
        let h = self.fb_h.load(Ordering::Relaxed).min(u16::MAX as u32) as u16;
        b[6..8].copy_from_slice(&w.to_be_bytes());
        b[8..10].copy_from_slice(&h.to_be_bytes());
        if std::env::var("PYLON_VNC_DEBUG").is_ok() {
            eprintln!("[vnc-dbg] 发请求 inc={incremental} {}", hex(&b));
        }
        self.write(&b);
    }

    pub fn fail(&self, msg: &str) {
        {
            let mut slot = match self.error.lock() {
                Ok(g) => g,
                Err(p) => p.into_inner(),
            };
            if slot.is_none() {
                *slot = Some(msg.to_string());
            }
        }
        self.closed.store(true, Ordering::Relaxed);
        // shutdown 让阻塞中的 read 立刻返回，主循环才能退出
        if let Ok(s) = self.sock.lock() {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
    }

    pub fn close(&self) {
        self.closed.store(true, Ordering::Relaxed);
        if let Ok(s) = self.sock.lock() {
            let _ = s.shutdown(std::net::Shutdown::Both);
        }
    }

    pub fn take_error(&self) -> Option<String> {
        match self.error.lock() {
            Ok(mut g) => g.take(),
            Err(p) => p.into_inner().take(),
        }
    }
}

pub struct Session {
    reader: Reader,
    shared: Arc<Shared>,
    surface: Surface,
    zrle: Zrle,
    codec: Codec,
    pf: PixelFormat,
    w: usize,
    h: usize,
    info: Info,
    in_flight: i32,
    pending_full: bool,
    last_request: Option<Instant>,
    raw: Vec<u32>,
    dirty: Dirty,
    stats_frames: u32,
    stats_bytes: u64,
    stats_last: Instant,
    stats_decode_ms: u32,
    stats_total_ms: u32,
    /// 纯 CPU 段（blit+collect+commit）的最大耗时，不含等网络的时间
    stats_proc_ms: u32,
    frames: u64,
}

impl Session {
    pub fn open(cfg: &Config) -> Result<Session, String> {
        let addr = format!("{}:{}", cfg.host, cfg.port);
        let sockaddr = addr
            .to_socket_addrs()
            .map_err(|e| format!("解析地址 {addr} 失败：{e}"))?
            .next()
            .ok_or_else(|| format!("解析地址 {addr} 失败"))?;
        let sock = TcpStream::connect_timeout(&sockaddr, cfg.timeout)
            .map_err(|e| format!("连接 {} 失败：{e}", addr))?;
        // 键鼠是大量小包，Nagle 会把它们攒起来，手感立刻发黏
        let _ = sock.set_nodelay(true);

        let read_half = sock
            .try_clone()
            .map_err(|e| format!("复制 socket 句柄失败：{e}"))?;
        let mut reader = Reader::new(read_half);
        let mut write_side = sock
            .try_clone()
            .map_err(|e| format!("复制 socket 句柄失败：{e}"))?;

        let hello = reader.to_vec(12).map_err(|e| format!("读版本失败：{e}"))?;
        let version = String::from_utf8_lossy(&hello).into_owned();
        let minor: u32 = version
            .get(8..11)
            .and_then(|s| s.parse().ok())
            .ok_or_else(|| format!("对端不是 VNC 服务（收到 {}）", version.trim_end()))?;

        // 高版本一律按 3.8 谈：Apple 的 3.889 在认证流程上就是 3.8
        let (reply, mode) = if minor >= 8 {
            ("RFB 003.008\n", 8)
        } else if minor >= 7 {
            ("RFB 003.007\n", 7)
        } else {
            ("RFB 003.003\n", 3)
        };
        write_side
            .write_all(reply.as_bytes())
            .map_err(|e| format!("发送版本失败：{e}"))?;

        authenticate(&mut reader, &mut write_side, cfg, mode)?;

        // ClientInit：shared=1，允许别的客户端同时连着
        write_side
            .write_all(&[1])
            .map_err(|e| format!("发送 ClientInit 失败：{e}"))?;

        let remote_w = reader.u16().map_err(fmt) ? as usize;
        let remote_h = reader.u16().map_err(fmt) ? as usize;
        let raw_pf = reader.to_vec(16).map_err(fmt)?;
        let _server_pf = PixelFormat::parse(&raw_pf);
        let name = reader.u32_string().map_err(fmt)?;
        if remote_w == 0 || remote_h == 0 {
            return Err(format!("对端报告的屏幕尺寸异常：{remote_w}×{remote_h}"));
        }

        // Retina 屏报的是物理像素（2940×1912），画布通常只有一千多像素宽，
        // 多出来的细节看不见却要过管道、上 canvas。降 2 倍后数据量降到 1/4，肉眼几乎无差。
        let scale = match cfg.quality {
            Quality::Sharp => 1,
            Quality::Speed => cfg.scale.unwrap_or(if remote_w >= 2400 { 2 } else { 1 }).max(1),
        };

        let pf = match cfg.quality {
            Quality::Sharp => PF_RGBA32,
            Quality::Speed => PF_RGB565,
        };

        // SetPixelFormat
        let mut msg = [0u8; 20];
        msg[0] = 0;
        msg[4..20].copy_from_slice(&pf.encode());
        write_side
            .write_all(&msg)
            .map_err(|e| format!("发送 SetPixelFormat 失败：{e}"))?;

        // SetEncodings：ZRLE 是 Apple/TigerVNC/RealVNC 都认的压缩编码，
        // CopyRect 负责滚屏和拖窗口，Raw 兜底
        let encodings = [ENC_ZRLE, ENC_COPY_RECT, ENC_RAW];
        let mut msg = Vec::with_capacity(4 + encodings.len() * 4);
        msg.push(2);
        msg.push(0);
        msg.extend_from_slice(&(encodings.len() as u16).to_be_bytes());
        for e in encodings {
            msg.extend_from_slice(&e.to_be_bytes());
        }
        write_side
            .write_all(&msg)
            .map_err(|e| format!("发送 SetEncodings 失败：{e}"))?;

        let surface = Surface::new(remote_w, remote_h, scale);
        let info = Info {
            name,
            remote_w,
            remote_h,
            out_w: surface.out.w,
            out_h: surface.out.h,
            scale,
        };

        let shared = Arc::new(Shared::new(sock));
        shared
            .handshake_at
            .store(shared.now_ms(), Ordering::Relaxed);
        shared.fb_w.store(remote_w as u32, Ordering::Relaxed);
        shared.fb_h.store(remote_h as u32, Ordering::Relaxed);

        Ok(Session {
            reader,
            shared,
            surface,
            zrle: Zrle::new(),
            codec: Codec::new(&pf),
            pf,
            w: remote_w,
            h: remote_h,
            info,
            in_flight: 0,
            pending_full: true,
            last_request: None,
            raw: Vec::new(),
            dirty: Dirty::new(),
            stats_frames: 0,
            stats_bytes: 0,
            stats_last: Instant::now(),
            stats_decode_ms: 0,
            stats_total_ms: 0,
            stats_proc_ms: 0,
            frames: 0,
        })
    }

    pub fn info(&self) -> &Info {
        &self.info
    }

    pub fn shared(&self) -> Arc<Shared> {
        Arc::clone(&self.shared)
    }

    pub fn frames(&self) -> u64 {
        self.frames
    }

    /// 纯 CPU 段的单帧最大耗时（毫秒），诊断降采样/比对用
    pub fn proc_ms(&self) -> u32 {
        self.stats_proc_ms
    }

    /// 把当前降采样后的画面存成 24 位 BMP。
    /// 纯诊断用：颜色通道是否错位、解码有没有画歪，光看数字看不出来，存出来一眼睛就明白。
    pub fn dump_bmp(&self, path: &str) -> std::io::Result<()> {
        use std::io::Write as _;
        let fb = &self.surface.out;
        let (w, h) = (fb.w, fb.h);
        let row = (w * 3 + 3) & !3;
        let size = 54 + row * h;
        let mut f = std::io::BufWriter::new(std::fs::File::create(path)?);

        let mut head = Vec::with_capacity(54);
        head.extend_from_slice(b"BM");
        head.extend_from_slice(&(size as u32).to_le_bytes());
        head.extend_from_slice(&0u32.to_le_bytes());
        head.extend_from_slice(&54u32.to_le_bytes());
        head.extend_from_slice(&40u32.to_le_bytes());
        head.extend_from_slice(&(w as i32).to_le_bytes());
        head.extend_from_slice(&(h as i32).to_le_bytes());
        head.extend_from_slice(&1u16.to_le_bytes());
        head.extend_from_slice(&24u16.to_le_bytes());
        head.extend_from_slice(&0u32.to_le_bytes());
        head.extend_from_slice(&((row * h) as u32).to_le_bytes());
        head.extend_from_slice(&[0u8; 16]);
        f.write_all(&head)?;

        let mut line = vec![0u8; row];
        // BMP 的行序是自下而上；像素在内存里是 R、G、B、A，BMP 要 B、G、R
        for y in (0..h).rev() {
            for x in 0..w {
                let p = fb.px[y * w + x];
                line[x * 3] = (p >> 16) as u8;
                line[x * 3 + 1] = (p >> 8) as u8;
                line[x * 3 + 2] = p as u8;
            }
            f.write_all(&line)?;
        }
        f.flush()
    }

    /// 主循环。返回 Err 只在协议层真的出问题时；正常关闭返回 Ok。
    pub fn run<S: FrameSink>(&mut self, sink: &mut S) -> Result<(), String> {
        sink.init(&self.info).map_err(fmt)?;
        self.pump()?;

        loop {
            if self.shared.closed.load(Ordering::Relaxed) {
                break;
            }
            let kind = match self.reader.u8() {
                Ok(v) => v,
                Err(e) => {
                    if self.shared.closed.load(Ordering::Relaxed) {
                        break;
                    }
                    return Err(format!("读 socket 失败：{e}"));
                }
            };
            match kind {
                MSG_FB_UPDATE => self.handle_update(sink)?,
                MSG_SET_COLOUR_MAP => {
                    self.reader.skip(1).map_err(fmt)?;
                    let _ = self.reader.u16().map_err(fmt)?;
                    let n = self.reader.u16().map_err(fmt)?;
                    self.reader.skip(n as usize * 6).map_err(fmt)?;
                }
                MSG_BELL => {}
                MSG_CUT_TEXT => {
                    self.reader.skip(3).map_err(fmt)?;
                    let text = self.reader.u32_string().map_err(fmt)?;
                    let _ = sink.clipboard(&text);
                }
                other => return Err(format!("未知的服务端消息类型 {other}，连接可能已错位")),
            }
        }

        if let Some(err) = self.shared.take_error() {
            return Err(err);
        }
        let _ = sink.closed();
        Ok(())
    }

    fn throttle(&mut self) {
        if let Some(last) = self.last_request {
            let dt = last.elapsed();
            if dt < MIN_REQUEST_GAP {
                std::thread::sleep(MIN_REQUEST_GAP - dt);
            }
        }
        self.last_request = Some(Instant::now());
    }

    fn pump(&mut self) -> Result<(), String> {
        while self.in_flight < MAX_IN_FLIGHT {
            let incremental = !self.pending_full;
            self.pending_full = false;
            self.throttle();
            self.shared.request(incremental);
            self.in_flight += 1;
        }
        Ok(())
    }

    fn handle_update<S: FrameSink>(&mut self, sink: &mut S) -> Result<(), String> {
        // 一个响应对应一个在飞的请求（看门狗补发的请求不受计数约束，所以用 saturating）
        self.in_flight = (self.in_flight - 1).max(0);
        let t_frame = Instant::now();

        self.reader.skip(1).map_err(fmt)?;
        let count = self.reader.u16().map_err(fmt)?;
        let dbg = std::env::var("PYLON_VNC_DEBUG").is_ok();

        let mut dirty = std::mem::take(&mut self.dirty);
        dirty.clear();
        let mut covered: u64 = 0;

        for _ in 0..count {
            let x = self.reader.u16().map_err(fmt)? as usize;
            let y = self.reader.u16().map_err(fmt)? as usize;
            let w = self.reader.u16().map_err(fmt)? as usize;
            let h = self.reader.u16().map_err(fmt)? as usize;
            let enc = self.reader.i32().map_err(fmt)?;
            covered += (w * h) as u64;

            if dbg {
                eprintln!("[vnc-dbg] rect {w}×{h}@{x},{y} enc={enc}");
            }
            if x + w > self.w || y + h > self.h {
                self.dirty = dirty;
                return Err(format!(
                    "帧越界：{w}×{h}@{x},{y}，屏幕 {}×{}",
                    self.w, self.h
                ));
            }

            match enc {
                ENC_RAW => {
                    let pb = self.codec.pixel_bytes();
                    let bytes = self.reader.to_vec(w * h * pb).map_err(fmt)?;
                    let t_proc = Instant::now();
                    self.raw.clear();
                    self.raw.resize(w * h, 0);
                    for i in 0..w * h {
                        self.raw[i] = self.codec.pack(&bytes, i * pb);
                    }
                    self.surface.blit(&self.raw, x, y, w, h);
                    self.surface.collect(x, y, w, h, &mut dirty);
                    let proc_ms = (t_proc.elapsed().as_millis() as u32)
                        .saturating_add(self.stats_proc_ms);
                    self.stats_proc_ms = proc_ms;
                }
                ENC_COPY_RECT => {
                    let sx = self.reader.u16().map_err(fmt)? as usize;
                    let sy = self.reader.u16().map_err(fmt)? as usize;
                    if sx + w > self.w || sy + h > self.h {
                        self.dirty = dirty;
                        return Err(format!("CopyRect 源越界：{w}×{h}@{sx},{sy}"));
                    }
                    let t_proc = Instant::now();
                    self.surface.copy_rect(sx, sy, x, y, w, h, &mut dirty);
                    let proc_ms = (t_proc.elapsed().as_millis() as u32)
                        .saturating_add(self.stats_proc_ms);
                    self.stats_proc_ms = proc_ms;
                }
                ENC_ZRLE => {
                    let len = self.reader.u32().map_err(fmt)? as usize;
                    if len > self.w * self.h * 4 + (1 << 20) {
                        self.dirty = dirty;
                        return Err(format!("ZRLE 数据长度异常：{len}"));
                    }
                    let payload = self.reader.to_vec(len).map_err(fmt)?;
                    if std::env::var("PYLON_VNC_DEBUG").is_ok() {
                        eprintln!(
                            "[vnc-dbg] ZRLE {w}×{h}@{x},{y} len={len} head={}",
                            hex(&payload[..payload.len().min(4)])
                        );
                    }
                    let t_dec = Instant::now();
                    let px = match self.zrle.decode(&payload, w, h, &self.pf) {
                        Ok(v) => v,
                        Err(e) => {
                            self.dirty = dirty;
                            return Err(format!(
                                "{e}（ZRLE {w}×{h}@{x},{y} len={len} head={}）",
                                hex(&payload[..payload.len().min(8)])
                            ));
                        }
                    };
                    let dec_ms = t_dec.elapsed().as_millis() as u32;
                    if dec_ms > self.stats_decode_ms {
                        self.stats_decode_ms = dec_ms;
                    }
                    let t_proc = Instant::now();
                    self.surface.blit(px, x, y, w, h);
                    self.surface.collect(x, y, w, h, &mut dirty);
                    let proc_ms = (t_proc.elapsed().as_millis() as u32)
                        .saturating_add(self.stats_proc_ms);
                    self.stats_proc_ms = proc_ms;
                }
                other => {
                    self.dirty = dirty;
                    return Err(format!("服务端用了未协商的编码 {other}"));
                }
            }
        }

        // 覆盖过半屏才算真的拿到了整屏；2×2、46×46 这种是 Apple 的占位/局部更新
        if !self.shared.full_seen.load(Ordering::Relaxed)
            && covered * 2 >= (self.w * self.h) as u64
        {
            self.shared.full_seen.store(true, Ordering::Relaxed);
        }

        let t_proc = Instant::now();
        self.surface.commit(&dirty);
        let proc_ms = (t_proc.elapsed().as_millis() as u32).saturating_add(self.stats_proc_ms);
        self.stats_proc_ms = proc_ms;

        let total_ms = t_frame.elapsed().as_millis() as u32;
        if !dirty.is_empty() {
            sink.frames(&dirty.tiles, &dirty.px).map_err(fmt)?;
            self.frames += 1;
            self.stats_frames += 1;
            if total_ms > self.stats_total_ms {
                self.stats_total_ms = total_ms;
            }
            self.shared
                .last_frame
                .store(self.shared.now_ms(), Ordering::Relaxed);
            self.shared.stall_count.store(0, Ordering::Relaxed);
            self.shared.stall_since.store(0, Ordering::Relaxed);
        }
        self.dirty = dirty;

        // CPU 段异常时直接打一条，不占管道协议字段
        if self.stats_proc_ms >= 15 {
            eprintln!("[vnc-proc] 本秒 CPU 段峰值 {}ms（解码 {}ms，其余为降采样+比对）", self.stats_proc_ms, self.stats_decode_ms);
        }

        // 每秒一份统计
        if self.stats_last.elapsed() >= Duration::from_secs(1) {
            let dt = self.stats_last.elapsed().as_secs_f64();
            let fps = (self.stats_frames as f64 / dt).round() as u16;
            let bytes = self.reader.received - self.stats_bytes;
            let kbps = ((bytes as f64 * 8.0) / 1000.0 / dt) as u32;
            let _ = sink.stats(fps, kbps, self.stats_decode_ms, self.stats_total_ms);
            self.stats_frames = 0;
            self.stats_bytes = self.reader.received;
            self.stats_last = Instant::now();
            self.stats_decode_ms = 0;
            self.stats_total_ms = 0;
            self.stats_proc_ms = 0;
        }

        self.pump()
    }
}

pub fn hex(b: &[u8]) -> String {
    b.iter().map(|x| format!("{x:02x}")).collect()
}

fn fmt<E: std::fmt::Display>(e: E) -> String {
    e.to_string()
}

fn authenticate(
    reader: &mut Reader,
    sock: &mut TcpStream,
    cfg: &Config,
    mode: u32,
) -> Result<(), String> {
    let chosen;

    if mode == 3 {
        // 3.3 是服务端直接指定安全类型
        let t = reader.u32().map_err(fmt)? as u8;
        match t {
            SEC_NONE | SEC_VNC_AUTH => chosen = t,
            other => return Err(format!("对端要求不支持的安全类型 {other}")),
        }
    } else {
        let count = reader.u8().map_err(fmt)? as usize;
        if count == 0 {
            let reason = reader.u32_string().unwrap_or_default();
            return Err(if reason.is_empty() {
                "服务端拒绝连接".to_string()
            } else {
                format!("服务端拒绝连接：{reason}")
            });
        }
        let types = reader.to_vec(count).map_err(fmt)?;
        if std::env::var("PYLON_VNC_DEBUG").is_ok() {
            eprintln!("[vnc-dbg] 服务端提供安全类型：{types:?}");
        }
        if types.contains(&SEC_VNC_AUTH) {
            if cfg.password.is_none() {
                return Err("对端要求 VNC 密码，但这条连接没有保存密码".to_string());
            }
            chosen = SEC_VNC_AUTH;
        } else if types.contains(&SEC_NONE) {
            chosen = SEC_NONE;
        } else {
            return Err(format!("对端只支持这些安全类型：{types:?}，本客户端都不支持"));
        }
        sock.write_all(&[chosen])
            .map_err(|e| format!("发送安全类型失败：{e}"))?;
    }

    if chosen == SEC_VNC_AUTH {
        let password = cfg
            .password
            .as_ref()
            .ok_or_else(|| "对端要求 VNC 密码，但没有提供".to_string())?;
        let challenge = reader.to_vec(16).map_err(fmt)?;
        let response = vnc_auth_response(password, &challenge);
        if std::env::var("PYLON_VNC_DEBUG").is_ok() {
            eprintln!(
                "[vnc-dbg] 密码 {:?}（{} 字节）\n[vnc-dbg] 挑战 {}\n[vnc-dbg] 响应 {}",
                password,
                password.len(),
                hex(&challenge),
                hex(&response)
            );
        }
        sock.write_all(&response)
            .map_err(|e| format!("发送认证响应失败：{e}"))?;
    }

    // 3.3 和 3.7 认证后没有 SecurityResult，3.8 才有
    if mode >= 8 {
        let result = reader.u32().map_err(fmt)?;
        if result != 0 {
            let reason = reader.u32_string().unwrap_or_default();
            return Err(if reason.is_empty() {
                "认证失败：VNC 密码不对（注意只取前 8 位）".to_string()
            } else {
                reason
            });
        }
    }
    Ok(())
}

pub fn spawn_watchdog(shared: Arc<Shared>) {
    std::thread::spawn(move || loop {
        std::thread::sleep(Duration::from_millis(250));
        if shared.closed.load(Ordering::Relaxed) {
            return;
        }
        let now = shared.now_ms();

        if !shared.full_seen.load(Ordering::Relaxed) {
            let hs = shared.handshake_at.load(Ordering::Relaxed);
            if hs > 0 && now > hs + FIRST_FRAME_MS {
                shared.fail("连上了但迟迟收不到画面，远端屏幕共享可能已挂起（锁屏或熄屏）");
                return;
            }
            // 还没拿到整屏：隔 1.8s 补一个整帧请求。
            // Apple 通常在连上后 1~2 秒自己把初始整屏推过来；这里只是兜底，
            // 间隔取得保守 —— 实测高频补发整帧请求反而会打断它的 damage 累积，
            // 让整屏一直出不来。
            let next = shared.next_full_at.load(Ordering::Relaxed);
            if hs > 0 && now > hs + 1800 && now >= next {
                shared.next_full_at.store(now + 1800, Ordering::Relaxed);
                shared.request(false);
            }
            continue;
        }

        let last_frame = shared.last_frame.load(Ordering::Relaxed);
        if last_frame == 0 {
            continue;
        }

        let since = shared.stall_since.load(Ordering::Relaxed);
        if since > 0 && now > since + STALL_MS {
            let n = shared.stall_count.fetch_add(1, Ordering::Relaxed) + 1;
            if n > STALL_GIVEUP {
                shared.fail("画面持续没有响应，连接已失效，请重新连接");
            } else {
                // 起点重置成「现在」，再补一个整帧请求：正常的「无变化」不会走到这里，
                // 因为 stall_since 只在有输入时才起
                shared.stall_since.store(now, Ordering::Relaxed);
                shared.request(false);
            }
        }
    });
}
