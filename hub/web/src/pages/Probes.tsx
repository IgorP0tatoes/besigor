import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Chart, type ChartLine } from '../components/Chart';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Dialog } from '../components/ui';
import { api, ApiError } from '../lib/api';
import { fmtNumber } from '../lib/format';
import type { RangeKey } from '../lib/types';

type ProbeType = 'icmp' | 'tcp' | 'http' | 'dns';

interface Probe {
  id: string;
  name: string;
  type: ProbeType;
  target: string;
  port: number | null;
  interval: number;
  dnsServer: string | null;
  fails: number;
  last: { ts: number; ok: boolean; ms: number; loss: number; error?: string; certExpires?: number } | null;
}

interface ProbeSeries {
  step: number;
  ts: number[];
  avg: (number | null)[];
  min: (number | null)[];
  max: (number | null)[];
  loss: number[];
  uptime: number | null;
}

const TYPES: { key: ProbeType; label: string; hint: string }[] = [
  { key: 'icmp', label: 'Ping', hint: 'ICMP до хоста' },
  { key: 'tcp', label: 'TCP', hint: 'Открыт ли порт' },
  { key: 'http', label: 'HTTP(S)', hint: 'Ответ сайта и сертификат' },
  { key: 'dns', label: 'DNS', hint: 'Резолвится ли имя' },
];

const INTERVALS = [10, 30, 60, 300];
const fmtMs = (v: number) => `${fmtNumber(v, v >= 100 ? 0 : 1)} мс`;
const fmtLoss = (v: number) => `${fmtNumber(v, 0)} %`;

function ProbeForm({ serverId, probe, onDone }: { serverId: string; probe?: Probe; onDone: () => void }) {
  const [type, setType] = useState<ProbeType>(probe?.type ?? 'icmp');
  const [target, setTarget] = useState(probe?.target ?? '');
  const [port, setPort] = useState(probe?.port ? String(probe.port) : '443');
  const [interval, setIntervalSec] = useState(probe?.interval ?? 60);
  const [dnsServer, setDnsServer] = useState(probe?.dnsServer ?? '');
  const [name, setName] = useState(probe?.name ?? '');
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const body = { type, target, port: Number(port), interval, dnsServer, name };
    try {
      if (probe) await api(`/api/probes/${probe.id}`, { method: 'PUT', json: body });
      else await api(`/api/servers/${serverId}/probes`, { method: 'POST', json: body });
      onDone();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось сохранить');
    }
  };

  const placeholder = type === 'http' ? 'https://example.com/health' : type === 'dns' ? 'example.com' : 'example.com или 1.2.3.4';
  return (
    <Dialog onClose={onDone} label="Проверка">
      <form onSubmit={submit}>
        <h2>{probe ? 'Изменить проверку' : 'Новая проверка'}</h2>
        <p>Проверку выполняет агент этого сервера — так видно, как сервер «видит» цель.</p>
        <div className="segmented" role="group" aria-label="Тип" style={{ marginBottom: 16 }}>
          {TYPES.map((t) => (
            <button type="button" key={t.key} aria-pressed={type === t.key} onClick={() => setType(t.key)} title={t.hint}>
              {t.label}
            </button>
          ))}
        </div>
        <div className="form-grid">
          <div className="field" style={{ gridColumn: type === 'tcp' ? undefined : '1 / -1' }}>
            <label>{type === 'http' ? 'Адрес' : type === 'dns' ? 'Имя' : 'Хост'}</label>
            <input className="input num" value={target} onChange={(e) => setTarget(e.target.value)} placeholder={placeholder} required autoFocus />
          </div>
          {type === 'tcp' && (
            <div className="field">
              <label>Порт</label>
              <input className="input num" value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" required />
            </div>
          )}
          {type === 'dns' && (
            <div className="field">
              <label>DNS-сервер (необязательно)</label>
              <input className="input num" value={dnsServer} onChange={(e) => setDnsServer(e.target.value)} placeholder="1.1.1.1" />
            </div>
          )}
          <div className="field">
            <label>Название</label>
            <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="По умолчанию — цель" />
          </div>
          <div className="field">
            <label>Как часто</label>
            <div className="segmented" role="group" aria-label="Интервал">
              {INTERVALS.map((i) => (
                <button type="button" key={i} aria-pressed={interval === i} onClick={() => setIntervalSec(i)}>
                  {i < 60 ? `${i} с` : `${i / 60} мин`}
                </button>
              ))}
            </div>
          </div>
        </div>
        <div className="form-error" style={{ marginTop: 10 }}>
          {error}
        </div>
        <div className="dialog-actions">
          <button type="button" className="btn btn-ghost" onClick={onDone}>
            Отмена
          </button>
          <button className="btn btn-primary">{probe ? 'Сохранить' : 'Добавить'}</button>
        </div>
      </form>
    </Dialog>
  );
}

function ProbeChart({ probe, range }: { probe: Probe; range: RangeKey }) {
  const [s, setS] = useState<ProbeSeries | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () => api<ProbeSeries>(`/api/probes/${probe.id}/stats?range=${range}`).then((x) => alive && setS(x)).catch(() => {});
    void load();
    const t = setInterval(load, 60_000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [probe.id, range]);
  if (!s) return <div className="chart-box" />;
  if (!s.ts.length) {
    return (
      <div className="chart-box" style={{ height: 120 }}>
        <div className="chart-empty">Данных пока нет</div>
      </div>
    );
  }
  const lines: ChartLine[] = [
    { label: 'Среднее', color: '#8b7bff', values: s.avg, fill: true },
    { label: 'Мин', color: '#3dd6c4', values: s.min, dash: true },
    { label: 'Макс', color: '#f5a524', values: s.max, dash: true },
  ];
  return (
    <>
      <ErrorBoundary>
        <Chart ts={s.ts} step={s.step} lines={lines} format={fmtMs} height={170} />
      </ErrorBoundary>
      {s.loss.some((v) => v > 0) && (
        <ErrorBoundary>
          <Chart ts={s.ts} step={s.step} lines={[{ label: 'Потери', color: '#e5484d', values: s.loss, fill: true }]} format={fmtLoss} yMax={100} height={110} />
        </ErrorBoundary>
      )}
      {s.uptime !== null && <div className="faint probe-uptime">Доступность за период: {fmtNumber(s.uptime, 2)}&nbsp;%</div>}
    </>
  );
}

function status(p: Probe) {
  if (!p.last) return <span className="tag">ожидание</span>;
  if (!p.last.ok) return <span className="tag bad" title={p.last.error}>ошибка · {p.fails}</span>;
  return <span className="tag ok">{fmtMs(p.last.ms)}</span>;
}

function certDays(p: Probe) {
  const exp = p.last?.certExpires;
  if (!exp) return null;
  const days = Math.floor((exp - Date.now() / 1000) / 86400);
  return <span className={`tag ${days < 14 ? 'warn' : ''}`}>🔐 {days}&nbsp;дн</span>;
}

export function Probes({ serverId, range }: { serverId: string; range: RangeKey }) {
  const [list, setList] = useState<Probe[]>([]);
  const [editing, setEditing] = useState<Probe | 'new' | null>(null);

  const load = useCallback(() => api<Probe[]>(`/api/servers/${serverId}/probes`).then(setList).catch(() => {}), [serverId]);
  useEffect(() => {
    void load();
    const t = setInterval(load, 15_000);
    return () => clearInterval(t);
  }, [load]);

  return (
    <section className="glass probes rise">
      <div className="chart-head">
        <h2>Сетевые проверки</h2>
        <span className="hint">с этого сервера</span>
        <button className="btn btn-sm" onClick={() => setEditing('new')}>
          + Проверка
        </button>
      </div>
      {list.length === 0 ? (
        <p className="muted" style={{ margin: '4px 0 12px', fontSize: 14 }}>
          Добавьте ping, TCP-порт, сайт или DNS-имя — агент будет проверять их по расписанию, а при сбоях придёт алерт.
        </p>
      ) : (
        <div className="probe-grid">
          {list.map((p) => (
            <div key={p.id} className="probe">
              <div className="probe-head">
                <span className={`dot ${!p.last ? '' : p.last.ok ? 'ok' : 'bad'}`} />
                <div className="probe-title">
                  <b>{p.name}</b>
                  <span className="faint num">
                    {TYPES.find((t) => t.key === p.type)?.label} · {p.target}
                    {p.port ? `:${p.port}` : ''} · каждые {p.interval < 60 ? `${p.interval} с` : `${p.interval / 60} мин`}
                  </span>
                </div>
                <div className="probe-tags">
                  {status(p)}
                  {certDays(p)}
                </div>
                <div className="probe-actions">
                  <button className="btn btn-ghost btn-sm" onClick={() => setEditing(p)}>
                    Изменить
                  </button>
                  <button
                    className="btn btn-ghost btn-sm"
                    onClick={async () => {
                      await api(`/api/probes/${p.id}`, { method: 'DELETE' });
                      void load();
                    }}
                  >
                    Удалить
                  </button>
                </div>
              </div>
              <ProbeChart probe={p} range={range} />
            </div>
          ))}
        </div>
      )}
      {editing && (
        <ProbeForm
          serverId={serverId}
          probe={editing === 'new' ? undefined : editing}
          onDone={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
    </section>
  );
}
