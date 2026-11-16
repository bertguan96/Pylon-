//  Pylon Stream — Mac 发送端（单文件，macOS 13+）
//
//  ScreenCaptureKit 采集 → VideoToolbox 硬件 H.264 编码 → UDP 发送
//  同时监听 UDP 输入包，用 CGEvent 注入鼠标/键盘。协议见 PROTOCOL.md。
//
//  编译：  swiftc -O -o pylon-stream-sender StreamSender.swift
//  运行：  ./pylon-stream-sender <Windows IP> [端口=48000] [帧率=60] [码率Mbps=40]
//
//  权限：系统设置 → 隐私与安全性 → 屏幕录制 / 辅助功能，勾选终端或本程序，重启程序。

import Foundation
import Darwin
import CoreMedia
import CoreVideo
import VideoToolbox
import ScreenCaptureKit
import CoreGraphics

// MARK: - 协议常量

let MAGIC: UInt32 = 0x5053_5452   // "PSTR"
let VERSION: UInt8 = 1
let TYPE_HELLO: UInt8 = 1
let TYPE_CAPS: UInt8 = 2
let TYPE_VIDEO: UInt8 = 3
let TYPE_INPUT: UInt8 = 4
let TYPE_KEYREQ: UInt8 = 5
let TYPE_PING: UInt8 = 6
let TYPE_GOODBYE: UInt8 = 7
let FLAG_KEYFRAME: UInt16 = 0x0001
let FLAG_LAST: UInt16 = 0x0002
let MAX_PAYLOAD = 1200

// MARK: - 工具

func plog(_ s: String) {
    let f = DateFormatter(); f.dateFormat = "HH:mm:ss.SSS"
    print("[\(f.string(from: Date()))] \(s)"); fflush(stdout)
}

func be16(_ v: UInt16) -> Data {
    var x = v.bigEndian
    return Data(bytes: &x, count: 2)
}
func be32(_ v: UInt32) -> Data {
    var x = v.bigEndian
    return Data(bytes: &x, count: 4)
}
func be64(_ v: UInt64) -> Data {
    var x = v.bigEndian
    return Data(bytes: &x, count: 8)
}
func rd16(_ d: Data, _ o: Int) -> UInt16 {
    var v: UInt16 = 0
    d.withUnsafeBytes { v = $0.load(fromByteOffset: o, as: UInt16.self) }
    return UInt16(bigEndian: v)
}
func rd32(_ d: Data, _ o: Int) -> UInt32 {
    var v: UInt32 = 0
    d.withUnsafeBytes { v = $0.load(fromByteOffset: o, as: UInt32.self) }
    return UInt32(bigEndian: v)
}
func rd64(_ d: Data, _ o: Int) -> UInt64 {
    var v: UInt64 = 0
    d.withUnsafeBytes { v = $0.load(fromByteOffset: o, as: UInt64.self) }
    return UInt64(bigEndian: v)
}

func header(type: UInt8, flags: UInt16, seq: UInt32) -> Data {
    var d = Data()
    d.append(be32(MAGIC)); d.append(VERSION); d.append(type)
    d.append(be16(flags)); d.append(be32(seq))
    return d
}

// MARK: - UDP

final class Udp {
    let fd: Int32
    let dest: sockaddr_in
    let queue = DispatchQueue(label: "pylon.stream.send", qos: .userInteractive)
    let lock = NSLock()
    var seq: UInt32 = 1

    init?(host: String, port: UInt16) {
        fd = socket(AF_INET, SOCK_DGRAM, Int32(IPPROTO_UDP))
        if fd < 0 { plog("socket 失败: \(String(cString: strerror(errno)))"); return nil }
        var a = sockaddr_in()
        a.sin_family = sa_family_t(AF_INET)
        a.sin_port = in_port_t(port.bigEndian)
        a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
        if inet_pton(AF_INET, host, &a.sin_addr) != 1 {
            plog("目标 IP 无效: \(host)"); return nil
        }
        dest = a
        var buf: Int32 = 4 * 1024 * 1024
        _ = withUnsafePointer(to: &buf) {
            setsockopt(fd, SOL_SOCKET, SO_SNDBUF, $0, socklen_t(MemoryLayout<Int32>.size))
        }
    }

    deinit { _ = close(fd) }

    func nextSeq() -> UInt32 {
        lock.lock(); defer { lock.unlock() }
        let s = seq; seq &+= 1; return s
    }

    func send(type: UInt8, flags: UInt16 = 0, payload: Data = Data()) {
        var p = header(type: type, flags: flags, seq: nextSeq())
        p.append(payload)
        queue.sync { raw(p) }
    }

    func sendFrame(id: UInt32, ts: UInt64, isKey: Bool, annex: Data) {
        let base = nextSeq()
        let chunk = MAX_PAYLOAD - 28
        let total = UInt16((annex.count + chunk - 1) / chunk)
        let flags: UInt16 = isKey ? FLAG_KEYFRAME : 0
        queue.sync {
            var i: UInt16 = 0
            var off = 0
            while off < annex.count {
                let n = min(chunk, annex.count - off)
                var p = header(type: TYPE_VIDEO, flags: flags, seq: base &+ UInt32(i))
                p.append(be32(id)); p.append(be64(ts))
                p.append(be16(i)); p.append(be16(total))
                if i == total - 1 {
                    var f = (flags | FLAG_LAST).bigEndian
                    p.replaceSubrange(6..<8, with: Data(bytes: &f, count: 2))
                }
                p.append(annex.subdata(in: off..<(off + n)))
                raw(p)
                off += n; i += 1
            }
        }
    }

    fileprivate func raw(_ p: Data) {
        p.withUnsafeBytes { bytes in
            guard let base = bytes.baseAddress else { return }
            var dst = dest
            let n = withUnsafePointer(to: &dst) { dp in
                dp.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
                    sendto(fd, base, p.count, 0, sp, socklen_t(MemoryLayout<sockaddr_in>.size))
                }
            }
            if n < 0 { plog("sendto: \(String(cString: strerror(errno)))") }
        }
    }
}

// MARK: - H.264 格式转换

func parameterSets(_ s: CMSampleBuffer) -> (Data, Data)? {
    guard let desc = CMSampleBufferGetFormatDescription(s) else { return nil }
    var sps: Data?
    var pps: Data?
    for i in 0..<2 {
        var ptr: UnsafePointer<UInt8>? = nil
        var size: Int = 0
        var count: Int = 0
        let st = CMVideoFormatDescriptionGetH264ParameterSetAtIndex(
            desc, parameterSetIndex: i,
            parameterSetPointerOut: &ptr, parameterSetSizeOut: &size,
            parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
        if st != noErr || ptr == nil { continue }
        let d = Data(bytes: ptr!, count: size)
        if i == 0 { sps = d } else { pps = d }
    }
    if let a = sps, let b = pps { return (a, b) }
    return nil
}

func toAnnexB(_ bytes: [UInt8], params: (Data, Data)?, wantKey: Bool) -> (Data, Bool) {
    var out = Data()
    func nal(_ d: Data) { out.append(contentsOf: [0, 0, 0, 1]); out.append(d) }
    func nal(_ a: [UInt8]) { out.append(contentsOf: [0, 0, 0, 1]); out.append(contentsOf: a) }

    if wantKey, let p = params { nal(p.0); nal(p.1) }

    var off = 0
    var key = false
    while off + 4 <= bytes.count {
        let len = (Int(bytes[off]) << 24) | (Int(bytes[off + 1]) << 16) |
                  (Int(bytes[off + 2]) << 8) | Int(bytes[off + 3])
        off += 4
        if len <= 0 || off + len > bytes.count { break }
        let n = Array(bytes[off..<(off + len)])
        off += len
        if let f = n.first, (f & 0x1f) == 5 { key = true }
        nal(n)
    }
    return (out, key)
}

// MARK: - 编码发送器

final class Sender {
    let udp: Udp
    let fps: Int
    let bitrate: Int
    var w: Int = 0
    var h: Int = 0
    var compression: VTCompressionSession?
    var frameId: UInt32 = 0
    let encodeLock = NSLock()
    var params: (Data, Data)?
    let paramsLock = NSLock()
    var forceKey = false

    init(udp: Udp, fps: Int, bitrateMbps: Int) {
        self.udp = udp; self.fps = fps; self.bitrate = bitrateMbps * 1_000_000
    }

    func setup(w: Int32, h: Int32) -> Bool {
        self.w = Int(w); self.h = Int(h)
        let cb: VTCompressionOutputCallback = { ref, status, _, sample in
            guard let ref = ref else { return }
            let s = Unmanaged<Sender>.fromOpaque(ref).takeUnretainedValue()
            s.output(status: status, sample: sample)
        }
        // 先试硬编码；失败退回软编码（仍然只需 swiftc，无外部依赖）
        let specs: [[CFString: Any]] = [
            [kVTVideoEncoderSpecification_EnableHardwareAcceleratedVideoEncoder: true],
            [:]
        ]
        for spec in specs {
            var session: VTCompressionSession?
            let st = VTCompressionSessionCreate(
                allocator: nil, width: w, height: h, codecType: kCMVideoCodecType_H264,
                encoderSpecification: spec.isEmpty ? nil : spec as CFDictionary,
                imageBufferAttributes: nil, compressedDataAllocator: nil,
                outputCallback: cb, refcon: Unmanaged.passUnretained(self).toOpaque(),
                compressionSessionOut: &session)
            if st == noErr, session != nil { compression = session; break }
        }
        guard let s = compression else { plog("编码器创建失败"); return false }

        VTCompressionSessionSetProperty(s, kVTCompressionPropertyKey_RealTime, kCFBooleanTrue)
        VTCompressionSessionSetProperty(s, kVTCompressionPropertyKey_AllowFrameReordering, kCFBooleanFalse)
        VTCompressionSessionSetProperty(s, kVTCompressionPropertyKey_ExpectedFrameRate, NSNumber(value: fps))
        VTCompressionSessionSetProperty(s, kVTCompressionPropertyKey_AverageBitRate, NSNumber(value: bitrate))
        VTCompressionSessionSetProperty(s, kVTCompressionPropertyKey_MaxKeyFrameInterval, NSNumber(value: fps * 2))
        VTCompressionSessionSetProperty(s, kVTCompressionPropertyKey_ProfileLevel, kVTProfileLevel_H264_High_AutoLevel)
        plog("编码器就绪 \(w)×\(h) @ \(fps)fps \(bitrate / 1_000_000)Mbps")
        return true
    }

    func encode(_ px: CVPixelBuffer) {
        guard let s = compression else { return }
        encodeLock.lock(); defer { encodeLock.unlock() }
        var props: [CFString: Any]? = nil
        if forceKey {
            props = [kVTEncodeFrameOptionKey_ForceKeyFrame: kCFBooleanTrue]
            forceKey = false
        }
        let st = VTCompressionSessionEncodeFrame(
            s, imageBuffer: px,
            presentationTimeStamp: CMClockGetTime(CMClockGetHostTimeClock()),
            duration: CMTime(value: 1, timescale: Int32(fps)),
            frameProperties: props as CFDictionary?, infoFlagsOut: nil)
        if st != noErr { plog("编码失败 \(st)") }
    }

    func requestKeyframe() { forceKey = true }

    fileprivate func output(status: OSStatus, sample: CMSampleBuffer?) {
        guard status == noErr, let s = sample,
              let block = CMSampleBufferGetDataBuffer(s) else { return }
        var total: Int = 0
        var ptr: UnsafeMutablePointer<Int8>? = nil
        let st = CMBlockBufferGetDataPointer(block, atOffset: 0, lengthAtOffsetOut: nil,
                                              totalLengthOut: &total, dataPointerOut: &ptr)
        guard st == noErr, let p = ptr, total > 0 else { return }
        let bytes = Array(UnsafeRawBufferPointer(start: UnsafeRawPointer(p), count: total))

        if let np = parameterSets(s) {
            paramsLock.lock(); params = np; paramsLock.unlock()
        }
        paramsLock.lock(); let p2 = params; paramsLock.unlock()

        var wantKey = false
        if bytes.count > 4 {
            let t = bytes[4] & 0x1f
            wantKey = (t == 5 || t == 7)
        }
        let (annex, isKey) = toAnnexB(bytes, params: p2, wantKey: wantKey)

        encodeLock.lock(); frameId &+= 1; let fid = frameId; encodeLock.unlock()
        let ts = UInt64(DispatchTime.now().uptimeNanoseconds / 1000)
        udp.sendFrame(id: fid, ts: ts, isKey: isKey, annex: annex)
    }
}

// MARK: - 输入注入

final class Injector {
    func handle(_ p: Data) {
        guard p.count >= 2 else { return }
        switch p[0] {
        case 1: // MOUSE_MOVE
            if p.count < 5 { return }
            let pt = CGPoint(x: CGFloat(rd16(p, 1)), y: CGFloat(rd16(p, 3)))
            CGEvent(mouseEventSource: nil, mouseType: .mouseMoved,
                    mouseCursorPosition: pt, mouseButton: .left)?.post(tap: .cghidEventTap)
        case 2: // MOUSE_BUTTON
            if p.count < 3 { return }
            let down = p[2] != 0
            let type: CGEventType, mb: CGMouseButton
            switch p[1] {
            case 0: type = down ? .leftMouseDown : .leftMouseUp; mb = .left
            case 1: type = down ? .rightMouseDown : .rightMouseUp; mb = .right
            case 2: type = down ? .otherMouseDown : .otherMouseUp; mb = .center
            default: return
            }
            let loc = CGEvent(source: nil)?.location ?? CGPoint.zero
            CGEvent(mouseEventSource: nil, mouseType: type,
                    mouseCursorPosition: loc, mouseButton: mb)?.post(tap: .cghidEventTap)
        case 3: // WHEEL
            if p.count < 3 { return }
            let d = Int32(Int16(bitPattern: rd16(p, 1)))
            CGEvent(scrollWheelEvent2Source: nil, units: .pixel,
                    wheelCount: 1, wheel1: d, wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
        case 4: // KEY: mac 虚拟键码 u16 + down u8
            if p.count < 4 { return }
            CGEvent(keyboardEventSource: nil, virtualKey: CGKeyCode(rd16(p, 1)),
                    keyDown: p[3] != 0)?.post(tap: .cghidEventTap)
        default: break
        }
    }
}

// MARK: - 采集回调

final class Capture: NSObject, SCStreamDelegate, SCStreamOutput {
    weak var sender: Sender?
    func stream(_ stream: SCStream, didStopWithError error: Error) {
        plog("采集停止: \(error.localizedDescription)"); exit(3)
    }
    func stream(_ stream: SCStream, didOutputSampleBuffer b: CMSampleBuffer, of t: SCStreamOutputType) {
        guard t == .screen, let px = CMSampleBufferGetImageBuffer(b) else { return }
        sender?.encode(px)
    }
}

// MARK: - 输入监听线程

var gUdp: Udp?
var gSender: Sender?

func startInput(port: UInt16, injector: Injector) {
    let fd = socket(AF_INET, SOCK_DGRAM, Int32(IPPROTO_UDP))
    if fd < 0 { plog("输入 socket 失败"); return }
    var a = sockaddr_in()
    a.sin_family = sa_family_t(AF_INET)
    a.sin_port = in_port_t(port.bigEndian)
    a.sin_addr.s_addr = INADDR_ANY
    a.sin_len = UInt8(MemoryLayout<sockaddr_in>.size)
    let r = withUnsafePointer(to: &a) { p in
        p.withMemoryRebound(to: sockaddr.self, capacity: 1) { sp in
            bind(fd, sp, socklen_t(MemoryLayout<sockaddr_in>.size))
        }
    }
    if r != 0 { plog("绑定输入端口失败 \(port): \(String(cString: strerror(errno)))"); return }

    let src = DispatchSource.makeReadSource(fileDescriptor: fd, queue: .global(qos: .userInteractive))
    src.setEventHandler {
        var buf = [UInt8](repeating: 0, count: 2048)
        let n = buf.withUnsafeMutableBytes { recvfrom(fd, $0.baseAddress, 2048, 0, nil, nil) }
        if n <= 12 { return }
        let d = Data(buf[0..<Int(n)])
        guard rd32(d, 0) == MAGIC else { return }
        switch d[5] {
        case TYPE_INPUT: injector.handle(d.subdata(in: 12..<d.count))
        case TYPE_PING:  gUdp?.send(type: TYPE_PING, payload: d.subdata(in: 12..<d.count))
        case TYPE_KEYREQ: gSender?.requestKeyframe()
        case TYPE_HELLO:
            gUdp?.send(type: TYPE_CAPS, payload: caps(w: gSender?.w ?? 0,
                                                       h: gSender?.h ?? 0, fps: gSender?.fps ?? 60))
        case TYPE_GOODBYE: exit(0)
        default: break
        }
    }
    src.resume()
}

func caps(w: Int, h: Int, fps: Int) -> Data {
    var d = Data()
    d.append(be16(UInt16(w))); d.append(be16(UInt16(h)))
    d.append(be16(UInt16(fps))); d.append(be16(1))
    d.append(be32(UInt32(truncatingIfNeeded: CGMainDisplayID())))
    d.append(be64(0))
    return d
}

// MARK: - main

func run() {
    let a = CommandLine.arguments
    guard a.count >= 2 else {
        plog("用法: \(a[0]) <Windows IP> [端口=48000] [帧率=60] [码率Mbps=40]")
        exit(2)
    }
    let host = a[1]
    let port = a.count > 2 ? (UInt16(a[2]) ?? 48000) : 48000
    let fps = a.count > 3 ? (Int(a[3]) ?? 60) : 60
    let mbps = a.count > 4 ? (Int(a[4]) ?? 40) : 40
    plog("目标 \(host):\(port) \(fps)fps \(mbps)Mbps")

    guard let udp = Udp(host: host, port: port) else { exit(1) }
    gUdp = udp
    let sender = Sender(udp: udp, fps: fps, bitrateMbps: mbps)
    gSender = sender
    startInput(port: port, injector: Injector())

    // ScreenCaptureKit 的 async API 用 semaphore 桥到同步
    let sem = DispatchSemaphore(value: 0)
    var content: SCShareableContent?
    var err: Error?
    Task.detached {
        do { content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true) }
        catch { err = error }
        sem.signal()
    }
    _ = sem.wait(timeout: .now() + 10)
    if let e = err { plog("屏幕列表失败（检查屏幕录制权限）: \(e.localizedDescription)"); exit(4) }
    guard let c = content, let display = c.displays.first else { plog("没找到显示器"); exit(4) }

    let w = Int(display.width), h = Int(display.height)
    plog("显示器 \(display.displayID) \(w)×\(h)")
    guard sender.setup(w: Int32(w), h: Int32(h)) else { exit(5) }
    udp.send(type: TYPE_CAPS, payload: caps(w: w, h: h, fps: fps))

    let conf = SCStreamConfiguration()
    conf.width = w; conf.height = h
    conf.pixelFormat = kCVPixelFormatType_32BGRA
    conf.minimumFrameInterval = CMTime(value: 1, timescale: Int32(fps))
    conf.showsCursor = true
    let cap = Capture(); cap.sender = sender
    let stream = SCStream(filter: SCContentFilter(display: display, excludingWindows: []),
                          configuration: conf, delegate: cap)
    do {
        try stream.addStreamOutput(cap, type: .screen, sampleQueue: .global(qos: .userInteractive))
        try stream.startCapture()
        plog("采集已启动")
    } catch { plog("启动采集失败（检查屏幕录制权限）: \(error.localizedDescription)"); exit(6) }

    Timer.scheduledTimer(withTimeInterval: 2, repeats: true) { _ in
        udp.send(type: TYPE_PING, payload: be64(UInt64(DispatchTime.now().uptimeNanoseconds / 1000)))
    }
    RunLoop.main.run()
}

run()
