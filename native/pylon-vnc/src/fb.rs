//! 位图与「只发变化块」。
//!
//! 两份位图：`full` 是远端的原始像素（CopyRect 要从这里取源），`out` 是降采样后
//! 真正要交给渲染进程的尺寸。每贴一块就把对应区域从 full 重算进 out，再按 64×64
//! 比对，只把变的块收集起来 —— 服务端经常整屏重传，实际变化往往只是一小块，
//! 这一层过滤能把过管道的数据量压下去一个数量级。

pub struct Fb {
    pub w: usize,
    pub h: usize,
    pub px: Vec<u32>,
}

impl Fb {
    fn new(w: usize, h: usize) -> Fb {
        Fb {
            w,
            h,
            px: vec![0u32; w * h],
        }
    }
}

pub struct DirtyTile {
    pub x: u16,
    pub y: u16,
    pub w: u16,
    pub h: u16,
    /// 在 `Dirty::px` 里的起始像素下标
    pub off: usize,
}

/// 一帧里要发出去的变化块。容量跨帧复用，避免每帧分配。
pub struct Dirty {
    pub tiles: Vec<DirtyTile>,
    pub px: Vec<u32>,
}

impl Dirty {
    pub fn new() -> Dirty {
        Dirty {
            tiles: Vec::with_capacity(512),
            px: Vec::new(),
        }
    }

    pub fn clear(&mut self) {
        self.tiles.clear();
        self.px.clear();
    }

    pub fn is_empty(&self) -> bool {
        self.tiles.is_empty()
    }
}

impl Default for Dirty {
    fn default() -> Self {
        Dirty::new()
    }
}

const TILE: usize = 64;

pub struct Surface {
    pub full: Fb,
    pub out: Fb,
    pub scale: usize,
    painted: bool,
    scratch: Vec<u32>,
    /// 上一帧已发出的内容，比对的对象
    shadow: Vec<u32>,
}

impl Surface {
    pub fn new(w: usize, h: usize, scale: usize) -> Surface {
        let scale = scale.max(1);
        let ow = (w / scale).max(1);
        let oh = (h / scale).max(1);
        Surface {
            full: Fb::new(w, h),
            out: Fb::new(ow, oh),
            scale,
            painted: false,
            scratch: Vec::new(),
            shadow: vec![0u32; ow * oh],
        }
    }

    /// 把一块矩形贴进原始位图
    pub fn blit(&mut self, src: &[u32], x: usize, y: usize, w: usize, h: usize) {
        let stride = self.full.w;
        for row in 0..h {
            let dst = (y + row) * stride + x;
            self.full.px[dst..dst + w].copy_from_slice(&src[row * w..(row + 1) * w]);
        }
    }

    /// 取一块原始像素（CopyRect 的源区域）
    pub fn copy_rect(
        &mut self,
        sx: usize,
        sy: usize,
        x: usize,
        y: usize,
        w: usize,
        h: usize,
        dirty: &mut Dirty,
    ) {
        self.scratch.clear();
        self.scratch.resize(w * h, 0);
        let stride = self.full.w;
        for row in 0..h {
            let src = (sy + row) * stride + sx;
            self.scratch[row * w..(row + 1) * w].copy_from_slice(&self.full.px[src..src + w]);
        }
        // 先把 scratch 摘出来再贴：源区域和目标区域可能重叠（滚屏就是这样），
        // 必须整块读完再写，否则会读到已经被覆盖的像素
        let tmp = std::mem::take(&mut self.scratch);
        self.blit(&tmp, x, y, w, h);
        self.collect(x, y, w, h, dirty);
        self.scratch = tmp;
    }

    /// 把 full 里的一块区域重新算进 out，再把变化的块收进 dirty。
    ///
    /// 坐标是原始像素空间；out 空间按下标整除换算。右/下边界用向上取整，
    /// 宁可多算一列像素也不漏 —— 少算的那一列会在屏幕上留一条擦不掉的旧线。
    pub fn collect(&mut self, x: usize, y: usize, w: usize, h: usize, dirty: &mut Dirty) {
        let s = self.scale;
        let ox0 = x / s;
        let oy0 = y / s;
        let ox1 = ((x + w + s - 1) / s).min(self.out.w);
        let oy1 = ((y + h + s - 1) / s).min(self.out.h);
        if ox0 >= ox1 || oy0 >= oy1 {
            return;
        }
        let ow = ox1 - ox0;
        let oh = oy1 - oy0;

        if s == 1 {
            // 缩放为 1 时两块位图其实是同一份数据：先把 full 的内容写回 out
            for row in 0..oh {
                let dst = (oy0 + row) * self.out.w + ox0;
                let src = (oy0 + row) * self.full.w + ox0;
                self.out.px[dst..dst + ow].copy_from_slice(&self.full.px[src..src + ow]);
            }
        } else {
            self.downscale_region(ox0, oy0, ow, oh);
        }

        if !self.painted {
            // 首帧必然全变，直接整块发，省掉上千个 tile 头
            self.painted = true;
            let off = dirty.px.len();
            for row in 0..oh {
                let src = (oy0 + row) * self.out.w + ox0;
                dirty.px.extend_from_slice(&self.out.px[src..src + ow]);
            }
            dirty.tiles.push(DirtyTile {
                x: ox0 as u16,
                y: oy0 as u16,
                w: ow as u16,
                h: oh as u16,
                off,
            });
            return;
        }

        let mut ty = oy0;
        while ty < oy1 {
            let th = (oy1 - ty).min(TILE);
            let mut tx = ox0;
            while tx < ox1 {
                let tw = (ox1 - tx).min(TILE);
                if !self.tile_changed(tx, ty, tw, th) {
                    tx += TILE;
                    continue;
                }
                let off = dirty.px.len();
                for row in 0..th {
                    let src = (ty + row) * self.out.w + tx;
                    dirty.px.extend_from_slice(&self.out.px[src..src + tw]);
                }
                dirty.tiles.push(DirtyTile {
                    x: tx as u16,
                    y: ty as u16,
                    w: tw as u16,
                    h: th as u16,
                    off,
                });
                tx += TILE;
            }
            ty += TILE;
        }
    }

    /// 块内是否真有变化。JS 与 Rust 都没法在「已经贴过之后」再判断新旧，
    /// 所以这里用一份影子位图：out 里存的是**要发的**内容，比较对象是上一帧的副本。
    #[inline]
    fn tile_changed(&self, tx: usize, ty: usize, tw: usize, th: usize) -> bool {
        let stride = self.out.w;
        for row in 0..th {
            let start = (ty + row) * stride + tx;
            let a = &self.shadow[start..start + tw];
            let b = &self.out.px[start..start + tw];
            if a != b {
                return true;
            }
        }
        false
    }

    /// 把 out 落成「上一帧」，供下一次比对
    pub fn commit(&mut self, dirty: &Dirty) {
        for t in &dirty.tiles {
            let (tx, ty, tw, th) =
                (t.x as usize, t.y as usize, t.w as usize, t.h as usize);
            for row in 0..th {
                let dst = (ty + row) * self.out.w + tx;
                let src = t.off + row * tw;
                self.shadow[dst..dst + tw].copy_from_slice(&dirty.px[src..src + tw]);
            }
        }
    }

    fn downscale_region(&mut self, ox0: usize, oy0: usize, ow: usize, oh: usize) {
        let s = self.scale;
        let sw = self.full.w;
        let ow_stride = self.out.w;
        let n = (s * s) as u32;
        for oy in 0..oh {
            let fy = (oy0 + oy) * s;
            for ox in 0..ow {
                let fx = (ox0 + ox) * s;
                let (mut r, mut g, mut b) = (0u32, 0u32, 0u32);
                for sy in 0..s {
                    let row = (fy + sy) * sw;
                    for sx in 0..s {
                        let p = self.full.px[row + fx + sx];
                        r += p & 0xff;
                        g += (p >> 8) & 0xff;
                        b += (p >> 16) & 0xff;
                    }
                }
                let v = 0xff00_0000 | ((b / n) << 16) | ((g / n) << 8) | (r / n);
                self.out.px[(oy0 + oy) * ow_stride + ox0 + ox] = v;
            }
        }
    }
}
