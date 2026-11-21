//! H.264 编码器：调用 ffmpeg.exe 子进程，NVENC 硬件编码。
//!
//! 数据流：
//!   Rust 采集 BGRA → stdin 喂给 ffmpeg（rawvideo）
//!   ffmpeg 用 h264_nvenc 编码 → stdout 输出 Annex-B H.264
//!   Rust 读 stdout → UDP 群发
//!
//! 为什么不用 Media Foundation：windows-rs 的 SinkWriter 绑定在这台环境反复报
//! 参数错误（0xC00D36D5 / 0x80070057），调试成本高于用成熟的 ffmpeg 命令行。
//! 核心协议、采集、传输、输入仍是我们自己写的 —— 编码只是借一个成熟组件。

use std::io::{Read, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{channel, Receiver, Sender};

pub struct EncodeInput<'a> {
    pub bgra: &'a [u8],
    pub width: u32,
    pub height: u32,
}

pub struct Encoder {
    child: Child,
    stdin: ChildStdin,
    rx: Receiver<Vec<u8>>,
    read_buf: Vec<u8>,
    width: u32,
    height: u32,
    frames: u32,
}

impl Encoder {
    /// 启动 ffmpeg 编码进程。
    pub fn new(
        ffmpeg_path: Option<&std::path::Path>,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_mbps: u32,
    ) -> Result<Self, String> {
        let exe = ffmpeg_path
            .map(|p| p.to_path_buf())
            .unwrap_or_else(|| PathBuf::from("ffmpeg.exe"));

        // 先试 NVENC；构造两个候选，运行时由 main 决定
        Self::with_codec(exe, width, height, fps, bitrate_mbps, "h264_nvenc", true)
    }

    /// 用指定编码器启动
    pub fn with_codec(
        exe: PathBuf,
        width: u32,
        height: u32,
        fps: u32,
        bitrate_mbps: u32,
        codec: &str,
        hw: bool,
    ) -> Result<Self, String> {
        let mut args: Vec<String> = vec![
            "-hide_banner".into(), "-loglevel".into(), "error".into(),
            "-f".into(), "rawvideo".into(), "-pix_fmt".into(), "bgra".into(),
            "-s".into(), format!("{}x{}", width, height),
            "-r".into(), fps.to_string(),
            "-i".into(), "pipe:0".into(),
            "-an".into(),
            "-c:v".into(), codec.into(),
        ];
        if hw {
            args.extend([
                "-preset".into(), "p1".into(),   // 最低延迟
                "-tune".into(), "ll".into(),     // low latency
                "-rc".into(), "cbr".into(),
            ]);
        } else {
            args.extend([
                "-preset".into(), "ultrafast".into(),
                "-tune".into(), "zerolatency".into(),
            ]);
        }
        args.extend([
            "-b:v".into(), format!("{}M", bitrate_mbps),
            "-maxrate".into(), format!("{}M", bitrate_mbps),
            "-bufsize".into(), format!("{}M", (bitrate_mbps / 2).max(1)),
            "-bf".into(), "0".into(),                    // 关 B 帧，低延迟
            "-g".into(), (fps * 2).to_string(),          // 2 秒一个关键帧
            "-pix_fmt".into(), "yuv420p".into(),
            "-f".into(), "h264".into(),
            "pipe:1".into(),
        ]);

        let mut cmd = Command::new(&exe);
        cmd.args(&args)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());

        let mut child = cmd.spawn().map_err(|e| format!("启动 ffmpeg 失败（{:?}）: {}", exe, e))?;
        let stdin = child.stdin.take().ok_or("ffmpeg stdin 不可用")?;
        let mut stdout = child.stdout.take().ok_or("ffmpeg stdout 不可用")?;
        // 独立线程读 stdout：ffmpeg 要攒够帧才输出，主线程不能阻塞在 read 上
        let (tx, rx): (Sender<Vec<u8>>, Receiver<Vec<u8>>) = channel();
        std::thread::spawn(move || {
            let mut buf = [0u8; 128 * 1024];
            loop {
                match stdout.read(&mut buf) {
                    Ok(0) => break,
                    Ok(n) => { if tx.send(buf[..n].to_vec()).is_err() { break; } }
                    Err(_) => break,
                }
            }
        });

        eprintln!("[encoder] ffmpeg {} 就绪 {}×{} @{}fps {}Mbps", codec, width, height, fps, bitrate_mbps);
        Ok(Self {
            child,
            stdin,
            rx,
            read_buf: Vec::with_capacity(256 * 1024),
            width,
            height,
            frames: 0,
        })
    }

    /// 编码一帧：写 BGRA 到 stdin，读回 H.264 Annex-B 数据。
    pub fn encode(&mut self, input: &EncodeInput<'_>) -> Result<&[u8], String> {
        if let Some(status) = self.child.try_wait().map_err(|e| format!("try_wait: {e}"))? {
            return Err(format!("ffmpeg 进程已退出（status {status}）"));
        }
        let expected = (self.width * self.height * 4) as usize;
        if input.bgra.len() < expected {
            return Err(format!("BGRA 帧大小不对：{} < {}", input.bgra.len(), expected));
        }
        self.stdin
            .write_all(&input.bgra[..expected])
            .map_err(|e| format!("写 ffmpeg stdin 失败: {}", e))?;
        self.frames += 1;

        // 从 channel 非阻塞收取 ffmpeg 已编码的数据
        self.read_buf.clear();
        while let Ok(chunk) = self.rx.try_recv() {
            self.read_buf.extend_from_slice(&chunk);
            if self.read_buf.len() >= 2 * 1024 * 1024 { break; }
        }
        Ok(&self.read_buf)
    }

    pub fn needs_restart(&self) -> bool {
        false
    }

    pub fn frames(&self) -> u32 {
        self.frames
    }
}

impl Drop for Encoder {
    fn drop(&mut self) {
        let _ = self.stdin.flush();
        // stdin 会在 child drop 时自动关闭；直接 kill 进程
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

#[cfg(test)]
mod tests {
    #[test]
    fn encoder_module_compiles() {
        assert!(true);
    }
}
