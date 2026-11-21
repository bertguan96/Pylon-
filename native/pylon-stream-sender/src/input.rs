//! 接收控制台发来的 INPUT 包，用 SendInput 注入到本机。
//! 坐标系：控制台传的是远端像素坐标（CAPS 里的宽高），这里直接映射到虚拟桌面。

use std::mem::size_of;

use windows::Win32::Foundation::*;
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::{GetSystemMetrics, SM_CXVIRTUALSCREEN, SM_CYVIRTUALSCREEN};

use crate::protocol::{INPUT_KEY, INPUT_MOUSE_BUTTON, INPUT_MOUSE_MOVE, INPUT_WHEEL};

/// 从 UDP 输入负载里解析并注入（payload 是通用头之后的字节）
pub fn inject(payload: &[u8], remote_w: u32, remote_h: u32) {
    if payload.is_empty() {
        return;
    }
    match payload[0] {
        INPUT_MOUSE_MOVE => {
            if payload.len() < 5 {
                return;
            }
            let x = u16::from_be_bytes([payload[1], payload[2]]) as i32;
            let y = u16::from_be_bytes([payload[3], payload[4]]) as i32;
            let (sx, sy) = scale_to_screen(x, y, remote_w, remote_h);
            unsafe {
                let input = mouse_input(MOUSEEVENTF_ABSOLUTE | MOUSEEVENTF_MOVE, sx, sy, 0, 0);
                SendInput(&[input], size_of::<INPUT>() as i32);
            }
        }
        INPUT_MOUSE_BUTTON => {
            if payload.len() < 3 {
                return;
            }
            let button = payload[1];
            let down = payload[2] != 0;
            let (flag_down, flag_up) = match button {
                0 => (MOUSEEVENTF_LEFTDOWN, MOUSEEVENTF_LEFTUP),
                1 => (MOUSEEVENTF_RIGHTDOWN, MOUSEEVENTF_RIGHTUP),
                2 => (MOUSEEVENTF_MIDDLEDOWN, MOUSEEVENTF_MIDDLEUP),
                _ => return,
            };
            let flag = if down { flag_down } else { flag_up };
            unsafe {
                let input = mouse_input(flag, 0, 0, 0, 0);
                SendInput(&[input], size_of::<INPUT>() as i32);
            }
        }
        INPUT_WHEEL => {
            if payload.len() < 3 {
                return;
            }
            let delta = i16::from_be_bytes([payload[1], payload[2]]) as i32;
            unsafe {
                let input = mouse_input(MOUSEEVENTF_WHEEL, 0, 0, delta * 120, 0);
                SendInput(&[input], size_of::<INPUT>() as i32);
            }
        }
        INPUT_KEY => {
            if payload.len() < 4 {
                return;
            }
            // 协议里传的是 mac 虚拟键码（控制端原本连 Mac 用的）。
            // 这里要转成 Windows 虚拟键码 —— 用一张映射表。
            let mac_vk = u16::from_be_bytes([payload[1], payload[2]]);
            let down = payload[3] != 0;
            if let Some(vk) = mac_keycode_to_windows(mac_vk) {
                unsafe {
                    let mut input = INPUT::default();
                    input.r#type = INPUT_KEYBOARD;
                    input.Anonymous.ki = KEYBDINPUT {
                        wVk: VIRTUAL_KEY(vk),
                        wScan: 0,
                        dwFlags: if down {
                            KEYBD_EVENT_FLAGS(0)
                        } else {
                            KEYEVENTF_KEYUP
                        },
                        time: 0,
                        dwExtraInfo: 0,
                    };
                    SendInput(&[input], size_of::<INPUT>() as i32);
                }
            }
        }
        _ => {}
    }
}

/// Windows 绝对鼠标坐标：0..65535 映射到整个虚拟桌面
fn scale_to_screen(x: i32, y: i32, rw: u32, rh: u32) -> (i32, i32) {
    let sw = unsafe { GetSystemMetrics(SM_CXVIRTUALSCREEN).max(1) } as f64;
    let sh = unsafe { GetSystemMetrics(SM_CYVIRTUALSCREEN).max(1) } as f64;
    let sx = ((x as f64 / rw.max(1) as f64) * 65535.0).round() as i32;
    let sy = ((y as f64 / rh.max(1) as f64) * 65535.0).round() as i32;
    let _ = (sw, sh); // 绝对坐标用 0..65535，不需要屏幕像素尺寸
    (sx.clamp(0, 65535), sy.clamp(0, 65535))
}

fn mouse_input(flags: MOUSE_EVENT_FLAGS, x: i32, y: i32, data: i32, extra: usize) -> INPUT {
    let mut input = INPUT::default();
    input.r#type = INPUT_MOUSE;
    input.Anonymous.mi = MOUSEINPUT {
        dx: x,
        dy: y,
        mouseData: data as u32,
        dwFlags: flags,
        time: 0,
        dwExtraInfo: extra,
    };
    input
}

/// mac 虚拟键码 → Windows VK。
/// 控制端原本发 mac 键码是为了连 Mac；现在被控端是 Windows，必须转换。
/// 这张表覆盖常用键；不在表里的键直接丢弃（比注入错键安全）。
fn mac_keycode_to_windows(mac: u16) -> Option<u16> {
    let vk = match mac {
        0 => 0x41,  // A
        11 => 0x42, // B
        8 => 0x43,  // C
        2 => 0x44,  // D
        14 => 0x45, // E
        3 => 0x46,  // F
        5 => 0x47,  // G
        4 => 0x48,  // H
        34 => 0x49, // I
        38 => 0x4A, // J
        40 => 0x4B, // K
        37 => 0x4C, // L
        46 => 0x4D, // M
        45 => 0x4E, // N
        31 => 0x4F, // O
        35 => 0x50, // P
        12 => 0x51, // Q
        15 => 0x52, // R
        1 => 0x53,  // S
        16 => 0x54, // T
        32 => 0x55, // U
        9 => 0x56,  // V
        13 => 0x57, // W
        7 => 0x58,  // X
        6 => 0x59,  // Y
        17 => 0x5A, // Z
        29 => 0x30, // 0
        18 => 0x31, // 1
        19 => 0x32, // 2
        20 => 0x33, // 3
        21 => 0x34, // 4
        23 => 0x35, // 5
        22 => 0x36, // 6
        26 => 0x37, // 7
        28 => 0x38, // 8
        25 => 0x39, // 9
        49 => 0x20, // Space
        36 => 0x0D, // Return
        53 => 0x1B, // Escape
        48 => 0x09, // Tab
        51 => 0x08, // Backspace
        56 => 0x10, // Shift
        59 => 0x11, // Ctrl
        58 => 0x12, // Alt
        55 => 0x5B, // Win
        126 => 0x26, // Up
        125 => 0x28, // Down
        123 => 0x25, // Left
        124 => 0x27, // Right
        _ => return None,
    };
    Some(vk)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keycode_mapping() {
        assert_eq!(mac_keycode_to_windows(0), Some(0x41)); // A
        assert_eq!(mac_keycode_to_windows(49), Some(0x20)); // Space
        assert_eq!(mac_keycode_to_windows(36), Some(0x0D)); // Return
        assert_eq!(mac_keycode_to_windows(9999), None);
    }
}
