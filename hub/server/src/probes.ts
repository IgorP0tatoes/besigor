import { randomUUID } from 'node:crypto';
import type { DB } from './db.js';

export type ProbeType = 'icmp' | 'tcp' | 'http' | 'dns';
export const PROBE_TYPES: ProbeType[] = ['icmp', 'tcp', 'http', 'dns'];

export interface Probe {
  id: string;
  serverId: string;
  name: string;
  type: ProbeType;
  target: string;
  port: number | null;
  interval: number;
  dnsServer: string | null;
}

/** One check as reported by the agent (docs/protocol.md). */
export interface ProbeResult {
  id: string;
  ts: number;
  ok: boolean;
  ms: number;
  loss: number;
  error?: string;
  certExpires?: number;
}

/** Stored per minute / per hour. */
export interface ProbeBucket {
  ts: number;
  n: number;
  ok: number;
  avg: number;
  min: number;
  max: number;
  loss: number;
  certExpires?: number;
}

export interface ProbeState {
  last?: ProbeResult;
  /** failures in a row, for the "target down" alert */
  fails: number;
  recent: ProbeResult[];
}

type Row = { id: string; server_id: string; name: string; type: ProbeType; target: string; port: number | null; interval: number; dns_server: string | null };

const toProbe = (r: Row): Probe => ({
  id: r.id, serverId: r.server_id, name: r.name, type: r.type, target: r.target, port: r.port, interval: r.interval, dnsServer: r.dns_server,
});

export function validateProbe(b: Partial<Probe>): Omit<Probe, 'id' | 'serverId'> | string {
  const type = b.type as ProbeType;
  if (!PROBE_TYPES.includes(type)) return 'Неизвестный тип проверки';
  const target = String(b.target ?? '').trim();
  if (!target || target.length > 255) return 'Укажите цель проверки';
  if (type === 'http' && !/^https?:\/\/[^\s]+$/i.test(target)) return 'Адрес должен начинаться с http:// или https://';
  if (type !== 'http' && !/^[\w.:-]+$/.test(target)) return 'Укажите домен или IP-адрес без схемы и пути';
  const port = type === 'tcp' ? Number(b.port) : null;
  if (type === 'tcp' && (!Number.isInteger(port) || port! < 1 || port! > 65535)) return 'Укажите порт от 1 до 65535';
  const interval = Math.min(3600, Math.max(10, Math.round(Number(b.interval) || 60)));
  const dnsServer = type === 'dns' && b.dnsServer ? String(b.dnsServer).trim().slice(0, 100) : null;
  const name = String(b.name ?? '').trim().slice(0, 64) || (type === 'tcp' ? `${target}:${port}` : target);
  return { name, type, target, port, interval, dnsServer };
}

export class ProbeStore {
  private state = new Map<string, ProbeState>();

  constructor(private db: DB) {}

  list(serverId?: string): Probe[] {
    const rows = serverId
      ? (this.db.prepare('SELECT * FROM probes WHERE server_id = ? ORDER BY created_at').all(serverId) as Row[])
      : (this.db.prepare('SELECT * FROM probes ORDER BY created_at').all() as Row[]);
    return rows.map(toProbe);
  }

  get(id: string): Probe | undefined {
    const r = this.db.prepare('SELECT * FROM probes WHERE id = ?').get(id) as Row | undefined;
    return r && toProbe(r);
  }

  create(serverId: string, p: Omit<Probe, 'id' | 'serverId'>) {
    const id = randomUUID();
    this.db
      .prepare('INSERT INTO probes (id, server_id, name, type, target, port, interval, dns_server, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, serverId, p.name, p.type, p.target, p.port, p.interval, p.dnsServer, Math.floor(Date.now() / 1000));
    return id;
  }

  update(id: string, p: Omit<Probe, 'id' | 'serverId'>) {
    this.db
      .prepare('UPDATE probes SET name = ?, type = ?, target = ?, port = ?, interval = ?, dns_server = ? WHERE id = ?')
      .run(p.name, p.type, p.target, p.port, p.interval, p.dnsServer, id);
    this.state.delete(id);
  }

  remove(id: string) {
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM probes WHERE id = ?').run(id);
      this.db.prepare('DELETE FROM probe_1m WHERE probe_id = ?').run(id);
      this.db.prepare('DELETE FROM probe_1h WHERE probe_id = ?').run(id);
      this.db.prepare("DELETE FROM alert_state WHERE type LIKE 'probe%' AND key = ?").run(id);
    })();
    this.state.delete(id);
  }

  removeServer(serverId: string) {
    for (const p of this.list(serverId)) this.remove(p.id);
  }

  /** What the agent of a server should run. */
  agentConfig(serverId: string) {
    return this.list(serverId).map((p) => ({
      id: p.id, type: p.type, target: p.target, port: p.port ?? undefined, interval: p.interval, server: p.dnsServer ?? undefined,
    }));
  }

  stateOf(id: string): ProbeState {
    let st = this.state.get(id);
    if (!st) this.state.set(id, (st = { fails: 0, recent: [] }));
    return st;
  }

  /** Stores results of a server's probes; unknown ids are ignored. */
  ingest(serverId: string, results: ProbeResult[]) {
    const known = new Set(this.list(serverId).map((p) => p.id));
    const byBucket = new Map<string, ProbeResult[]>();
    for (const r of results) {
      if (!known.has(r.id) || !Number.isFinite(r.ts)) continue;
      const st = this.stateOf(r.id);
      if (!st.last || r.ts >= st.last.ts) {
        st.last = r;
        st.fails = r.ok ? 0 : st.fails + 1;
      }
      st.recent.push(r);
      const cutoff = r.ts - 3600;
      while (st.recent.length && st.recent[0]!.ts < cutoff) st.recent.shift();
      const key = `${r.id}|${Math.floor(r.ts / 60) * 60}`;
      byBucket.set(key, [...(byBucket.get(key) ?? []), r]);
    }
    const get = this.db.prepare('SELECT data FROM probe_1m WHERE probe_id = ? AND ts = ?');
    const put = this.db.prepare('INSERT INTO probe_1m (probe_id, ts, data) VALUES (?, ?, ?) ON CONFLICT(probe_id, ts) DO UPDATE SET data = excluded.data');
    this.db.transaction(() => {
      for (const [key, list] of byBucket) {
        const [id, tsStr] = key.split('|') as [string, string];
        const ts = Number(tsStr);
        const prev = get.get(id, ts) as { data: string } | undefined;
        const merged = mergeBuckets([...(prev ? [JSON.parse(prev.data) as ProbeBucket] : []), ...list.map(toBucket)], ts);
        put.run(id, ts, JSON.stringify(merged));
      }
    })();
  }

  rollup(now = Math.floor(Date.now() / 1000)) {
    const since = Math.floor((now - 3 * 3600) / 3600) * 3600;
    const rows = this.db.prepare('SELECT probe_id, ts, data FROM probe_1m WHERE ts >= ? ORDER BY ts').all(since) as { probe_id: string; ts: number; data: string }[];
    const groups = new Map<string, ProbeBucket[]>();
    for (const r of rows) {
      const key = `${r.probe_id}|${Math.floor(r.ts / 3600) * 3600}`;
      groups.set(key, [...(groups.get(key) ?? []), JSON.parse(r.data) as ProbeBucket]);
    }
    const put = this.db.prepare('INSERT INTO probe_1h (probe_id, ts, data) VALUES (?, ?, ?) ON CONFLICT(probe_id, ts) DO UPDATE SET data = excluded.data');
    this.db.transaction(() => {
      for (const [key, list] of groups) {
        const [id, ts] = key.split('|') as [string, string];
        put.run(id, Number(ts), JSON.stringify(mergeBuckets(list, Number(ts))));
      }
    })();
  }

  prune(now = Math.floor(Date.now() / 1000)) {
    this.db.prepare('DELETE FROM probe_1m WHERE ts < ?').run(now - 7 * 86400);
    this.db.prepare('DELETE FROM probe_1h WHERE ts < ?').run(now - 365 * 86400);
  }

  series(id: string, seconds: number, now = Math.floor(Date.now() / 1000)) {
    const table = seconds <= 86400 ? 'probe_1m' : 'probe_1h';
    const rows = this.db.prepare(`SELECT data FROM ${table} WHERE probe_id = ? AND ts >= ? ORDER BY ts`).all(id, now - seconds) as { data: string }[];
    const b = rows.map((r) => JSON.parse(r.data) as ProbeBucket);
    return {
      step: table === 'probe_1m' ? 60 : 3600,
      ts: b.map((x) => x.ts),
      avg: b.map((x) => (x.ok ? x.avg : null)),
      min: b.map((x) => (x.ok ? x.min : null)),
      max: b.map((x) => (x.ok ? x.max : null)),
      loss: b.map((x) => x.loss),
      uptime: b.length ? (b.reduce((s, x) => s + x.ok, 0) / Math.max(1, b.reduce((s, x) => s + x.n, 0))) * 100 : null,
    };
  }
}

function toBucket(r: ProbeResult): ProbeBucket {
  return { ts: r.ts, n: 1, ok: r.ok ? 1 : 0, avg: r.ms, min: r.ms, max: r.ms, loss: r.loss, certExpires: r.certExpires || undefined };
}

/** Combines buckets: averages weighted by successful checks, loss by count. */
export function mergeBuckets(list: ProbeBucket[], ts: number): ProbeBucket {
  const n = list.reduce((s, b) => s + b.n, 0);
  const ok = list.reduce((s, b) => s + b.ok, 0);
  const good = list.filter((b) => b.ok > 0);
  const avg = ok ? good.reduce((s, b) => s + b.avg * b.ok, 0) / ok : 0;
  const round = (v: number) => Math.round(v * 100) / 100;
  return {
    ts,
    n,
    ok,
    avg: round(avg),
    min: good.length ? Math.min(...good.map((b) => b.min)) : 0,
    max: good.length ? Math.max(...good.map((b) => b.max)) : 0,
    loss: round(list.reduce((s, b) => s + b.loss * b.n, 0) / Math.max(1, n)),
    certExpires: list.map((b) => b.certExpires).filter((v): v is number => !!v).at(-1),
  };
}
