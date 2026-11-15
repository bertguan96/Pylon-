//! 原生引擎与 Node 主进程之间的私有管道协议。
//!
//! 为什么走管道而不是做成 Node 原生插件（node-gyp / napi）：原生插件要和
//! Electron 的 ABI 绑定，每升一次 Electron 就得重编一次，还要求目标机器上有
//! MSVC。独立进程 + 二进制管道把这个耦合彻底切断了 —— 引擎就是一个 exe，
//! 崩了也只影响自己，Node 侧只要重新拉起来。
//!
//! 帧格式（全部小端）：
//!   magic 'P' 'V' | kind u8 | flags u8 | len u32 | payload
//! 加 magic 是为了在管道里出现错位时能立刻发现，而不是把像素当指令执行。

use std::io::{self, Read, Write};

pub const KIND_INIT: u8 = 1;
pub const KIND_FRAMES: u8 = 2;
pub const KIND_STATS: u8 = 3;
pub const KIND_ERROR: u8 = 4;
pub const KIND_CLOSED: u8 = 5;
pub const KIND_CLIPBOARD: u8 = 6;

pub const KIND_POINTER: u8 = 0x10;
pub const KIND_KEY: u8 = 0x11;
pub const KIND_FULL: u8 = 0x12;
pub const KIND_CLOSE: u8 = 0x13;
pub const KIND_CUT_TEXT: u8 = 0x14;

/// u32 切片 → 字节切片。x86_64 是小端，u32 的内存布局本身就是 RGBA 顺序。
/// 这是本文件里唯一的 unsafe：省掉每帧几百万次 to_le_bytes，是整条链路最值的一处。
#[inline]
pub fn as_bytes(v: &[u32]) -> &[u8] {
    unsafe { std::slice::from_raw_parts(v.as_ptr() as *const u8, v.len() * 4) }
}

pub fn frame_header(kind: u8, len: usize) -> [u8; 8] {
    let mut h = [0u8; 8];
    h[0] = b'P';
    h[1] = b'V';
    h[2] = kind;
    h[3] = 0;
    h[4..8].copy_from_slice(&(len as u32).to_le_bytes());
    h
}

pub struct Out<W: Write> {
    w: W,
}

impl<W: Write> Out<W> {
    pub fn new(w: W) -> Out<W> {
        Out { w }
    }

    fn begin(&mut self, kind: u8, len: usize) -> io::Result<()> {
        self.w.write_all(&frame_header(kind, len))
    }

    pub fn init(
        &mut self,
        out_w: u16,
        out_h: u16,
        remote_w: u16,
        remote_h: u16,
        scale: u16,
        name: &str,
    ) -> io::Result<()> {
        let body = name.as_bytes();
        self.begin(KIND_INIT, 10 + body.len())?;
        let mut buf = Vec::with_capacity(10 + body.len());
        buf.extend_from_slice(&out_w.to_le_bytes());
        buf.extend_from_slice(&out_h.to_le_bytes());
        buf.extend_from_slice(&remote_w.to_le_bytes());
        buf.extend_from_slice(&remote_h.to_le_bytes());
        buf.extend_from_slice(&scale.to_le_bytes());
        buf.extend_from_slice(body);
        self.w.write_all(&buf)?;
        self.w.flush()
    }

    pub fn frames(&mut self, tiles: &[crate::fb::DirtyTile], px: &[u32]) -> io::Result<()> {
        let len = 2 + tiles.len() * 8 + px.len() * 4;
        self.begin(KIND_FRAMES, len)?;
        let mut head = Vec::with_capacity(2 + tiles.len() * 8);
        head.extend_from_slice(&(tiles.len() as u16).to_le_bytes());
        for t in tiles {
            head.extend_from_slice(&t.x.to_le_bytes());
            head.extend_from_slice(&t.y.to_le_bytes());
            head.extend_from_slice(&t.w.to_le_bytes());
            head.extend_from_slice(&t.h.to_le_bytes());
        }
        self.w.write_all(&head)?;
        self.w.write_all(as_bytes(px))?;
        self.w.flush()
    }

    pub fn stats(&mut self, fps: u16, kbps: u32, decode_us: u32, total_us: u32) -> io::Result<()> {
        self.begin(KIND_STATS, 12)?;
        let mut buf = [0u8; 12];
        buf[0..2].copy_from_slice(&fps.to_le_bytes());
        buf[2..6].copy_from_slice(&kbps.to_le_bytes());
        buf[6..10].copy_from_slice(&decode_us.to_le_bytes());
        buf[10..12].copy_from_slice(&(total_us.min(u16::MAX as u32) as u16).to_le_bytes());
        self.w.write_all(&buf)?;
        self.w.flush()
    }

    pub fn error(&mut self, msg: &str) -> io::Result<()> {
        let body = msg.as_bytes();
        self.begin(KIND_ERROR, body.len())?;
        self.w.write_all(body)?;
        self.w.flush()
    }

    pub fn closed(&mut self) -> io::Result<()> {
        self.begin(KIND_CLOSED, 0)?;
        self.w.flush()
    }

    pub fn clipboard(&mut self, text: &str) -> io::Result<()> {
        let body = text.as_bytes();
        self.begin(KIND_CLIPBOARD, body.len())?;
        self.w.write_all(body)?;
        self.w.flush()
    }
}

pub enum Command {
    Pointer { mask: u8, x: u16, y: u16 },
    Key { down: bool, keysym: u32 },
    Full,
    CutText(String),
    Close,
}

/// 从 stdin 读命令。返回 None 表示对端（Node）已经关掉管道。
pub fn read_command<R: Read>(r: &mut R, buf: &mut Vec<u8>) -> io::Result<Option<Command>> {
    let mut h = [0u8; 8];
    match r.read_exact(&mut h) {
        Ok(()) => {}
        Err(e) if e.kind() == io::ErrorKind::UnexpectedEof => return Ok(None),
        Err(e) => return Err(e),
    }
    if h[0] != b'P' || h[1] != b'V' {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "管道数据错位：magic 不匹配",
        ));
    }
    let kind = h[2];
    let len = u32::from_le_bytes([h[4], h[5], h[6], h[7]]) as usize;
    if len > 1 << 20 {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "管道长度字段异常",
        ));
    }
    buf.clear();
    buf.resize(len, 0);
    if len > 0 {
        r.read_exact(buf)?;
    }
    Ok(Some(match kind {
        KIND_POINTER => Command::Pointer {
            mask: buf[0],
            x: u16::from_le_bytes([buf[1], buf[2]]),
            y: u16::from_le_bytes([buf[3], buf[4]]),
        },
        KIND_KEY => Command::Key {
            down: buf[0] != 0,
            keysym: u32::from_le_bytes([buf[4], buf[5], buf[6], buf[7]]),
        },
        KIND_FULL => Command::Full,
        KIND_CUT_TEXT => Command::CutText(String::from_utf8_lossy(buf).into_owned()),
        KIND_CLOSE => Command::Close,
        other => {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("未知的管道命令：{other}"),
            ))
        }
    }))
}
