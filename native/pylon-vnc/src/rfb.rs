//! RFB 协议的常量、像素格式，以及一个「想读 n 字节就一定能读到 n 字节」的读缓冲。
//!
//! 和 JS 版的区别只有一个但很关键：这里是阻塞式读一个自管理的环形缓冲，
//! 没有 async/await，没有每个字段一个 microtask。JS 版读一个 u16 要走一次
//! Promise + 微任务调度，一帧几十个字段就是几百次调度开销 —— 原生版本这一段
//! 直接是几次内存访问。

use std::io::{self, Read};
use std::net::TcpStream;

pub const ENC_RAW: i32 = 0;
pub const ENC_COPY_RECT: i32 = 1;
pub const ENC_ZRLE: i32 = 16;

pub const MSG_FB_UPDATE: u8 = 0;
pub const MSG_SET_COLOUR_MAP: u8 = 1;
pub const MSG_BELL: u8 = 2;
pub const MSG_CUT_TEXT: u8 = 3;

pub const SEC_NONE: u8 = 1;
pub const SEC_VNC_AUTH: u8 = 2;

#[derive(Clone, Copy, Debug)]
pub struct PixelFormat {
    pub bpp: u8,
    pub depth: u8,
    pub big_endian: bool,
    pub true_color: bool,
    pub r_max: u16,
    pub g_max: u16,
    pub b_max: u16,
    pub r_shift: u8,
    pub g_shift: u8,
    pub b_shift: u8,
}

/// 32bpp / depth 24 / 小端，R 落在 16 位上。
///
/// 内存里正好是 B、G、R 三个字节，解码时补个 0xFF 就是 RGBA，一次位运算都不用。
/// depth 取 24 还有个白拿的好处：ZRLE 的 CPIXEL 会退化成 3 字节，省 1/4 传输量。
pub const PF_RGBA32: PixelFormat = PixelFormat {
    bpp: 32,
    depth: 24,
    big_endian: false,
    true_color: true,
    r_max: 255,
    g_max: 255,
    b_max: 255,
    r_shift: 16,
    g_shift: 8,
    b_shift: 0,
};

/// 16bpp RGB565：同样的 ZRLE 编码下流量再减一半，代价是渐变色带。
pub const PF_RGB565: PixelFormat = PixelFormat {
    bpp: 16,
    depth: 16,
    big_endian: false,
    true_color: true,
    r_max: 31,
    g_max: 63,
    b_max: 31,
    r_shift: 11,
    g_shift: 5,
    b_shift: 0,
};

impl PixelFormat {
    pub fn parse(buf: &[u8]) -> PixelFormat {
        PixelFormat {
            bpp: buf[0],
            depth: buf[1],
            big_endian: buf[2] != 0,
            true_color: buf[3] != 0,
            r_max: u16::from_be_bytes([buf[4], buf[5]]),
            g_max: u16::from_be_bytes([buf[6], buf[7]]),
            b_max: u16::from_be_bytes([buf[8], buf[9]]),
            r_shift: buf[10],
            g_shift: buf[11],
            b_shift: buf[12],
        }
    }

    pub fn encode(&self) -> [u8; 16] {
        let mut out = [0u8; 16];
        out[0] = self.bpp;
        out[1] = self.depth;
        out[2] = self.big_endian as u8;
        out[3] = self.true_color as u8;
        out[4..6].copy_from_slice(&self.r_max.to_be_bytes());
        out[6..8].copy_from_slice(&self.g_max.to_be_bytes());
        out[8..10].copy_from_slice(&self.b_max.to_be_bytes());
        out[10] = self.r_shift;
        out[11] = self.g_shift;
        out[12] = self.b_shift;
        out
    }

    /// ZRLE 一个 CPIXEL 占几个字节：32bpp 且 depth<=24 时规范只发低 3 字节
    pub fn cpixel_bytes(&self) -> usize {
        if self.bpp == 32 && self.depth <= 24 {
            3
        } else {
            (self.bpp as usize) / 8
        }
    }

    pub fn pixel_bytes(&self) -> usize {
        (self.bpp as usize) / 8
    }
}

/// 带缓冲的 TCP 读端。
///
/// 内部只有一份 Vec：有效区间是 `buf[pos..len]`。快路径（够读）零拷贝，
/// 慢路径（不够）先把尾巴挪到头部再 read 补齐 —— 这样就避免了 JS 版里
/// 「跨 chunk 拼接要新分配一个 Buffer」的老问题。
pub struct Reader {
    sock: TcpStream,
    buf: Vec<u8>,
    pos: usize,
    len: usize,
    /// 累计收到的字节数，算码率用
    pub received: u64,
}

impl Reader {
    pub fn new(sock: TcpStream) -> Reader {
        Reader {
            sock,
            buf: vec![0u8; 64 * 1024],
            pos: 0,
            len: 0,
            received: 0,
        }
    }

    pub fn sock(&self) -> &TcpStream {
        &self.sock
    }

    fn ensure(&mut self, n: usize) -> io::Result<()> {
        if self.len - self.pos >= n {
            return Ok(());
        }
        if self.pos > 0 {
            self.buf.copy_within(self.pos..self.len, 0);
            self.len -= self.pos;
            self.pos = 0;
        }
        if self.buf.len() < n {
            self.buf.resize(n, 0);
        }
        while self.len < n {
            let got = self.sock.read(&mut self.buf[self.len..n])?;
            if got == 0 {
                return Err(io::Error::new(
                    io::ErrorKind::UnexpectedEof,
                    "对端关闭了连接",
                ));
            }
            self.len += got;
            self.received += got as u64;
        }
        Ok(())
    }

    pub fn take(&mut self, n: usize) -> io::Result<&[u8]> {
        self.ensure(n)?;
        let end = self.pos + n;
        self.pos = end;
        Ok(&self.buf[end - n..end])
    }

    pub fn to_vec(&mut self, n: usize) -> io::Result<Vec<u8>> {
        Ok(self.take(n)?.to_vec())
    }

    pub fn skip(&mut self, n: usize) -> io::Result<()> {
        if n == 0 {
            return Ok(());
        }
        self.ensure(n)?;
        self.pos += n;
        Ok(())
    }

    pub fn u8(&mut self) -> io::Result<u8> {
        Ok(self.take(1)?[0])
    }

    pub fn u16(&mut self) -> io::Result<u16> {
        let b = self.take(2)?;
        Ok(u16::from_be_bytes([b[0], b[1]]))
    }

    pub fn u32(&mut self) -> io::Result<u32> {
        let b = self.take(4)?;
        Ok(u32::from_be_bytes([b[0], b[1], b[2], b[3]]))
    }

    pub fn i32(&mut self) -> io::Result<i32> {
        Ok(self.u32()? as i32)
    }

    /// 读 4 字节长度 + 内容的字符串（桌面名、剪贴板都是这个形状）
    pub fn u32_string(&mut self) -> io::Result<String> {
        let len = self.u32()? as usize;
        if len == 0 {
            return Ok(String::new());
        }
        if len > 1 << 20 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("字符串长度异常：{len}"),
            ));
        }
        let bytes = self.to_vec(len)?;
        Ok(String::from_utf8_lossy(&bytes).into_owned())
    }
}
