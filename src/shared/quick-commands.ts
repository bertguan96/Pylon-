import type { QuickCommand } from './types'

/**
 * 内置快捷命令库。
 *
 * 两条约定，写新命令时请遵守：
 *
 * 1. **只读诊断类** 一律 `autoRun: true`，点一下就执行，省掉一次回车。
 * 2. **会改变系统状态** 的（重启服务、清日志、reboot）必须 `autoRun: false` 且标
 *    `danger: true` —— 只把命令填进命令行，等用户自己补参数、自己回车。
 *    这个开关是防止误点把线上服务停掉的第一道闸。
 *
 * id 统一用 `builtin:` 前缀，主进程据此拒绝编辑/删除请求。
 */
export const BUILTIN_QUICK_COMMANDS: QuickCommand[] = [
  // ---------- 系统信息 ----------
  {
    id: 'builtin:sys:uptime',
    label: '运行时长与负载',
    command: 'uptime',
    group: '系统信息',
    autoRun: true,
    builtin: true,
    description: '1/5/15 分钟平均负载，卡顿时第一眼就看它'
  },
  {
    id: 'builtin:sys:mem',
    label: '内存占用',
    command: 'free -h',
    group: '系统信息',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:sys:disk',
    label: '磁盘使用',
    command: 'df -h -x tmpfs -x devtmpfs',
    group: '系统信息',
    autoRun: true,
    builtin: true,
    description: '已过滤内存盘，只看真实分区'
  },
  {
    id: 'builtin:sys:os',
    label: '系统版本',
    command: 'cat /etc/os-release | head -4',
    group: '系统信息',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:sys:cpu',
    label: 'CPU 与核心数',
    command: "lscpu | grep -E 'Model name|^CPU\\(s\\)|MHz' || nproc",
    group: '系统信息',
    autoRun: true,
    builtin: true
  },

  // ---------- 进程与服务 ----------
  {
    id: 'builtin:proc:cpu',
    label: 'CPU 占用前十',
    command: 'ps aux --sort=-%cpu | head -12',
    group: '进程与服务',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:proc:mem',
    label: '内存占用前十',
    command: 'ps aux --sort=-%rss | head -12',
    group: '进程与服务',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:proc:ports',
    label: '端口占用情况',
    command: 'ss -tunlp',
    group: '进程与服务',
    autoRun: true,
    builtin: true,
    description: '哪条连接被谁占着，排查端口冲突用'
  },
  {
    id: 'builtin:proc:failed',
    label: '启动失败的服务',
    command: 'systemctl --failed --no-pager',
    group: '进程与服务',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:proc:status',
    label: '查看服务状态',
    command: 'systemctl status ',
    group: '进程与服务',
    autoRun: false,
    builtin: true,
    description: '填入后补上服务名再回车'
  },
  {
    id: 'builtin:proc:restart',
    label: '重启服务',
    command: 'sudo systemctl restart ',
    group: '进程与服务',
    autoRun: false,
    builtin: true,
    danger: true,
    description: '填入后补上服务名，确认无误再回车'
  },

  // ---------- 网络 ----------
  {
    id: 'builtin:net:ip',
    label: '本机 IP 地址',
    command: "ip -4 addr show scope global | grep -E 'inet|^[0-9]'",
    group: '网络',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:net:listen',
    label: '监听中的端口',
    command: 'ss -lntp',
    group: '网络',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:net:route',
    label: '路由表',
    command: 'ip route',
    group: '网络',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:net:publicip',
    label: '出口公网 IP',
    command: 'curl -s --max-time 5 https://ifconfig.me; echo',
    group: '网络',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:net:ping',
    label: '测试连通性',
    command: 'ping -c 4 ',
    group: '网络',
    autoRun: false,
    builtin: true,
    description: '填入后补上目标地址或域名'
  },
  {
    id: 'builtin:net:curl',
    label: '探测 HTTP 状态',
    command: 'curl -sS -o /dev/null -w "%{http_code} %{time_total}s\\n" ',
    group: '网络',
    autoRun: false,
    builtin: true,
    description: '填入后补上 URL'
  },

  // ---------- 日志 ----------
  {
    id: 'builtin:log:journal',
    label: '系统日志最近 50 行',
    command: 'journalctl -n 50 --no-pager',
    group: '日志',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:log:ssh',
    label: 'SSH 登录日志',
    command: 'sudo journalctl -u ssh -n 50 --no-pager',
    group: '日志',
    autoRun: true,
    builtin: true,
    description: '排查登录失败、爆破尝试'
  },
  {
    id: 'builtin:log:last',
    label: '最近登录记录',
    command: 'last -n 15',
    group: '日志',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:log:dmesg',
    label: '内核报错',
    command: 'dmesg -T | tail -30',
    group: '日志',
    autoRun: true,
    builtin: true,
    description: 'OOM、磁盘 I/O 错误都会出现在这里'
  },

  // ---------- 磁盘与文件 ----------
  {
    id: 'builtin:file:dusize',
    label: '当前目录各子项大小',
    command: 'du -h --max-depth=1 . 2>/dev/null | sort -rh | head -15',
    group: '磁盘与文件',
    autoRun: true,
    builtin: true,
    description: '找出是谁把盘占满了'
  },
  {
    id: 'builtin:file:bigfiles',
    label: '查找大于 100M 的文件',
    command: 'find . -type f -size +100M 2>/dev/null | head -20',
    group: '磁盘与文件',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:file:recent',
    label: '最近修改的文件',
    command: 'ls -lt | head -15',
    group: '磁盘与文件',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:file:lsblk',
    label: '磁盘与分区',
    command: 'lsblk -o NAME,SIZE,FSTYPE,MOUNTPOINT',
    group: '磁盘与文件',
    autoRun: true,
    builtin: true
  },

  // ---------- Docker ----------
  {
    id: 'builtin:docker:ps',
    label: '容器列表',
    command: "docker ps -a --format 'table {{.Names}}\\t{{.Status}}\\t{{.Image}}'",
    group: 'Docker',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:docker:df',
    label: 'Docker 空间占用',
    command: 'docker system df',
    group: 'Docker',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:docker:images',
    label: '镜像列表',
    command: 'docker images',
    group: 'Docker',
    autoRun: true,
    builtin: true
  },
  {
    id: 'builtin:docker:logs',
    label: '跟踪容器日志',
    command: 'docker logs -f --tail 100 ',
    group: 'Docker',
    autoRun: false,
    builtin: true,
    description: '填入容器名再回车；Ctrl+C 退出'
  },

  // ---------- 维护（慎用） ----------
  {
    id: 'builtin:maint:vacuum',
    label: '清理 7 天前系统日志',
    command: 'sudo journalctl --vacuum-time=7d',
    group: '维护（慎用）',
    autoRun: false,
    builtin: true,
    danger: true
  },
  {
    id: 'builtin:maint:aptclean',
    label: '清理 apt 包缓存',
    command: 'sudo apt-get clean && sudo apt-get autoremove -y',
    group: '维护（慎用）',
    autoRun: false,
    builtin: true,
    danger: true
  },
  {
    id: 'builtin:maint:reboot',
    label: '重启服务器',
    command: 'sudo reboot',
    group: '维护（慎用）',
    autoRun: false,
    builtin: true,
    danger: true,
    description: '只填入不执行，确认无误再自己回车'
  }
]
