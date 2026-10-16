// Mirrors agent/internal/metrics/types.go.

export interface HostInfo {
  version: string;
  hostname: string;
  os: string;
  kernel: string;
  arch: string;
  cpuModel: string;
  cores: number;
  memTotal: number;
  bootTime: number;
}

export interface Disk {
  mount: string;
  dev: string;
  fs: string;
  total: number;
  used: number;
}

export interface NetIface {
  iface: string;
  rx: number;
  tx: number;
}

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  health: string;
  cpu: number;
  mem: number;
  memLimit: number;
  /** bytes/s in live samples, bytes per bucket in stored records */
  rx: number;
  tx: number;
  restarts: number;
  started: number;
  exitCode: number;
}

export interface Sample {
  ts: number;
  cpu: number;
  cpuUser: number;
  cpuSys: number;
  cpuIowait: number;
  cpuSteal: number;
  load: [number, number, number];
  memUsed: number;
  memTotal: number;
  memBuffCache: number;
  swapUsed: number;
  swapTotal: number;
  disks: Disk[] | null;
  diskRead: number;
  diskWrite: number;
  net: NetIface[] | null;
  rx: number;
  tx: number;
  uptime: number;
  containers?: Container[];
}

export interface Envelope {
  t: string;
  d?: unknown;
}

export type Resolution = '1m' | '15m' | '1h';

export const RESOLUTION_SECONDS: Record<Resolution, number> = { '1m': 60, '15m': 900, '1h': 3600 };
