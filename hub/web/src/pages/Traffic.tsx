import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { AnimatedNumber } from '../components/AnimatedNumber';
import { Dialog } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { fmtBytes, fmtNumber, level } from '../lib/format';

type Mode = 'sum' | 'tx' | 'max';

interface Traffic {
  limit: number | null;
  resetDay: number;
  mode: Mode;
  periodStart: string;
  periodEnd: string;
  rx: number;
  tx: number;
  used: number;
  forecast: number;
  daily: { day: string; rx: number; tx: number }[];
  modes: Record<Mode, string>;
}

const GB = 1024 ** 3;
const fmtDate = (iso: string) => new Date(iso + 'T00:00:00Z').toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', timeZone: 'UTC' });

function Settings({ serverId, t, onDone }: { serverId: string; t: Traffic; onDone: () => void }) {
  const [unit, setUnit] = useState<'GB' | 'TB'>(t.limit && t.limit >= 1024 * GB ? 'TB' : 'GB');
  const [limit, setLimit] = useState(t.limit ? String(+(t.limit / (unit === 'TB' ? 1024 * GB : GB)).toFixed(2)) : '');
  const [resetDay, setResetDay] = useState(String(t.resetDay));
  const [mode, setMode] = useState<Mode>(t.mode);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const n = Number(limit.replace(',', '.'));
    if (limit.trim() && !(n > 0)) return setError('Лимит должен быть положительным числом');
    try {
      await api(`/api/servers/${serverId}/traffic`, {
        method: 'PUT',
        json: { limit: limit.trim() ? Math.round(n * (unit === 'TB' ? 1024 * GB : GB)) : null, resetDay: Number(resetDay), mode },
      });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    }
  };

  return (
    <Dialog onClose={onDone} label="Лимит трафика">
      <form onSubmit={submit}>
        <h2>Лимит трафика</h2>
        <p>Укажите месячный лимит из тарифа VPS. Пустое поле — без лимита, только счётчик. Алерты придут на 80&nbsp;% и 95&nbsp;%.</p>
        <div className="form-grid">
          <div className="field" style={{ gridColumn: '1 / -1' }}>
            <label>Лимит</label>
            <div style={{ display: 'flex', gap: 8 }}>
              <input className="input num" style={{ flex: 1, minWidth: 0 }} value={limit} onChange={(e) => setLimit(e.target.value)} placeholder="Без лимита" inputMode="decimal" />
              <div className="segmented" role="group" aria-label="Единицы">
                {(['GB', 'TB'] as const).map((u) => (
                  <button type="button" key={u} aria-pressed={unit === u} onClick={() => setUnit(u)}>
                    {u === 'GB' ? 'ГБ' : 'ТБ'}
                  </button>
                ))}
              </div>
            </div>
          </div>
          <div className="field">
            <label>День сброса</label>
            <select className="input" value={resetDay} onChange={(e) => setResetDay(e.target.value)}>
              {Array.from({ length: 28 }, (_, i) => (
                <option key={i + 1} value={i + 1}>
                  {i + 1}-е число
                </option>
              ))}
            </select>
          </div>
        </div>
        <div className="field" style={{ marginTop: 14 }}>
          <label>Как провайдер считает трафик</label>
          <div className="segmented" role="group" aria-label="Режим">
            {(Object.keys(t.modes) as Mode[]).map((m) => (
              <button type="button" key={m} aria-pressed={mode === m} onClick={() => setMode(m)}>
                {t.modes[m]}
              </button>
            ))}
          </div>
        </div>
        <div className="form-error" style={{ marginTop: 10 }}>
          {error}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onDone}>
            Отмена
          </button>
          <button className="btn btn-primary">Сохранить</button>
        </div>
      </form>
    </Dialog>
  );
}

export function TrafficCard({ serverId }: { serverId: string }) {
  const [t, setT] = useState<Traffic | null>(null);
  const [editing, setEditing] = useState(false);
  const load = useCallback(() => api<Traffic>(`/api/servers/${serverId}/traffic`).then(setT).catch(() => {}), [serverId]);
  useEffect(() => {
    void load();
    const timer = setInterval(load, 60_000);
    return () => clearInterval(timer);
  }, [load]);
  if (!t) return null;

  const pctUsed = t.limit ? (t.used / t.limit) * 100 : 0;
  const peak = Math.max(1, ...t.daily.map((d) => Math.max(d.rx, d.tx)));
  // one column per day of the period, future days stay empty
  const byDay = new Map(t.daily.map((d) => [d.day, d]));
  const days: { day: string; rx: number; tx: number }[] = [];
  for (let d = new Date(t.periodStart + 'T00:00:00Z'); d < new Date(t.periodEnd + 'T00:00:00Z'); d.setUTCDate(d.getUTCDate() + 1)) {
    const key = d.toISOString().slice(0, 10);
    days.push(byDay.get(key) ?? { day: key, rx: 0, tx: 0 });
  }
  const over = t.limit && t.forecast > t.limit;

  return (
    <section className="glass traffic rise">
      <div className="chart-head">
        <h2>Трафик за месяц</h2>
        <span className="hint">
          {fmtDate(t.periodStart)} — {fmtDate(t.periodEnd)}
        </span>
        <button className="btn btn-sm" onClick={() => setEditing(true)}>
          {t.limit ? 'Лимит' : 'Задать лимит'}
        </button>
      </div>
      <div className="traffic-body">
        <div>
          <div className="stat-value">
            <AnimatedNumber value={t.used} format={fmtBytes} />
            {t.limit && <small>из {fmtBytes(t.limit)}</small>}
          </div>
          {t.limit && (
            <div className={`bar ${level(pctUsed, 80, 95)}`} style={{ marginTop: 12, height: 8 }}>
              <i style={{ width: `${Math.min(100, pctUsed)}%` }} />
            </div>
          )}
          <div className="traffic-meta faint">
            <span>↓ {fmtBytes(t.rx)}</span>
            <span>↑ {fmtBytes(t.tx)}</span>
            <span className={over ? 'warn-text' : ''}>
              прогноз {fmtBytes(t.forecast)}
              {t.limit ? ` · ${fmtNumber((t.forecast / t.limit) * 100, 0)} %` : ''}
            </span>
            <span>считается: {t.modes[t.mode]}</span>
          </div>
        </div>
        <div className="traffic-days" aria-label="По дням">
          {days.map((d) => (
            <div key={d.day} className="traffic-day" title={`${fmtDate(d.day)}: ↓ ${fmtBytes(d.rx)} · ↑ ${fmtBytes(d.tx)}`}>
              <i className="rx" style={{ height: `${(d.rx / peak) * 100}%` }} />
              <i className="tx" style={{ height: `${(d.tx / peak) * 100}%` }} />
            </div>
          ))}
        </div>
      </div>
      {editing && (
        <Settings
          serverId={serverId}
          t={t}
          onDone={() => {
            setEditing(false);
            void load();
          }}
        />
      )}
    </section>
  );
}
