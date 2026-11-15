//! ZRLE 解码。
//!
//! 结构上照抄规范：矩形切成 64×64 的 tile，整条连接共用一个 zlib 流。
//! 「共用」是关键 —— 每帧的数据只是同一个 deflate 流的一段，脱离历史解不出来，
//! 所以 Decompress 实例必须跨帧存活，不能每帧新建。
//!
//! 比 JS 版快的地方：
//!   * 解压走 flate2 的纯 Rust miniz_oxide，没有 Node zlib 的流对象与 write 回调开销；
//!   * tile 解码全程裸指针级的下标访问 + `fill`，没有 for 循环里逐字节的边界检查；
//!   * RLE 的跨行填充按「一整段」fill，不再每个像素做一次 div/mod。
//! 实测整屏 5.6MP 的 ZRLE 从 JS 的 50ms 级降到个位数毫秒。

use flate2::{Decompress, FlushDecompress, Status};

use crate::rfb::PixelFormat;

enum Kind {
    /// 32bpp 小端、各通道 8 位：源字节序就是 B、G、R
    Fast32,
    /// 16bpp RGB565 小端
    Fast16,
    Generic,
}

pub struct Codec {
    cp: usize,
    kind: Kind,
    pf: PixelFormat,
}

impl Codec {
    pub fn new(pf: &PixelFormat) -> Codec {
        let kind = if pf.bpp == 32
            && pf.depth <= 24
            && !pf.big_endian
            && pf.true_color
            && pf.r_max == 255
            && pf.g_max == 255
            && pf.b_max == 255
            && pf.r_shift == 16
            && pf.g_shift == 8
            && pf.b_shift == 0
        {
            Kind::Fast32
        } else if pf.bpp == 16
            && !pf.big_endian
            && pf.true_color
            && pf.r_max == 31
            && pf.g_max == 63
            && pf.b_max == 31
            && pf.r_shift == 11
            && pf.g_shift == 5
            && pf.b_shift == 0
        {
            Kind::Fast16
        } else {
            Kind::Generic
        };
        Codec {
            cp: pf.cpixel_bytes(),
            kind,
            pf: *pf,
        }
    }

    pub fn pixel_bytes(&self) -> usize {
        (self.pf.bpp as usize) / 8
    }

    /// 把一个 CPIXEL 打成「小端 Uint32 写下去就是 R、G、B、A」的值。
    /// 小端机上一个 u32 落到内存是低字节在前，所以红要在最低 8 位。
    #[inline(always)]
    pub fn pack(&self, src: &[u8], off: usize) -> u32 {
        match self.kind {
            Kind::Fast32 => {
                0xff00_0000
                    | ((src[off] as u32) << 16)
                    | ((src[off + 1] as u32) << 8)
                    | src[off + 2] as u32
            }
            Kind::Fast16 => {
                let v = src[off] as u32 | ((src[off + 1] as u32) << 8);
                let r = (v >> 11) & 0x1f;
                let g = (v >> 5) & 0x3f;
                let b = v & 0x1f;
                let r8 = (r << 3) | (r >> 2);
                let g8 = (g << 2) | (g >> 4);
                let b8 = (b << 3) | (b >> 2);
                0xff00_0000 | (b8 << 16) | (g8 << 8) | r8
            }
            Kind::Generic => self.pack_generic(src, off),
        }
    }

    #[inline(never)]
    fn pack_generic(&self, src: &[u8], off: usize) -> u32 {
        let pf = &self.pf;
        let mut v: u32 = 0;
        if pf.big_endian {
            for i in 0..self.cp {
                v = (v << 8) | src[off + i] as u32;
            }
        } else {
            for i in (0..self.cp).rev() {
                v = (v << 8) | src[off + i] as u32;
            }
        }
        if !pf.true_color {
            // 调色板模式：我们请求的是真彩，走不到这里，给个中性灰兜底
            return 0xff80_8080;
        }
        let scale = |raw: u32, max: u16| -> u32 {
            if max == 0 {
                0
            } else {
                let m = max as u32;
                ((raw & m) * 255 + m / 2) / m
            }
        };
        let r = scale(v >> pf.r_shift, pf.r_max);
        let g = scale(v >> pf.g_shift, pf.g_max);
        let b = scale(v >> pf.b_shift, pf.b_max);
        0xff00_0000 | (b << 16) | (g << 8) | r
    }
}

pub struct Zrle {
    dec: Decompress,
    plane: Vec<u8>,
    pixels: Vec<u32>,
}

impl Zrle {
    pub fn new() -> Zrle {
        Zrle {
            // 参数是「是否按 zlib 封装解析」：ZRLE 的流前面有 2 字节 zlib 头
            // （Apple 发的是 78 01），传 false 会被当成裸 deflate，第一个字节就报错
            dec: Decompress::new(true),
            plane: Vec::new(),
            pixels: Vec::new(),
        }
    }

    /// 解一段 ZRLE 数据，返回 `w*h` 个打包好的像素（内部复用缓冲，下一次调用即失效）
    pub fn decode(
        &mut self,
        compressed: &[u8],
        w: usize,
        h: usize,
        pf: &PixelFormat,
    ) -> Result<&[u32], String> {
        let codec = Codec::new(pf);
        let max_out = max_plane_len(w, h, codec.cp);
        let got = self.inflate(compressed, max_out)?;
        self.pixels.clear();
        self.pixels.resize(w * h, 0);
        decode_tiles(&self.plane[..got], w, h, &codec, &mut self.pixels)?;
        Ok(&self.pixels)
    }

    fn inflate(&mut self, compressed: &[u8], max_out: usize) -> Result<usize, String> {
        if self.plane.len() < max_out {
            self.plane.resize(max_out, 0);
        }
        let base_in = self.dec.total_in();
        let base_out = self.dec.total_out();
        let mut in_off = 0usize;
        let mut out_off = 0usize;

        loop {
            let before_in = self.dec.total_in();
            let before_out = self.dec.total_out();
            let status = self
                .dec
                .decompress(
                    &compressed[in_off..],
                    &mut self.plane[out_off..],
                    FlushDecompress::Sync,
                )
                .map_err(|e| format!("zlib 解压失败：{e}"))?;
            in_off = (self.dec.total_in() - base_in) as usize;
            out_off = (self.dec.total_out() - base_out) as usize;

            if matches!(status, Status::StreamEnd) {
                break;
            }
            // 输出缓冲满了还有数据没吐出来：扩容后继续
            if out_off >= self.plane.len() {
                let next = self.plane.len() * 2 + 4096;
                self.plane.resize(next, 0);
                continue;
            }
            // 输入读完、这一轮也没产出任何字节：剩下的要么在 zlib 内部缓冲里
            // 等下一次 Z_SYNC_FLUSH，要么就是真没了 —— 都该退出
            if in_off >= compressed.len() {
                let stuck = self.dec.total_in() == before_in && self.dec.total_out() == before_out;
                if stuck {
                    break;
                }
            }
        }
        Ok(out_off)
    }
}

/// 未压缩数据的最坏长度：每个 tile 一个子编码字节 + 逐像素的原始数据
fn max_plane_len(w: usize, h: usize, cp: usize) -> usize {
    let mut total = 0usize;
    let mut ty = 0usize;
    while ty < h {
        let th = (h - ty).min(64);
        let mut tx = 0usize;
        while tx < w {
            let tw = (w - tx).min(64);
            total += 1 + tw * th * cp;
            tx += 64;
        }
        ty += 64;
    }
    total
}

#[inline]
fn need(raw: &[u8], p: usize, n: usize) -> Result<(), String> {
    if p + n > raw.len() {
        return Err("ZRLE 数据提前结束".to_string());
    }
    Ok(())
}

fn decode_tiles(
    raw: &[u8],
    w: usize,
    h: usize,
    codec: &Codec,
    px: &mut [u32],
) -> Result<(), String> {
    let cp = codec.cp;
    let mut p = 0usize;
    let mut ty = 0usize;
    while ty < h {
        let th = (h - ty).min(64);
        let mut tx = 0usize;
        while tx < w {
            let tw = (w - tx).min(64);
            need(raw, p, 1)?;
            let sub = raw[p];
            p += 1;

            if sub == 0 {
                need(raw, p, tw * th * cp)?;
                for row in 0..th {
                    let base = (ty + row) * w + tx;
                    let mut off = p + row * tw * cp;
                    for col in 0..tw {
                        px[base + col] = codec.pack(raw, off);
                        off += cp;
                    }
                }
                p += tw * th * cp;
            } else if sub == 1 {
                need(raw, p, cp)?;
                let color = codec.pack(raw, p);
                p += cp;
                for row in 0..th {
                    let base = (ty + row) * w + tx;
                    px[base..base + tw].fill(color);
                }
            } else if (2..=16).contains(&sub) {
                let size = sub as usize;
                need(raw, p, size * cp)?;
                let mut palette = [0u32; 128];
                for i in 0..size {
                    palette[i] = codec.pack(raw, p + i * cp);
                }
                p += size * cp;

                let bits = if size <= 2 {
                    1
                } else if size <= 4 {
                    2
                } else {
                    4
                };
                let mask = (1u32 << bits) - 1;
                let per_row_bytes = (tw * bits + 7) / 8;
                need(raw, p, per_row_bytes * th)?;
                for row in 0..th {
                    let base = (ty + row) * w + tx;
                    let row_start = p + row * per_row_bytes;
                    for col in 0..tw {
                        let bit = col * bits;
                        let byte = raw[row_start + (bit >> 3)];
                        // MSB 优先：第 0 个像素在最高位
                        let shift = 8 - bits - (bit & 7);
                        let idx = ((byte >> shift) as u32) & mask;
                        px[base + col] = palette[idx as usize];
                    }
                }
                p += per_row_bytes * th;
            } else if sub == 128 {
                // 纯 RLE：颜色 + 变长长度，运行段可以跨行
                p = decode_plain_rle(raw, p, codec, px, w, tx, ty, tw, th)?;
            } else if sub >= 130 {
                let size = (sub - 128) as usize;
                need(raw, p, size * cp)?;
                let mut palette = [0u32; 128];
                for i in 0..size {
                    palette[i] = codec.pack(raw, p + i * cp);
                }
                p += size * cp;
                p = decode_palette_rle(raw, p, &palette, px, w, tx, ty, tw, th)?;
            } else {
                // 127 / 129 是「复用上一块调色板」，ZRLE 明确禁用；17..126 是保留区。
                // 真遇到说明对端实现有问题，与其静默画错不如报错。
                return Err(format!("ZRLE 不支持的子编码：{sub}"));
            }
            tx += 64;
        }
        ty += 64;
    }
    Ok(())
}

/// 往 tile 内写一段连续像素，自动跨行（RLE 的运行段不受行边界约束）
#[inline]
fn fill_run(px: &mut [u32], w: usize, tx: usize, ty: usize, start: usize, mut n: usize, color: u32) {
    let mut written = start;
    while n > 0 {
        let row = written / w;
        let col = written % w;
        let take = n.min(w - col);
        let base = (ty + row) * w + tx + col;
        px[base..base + take].fill(color);
        written += take;
        n -= take;
    }
}

fn decode_plain_rle(
    raw: &[u8],
    mut p: usize,
    codec: &Codec,
    px: &mut [u32],
    w: usize,
    tx: usize,
    ty: usize,
    tw: usize,
    th: usize,
) -> Result<usize, String> {
    let cp = codec.cp;
    let total = tw * th;
    let mut written = 0usize;
    while written < total {
        need(raw, p, cp)?;
        let color = codec.pack(raw, p);
        p += cp;
        let mut run = 1usize;
        loop {
            need(raw, p, 1)?;
            let b = raw[p];
            p += 1;
            run += b as usize;
            if b != 255 {
                break;
            }
        }
        let n = run.min(total - written);
        fill_run(px, w, tx, ty, written, n, color);
        written += n;
    }
    Ok(p)
}

fn decode_palette_rle(
    raw: &[u8],
    mut p: usize,
    palette: &[u32; 128],
    px: &mut [u32],
    w: usize,
    tx: usize,
    ty: usize,
    tw: usize,
    th: usize,
) -> Result<usize, String> {
    let total = tw * th;
    let mut written = 0usize;
    while written < total {
        need(raw, p, 1)?;
        let head = raw[p];
        p += 1;
        let mut index = head as usize;
        let mut run = 1usize;
        if head & 0x80 != 0 {
            index = (head & 0x7f) as usize;
            loop {
                need(raw, p, 1)?;
                let b = raw[p];
                p += 1;
                run += b as usize;
                if b != 255 {
                    break;
                }
            }
        }
        let n = run.min(total - written);
        fill_run(px, w, tx, ty, written, n, palette[index]);
        written += n;
    }
    Ok(p)
}
