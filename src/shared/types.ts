/**
 * 主进程 / preload / 渲染进程共用的类型契约。
 * 任何跨进程传输的结构都在这里定义，避免三端各写一份而漂移。
 */

/** 认证方式。keyboard-interactive 单独列出，很多国内云主机与老设备只认它。 */
export type AuthType = 'password' | 'privateKey' | 'agent'

/**
 * 连接类型。
 * ssh  —— 终端会话（本应用的主线）
 * vnc  —— 远程桌面（RFB 协议，用来控 Mac / Windows / NAS 的图形界面）
 */
export type ConnectionKind = 'ssh' | 'vnc'

/** 一条连接配置。注意：这里【不包含】密码和私钥口令，它们单独加密存储。 */
export interface ConnectionConfig {
  id: string
  /** 缺省视为 ssh：老版本写下的 connections.json 里没有这个字段 */
  kind?: ConnectionKind
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  /** privateKey 认证时的私钥文件绝对路径 */
  privateKeyPath?: string
  /** 分组名，用于侧边栏归类 */
  group?: string
  /** 标签颜色标识 */
  color?: string
  /**
   * 放开老算法白名单。老摄像头、老 NAS 往往只支持 sha1 系列 KEX/MAC，
   * 不开这个开关会直接握手失败。默认 false。
   */
  legacyAlgorithms: boolean
  /** 建连超时（毫秒） */
  timeout: number
  /** 是否已保存凭据（密码或私钥口令），仅用来决定 UI 是否要弹输入框 */
  hasSecret: boolean
  createdAt: number
  updatedAt: number
}

/** 新建 / 编辑连接时提交的表单数据 */
export interface ConnectionInput {
  id?: string
  kind?: ConnectionKind
  name: string
  host: string
  port: number
  username: string
  authType: AuthType
  privateKeyPath?: string
  group?: string
  color?: string
  legacyAlgorithms: boolean
  timeout?: number
  /** 明文密码或私钥口令。传 undefined 表示"沿用已保存的"，传空串表示"清空" */
  secret?: string
  /** 是否把 secret 持久化（默认 true） */
  rememberSecret?: boolean
}

/** 会话生命周期状态 */
export type SessionStatus = 'connecting' | 'connected' | 'closed' | 'error'

export interface SessionInfo {
  sessionId: string
  connectionId: string
  title: string
  host: string
  username: string
  status: SessionStatus
  /** status 为 error 时的可读原因 */
  error?: string
  /** 远端 PTY 的初始列数，用于渲染端首次布局 */
  cols: number
  rows: number
}

/** 打开会话的入参 */
export interface OpenSessionRequest {
  connectionId: string
  /** 用户临时输入的密码/口令；不传则用已保存的 */
  secret?: string
  cols: number
  rows: number
}

/**
 * 本机 shell 的伪连接 ID。
 * 它不是一条真实的 SSH 配置，只是让「本机终端」能复用标签、状态栏那一套 UI。
 */
export const LOCAL_CONNECTION_ID = '__local__'

/** 打开本机 shell 的入参：只需要初始尺寸，没有主机和凭据 */
export interface OpenLocalSessionRequest {
  cols: number
  rows: number
}

/** 连通性 / 认证诊断结果 */
export interface DiagnoseResult {
  ok: boolean
  /** 分阶段结论：tcp / handshake / auth / shell */
  stage: 'tcp' | 'handshake' | 'auth' | 'shell' | 'done'
  message: string
  /** 协商成功的算法，排查老设备时非常有用 */
  negotiated?: {
    kex?: string
    cipher?: string
    mac?: string
    serverHostKey?: string
  }
  latencyMs?: number
}

/**
 * 一条快捷命令（命令片段）。
 *
 * autoRun 决定点击后是否自动回车：
 * 只读诊断类命令直接执行，改状态的命令（重启服务、reboot）只填入不执行 ——
 * 误点一次不至于把线上服务停了。
 */
export interface QuickCommand {
  id: string
  label: string
  command: string
  group: string
  autoRun: boolean
  /** 内置命令：只能使用，不能编辑或删除 */
  builtin?: boolean
  /** 会改变系统状态的操作，UI 上做警示 */
  danger?: boolean
  description?: string
}

/** 新建 / 编辑自定义快捷命令 */
export interface QuickCommandInput {
  id?: string
  label: string
  command: string
  group?: string
  autoRun: boolean
  description?: string
}

/** ZMODEM（rz / sz）文件传输的实时状态 */
export interface ZmodemState {
  sessionId: string
  /** download = 远端 sz 发给我们；upload = 远端 rz 让我们发 */
  direction: 'download' | 'upload'
  name: string
  transferred: number
  total: number
  status: 'active' | 'done' | 'error'
  /** 落盘路径（下载成功时有值） */
  path?: string
  /** status 为 error 时的原因 */
  message?: string
}

/** 主进程 → 渲染进程的推送事件 */
export type MainEvent =
  | { type: 'session:data'; sessionId: string; data: Uint8Array }
  | { type: 'session:status'; sessionId: string; status: SessionStatus; error?: string }
  | { type: 'session:exit'; sessionId: string; code: number | null }
  | { type: 'session:title'; sessionId: string; title: string }
  | { type: 'zmodem:update'; state: ZmodemState }
  | { type: 'vnc:init'; sessionId: string; width: number; height: number; name: string }
  | { type: 'vnc:rects'; sessionId: string; rects: VncRect[] }
  | { type: 'vnc:status'; sessionId: string; status: SessionStatus; error?: string }
  | { type: 'vnc:clipboard'; sessionId: string; text: string }
  | { type: 'vnc:stats'; sessionId: string; stats: VncStats }

/**
 * 远程桌面（VNC / RFB）相关类型。
 *
 * 帧数据只在主进程解码，渲染进程拿到的已经是 RGBA —— 两边不必再各自实现
 * ZRLE / Raw 这类编码，界面层只负责把矩形贴到 canvas 上。
 */

/** 一块被更新的屏幕区域，data 是 w*h*4 的 RGBA */
export interface VncRect {
  x: number
  y: number
  w: number
  h: number
  data: Uint8Array
}

export interface VncSessionInfo {
  sessionId: string
  connectionId: string
  title: string
  host: string
  port: number
  width: number
  height: number
  /** 对端在 ServerInit 里报的桌面名，多数是 "MacBookPro" 或 "hostname (user)" */
  desktopName: string
}

/** 每秒统计一次，用来判断卡在哪：帧率低是编码压力，码率高是画面变化大 */
export interface VncStats {
  fps: number
  kbps: number
}

/** 对端提供的认证方式，探测结果里会显示，方便判断 Mac 那边开没开 VNC 密码 */
export type VncSecurity = 'none' | 'vnc-password' | 'ard' | 'unknown'

export interface VncProbeResult {
  ok: boolean
  message: string
  /** 桌面名 */
  name?: string
  width?: number
  height?: number
  security?: VncSecurity
  /** TCP 建连 + 握手耗时 */
  latencyMs?: number
}

export interface VncOpenRequest {
  connectionId: string
  /** 临时输入的密码；不传则用已保存的 */
  password?: string
}

export interface VncProbeInput {
  host: string
  port: number
  password?: string
}

/** 渲染进程暴露给页面的 API 形状，preload 必须与之严格一致 */
export interface BridgeApi {
  connections: {
    list: () => Promise<ConnectionConfig[]>
    save: (input: ConnectionInput) => Promise<ConnectionConfig>
    remove: (id: string) => Promise<void>
    diagnose: (input: ConnectionInput) => Promise<DiagnoseResult>
    pickPrivateKey: () => Promise<string | null>
  }
  session: {
    open: (req: OpenSessionRequest) => Promise<SessionInfo>
    /** 打开本机 shell（不走 SSH，不需要任何连接配置） */
    openLocal: (req: OpenLocalSessionRequest) => Promise<SessionInfo>
    write: (sessionId: string, data: string) => void
    resize: (sessionId: string, cols: number, rows: number) => void
    close: (sessionId: string) => Promise<void>
    /** 渲染端消费完一批数据后的确认，用于主进程背压控制 */
    ack: (sessionId: string, bytes: number) => void
    /** 中止正在进行的 rz / sz 传输 */
    cancelZmodem: (sessionId: string) => void
  }
  quickCommands: {
    /** 返回内置命令 + 自定义命令的合并结果 */
    list: () => Promise<QuickCommand[]>
    save: (input: QuickCommandInput) => Promise<QuickCommand>
    remove: (id: string) => Promise<void>
  }
  /** 远程桌面（VNC）。高频的键鼠事件走 send，不等 Promise */
  vnc: {
    open: (req: VncOpenRequest) => Promise<VncSessionInfo>
    close: (sessionId: string) => Promise<void>
    /** 鼠标位置与按键掩码（bit0 左键、bit1 中键、bit2 右键） */
    pointer: (sessionId: string, x: number, y: number, mask: number) => void
    /** X11 keysym 的按下 / 抬起 */
    key: (sessionId: string, keysym: number, down: boolean) => void
    /** 把本地剪贴板推给远端 */
    clipboard: (sessionId: string, text: string) => void
    /** 直接读系统剪贴板并推给远端（渲染进程读剪贴板要权限，主进程更省事） */
    paste: (sessionId: string) => void
    /** 标签切换时暂停拉帧，切回来再继续，省 CPU 和带宽 */
    setActive: (sessionId: string, active: boolean) => void
    /** 重新要一整帧：面板刚挂载、或怀疑画面不同步时用 */
    refresh: (sessionId: string) => void
    probe: (input: VncProbeInput) => Promise<VncProbeResult>
  }
  onEvent: (handler: (event: MainEvent) => void) => () => void
}
