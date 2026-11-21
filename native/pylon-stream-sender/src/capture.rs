//! DXGI Desktop Duplication 屏幕采集。
//!
//! 为什么不用 GDI BitBlt：BitBlt 走 CPU 拷贝，3840×2160 一帧要 15~25ms，
//! 60fps 根本不可能。Desktop Duplication 让 GPU 把桌面纹理直接复制给我们，
//! 只读一次显存，实测 4K 一帧 2~4ms —— 这是 Windows 上 60fps 采集的唯一现实路径。
//!
//! 流程（每一帧）：
//!   AcquireNextFrame → 拿到 IDXGIResource → QueryInterface 成 ID3D11Texture2D
//!   → CopyResource 到 staging texture（CPU 可读）→ Map → 逐行拷贝到 BGRA buffer
//!   → ReleaseFrame

use std::ptr;

use windows::core::Interface;
use windows::Win32::Foundation::*;
use windows::Win32::Graphics::Direct3D::*;
use windows::Win32::Graphics::Direct3D11::*;
use windows::Win32::Graphics::Dxgi::Common::*;
use windows::Win32::Graphics::Dxgi::*;
use windows::Win32::System::Threading::*;

pub struct CapturedFrame {
    pub width: u32,
    pub height: u32,
    /// BGRA，每行 4 字节对齐，长度 = width*height*4
    pub bgra: Vec<u8>,
}

pub struct Capture {
    device: ID3D11Device,
    context: ID3D11DeviceContext,
    duplication: IDXGIOutputDuplication,
    staging: ID3D11Texture2D,
    width: u32,
    height: u32,
    /// staging texture 的行跨度（字节），通常 >= width*4
    stride: usize,
    /// 上次 AcquireNextFrame 的错误计数，用于诊断
    pub errors: u32,
}

impl Capture {
    /// 初始化采集。monitor_index=0 是主显示器。
    pub fn new(monitor_index: u32) -> Result<Self, String> {
        unsafe {
            // 1) 创建 D3D11 设备和立即上下文
            let mut device = None;
            let mut context = None;
            let hr = D3D11CreateDevice(
                None,
                D3D_DRIVER_TYPE_HARDWARE,
                HMODULE(std::ptr::null_mut()),
                D3D11_CREATE_DEVICE_FLAG(0),
                Some(&[D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_1, D3D_FEATURE_LEVEL_10_0]),
                D3D11_SDK_VERSION,
                Some(&mut device),
                None,
                Some(&mut context),
            );
            let hr = hr.map_err(|e| format!("D3D11CreateDevice 失败: {e:?}"))?;
            let _ = hr;
            let device: ID3D11Device = device.ok_or("D3D11 device 为空")?;
            let context: ID3D11DeviceContext = context.ok_or("D3D11 context 为空")?;

            // 2) 拿到 DXGI 设备 → 适配器 → 输出（显示器）
            let dxgi_device: IDXGIDevice = device.cast().map_err(|e| format!("拿 IDXGIDevice 失败: {e:?}"))?;
            let adapter: IDXGIAdapter = dxgi_device
                .GetParent()
                .map_err(|e| format!("拿适配器失败: {e:?}"))?;

            let mut output: Option<IDXGIOutput> = None;
            for idx in 0..=monitor_index {
                match adapter.EnumOutputs(idx) {
                    Ok(o) if idx == monitor_index => { output = Some(o); break; }
                    Ok(_) => continue,
                    Err(_) => break, // 没有更多输出
                }
            }
            let output = output.ok_or(format!("找不到显示器 #{monitor_index}"))?;

            // 3) 拿显示器描述里的分辨率（GetDesc 里没有尺寸，需从 duplication 的
            //    AcquireNextFrame 拿；这里先用一个占位，首帧时按实际尺寸建 staging）
            let output1: IDXGIOutput1 = output.cast().map_err(|e| format!("拿 IDXGIOutput1 失败: {e:?}"))?;
            let duplication = output1
                .DuplicateOutput(&device)
                .map_err(|e| format!("DuplicateOutput 失败（可能有全屏独占程序或远程桌面会话）: {e:?}"))?;

            // 4) staging texture 首帧再建（此时才知道真实尺寸）；先用 1x1 占位
            let (staging, width, height, stride) = make_staging(&device, 1, 1)?;

            Ok(Self {
                device,
                context,
                duplication,
                staging,
                width,
                height,
                stride,
                errors: 0,
            })
        }
    }

    /// 抓一帧。超时返回 Ok(None)，让调用方继续轮询（不要阻塞太久）。
    pub fn grab(&mut self, timeout_ms: u32) -> Result<Option<CapturedFrame>, String> {
        unsafe {
            let mut info = DXGI_OUTDUPL_FRAME_INFO::default();
            let mut resource = None;

            let hr = self.duplication.AcquireNextFrame(timeout_ms, &mut info, &mut resource);
            if hr.is_err() {
                // DXGI_ERROR_WAIT_TIMEOUT 是正常的「没有新帧」
                let code = hr.unwrap_err().code();
                if code == DXGI_ERROR_WAIT_TIMEOUT {
                    return Ok(None);
                }
                self.errors += 1;
                if self.errors <= 3 || self.errors % 100 == 0 {
                    eprintln!("[capture] AcquireNextFrame 错误 {:08x}（累计 {}）", code.0 as u32, self.errors);
                }
                return Ok(None);
            }

            // 鼠标形状更新不算画面变化，但我们仍要释放帧；没有桌面纹理就返回 None
            let resource = match resource {
                Some(r) => r,
                None => {
                    let _ = self.duplication.ReleaseFrame();
                    return Ok(None);
                }
            };

            let texture: ID3D11Texture2D = match resource.cast() {
                Ok(t) => t,
                Err(_) => {
                    let _ = self.duplication.ReleaseFrame();
                    return Ok(None); // 鼠标指针纹理，不是桌面
                }
            };

            let mut desc = D3D11_TEXTURE2D_DESC::default();
            texture.GetDesc(&mut desc);
            let w = desc.Width;
            let h = desc.Height;

            // 分辨率变了（用户改分辨率/接了外接屏）就重建 staging
            if w != self.width || h != self.height {
                let (staging, _, _, stride) = make_staging(&self.device, w, h)?;
                self.staging = staging;
                self.width = w;
                self.height = h;
                self.stride = stride;
                eprintln!("[capture] 分辨率变化 → {w}×{h}");
            }

            // GPU 拷贝桌面纹理到 staging
            let tex_id3d11: &ID3D11Texture2D = &texture;
            self.context.CopyResource(&self.staging, tex_id3d11);

            // 映射 staging 读取像素
            let mut mapped = D3D11_MAPPED_SUBRESOURCE::default();
            let hr = self.context.Map(
                &self.staging,
                0,
                D3D11_MAP_READ,
                0u32,
                Some(&mut mapped),
            );
            if let Err(e) = hr {
                let _ = self.duplication.ReleaseFrame();
                return Err(format!("Map 失败: {e:?}"));
            }

            let src = mapped.pData as *const u8;
            let stride = mapped.RowPitch as usize;
            let row_bytes = (w as usize) * 4;
            let mut bgra = vec![0u8; row_bytes * h as usize];
            for y in 0..h as usize {
                let src_row = src.add(y * stride);
                let dst_row = &mut bgra[y * row_bytes..(y + 1) * row_bytes];
                // Desktop Duplication 输出 BGRA 或 RGBA 取决于格式；
                // 我们请求 staging 用 BGRA，所以这里直接拷
                ptr::copy_nonoverlapping(src_row, dst_row.as_mut_ptr(), row_bytes);
            }

            self.context.Unmap(&self.staging, 0);
            let _ = self.duplication.ReleaseFrame();

            // 诊断：每 100 帧统计非黑像素比例，确认采集到的是真实画面
            static DIAG: std::sync::atomic::AtomicU32 = std::sync::atomic::AtomicU32::new(0);
            let cnt = DIAG.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            if cnt % 100 == 0 {
                let step = (bgra.len() / 4000).max(4) & !3;
                let mut nonzero = 0usize;
                let mut maxv = 0u8;
                for i in (0..bgra.len() - step).step_by(step) {
                    let v = bgra[i].max(bgra[i + 1]).max(bgra[i + 2]);
                    if v > 8 { nonzero += 1; }
                    maxv = maxv.max(v);
                }
                eprintln!("[capture] 诊断: 采样 {} 点, 非黑 {}, 最大亮度 {}", bgra.len()/step, nonzero, maxv);
            }

            Ok(Some(CapturedFrame {
                width: w,
                height: h,
                bgra,
            }))
        }
    }
}

/// 创建 CPU 可读的 staging texture
unsafe fn make_staging(
    device: &ID3D11Device,
    w: u32,
    h: u32,
) -> Result<(ID3D11Texture2D, u32, u32, usize), String> {
    let desc = D3D11_TEXTURE2D_DESC {
        Width: w,
        Height: h,
        MipLevels: 1,
        ArraySize: 1,
        Format: DXGI_FORMAT_B8G8R8A8_UNORM,
        SampleDesc: DXGI_SAMPLE_DESC {
            Count: 1,
            Quality: 0,
        },
        Usage: D3D11_USAGE_STAGING,
        BindFlags: 0u32,
        CPUAccessFlags: D3D11_CPU_ACCESS_READ.0 as u32,
        MiscFlags: 0u32,
    };
    let mut tex = None;
    device
        .CreateTexture2D(&desc, None, Some(&mut tex))
        .map_err(|e| format!("CreateTexture2D 失败: {e:?}"))?;
    let tex: ID3D11Texture2D = tex.ok_or("staging texture 为空")?;
    // staging 的 RowPitch 通常就是 w*4，但按 16 字节对齐；保守按 w*4 估，
    // 实际读取时用 Map 返回的 RowPitch
    Ok((tex, w, h, (w as usize) * 4))
}
