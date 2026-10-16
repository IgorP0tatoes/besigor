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

export interface Container {
  id: string;
  name: string;
  image: string;
  state: string;
  health: string;
  cpu: number;
  mem: number;
  memLimit: number;
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
  disks: { mount: string; dev: string; fs: string; total: number; used: number }[] | null;
  diskRead: number;
  diskWrite: number;
  net: { iface: string; rx: number; tx: number }[] | null;
  rx: number;
  tx: number;
  uptime: number;
  containers?: Container[];
}

export interface Server {
  id: string;
  name: string;
  createdAt: number;
  lastSeen: number | null;
  online: boolean;
  ip: string | null;
  connectedAt: number | null;
  host: HostInfo | null;
  live: Sample | null;
  outdated: boolean;
  traffic: { used: number; limit: number | null } | null;
}

export type RangeKey = '1h' | '12h' | '24h' | '1w' | '30d' | '1y';

export interface Series {
  range: RangeKey;
  step: number;
  ts: number[];
  cpu: number[];
  cpuUser: number[];
  cpuSys: number[];
  cpuIowait: number[];
  cpuSteal: number[];
  load1: number[];
  load5: number[];
  load15: number[];
  memUsed: number[];
  memBuffCache: number[];
  memTotal: number;
  swapUsed: number[];
  swapTotal: number;
  diskRead: number[];
  diskWrite: number[];
  rx: number[];
  tx: number[];
  disks: { mount: string; total: number; used: (number | null)[] }[];
  net: { iface: string; rx: (number | null)[]; tx: (number | null)[] }[];
  containers: { name: string; cpu: (number | null)[]; mem: (number | null)[] }[];
}

export type LiveEvent =
  | { type: 'live'; serverId: string; sample: Sample }
  | { type: 'status'; serverId: string; online: boolean; at: number }
  | { type: 'hello'; serverId: string; host: HostInfo }
  | { type: 'servers' };
