//! Pylon 原生 VNC 引擎。
//!
//! 两种跑法：
//!   `pylon-vnc serve --host H --port P [...]`  —— 被 Node 主进程拉起，用私有管道
//!     协议收发（见 pipe.rs）；stdin 是输入指令，stdout 是帧数据。
//!   `pylon-vnc live --host H --port P [...]`   —— 独立的真机诊断，直接对着 Mac
//!     跑指标打到终端。和 JS 版的 VNC_LIVE 是同一个用途，方便两边对比数字。

mod client;
mod des;
mod fb;
mod pipe;
mod rfb;
mod zrle;

use std::io::{self, Write};
use std::time::{Duration, Instant};

use client::{spawn_watchdog, Config, FrameSink, Info, Quality, Session};
use fb::DirtyTile;
use pipe::{Command, Out};

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.is_empty() {
        usage();
        std::process::exit(2);
    }
    let mode = args[0].clone();
    let parsed = match parse_config(&args[1..]) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("[pylon-vnc] 参数错误：{e}");
            std::process::exit(2);
        }
    };

    let code = match mode.as_str() {
        "serve" => serve(parsed.config),
        "live" => live(parsed.config, parsed.live),
        "--help" | "-h" | "help" => {
            usage();
            0
        }
        other => {
            eprintln!("[pylon-vnc] 未知模式：{other}");
            usage();
            2
        }
    };
    std::process::exit(code);
}

fn usage() {
    eprintln!(
        "用法：
  pylon-vnc serve --host H --port P [--quality speed|sharp] [--scale N]
      Node 拉起模式：stdin 收指令、stdout 出帧（私有管道协议）
  pylon-vnc live  --host H --port P [--move] [--seconds N] [...]
      真机诊断模式：把握手/首帧/帧率/解码耗时打到终端

  密码从环境变量 PYLON_VNC_PASSWORD 读（不放命令行，避免出现在进程列表里）"
    );
}

struct LiveOpts {
    move_mouse: bool,
    seconds: u64,
    /// 退出前把画面存成 BMP，人工核对颜色与内容
    dump: Option<String>,
}

struct Parsed {
    config: Config,
    live: LiveOpts,
}

fn parse_config(args: &[String]) -> Result<Parsed, String> {
    let mut host = String::new();
    let mut port: u16 = 5900;
    let mut quality = Quality::Speed;
    let mut scale: Option<usize> = None;
    let mut password = std::env::var("PYLON_VNC_PASSWORD").ok();
    let mut live = LiveOpts {
        move_mouse: false,
        seconds: 3,
        dump: None,
    };

    let mut i = 0;
    while i < args.len() {
        let key = args[i].clone();
        let value = || -> Result<String, String> {
            args.get(i + 1)
                .cloned()
                .ok_or_else(|| format!("{key} 缺少参数值"))
        };
        match key.as_str() {
            "--host" => {
                host = value()?;
                i += 2;
            }
            "--port" => {
                port = value()?
                    .parse()
                    .map_err(|_| "端口不是数字".to_string())?;
                i += 2;
            }
            "--password" => {
                password = Some(value()?);
                i += 2;
            }
            "--quality" => {
                quality = match value()?.as_str() {
                    "sharp" => Quality::Sharp,
                    _ => Quality::Speed,
                };
                i += 2;
            }
            "--scale" => {
                scale = Some(value()?.parse::<usize>().map_err(|_| "scale 不是数字")?.max(1));
                i += 2;
            }
            "--seconds" => {
                live.seconds = value()?.parse().map_err(|_| "seconds 不是数字")?;
                i += 2;
            }
            "--dump" => {
                live.dump = Some(value()?);
                i += 2;
            }
            "--move" => {
                live.move_mouse = true;
                i += 1;
            }
            other => return Err(format!("未知参数 {other}")),
        }
    }

    if host.is_empty() {
        return Err("必须给 --host".to_string());
    }

    Ok(Parsed {
        config: Config {
            host,
            port,
            password,
            quality,
            scale,
            timeout: Duration::from_millis(8000),
        },
        live,
    })
}

fn serve(cfg: Config) -> i32 {
    let mut session = match Session::open(&cfg) {
        Ok(s) => s,
        Err(e) => {
            let mut out = Out::new(io::stdout().lock());
            let _ = emit_error(&mut out, &e);
            return 1;
        }
    };
    let info = session.info().clone();
    eprintln!(
        "[pylon-vnc] 已连接 {} \"{}\"，远端 {}×{}，输出 {}×{}（1/{}）",
        cfg.host, info.name, info.remote_w, info.remote_h, info.out_w, info.out_h, info.scale
    );

    let shared = session.shared();
    spawn_watchdog(std::sync::Arc::clone(&shared));
    spawn_input(shared);

    let stdout = io::stdout();
    let mut sink = Out::new(stdout.lock());
    let result = session.run(&mut sink);

    match result {
        Ok(()) => 0,
        Err(e) => {
            let _ = emit_error(&mut sink, &e);
            1
        }
    }
}

fn spawn_input(shared: std::sync::Arc<client::Shared>) {
    std::thread::spawn(move || {
        let stdin = io::stdin();
        let mut handle = stdin.lock();
        let mut buf = Vec::new();
        loop {
            match pipe::read_command(&mut handle, &mut buf) {
                Ok(Some(Command::Pointer { mask, x, y })) => shared.pointer(mask, x, y),
                Ok(Some(Command::Key { down, keysym })) => shared.key(down, keysym),
                Ok(Some(Command::CutText(text))) => shared.cut_text(&text),
                Ok(Some(Command::Full)) => {
                    shared.stall_since.store(shared.now_ms(), std::sync::atomic::Ordering::Relaxed);
                    shared.request(false);
                }
                Ok(Some(Command::Close)) | Ok(None) => {
                    shared.close();
                    return;
                }
                Err(e) => {
                    shared.fail(&format!("读输入指令失败：{e}"));
                    return;
                }
            }
        }
    });
}

struct ConsoleSink {
    t0: Instant,
    first_frame_at: Option<Instant>,
    tiles: usize,
    pixels: u64,
}

impl FrameSink for ConsoleSink {
    fn init(&mut self, info: &Info) -> io::Result<()> {
        println!(
            "[vnc] 握手成功：远端 {}×{}，输出 {}×{}（1/{}） \"{}\"",
            info.remote_w, info.remote_h, info.out_w, info.out_h, info.scale, info.name
        );
        Ok(())
    }

    fn frames(&mut self, tiles: &[DirtyTile], px: &[u32]) -> io::Result<()> {
        if self.first_frame_at.is_none() {
            self.first_frame_at = Some(Instant::now());
            println!(
                "[vnc] 首帧到达（自启动 {}ms）：{} 个块",
                self.t0.elapsed().as_millis(),
                tiles.len()
            );
        }
        self.tiles += tiles.len();
        self.pixels += px.len() as u64;
        Ok(())
    }

    fn stats(&mut self, fps: u16, kbps: u32, decode_ms: u32, total_ms: u32) -> io::Result<()> {
        println!(
            "[vnc] {fps} fps · {kbps} kbps · 解码最长 {decode_ms}ms · 单帧处理最长 {total_ms}ms · 块/秒 {} · 像素/秒 {:.2}MP",
            self.tiles, self.pixels as f64 / 1e6
        );
        self.tiles = 0;
        self.pixels = 0;
        Ok(())
    }

    fn clipboard(&mut self, text: &str) -> io::Result<()> {
        println!("[vnc] 剪贴板：{} 字", text.chars().count());
        Ok(())
    }

    fn closed(&mut self) -> io::Result<()> {
        println!("[vnc] 连接已关闭");
        Ok(())
    }
}

fn live(cfg: Config, opts: LiveOpts) -> i32 {
    let mut session = match Session::open(&cfg) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("[vnc] 失败：{e}");
            return 1;
        }
    };
    let info = session.info().clone();

    let shared = session.shared();
    spawn_watchdog(std::sync::Arc::clone(&shared));

    if opts.move_mouse {
        let w = info.remote_w as f64;
        let h = info.remote_h as f64;
        let s = std::sync::Arc::clone(&shared);
        std::thread::spawn(move || {
            let mut tick = 0u32;
            loop {
                if s.closed.load(std::sync::atomic::Ordering::Relaxed) {
                    return;
                }
                tick += 1;
                let a = (tick as f64 / 20.0) * std::f64::consts::TAU;
                let x = (w / 2.0 + a.cos() * (w / 3.0)) as u16;
                let y = (h / 2.0 + a.sin() * (h / 3.0)) as u16;
                s.pointer(if tick % 40 == 0 { 1 } else { 0 }, x, y);
                std::thread::sleep(Duration::from_millis(16));
            }
        });
        println!("[vnc] 已开启持续鼠标移动（约 60 次/秒）");
    }

    if opts.seconds > 0 {
        let s = std::sync::Arc::clone(&shared);
        let secs = opts.seconds;
        std::thread::spawn(move || {
            std::thread::sleep(Duration::from_secs(secs));
            s.close();
        });
    }

    let mut sink = ConsoleSink {
        t0: Instant::now(),
        first_frame_at: None,
        tiles: 0,
        pixels: 0,
    };
    let dump = opts.dump.clone();
    let result = session.run(&mut sink);
    if let Some(path) = dump {
        match session.dump_bmp(&path) {
            Ok(()) => println!("[vnc] 画面已存到 {path}"),
            Err(e) => println!("[vnc] 存图失败：{e}"),
        }
    }
    match result {
        Ok(()) => {
            println!("[vnc] 完成：{} 帧", session.frames());
            0
        }
        Err(e) => {
            eprintln!("[vnc] 中断：{e}");
            1
        }
    }
}

/// 出错时也要让管道另一头知道原因，否则 Node 侧只能看到「进程退了」
pub fn emit_error<W: Write>(out: &mut Out<W>, msg: &str) -> io::Result<()> {
    out.error(msg)?;
    out.closed()
}
