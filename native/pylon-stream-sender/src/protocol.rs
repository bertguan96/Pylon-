//! 私有串流协议（与 native/pylon-stream/PROTOCOL.md 完全一致）。
//! 所有整数网络序。12 字节通用头 + 16 字节视频帧头。

pub const MAGIC: u32 = 0x5053_5452; // "PSTR"
pub const VERSION: u8 = 1;

pub const TYPE_HELLO: u8 = 1;
pub const TYPE_CAPS: u8 = 2;
pub const TYPE_VIDEO: u8 = 3;
pub const TYPE_INPUT: u8 = 4;
pub const TYPE_KEYREQ: u8 = 5;
pub const TYPE_PING: u8 = 6;
pub const TYPE_GOODBYE: u8 = 7;

pub const FLAG_KEYFRAME: u16 = 0x0001;
pub const FLAG_LAST: u16 = 0x0002;

pub const HEADER: usize = 12;
pub const FRAME_HEADER: usize = 16;
pub const MAX_PAYLOAD: usize = 1200;

#[inline]
pub fn header(kind: u8, flags: u16, seq: u32) -> [u8; HEADER] {
    let mut b = [0u8; HEADER];
    b[0..4].copy_from_slice(&MAGIC.to_be_bytes());
    b[4] = VERSION;
    b[5] = kind;
    b[6..8].copy_from_slice(&flags.to_be_bytes());
    b[8..12].copy_from_slice(&seq.to_be_bytes());
    b
}

/// 一次性封装完整视频帧的头（调用方自己拼 header + 这个 + 分片负载）
#[inline]
pub fn frame_header(id: u32, ts_us: u64, idx: u16, total: u16) -> [u8; FRAME_HEADER] {
    let mut b = [0u8; FRAME_HEADER];
    b[0..4].copy_from_slice(&id.to_be_bytes());
    b[4..12].copy_from_slice(&ts_us.to_be_bytes());
    b[12..14].copy_from_slice(&idx.to_be_bytes());
    b[14..16].copy_from_slice(&total.to_be_bytes());
    b
}

/// CAPS 负载（20 字节）：宽、高、帧率、编码、屏幕 ID、保留
pub fn caps(width: u16, height: u16, fps: u16, screen_id: u32) -> [u8; 20] {
    let mut b = [0u8; 20];
    b[0..2].copy_from_slice(&width.to_be_bytes());
    b[2..4].copy_from_slice(&height.to_be_bytes());
    b[4..6].copy_from_slice(&fps.to_be_bytes());
    b[6..8].copy_from_slice(&1u16.to_be_bytes()); // H.264
    b[8..12].copy_from_slice(&screen_id.to_be_bytes());
    b
}

/// 输入子类型
pub const INPUT_MOUSE_MOVE: u8 = 1;
pub const INPUT_MOUSE_BUTTON: u8 = 2;
pub const INPUT_WHEEL: u8 = 3;
pub const INPUT_KEY: u8 = 4;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn header_fields() {
        let h = header(TYPE_VIDEO, FLAG_KEYFRAME, 42);
        assert_eq!(&h[0..4], b"PSTR");
        assert_eq!(h[4], VERSION);
        assert_eq!(h[5], TYPE_VIDEO);
        assert_eq!(u16::from_be_bytes([h[6], h[7]]), FLAG_KEYFRAME);
        assert_eq!(u32::from_be_bytes([h[8], h[9], h[10], h[11]]), 42);
    }

    #[test]
    fn frame_header_fields() {
        let h = frame_header(7, 0x0102_0304_0506_0708, 2, 9);
        assert_eq!(u32::from_be_bytes([h[0], h[1], h[2], h[3]]), 7);
        assert_eq!(u64::from_be_bytes(h[4..12].try_into().unwrap()), 0x0102_0304_0506_0708);
        assert_eq!(u16::from_be_bytes([h[12], h[13]]), 2);
        assert_eq!(u16::from_be_bytes([h[14], h[15]]), 9);
    }

    #[test]
    fn caps_fields() {
        let c = caps(1920, 1080, 60, 0xdead_beef);
        assert_eq!(u16::from_be_bytes([c[0], c[1]]), 1920);
        assert_eq!(u16::from_be_bytes([c[2], c[3]]), 1080);
        assert_eq!(u16::from_be_bytes([c[4], c[5]]), 60);
        assert_eq!(u16::from_be_bytes([c[6], c[7]]), 1);
        assert_eq!(u32::from_be_bytes([c[8], c[9], c[10], c[11]]), 0xdead_beef);
    }
}
