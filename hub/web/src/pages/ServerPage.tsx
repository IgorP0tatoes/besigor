import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { AnimatedNumber } from '../components/AnimatedNumber';
import { Chart, type ChartLine } from '../components/Chart';
import { ErrorBoundary } from '../components/ErrorBoundary';
import { Dialog, StatusDot, useToast } from '../components/ui';
import { api } from '../lib/api';
import { bitsParts, bytesParts, fmtAgo, fmtBits, fmtBytes, fmtNumber, fmtRate, fmtUptime, pct } from '../lib/format';
import { useHub } from '../lib/hub';
import type { RangeKey, Series, Server } from '../lib/types';
import { DockerChoice, InstallSteps, type TokenResult } from './AddServer';
import { AlertsPanel } from './AlertsPanel';
import { Containers } from './Containers';
import { Probes } from './Probes';
import { TrafficCard } from './Traffic';
import { worstDisk } from './Dashboard';

const RANGES: { key: RangeKey; label: string }[] = [
  { key: '1h', label: '1 ч' },
  { key: '12h', label: '12 ч' },
  { key: '24h', label: '24 ч' },
  { key: '1w', label: '1 нед' },
  { key: '30d', label: '30 дн' },
  { key: '1y', label: '1 год' },
];

const C = {
  violet: '#8b7bff',
  lilac: '#d7b6ff',
  blue: '#5ab0ff',
  teal: '#3dd6c4',
  amber: '#f5a524',
  red: '#e5484d',
  pink: '#ff7ad9',
  green: '#3dd68c',
};
const PALETTE = [C.violet, C.teal, C.amber, C.pink, C.blue, C.green, C.lilac];

const fmtPctAxis = (v: number) => fmtNumber(v, 0) + ' %';
const fmtPctVal = (v: number) => fmtNumber(v, 1) + ' %';
const fmtLoad = (v: number) => fmtNumber(v, 2);

function Stat({ label, children, sub }: { label: string; children: ReactNode; sub?: ReactNode }) {
  return (
    <div className="stat glass rise">
      <div className="stat-label">{label}</div>
      <div className="stat-value">{children}</div>
      {sub && <div className="stat-sub">{sub}</div>}
    </div>
  );
}

function Unit({ parts }: { parts: [string, string] }) {
  return (
    <>
      <span className="num">{parts[0]}</span>
      <small>{parts[1]}</small>
    </>
  );
}

function ChartCard({ title, hint, children, empty }: { title: string; hint?: string; children: ReactNode; empty: boolean }) {
  return (
    <section className="chart-card glass rise">
      <div className="chart-head">
        <h2>{title}</h2>
        {hint && <span className="hint">{hint}</span>}
      </div>
      {empty ? (
        <div className="chart-box">
          <div className="chart-empty">Данных за этот период пока нет</div>
        </div>
      ) : (
        <ErrorBoundary>{children}</ErrorBoundary>
      )}
    </section>
  );
}

function useSeries(id: string, range: RangeKey) {
  const [data, setData] = useState<Series | null>(null);
  useEffect(() => {
    let alive = true;
    const load = () =>
      api<Series>(`/api/servers/${id}/stats?range=${range}`)
        .then((s) => alive && setData(s))
        .catch(() => {});
    setData(null);
    void load();
    const every = range === '1h' || range === '12h' || range === '24h' ? 60_000 : 300_000;
    const t = setInterval(load, every);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id, range]);
  return data;
}

function Charts({ s }: { s: Series }) {
  const empty = s.ts.length === 0;
  const charts = useMemo(() => {
    const memPct = (arr: number[]) => arr.map((v) => pct(v, s.memTotal));
    const cpu: ChartLine[] = [
      { label: 'Всего', color: C.violet, values: s.cpu, fill: true },
      { label: 'User', color: C.teal, values: s.cpuUser },
      { label: 'System', color: C.amber, values: s.cpuSys },
      { label: 'IO wait', color: C.pink, values: s.cpuIowait },
      { label: 'Steal', color: C.red, values: s.cpuSteal, dash: true },
    ];
    const load: ChartLine[] = [
      { label: '1 мин', color: C.violet, values: s.load1, fill: true },
      { label: '5 мин', color: C.teal, values: s.load5 },
      { label: '15 мин', color: C.amber, values: s.load15 },
    ];
    const mem: ChartLine[] = [
      { label: 'Занято', color: C.violet, values: memPct(s.memUsed), fill: true },
      { label: 'Кэш', color: C.lilac, values: memPct(s.memBuffCache), dash: true },
    ];
    const swap: ChartLine[] = [{ label: 'Swap', color: C.amber, values: s.swapUsed.map((v) => pct(v, s.swapTotal)), fill: true }];
    const disks: ChartLine[] = s.disks.map((d, i) => ({
      label: d.mount,
      color: PALETTE[i % PALETTE.length]!,
      values: d.used.map((v) => (v == null ? null : pct(v, d.total))),
      fill: i === 0,
    }));
    const io: ChartLine[] = [
      { label: 'Чтение', color: C.teal, values: s.diskRead, fill: true },
      { label: 'Запись', color: C.violet, values: s.diskWrite, fill: true },
    ];
    const net: ChartLine[] = [
      { label: 'Входящий', color: C.teal, values: s.rx, fill: true },
      { label: 'Исходящий', color: C.violet, values: s.tx, fill: true },
    ];
    const ifaces: ChartLine[] = s.net.flatMap((n, i) => [
      { label: `${n.iface} ↓`, color: PALETTE[(i * 2) % PALETTE.length]!, values: n.rx },
      { label: `${n.iface} ↑`, color: PALETTE[(i * 2 + 1) % PALETTE.length]!, values: n.tx, dash: true },
    ]);
    const top = s.containers.slice(0, 6);
    const ctCpu: ChartLine[] = top.map((c, i) => ({ label: c.name, color: PALETTE[i % PALETTE.length]!, values: c.cpu }));
    const ctMem: ChartLine[] = top.map((c, i) => ({ label: c.name, color: PALETTE[i % PALETTE.length]!, values: c.mem }));
    return { cpu, load, mem, swap, disks, io, net, ifaces, ctCpu, ctMem };
  }, [s]);

  const common = { ts: s.ts, step: s.step };
  return (
    <div className="charts">
      <ChartCard title="Процессор" hint="% загрузки" empty={empty}>
        <Chart {...common} lines={charts.cpu} format={fmtPctVal} yMax={100} />
      </ChartCard>
      <ChartCard title="Память" hint={`из ${fmtBytes(s.memTotal)}`} empty={empty}>
        <Chart {...common} lines={charts.mem} format={fmtPctVal} yMax={100} />
      </ChartCard>
      <ChartCard title="Сеть" hint="все физические интерфейсы" empty={empty}>
        <Chart {...common} lines={charts.net} format={fmtBits} />
      </ChartCard>
      <ChartCard title="Диски" hint="% занятого места" empty={empty || charts.disks.length === 0}>
        <Chart {...common} lines={charts.disks} format={fmtPctVal} yMax={100} />
      </ChartCard>
      <ChartCard title="Дисковый ввод-вывод" empty={empty}>
        <Chart {...common} lines={charts.io} format={fmtRate} />
      </ChartCard>
      <ChartCard title="Load average" empty={empty}>
        <Chart {...common} lines={charts.load} format={fmtLoad} />
      </ChartCard>
      {s.swapTotal > 0 && (
        <ChartCard title="Swap" hint={`из ${fmtBytes(s.swapTotal)}`} empty={empty}>
          <Chart {...common} lines={charts.swap} format={fmtPctAxis} yMax={100} />
        </ChartCard>
      )}
      {s.containers.length > 0 && (
        <ChartCard title="Контейнеры · CPU" hint="топ-6 по нагрузке" empty={empty}>
          <Chart {...common} lines={charts.ctCpu} format={fmtPctVal} />
        </ChartCard>
      )}
      {s.containers.length > 0 && (
        <ChartCard title="Контейнеры · память" hint="топ-6 по нагрузке" empty={empty}>
          <Chart {...common} lines={charts.ctMem} format={fmtBytes} />
        </ChartCard>
      )}
      {s.net.length > 1 && (
        <ChartCard title="Интерфейсы" hint="включая туннели" empty={empty}>
          <Chart {...common} lines={charts.ifaces} format={fmtBits} />
        </ChartCard>
      )}
    </div>
  );
}

function Manage({ server }: { server: Server }) {
  const nav = useNavigate();
  const [dialog, setDialog] = useState<'rename' | 'token' | 'delete' | null>(null);
  const [name, setName] = useState(server.name);
  const [token, setToken] = useState<TokenResult | null>(null);
  const [docker, setDocker] = useState(server.docker);
  const [toast, show] = useToast();

  const close = () => {
    setDialog(null);
    setToken(null);
  };

  return (
    <>
      <div className="server-actions">
        <button className="btn btn-sm" onClick={() => setDialog('rename')}>
          Переименовать
        </button>
        <button
          className="btn btn-sm"
          onClick={() => {
            setDocker(server.docker);
            setDialog('token');
          }}
        >
          Новый токен
        </button>
        <button className="btn btn-sm btn-danger" onClick={() => setDialog('delete')}>
          Удалить
        </button>
      </div>

      {dialog === 'rename' && (
        <Dialog onClose={close} label="Переименовать">
          <form
            onSubmit={async (e) => {
              e.preventDefault();
              await api(`/api/servers/${server.id}`, { method: 'PATCH', json: { name } });
              show('Сохранено');
              close();
            }}
          >
            <h2>Переименовать сервер</h2>
            <div className="field" style={{ marginTop: 16 }}>
              <label htmlFor="rn">Имя</label>
              <input id="rn" className="input" value={name} onChange={(e) => setName(e.target.value)} maxLength={64} autoFocus required />
            </div>
            <div className="dialog-actions">
              <button type="button" className="btn btn-ghost" onClick={close}>
                Отмена
              </button>
              <button className="btn btn-primary" disabled={!name.trim()}>
                Сохранить
              </button>
            </div>
          </form>
        </Dialog>
      )}

      {dialog === 'token' && (
        <Dialog onClose={close} label="Новый токен">
          <h2>Новый токен</h2>
          {!token ? (
            <>
              <p>Старый токен перестанет работать, агент «{server.name}» отключится до перезапуска с новым токеном. Здесь же можно включить или выключить доступ к Docker.</p>
              <DockerChoice value={docker} onChange={setDocker} />
              <div className="dialog-actions">
                <button className="btn btn-ghost" onClick={close}>
                  Отмена
                </button>
                <button className="btn btn-primary" onClick={async () => setToken(await api<TokenResult>(`/api/servers/${server.id}/token`, { method: 'POST', json: { docker } }))}>
                  Выпустить
                </button>
              </div>
            </>
          ) : (
            <>
              <p>Выполните команду на сервере — она перезапишет настройки и перезапустит агента.</p>
              <InstallSteps result={token} />
              <div className="dialog-actions">
                <button className="btn btn-primary" onClick={close}>
                  Готово
                </button>
              </div>
            </>
          )}
        </Dialog>
      )}

      {dialog === 'delete' && (
        <Dialog onClose={close} label="Удалить сервер">
          <h2>Удалить «{server.name}»?</h2>
          <p>Вся история метрик сервера будет удалена, токен агента перестанет работать. Это нельзя отменить.</p>
          <div className="dialog-actions">
            <button className="btn btn-ghost" onClick={close}>
              Отмена
            </button>
            <button
              className="btn btn-danger"
              onClick={async () => {
                await api(`/api/servers/${server.id}`, { method: 'DELETE' });
                nav('/');
              }}
            >
              Удалить навсегда
            </button>
          </div>
        </Dialog>
      )}
      {toast}
    </>
  );
}

export function ServerPage() {
  const { id = '' } = useParams();
  const { servers, loaded } = useHub();
  const [range, setRange] = useState<RangeKey>('1h');
  const series = useSeries(id, range);
  const server = servers.find((s) => s.id === id);

  if (!server) {
    return (
      <main className="page">
        {loaded && (
          <div className="glass empty">
            <h2>Сервер не найден</h2>
            <p>Возможно, его удалили.</p>
            <Link className="btn" to="/">
              К списку серверов
            </Link>
          </div>
        )}
      </main>
    );
  }

  const l = server.online ? server.live : null;
  const h = server.host;
  const root = l?.disks?.find((d) => d.mount === '/') ?? l?.disks?.[0];

  return (
    <main className="page">
      <Link to="/" className="crumbs">
        ← Все серверы
      </Link>
      <div className="page-head">
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="eyebrow">02 · Сервер</div>
          <div className="server-title-row">
            <h1 style={{ display: 'flex', alignItems: 'center', gap: 14, minWidth: 0 }}>
              <StatusDot online={server.online} />
              <span style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{server.name}</span>
            </h1>
            <Manage server={server} />
          </div>
          <div className="chips">
            <span className={`tag ${server.online ? '' : 'bad'}`}>{server.online ? 'В сети' : `Не в сети · ${fmtAgo(server.lastSeen)}`}</span>
            {h && <span className="tag">{h.os}</span>}
            {h && <span className="tag">{h.kernel}</span>}
            {h && (
              <span className="tag">
                {h.cores}&nbsp;vCPU · {fmtBytes(h.memTotal)}
              </span>
            )}
            {h?.cpuModel && <span className="tag">{h.cpuModel}</span>}
            {server.ip && <span className="tag num">{server.ip}</span>}
            {h && <span className={`tag ${server.outdated ? 'warn' : ''}`}>агент {h.version}</span>}
            {!server.docker && <span className="tag">без доступа к Docker</span>}
          </div>
        </div>
      </div>

      <div className="stats-row">
        <Stat label="Процессор" sub={l ? `steal ${fmtNumber(l.cpuSteal, 1)} % · iowait ${fmtNumber(l.cpuIowait, 1)} %` : undefined}>
          {l ? <AnimatedNumber value={l.cpu} format={(v) => fmtNumber(v, 1)} /> : '—'}
          {l && <small>%</small>}
        </Stat>
        <Stat label="Память" sub={l ? `${fmtBytes(l.memUsed)} из ${fmtBytes(l.memTotal)}` : undefined}>
          {l ? <AnimatedNumber value={pct(l.memUsed, l.memTotal)} format={(v) => fmtNumber(v, 1)} /> : '—'}
          {l && <small>%</small>}
        </Stat>
        <Stat label="Диск" sub={root ? `${fmtBytes(root.used)} из ${fmtBytes(root.total)}` : undefined}>
          {l ? <AnimatedNumber value={worstDisk(l)} format={(v) => fmtNumber(v, 1)} /> : '—'}
          {l && <small>%</small>}
        </Stat>
        <Stat label="Сеть ↓" sub={l ? `↑ ${fmtBits(l.tx)}` : undefined}>
          {l ? <Unit parts={bitsParts(l.rx)} /> : '—'}
        </Stat>
        <Stat label="Load average" sub={l ? `${fmtNumber(l.load[1], 2)} · ${fmtNumber(l.load[2], 2)}` : undefined}>
          {l ? <AnimatedNumber value={l.load[0]} format={(v) => fmtNumber(v, 2)} /> : '—'}
        </Stat>
        <Stat label="Аптайм" sub={l && l.swapTotal > 0 ? `swap ${fmtBytes(l.swapUsed)}` : undefined}>
          {l ? <span className="num">{fmtUptime(l.uptime)}</span> : '—'}
        </Stat>
        {l && l.diskRead + l.diskWrite > 0 && (
          <Stat label="Диск I/O" sub={`запись ${fmtRate(l.diskWrite)}`}>
            <Unit parts={bytesParts(l.diskRead)} />
            <small>/с</small>
          </Stat>
        )}
      </div>

      <TrafficCard serverId={server.id} />

      <div className="toolbar">
        <div className="eyebrow" style={{ margin: 0 }}>
          История
        </div>
        <div className="segmented" role="group" aria-label="Период" style={{ marginLeft: 'auto' }}>
          {RANGES.map((r) => (
            <button key={r.key} aria-pressed={range === r.key} onClick={() => setRange(r.key)}>
              {r.label}
            </button>
          ))}
        </div>
      </div>
      {series ? <Charts s={series} /> : <div className="charts" style={{ minHeight: 300 }} />}

      {server.live?.containers && server.live.containers.length > 0 && (
        <Containers serverId={server.id} list={server.live.containers} online={server.online} logs={server.docker} />
      )}
      <Probes serverId={server.id} range={range} />
      <AlertsPanel serverId={server.id} />
    </main>
  );
}
