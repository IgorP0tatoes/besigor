import type { FastifyBaseLogger } from 'fastify';
import type { AgentHub } from './agents.js';
import type { DB } from './db.js';
import { fmtNum, fmtDuration, esc } from './text.js';
import { bus } from './live.js';
import type { Container, HostInfo, Sample } from './types.js';

export type Category = 'offline' | 'resources' | 'traffic' | 'containers' | 'probes';
export const CATEGORIES: Record<Category, string> = {
  offline: 'Офлайн и восстановление',
  resources: 'Ресурсы: CPU, RAM, диск, load',
  traffic: 'Трафик',
  containers: 'Контейнеры',
  probes: 'Сетевые проверки',
};

export type AlertType = 'status' | 'cpu' | 'ram' | 'disk' | 'load' | 'net' | 'container_down' | 'container_restarts';

interface AlertDef {
  label: string;
  category: Category;
  unit: string;
  /** status has no value, only a duration */
  hasValue: boolean;
  min: number;
  max: number;
  step: number;
  maxMinutes: number;
  defaults: { enabled: boolean; value: number; minutes: number };
}

export const ALERT_DEFS: Record<AlertType, AlertDef> = {
  status: { label: 'Сервер не в сети', category: 'offline', unit: '', hasValue: false, min: 0, max: 0, step: 0, maxMinutes: 60, defaults: { enabled: true, value: 0, minutes: 2 } },
  disk: { label: 'Диск', category: 'resources', unit: '%', hasValue: true, min: 1, max: 99, step: 1, maxMinutes: 60, defaults: { enabled: true, value: 90, minutes: 5 } },
  ram: { label: 'Память', category: 'resources', unit: '%', hasValue: true, min: 1, max: 99, step: 1, maxMinutes: 60, defaults: { enabled: true, value: 90, minutes: 10 } },
  cpu: { label: 'Процессор', category: 'resources', unit: '%', hasValue: true, min: 1, max: 99, step: 1, maxMinutes: 60, defaults: { enabled: false, value: 90, minutes: 10 } },
  load: { label: 'Load average', category: 'resources', unit: '× ядер', hasValue: true, min: 0.5, max: 10, step: 0.1, maxMinutes: 60, defaults: { enabled: false, value: 2, minutes: 10 } },
  net: { label: 'Сетевой трафик', category: 'traffic', unit: 'Мбит/с', hasValue: true, min: 1, max: 10000, step: 1, maxMinutes: 60, defaults: { enabled: false, value: 100, minutes: 10 } },
  container_down: { label: 'Контейнер остановился', category: 'containers', unit: '', hasValue: false, min: 0, max: 0, step: 0, maxMinutes: 30, defaults: { enabled: true, value: 0, minutes: 1 } },
  container_restarts: { label: 'Рестарты контейнера', category: 'containers', unit: 'раз', hasValue: true, min: 1, max: 20, step: 1, maxMinutes: 60, defaults: { enabled: true, value: 3, minutes: 10 } },
};

export const ALERT_TYPES = Object.keys(ALERT_DEFS) as AlertType[];

export interface AlertConfig {
  type: AlertType;
  enabled: boolean;
  value: number;
  minutes: number;
}

export interface Notifier {
  notify(category: Category, html: string): void;
}

export function getAlerts(db: DB, serverId: string): AlertConfig[] {
  const rows = db.prepare('SELECT type, enabled, value, minutes FROM alerts WHERE server_id = ?').all(serverId) as {
    type: AlertType;
    enabled: number;
    value: number;
    minutes: number;
  }[];
  const byType = new Map(rows.map((r) => [r.type, r]));
  return ALERT_TYPES.map((type) => {
    const r = byType.get(type);
    const d = ALERT_DEFS[type].defaults;
    return r ? { type, enabled: !!r.enabled, value: r.value, minutes: r.minutes } : { type, ...d };
  });
}

export function setAlert(db: DB, serverId: string, a: AlertConfig) {
  const def = ALERT_DEFS[a.type];
  const value = def.hasValue ? Math.min(def.max, Math.max(def.min, Number(a.value) || def.defaults.value)) : 0;
  const minutes = Math.min(def.maxMinutes, Math.max(1, Math.round(Number(a.minutes) || def.defaults.minutes)));
  db.prepare(
    `INSERT INTO alerts (server_id, type, enabled, value, minutes) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(server_id, type) DO UPDATE SET enabled = excluded.enabled, value = excluded.value, minutes = excluded.minutes`,
  ).run(serverId, a.type, a.enabled ? 1 : 0, value, minutes);
  if (!a.enabled) db.prepare('DELETE FROM alert_state WHERE server_id = ? AND type = ?').run(serverId, a.type);
}

export function mutedUntil(db: DB, serverId: string): number | null | undefined {
  const row = db.prepare('SELECT until FROM mutes WHERE server_id = ?').get(serverId) as { until: number | null } | undefined;
  if (!row) return undefined;
  if (row.until !== null && row.until <= Date.now() / 1000) {
    db.prepare('DELETE FROM mutes WHERE server_id = ?').run(serverId);
    return undefined;
  }
  return row.until; // null = until unmuted
}

export function setMute(db: DB, serverId: string, hours: number | null) {
  if (hours === 0) {
    db.prepare('DELETE FROM mutes WHERE server_id = ?').run(serverId);
    return;
  }
  const until = hours === null ? null : Math.floor(Date.now() / 1000) + Math.round(hours * 3600);
  db.prepare('INSERT INTO mutes (server_id, until) VALUES (?, ?) ON CONFLICT(server_id) DO UPDATE SET until = excluded.until').run(serverId, until);
}

const pctOf = (used: number, total: number) => (total > 0 ? (used / total) * 100 : 0);
export const worstDiskPct = (s: Sample) => Math.max(0, ...(s.disks ?? []).map((d) => pctOf(d.used, d.total)));

/** Current value of a metric alert for one live sample. */
function metric(type: AlertType, s: Sample, cores: number): number {
  switch (type) {
    case 'cpu':
      return s.cpu;
    case 'ram':
      return pctOf(s.memUsed, s.memTotal);
    case 'disk':
      return worstDiskPct(s);
    case 'load':
      return s.load[0] / Math.max(1, cores);
    case 'net':
      return ((s.rx + s.tx) * 8) / 1e6;
    default:
      return 0;
  }
}

function fmtMetric(type: AlertType, v: number) {
  switch (type) {
    case 'load':
      return `${fmtNum(v, 2)} × ядер`;
    case 'net':
      return `${fmtNum(v, v >= 100 ? 0 : 1)} Мбит/с`;
    default:
      return `${fmtNum(v, 1)} %`;
  }
}

const HISTORY_SECONDS = 3600;

/** Evaluates thresholds over the live stream and reports state changes. */
export class AlertEngine {
  private history = new Map<string, Sample[]>();
  /** containers seen running this session, per server — only they can "go down" */
  private seenRunning = new Map<string, Set<string>>();
  private downSince = new Map<string, number>();
  /** restart counters over time, per server|container */
  private restarts = new Map<string, { ts: number; id: string; count: number }[]>();
  private timer?: NodeJS.Timeout;
  private off?: () => void;

  constructor(
    private db: DB,
    private agents: AgentHub,
    private notifier: Notifier,
    private log: FastifyBaseLogger,
  ) {}

  start() {
    this.off = bus.subscribe((e) => {
      if (e.type === 'live') {
        const list = this.history.get(e.serverId) ?? [];
        list.push(e.sample);
        const cutoff = e.sample.ts - HISTORY_SECONDS;
        while (list.length && list[0]!.ts < cutoff) list.shift();
        this.history.set(e.serverId, list);
        this.trackContainers(e.serverId, e.sample);
      } else if (e.type === 'status' && !e.online) {
        // stale samples must not trigger anything after a reconnect
        this.history.delete(e.serverId);
      }
    });
    this.timer = setInterval(() => this.tick(), 15_000);
  }

  stop() {
    clearInterval(this.timer);
    this.off?.();
  }

  forget(serverId: string) {
    this.history.delete(serverId);
    this.seenRunning.delete(serverId);
    this.db.prepare('DELETE FROM alert_state WHERE server_id = ?').run(serverId);
    this.db.prepare('DELETE FROM alerts WHERE server_id = ?').run(serverId);
    this.db.prepare('DELETE FROM mutes WHERE server_id = ?').run(serverId);
  }

  /** Alerts currently firing, for the panel and the bot. */
  active(): { serverId: string; type: AlertType; key: string; since: number; value: number | null }[] {
    return (this.db.prepare('SELECT server_id, type, key, since, value FROM alert_state ORDER BY since').all() as {
      server_id: string;
      type: AlertType;
      key: string;
      since: number;
      value: number | null;
    }[]).map((r) => ({ serverId: r.server_id, type: r.type, key: r.key, since: r.since, value: r.value }));
  }

  tick(now = Math.floor(Date.now() / 1000)) {
    const servers = this.db.prepare('SELECT id, name, host_info, last_seen FROM servers').all() as {
      id: string;
      name: string;
      host_info: string | null;
      last_seen: number | null;
    }[];
    for (const srv of servers) {
      try {
        this.checkServer(srv, now);
      } catch (err) {
        this.log.error({ err, server: srv.name }, 'alert check failed');
      }
    }
  }

  private state(serverId: string, type: AlertType, key = '') {
    return this.db.prepare('SELECT since, value FROM alert_state WHERE server_id = ? AND type = ? AND key = ?').get(serverId, type, key) as
      | { since: number; value: number | null }
      | undefined;
  }

  private firingKeys(serverId: string, type: AlertType) {
    return (this.db.prepare('SELECT key FROM alert_state WHERE server_id = ? AND type = ?').all(serverId, type) as { key: string }[]).map((r) => r.key);
  }

  private fire(serverId: string, type: AlertType, since: number, value: number | null, key = '') {
    this.db.prepare('INSERT OR REPLACE INTO alert_state (server_id, type, key, since, value) VALUES (?, ?, ?, ?, ?)').run(serverId, type, key, since, value);
  }

  private resolve(serverId: string, type: AlertType, key = '') {
    this.db.prepare('DELETE FROM alert_state WHERE server_id = ? AND type = ? AND key = ?').run(serverId, type, key);
  }

  private send(serverId: string, category: Category, html: string) {
    if (mutedUntil(this.db, serverId) !== undefined) return;
    this.notifier.notify(category, html);
  }

  private trackContainers(serverId: string, s: Sample) {
    if (!s.containers) return;
    const running = this.seenRunning.get(serverId) ?? new Set<string>();
    this.seenRunning.set(serverId, running);
    for (const c of s.containers) {
      const k = `${serverId}|${c.name}`;
      if (c.state === 'running') {
        running.add(c.name);
        this.downSince.delete(k);
      } else if (running.has(c.name) && (c.state === 'exited' || c.state === 'dead') && !this.downSince.has(k)) {
        this.downSince.set(k, s.ts);
      }
      const hist = this.restarts.get(k) ?? [];
      // a recreated container (new id) starts counting from scratch
      if (hist.length && hist.at(-1)!.id !== c.id) hist.length = 0;
      hist.push({ ts: s.ts, id: c.id, count: c.restarts });
      while (hist.length && hist[0]!.ts < s.ts - HISTORY_SECONDS) hist.shift();
      this.restarts.set(k, hist);
    }
  }

  private checkContainers(serverId: string, name: string, list: Container[] | undefined, cfg: AlertConfig[], now: number) {
    if (!list) return;
    const byName = new Map(list.map((c) => [c.name, c]));
    const down = cfg.find((c) => c.type === 'container_down')!;
    const loop = cfg.find((c) => c.type === 'container_restarts')!;

    // stopped containers
    for (const key of this.firingKeys(serverId, 'container_down')) {
      const c = byName.get(key);
      if (!c) {
        this.resolve(serverId, 'container_down', key); // removed on purpose
        this.seenRunning.get(serverId)?.delete(key);
      } else if (c.state === 'running') {
        this.resolve(serverId, 'container_down', key);
        this.send(serverId, 'containers', `✅ ${name}: контейнер <b>${esc(key)}</b> снова работает`);
      }
    }
    if (down.enabled) {
      for (const c of list) {
        const since = this.downSince.get(`${serverId}|${c.name}`);
        if (since === undefined || now - since < down.minutes * 60 || this.state(serverId, 'container_down', c.name)) continue;
        this.fire(serverId, 'container_down', since, c.exitCode, c.name);
        this.send(serverId, 'containers', `🐳 ${name}: контейнер <b>${esc(c.name)}</b> остановился · код выхода ${c.exitCode}`);
      }
    }

    // restart loops
    for (const c of list) {
      const hist = (this.restarts.get(`${serverId}|${c.name}`) ?? []).filter((h) => h.ts >= now - loop.minutes * 60);
      const grown = hist.length ? hist.at(-1)!.count - Math.min(...hist.map((h) => h.count)) : 0;
      const firing = this.state(serverId, 'container_restarts', c.name);
      if (loop.enabled && !firing && grown >= loop.value) {
        this.fire(serverId, 'container_restarts', now, grown, c.name);
        this.send(serverId, 'containers', `🔁 ${name}: контейнер <b>${esc(c.name)}</b> перезапускается по кругу · ${grown} раз за ${loop.minutes}\u00a0мин`);
      } else if (firing && grown === 0 && c.state === 'running') {
        this.resolve(serverId, 'container_restarts', c.name);
        this.send(serverId, 'containers', `✅ ${name}: контейнер <b>${esc(c.name)}</b> перестал перезапускаться`);
      }
    }
    // a firing restart alert for a container that no longer exists
    for (const key of this.firingKeys(serverId, 'container_restarts')) {
      if (!byName.has(key)) this.resolve(serverId, 'container_restarts', key);
    }
  }

  private checkServer(srv: { id: string; name: string; host_info: string | null; last_seen: number | null }, now: number) {
    const cfg = getAlerts(this.db, srv.id);
    const name = `<b>${esc(srv.name)}</b>`;
    const online = this.agents.isOnline(srv.id);

    const status = cfg.find((c) => c.type === 'status')!;
    const down = this.state(srv.id, 'status');
    if (status.enabled && !online && srv.last_seen && !down && now - srv.last_seen >= status.minutes * 60) {
      this.fire(srv.id, 'status', srv.last_seen, null);
      this.send(srv.id, 'offline', `🔴 ${name} не в сети уже ${fmtDuration(now - srv.last_seen)}`);
    } else if (online && down) {
      this.resolve(srv.id, 'status');
      this.send(srv.id, 'offline', `✅ ${name} снова в сети · простой ${fmtDuration(now - down.since)}`);
    }

    if (!online) return; // metric alerts pause while the agent is away
    const hist = this.history.get(srv.id) ?? [];
    const cores = srv.host_info ? (JSON.parse(srv.host_info) as HostInfo).cores : 1;
    this.checkContainers(srv.id, name, hist.at(-1)?.containers, cfg, now);
    for (const c of cfg) {
      if (c.type === 'status' || c.type.startsWith('container') || !c.enabled) continue;
      const def = ALERT_DEFS[c.type];
      const from = now - c.minutes * 60;
      const window = hist.filter((s) => s.ts >= from);
      // need samples covering (almost) the whole window before judging
      if (!window.length || window[0]!.ts > from + 20) continue;
      const avg = window.reduce((sum, s) => sum + metric(c.type, s, cores), 0) / window.length;
      const firing = this.state(srv.id, c.type);
      if (avg > c.value && !firing) {
        this.fire(srv.id, c.type, now, avg);
        this.send(
          srv.id,
          def.category,
          `⚠️ ${name}: ${def.label.toLowerCase()} ${fmtMetric(c.type, avg)}\nпорог ${fmtMetric(c.type, c.value)} · ${c.minutes} мин`,
        );
      } else if (avg <= c.value && firing) {
        this.resolve(srv.id, c.type);
        this.send(srv.id, def.category, `✅ ${name}: ${def.label.toLowerCase()} в норме · ${fmtMetric(c.type, avg)}`);
      }
    }
  }
}
