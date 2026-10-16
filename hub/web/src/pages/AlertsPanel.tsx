import { useEffect, useRef, useState , type CSSProperties } from 'react';
import { useToast } from '../components/ui';
import { api } from '../lib/api';
import { fmtNumber } from '../lib/format';

export type AlertType =
  | 'status' | 'cpu' | 'ram' | 'disk' | 'load' | 'net'
  | 'container_down' | 'container_restarts'
  | 'probe_down' | 'probe_latency' | 'probe_loss' | 'cert_expiry'
  | 'traffic_quota';

interface AlertDef {
  label: string;
  unit: string;
  hasValue: boolean;
  hasMinutes?: boolean;
  min: number;
  max: number;
  step: number;
  maxMinutes: number;
}

interface AlertConfig {
  type: AlertType;
  enabled: boolean;
  value: number;
  minutes: number;
}

const HINTS: Record<AlertType, string> = {
  status: 'Агент не выходит на связь',
  disk: 'Самый заполненный раздел',
  ram: 'Занятая память без кэша',
  cpu: 'Средняя загрузка за период',
  load: 'Load average на одно ядро',
  net: 'Входящий + исходящий',
  container_down: 'Был запущен и остановился',
  container_restarts: 'Рестартов за период',
  probe_down: 'Неудачных проверок подряд',
  probe_latency: 'Среднее время ответа',
  probe_loss: 'Доля потерянных проверок',
  cert_expiry: 'Осталось дней до истечения',
  traffic_quota: '80 % и 95 % лимита из карточки трафика',
};

let defsCache: Record<AlertType, AlertDef> | null = null;

function fmtValue(def: AlertDef, v: number) {
  return def.unit === '%' ? `${fmtNumber(v, 0)} %` : `${fmtNumber(v, def.step < 1 ? 1 : 0)} ${def.unit}`;
}

function AlertRow({ serverId, def, cfg, onChange, onApplyAll }: { serverId: string; def: AlertDef; cfg: AlertConfig; onChange: (c: AlertConfig) => void; onApplyAll: (c: AlertConfig) => void }) {
  const [local, setLocal] = useState(cfg);
  const timer = useRef(0);
  useEffect(() => {
    setLocal(cfg);
  }, [cfg]);

  // sliders save shortly after the thumb stops moving
  const update = (patch: Partial<AlertConfig>, delay = 400) => {
    const next = { ...local, ...patch };
    setLocal(next);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(async () => {
      onChange(await api<AlertConfig>(`/api/servers/${serverId}/alerts/${cfg.type}`, { method: 'PUT', json: next }));
    }, delay);
  };

  return (
    <div className={`alert-row ${local.enabled ? '' : 'off'}`}>
      <label className="switch">
        <input type="checkbox" checked={local.enabled} onChange={(e) => update({ enabled: e.target.checked }, 0)} />
        <span />
      </label>
      <div className="alert-name">
        <div>{def.label}</div>
        <div className="faint">{HINTS[cfg.type]}</div>
      </div>
      <div className="alert-sliders">
        {def.hasValue && (
          <div className="slider">
            <span className="faint">Порог</span>
            <input type="range" min={def.min} max={def.max} step={def.step} value={local.value} disabled={!local.enabled} onChange={(e) => update({ value: Number(e.target.value) })} style={{ '--p': `${((local.value - def.min) / (def.max - def.min)) * 100}%` } as CSSProperties} />
            <b className="num">{fmtValue(def, local.value)}</b>
          </div>
        )}
        {def.hasMinutes !== false && (
        <div className="slider">
          <span className="faint">{def.hasValue ? 'Дольше' : 'Через'}</span>
          <input type="range" min={1} max={def.maxMinutes} step={1} value={local.minutes} disabled={!local.enabled} onChange={(e) => update({ minutes: Number(e.target.value) })} style={{ '--p': `${((local.minutes - 1) / (def.maxMinutes - 1)) * 100}%` } as CSSProperties} />
          <b className="num">{local.minutes}&nbsp;мин</b>
        </div>
        )}
      </div>
      <button className="btn btn-ghost btn-sm" title="Применить эту настройку ко всем серверам" onClick={() => onApplyAll(local)}>
        Ко всем
      </button>
    </div>
  );
}

const MUTES: { label: string; hours: number | null }[] = [
  { label: '1 ч', hours: 1 },
  { label: '4 ч', hours: 4 },
  { label: '24 ч', hours: 24 },
  { label: 'До включения', hours: null },
];

export function AlertsPanel({ serverId }: { serverId: string }) {
  const [defs, setDefs] = useState(defsCache);
  const [alerts, setAlerts] = useState<AlertConfig[]>([]);
  const [muted, setMuted] = useState<number | null | false>(false);
  const [toast, show] = useToast();

  useEffect(() => {
    if (!defsCache) {
      api<{ defs: Record<AlertType, AlertDef> }>('/api/alerts/defs').then((r) => {
        defsCache = r.defs;
        setDefs(r.defs);
      });
    }
    api<{ alerts: AlertConfig[]; mutedUntil: number | null | false }>(`/api/servers/${serverId}/alerts`).then((r) => {
      setAlerts(r.alerts);
      setMuted(r.mutedUntil);
    });
  }, [serverId]);

  const mute = async (hours: number | null) => {
    const r = await api<{ mutedUntil: number | null | false }>(`/api/servers/${serverId}/mute`, { method: 'POST', json: { hours } });
    setMuted(r.mutedUntil);
  };

  if (!defs || !alerts.length) return null;
  return (
    <section className="glass alerts-panel rise">
      <div className="chart-head" style={{ flexWrap: 'wrap', gap: 12 }}>
        <h2>Алерты</h2>
        <div className="mute-bar">
          {muted === false ? (
            <>
              <span className="faint">Заглушить:</span>
              {MUTES.map((m) => (
                <button key={m.label} className="btn btn-sm" onClick={() => mute(m.hours)}>
                  {m.label}
                </button>
              ))}
            </>
          ) : (
            <>
              <span className="tag warn">
                🔕 {muted === null ? 'заглушены до включения' : `заглушены до ${new Date(muted * 1000).toLocaleString('ru-RU', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}`}
              </span>
              <button className="btn btn-sm" onClick={() => mute(0)}>
                Включить
              </button>
            </>
          )}
        </div>
      </div>
      <div className="alert-list">
        {alerts.map((a) => (
          <AlertRow
            key={a.type}
            serverId={serverId}
            def={defs[a.type]}
            cfg={a}
            onChange={(c) => setAlerts((list) => list.map((x) => (x.type === c.type ? c : x)))}
            onApplyAll={async (c) => {
              const r = await api<{ servers: number }>('/api/alerts/apply-all', { method: 'POST', json: c });
              show(`Применено к ${r.servers} серверам`);
            }}
          />
        ))}
      </div>
      {toast}
    </section>
  );
}
