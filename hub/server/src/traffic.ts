import type { DB } from './db.js';

export type TrafficMode = 'sum' | 'tx' | 'max';
export const TRAFFIC_MODES: Record<TrafficMode, string> = {
  sum: 'входящий + исходящий',
  tx: 'только исходящий',
  max: 'больший из двух',
};

export interface TrafficSettings {
  limit: number | null; // bytes
  resetDay: number; // 1..28
  mode: TrafficMode;
}

export interface TrafficSummary extends TrafficSettings {
  periodStart: string; // YYYY-MM-DD (UTC)
  periodEnd: string; // first day of the next period
  rx: number;
  tx: number;
  used: number;
  /** linear projection to the end of the period */
  forecast: number;
  daily: { day: string; rx: number; tx: number }[];
}

const iso = (d: Date) => d.toISOString().slice(0, 10);

/** Current billing period for a reset day, in UTC. */
export function period(resetDay: number, now = new Date()) {
  const y = now.getUTCFullYear();
  const m = now.getUTCMonth();
  let start = new Date(Date.UTC(y, m, resetDay));
  if (start > now) start = new Date(Date.UTC(y, m - 1, resetDay));
  const end = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, resetDay));
  return { start, end };
}

export function usedBy(mode: TrafficMode, rx: number, tx: number) {
  return mode === 'tx' ? tx : mode === 'max' ? Math.max(rx, tx) : rx + tx;
}

export function getSettings(db: DB, serverId: string): TrafficSettings | undefined {
  const r = db.prepare('SELECT traffic_limit, traffic_reset_day, traffic_mode FROM servers WHERE id = ?').get(serverId) as
    | { traffic_limit: number | null; traffic_reset_day: number; traffic_mode: TrafficMode }
    | undefined;
  return r && { limit: r.traffic_limit, resetDay: r.traffic_reset_day, mode: r.traffic_mode };
}

export function setSettings(db: DB, serverId: string, s: Partial<TrafficSettings>) {
  const cur = getSettings(db, serverId);
  if (!cur) return false;
  const limit = s.limit === undefined ? cur.limit : s.limit && s.limit > 0 ? Math.round(s.limit) : null;
  const resetDay = Math.min(28, Math.max(1, Math.round(Number(s.resetDay ?? cur.resetDay)) || 1));
  const mode = s.mode && s.mode in TRAFFIC_MODES ? s.mode : cur.mode;
  db.prepare('UPDATE servers SET traffic_limit = ?, traffic_reset_day = ?, traffic_mode = ? WHERE id = ?').run(limit, resetDay, mode, serverId);
  return true;
}

export function summary(db: DB, serverId: string, now = new Date()): TrafficSummary | undefined {
  const st = getSettings(db, serverId);
  if (!st) return undefined;
  const { start, end } = period(st.resetDay, now);
  const daily = db
    .prepare('SELECT day, rx, tx FROM traffic_daily WHERE server_id = ? AND day >= ? AND day < ? ORDER BY day')
    .all(serverId, iso(start), iso(end)) as { day: string; rx: number; tx: number }[];
  const rx = daily.reduce((s, d) => s + d.rx, 0);
  const tx = daily.reduce((s, d) => s + d.tx, 0);
  const used = usedBy(st.mode, rx, tx);
  const elapsed = Math.max(3600_000, now.getTime() - start.getTime());
  const forecast = Math.round((used / elapsed) * (end.getTime() - start.getTime()));
  return { ...st, periodStart: iso(start), periodEnd: iso(end), rx, tx, used, forecast, daily };
}

export function pruneTraffic(db: DB, now = new Date()) {
  const cutoff = new Date(now.getTime() - 400 * 86400_000);
  db.prepare('DELETE FROM traffic_daily WHERE day < ?').run(iso(cutoff));
}
