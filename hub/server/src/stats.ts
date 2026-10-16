import type { DB } from './db.js';
import { RESOLUTION_SECONDS, type Container, type Resolution, type Sample } from './types.js';

const AVG_FIELDS = ['cpu', 'cpuUser', 'cpuSys', 'cpuIowait', 'cpuSteal', 'memUsed', 'memBuffCache', 'swapUsed', 'diskRead', 'diskWrite'] as const;

/**
 * Folds consecutive records into one bucket: rates and gauges are averaged,
 * byte counters (rx/tx, per-interface) are summed, disks and totals are taken
 * from the latest record.
 */
export function mergeSamples(records: Sample[], ts: number): Sample {
  const n = records.length;
  const last = records[n - 1]!;
  const out: Sample = { ...last, ts, load: [0, 0, 0], rx: 0, tx: 0, net: [] };
  for (const f of AVG_FIELDS) out[f] = 0;
  const net = new Map<string, { rx: number; tx: number }>();
  for (const r of records) {
    for (const f of AVG_FIELDS) out[f] += r[f] ?? 0;
    for (let i = 0; i < 3; i++) out.load[i]! += r.load?.[i] ?? 0;
    out.rx += r.rx ?? 0;
    out.tx += r.tx ?? 0;
    for (const ni of r.net ?? []) {
      const c = net.get(ni.iface) ?? { rx: 0, tx: 0 };
      c.rx += ni.rx;
      c.tx += ni.tx;
      net.set(ni.iface, c);
    }
  }
  for (const f of AVG_FIELDS) out[f] = round(out[f] / n, f.startsWith('cpu') ? 2 : 0);
  out.load = out.load.map((v) => round(v / n, 2)) as Sample['load'];
  out.net = [...net.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([iface, c]) => ({ iface, ...c }));
  out.containers = mergeContainers(records);
  return out;
}

function mergeContainers(records: Sample[]): Container[] | undefined {
  const acc = new Map<string, { n: number; cpu: number; mem: number; rx: number; tx: number; last: Container }>();
  for (const r of records) {
    for (const c of r.containers ?? []) {
      const a = acc.get(c.name) ?? { n: 0, cpu: 0, mem: 0, rx: 0, tx: 0, last: c };
      a.n++;
      a.cpu += c.cpu;
      a.mem += c.mem;
      a.rx += c.rx;
      a.tx += c.tx;
      a.last = c;
      acc.set(c.name, a);
    }
  }
  if (!acc.size) return undefined;
  return [...acc.values()]
    .map((a) => ({ ...a.last, cpu: round(a.cpu / a.n, 2), mem: Math.round(a.mem / a.n), rx: a.rx, tx: a.tx }))
    .sort((x, y) => x.name.localeCompare(y.name));
}

function round(v: number, digits: number) {
  const k = 10 ** digits;
  return Math.round(v * k) / k;
}

/** Stores minute records; returns the newest timestamp seen (for the ack). */
export function insertMinutes(db: DB, serverId: string, records: Sample[]): number {
  const stmt = db.prepare('INSERT OR IGNORE INTO stats_1m (server_id, ts, data) VALUES (?, ?, ?)');
  let upTo = 0;
  db.transaction(() => {
    for (const r of records) {
      if (!Number.isInteger(r.ts) || r.ts % 60 !== 0) continue;
      stmt.run(serverId, r.ts, JSON.stringify(r));
      upTo = Math.max(upTo, r.ts);
    }
  })();
  return upTo;
}

/**
 * Recomputes the coarse buckets over a recent window. Re-running is cheap and
 * idempotent, so late records (an agent replaying its buffer) are folded in.
 */
export function rollup(db: DB, now = Math.floor(Date.now() / 1000)) {
  rollupLevel(db, 'stats_1m', 'stats_15m', 900, now - 3 * 3600);
  rollupLevel(db, 'stats_15m', 'stats_1h', 3600, now - 4 * 3600);
}

function rollupLevel(db: DB, from: string, to: string, period: number, since: number) {
  const start = Math.floor(since / period) * period;
  const rows = db
    .prepare(`SELECT server_id, ts, data FROM ${from} WHERE ts >= ? ORDER BY server_id, ts`)
    .all(start) as { server_id: string; ts: number; data: string }[];
  const buckets = new Map<string, Sample[]>();
  for (const row of rows) {
    const key = `${row.server_id}|${Math.floor(row.ts / period) * period}`;
    const list = buckets.get(key) ?? [];
    list.push(JSON.parse(row.data) as Sample);
    buckets.set(key, list);
  }
  const upsert = db.prepare(`INSERT INTO ${to} (server_id, ts, data) VALUES (?, ?, ?) ON CONFLICT(server_id, ts) DO UPDATE SET data = excluded.data`);
  db.transaction(() => {
    for (const [key, list] of buckets) {
      const [serverId, ts] = key.split('|') as [string, string];
      upsert.run(serverId, Number(ts), JSON.stringify(mergeSamples(list, Number(ts))));
    }
  })();
}

const RETENTION: Record<Resolution, number> = { '1m': 7 * 86400, '15m': 90 * 86400, '1h': 365 * 86400 };

export function prune(db: DB, now = Math.floor(Date.now() / 1000)) {
  for (const res of Object.keys(RETENTION) as Resolution[]) {
    db.prepare(`DELETE FROM stats_${res} WHERE ts < ?`).run(now - RETENTION[res]);
  }
  db.prepare('DELETE FROM sessions WHERE expires_at < ?').run(now);
}

export const RANGES = {
  '1h': { seconds: 3600, res: '1m' },
  '12h': { seconds: 12 * 3600, res: '1m' },
  '24h': { seconds: 86400, res: '1m' },
  '1w': { seconds: 7 * 86400, res: '15m' },
  '30d': { seconds: 30 * 86400, res: '1h' },
  '1y': { seconds: 365 * 86400, res: '1h' },
} as const satisfies Record<string, { seconds: number; res: Resolution }>;

export type RangeKey = keyof typeof RANGES;

/** Column-oriented series, ready for uPlot. Byte counters become bytes/s. */
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

export function querySeries(db: DB, serverId: string, range: RangeKey, now = Math.floor(Date.now() / 1000)): Series {
  const { seconds, res } = RANGES[range];
  const step = RESOLUTION_SECONDS[res];
  const rows = db
    .prepare(`SELECT data FROM stats_${res} WHERE server_id = ? AND ts >= ? ORDER BY ts`)
    .all(serverId, now - seconds) as { data: string }[];
  const s: Series = {
    range, step, ts: [], cpu: [], cpuUser: [], cpuSys: [], cpuIowait: [], cpuSteal: [],
    load1: [], load5: [], load15: [], memUsed: [], memBuffCache: [], memTotal: 0, swapUsed: [], swapTotal: 0,
    diskRead: [], diskWrite: [], rx: [], tx: [], disks: [], net: [], containers: [],
  };
  const conts = new Map<string, Series['containers'][number]>();
  const disks = new Map<string, Series['disks'][number]>();
  const nets = new Map<string, Series['net'][number]>();
  rows.forEach((row, i) => {
    const r = JSON.parse(row.data) as Sample;
    s.ts.push(r.ts);
    s.cpu.push(r.cpu);
    s.cpuUser.push(r.cpuUser);
    s.cpuSys.push(r.cpuSys);
    s.cpuIowait.push(r.cpuIowait);
    s.cpuSteal.push(r.cpuSteal);
    s.load1.push(r.load?.[0] ?? 0);
    s.load5.push(r.load?.[1] ?? 0);
    s.load15.push(r.load?.[2] ?? 0);
    s.memUsed.push(r.memUsed);
    s.memBuffCache.push(r.memBuffCache);
    s.memTotal = r.memTotal;
    s.swapUsed.push(r.swapUsed);
    s.swapTotal = r.swapTotal;
    s.diskRead.push(r.diskRead);
    s.diskWrite.push(r.diskWrite);
    s.rx.push(Math.round(r.rx / step));
    s.tx.push(Math.round(r.tx / step));
    for (const d of r.disks ?? []) {
      let e = disks.get(d.mount);
      if (!e) disks.set(d.mount, (e = { mount: d.mount, total: d.total, used: new Array(i).fill(null) }));
      e.total = d.total;
      e.used[i] = d.used;
    }
    for (const c of r.containers ?? []) {
      let e = conts.get(c.name);
      if (!e) conts.set(c.name, (e = { name: c.name, cpu: new Array(i).fill(null), mem: new Array(i).fill(null) }));
      e.cpu[i] = c.cpu;
      e.mem[i] = c.mem;
    }
    for (const n of r.net ?? []) {
      let e = nets.get(n.iface);
      if (!e) nets.set(n.iface, (e = { iface: n.iface, rx: new Array(i).fill(null), tx: new Array(i).fill(null) }));
      e.rx[i] = Math.round(n.rx / step);
      e.tx[i] = Math.round(n.tx / step);
    }
  });
  const len = s.ts.length;
  for (const d of disks.values()) d.used.length = len;
  for (const n of nets.values()) {
    n.rx.length = len;
    n.tx.length = len;
  }
  // sparse arrays → explicit nulls so JSON keeps the gaps
  s.disks = [...disks.values()].map((d) => ({ ...d, used: Array.from(d.used, (v) => v ?? null) }));
  s.net = [...nets.values()].map((n) => ({ iface: n.iface, rx: Array.from(n.rx, (v) => v ?? null), tx: Array.from(n.tx, (v) => v ?? null) }));
  // the busiest containers first; charts show the top few
  const avg = (a: (number | null)[]) => a.reduce<number>((sum, v) => sum + (v ?? 0), 0) / Math.max(1, a.length);
  s.containers = [...conts.values()]
    .map((c) => {
      c.cpu.length = len;
      c.mem.length = len;
      return { name: c.name, cpu: Array.from(c.cpu, (v) => v ?? null), mem: Array.from(c.mem, (v) => v ?? null) };
    })
    .sort((a, b) => avg(b.cpu) - avg(a.cpu));
  return s;
}
