import { useState, type CSSProperties, type MouseEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { AnimatedNumber } from '../components/AnimatedNumber';
import { Sparkline } from '../components/Sparkline';
import { Meter, StatusDot } from '../components/ui';
import { fmtAgo, fmtBits, fmtNumber, level, pct, plural } from '../lib/format';
import { useHub } from '../lib/hub';
import type { Sample, Server } from '../lib/types';
import { AddServerDialog } from './AddServer';

type View = 'cards' | 'table';

function loadView(): View {
  try {
    return localStorage.getItem('besigor.view') === 'table' ? 'table' : 'cards';
  } catch {
    return 'cards';
  }
}

/** The fullest disk is what matters for alerts and the card. */
export function worstDisk(s: Sample | null) {
  return Math.max(0, ...(s?.disks ?? []).map((d) => pct(d.used, d.total)));
}

function subtitle(s: Server) {
  if (!s.host) return 'Ожидаем первое подключение агента…';
  return [s.host.os, s.ip].filter(Boolean).join(' · ');
}

function trackPointer(e: MouseEvent<HTMLElement>) {
  const r = e.currentTarget.getBoundingClientRect();
  e.currentTarget.style.setProperty('--mx', `${e.clientX - r.left}px`);
  e.currentTarget.style.setProperty('--my', `${e.clientY - r.top}px`);
}

function ServerCard({ s, i, history }: { s: Server; i: number; history: Sample[] }) {
  const l = s.live;
  const live = s.online && l;
  return (
    <Link to={`/servers/${s.id}`} className={`server-card glass rise ${s.online ? '' : 'offline'}`} style={{ '--i': i } as CSSProperties} onMouseMove={trackPointer}>
      <div className="card-head">
        <StatusDot online={s.online} />
        <span className="card-title">{s.name}</span>
        {s.outdated && <span className="tag warn">обновите агента</span>}
      </div>
      <div className="card-sub">{subtitle(s)}</div>
      <div className="meters">
        <Meter label="CPU" value={live ? l.cpu : 0} />
        <Meter label="RAM" value={live ? pct(l.memUsed, l.memTotal) : 0} />
        <Meter label="Диск" value={live ? worstDisk(l) : 0} />
      </div>
      <div className="card-foot">
        {live ? (
          <>
            <span className="net-rate">
              <b>↓</b>
              <AnimatedNumber value={l.rx} format={fmtBits} />
            </span>
            <span className="net-rate">
              <b>↑</b>
              <AnimatedNumber value={l.tx} format={fmtBits} />
            </span>
            <Sparkline values={history.map((h) => h.cpu)} />
          </>
        ) : (
          <span>{s.lastSeen ? `Был в сети ${fmtAgo(s.lastSeen)}` : 'Агент ещё не подключался'}</span>
        )}
      </div>
    </Link>
  );
}

function MiniMeter({ value }: { value: number }) {
  return (
    <div className="mini-meter">
      <span className="num">{fmtNumber(value, 1)}&nbsp;%</span>
      <div className={`bar ${level(value)}`}>
        <i style={{ width: `${Math.min(100, value)}%` }} />
      </div>
    </div>
  );
}

function ServerTable({ servers }: { servers: Server[] }) {
  const nav = useNavigate();
  return (
    <div className="glass table-wrap rise">
      <table className="servers">
        <thead>
          <tr>
            <th>Сервер</th>
            <th>CPU</th>
            <th>RAM</th>
            <th>Диск</th>
            <th className="r">Сеть ↓</th>
            <th className="r">Сеть ↑</th>
            <th className="r">Load</th>
            <th>Агент</th>
          </tr>
        </thead>
        <tbody>
          {servers.map((s) => {
            const l = s.online ? s.live : null;
            return (
              <tr key={s.id} onClick={() => nav(`/servers/${s.id}`)}>
                <td>
                  <span style={{ display: 'inline-flex', alignItems: 'center', gap: 10 }}>
                    <StatusDot online={s.online} />
                    <Link to={`/servers/${s.id}`} onClick={(e) => e.stopPropagation()}>
                      {s.name}
                    </Link>
                  </span>
                </td>
                <td>{l ? <MiniMeter value={l.cpu} /> : <span className="faint">—</span>}</td>
                <td>{l ? <MiniMeter value={pct(l.memUsed, l.memTotal)} /> : <span className="faint">—</span>}</td>
                <td>{l ? <MiniMeter value={worstDisk(l)} /> : <span className="faint">—</span>}</td>
                <td className="r num">{l ? fmtBits(l.rx) : '—'}</td>
                <td className="r num">{l ? fmtBits(l.tx) : '—'}</td>
                <td className="r num">{l ? fmtNumber(l.load[0], 2) : '—'}</td>
                <td>
                  <span className={`tag ${s.outdated ? 'warn' : ''}`}>{s.host?.version ?? '—'}</span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}

export function Dashboard() {
  const { servers, loaded, history } = useHub();
  const [view, setView] = useState<View>(loadView);
  const [adding, setAdding] = useState(false);
  const online = servers.filter((s) => s.online).length;

  const changeView = (v: View) => {
    setView(v);
    try {
      localStorage.setItem('besigor.view', v);
    } catch {
      /* private mode */
    }
  };

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">01 · Обзор</div>
          <h1>Серверы</h1>
          {loaded && servers.length > 0 && (
            <div className="muted" style={{ marginTop: 10 }}>
              {online} из {servers.length} {plural(servers.length, 'сервера', 'серверов', 'серверов')} в&nbsp;сети
            </div>
          )}
        </div>
        <div className="page-actions">
          {servers.length > 0 && (
            <div className="segmented" role="group" aria-label="Вид">
              <button aria-pressed={view === 'cards'} onClick={() => changeView('cards')}>
                Карточки
              </button>
              <button aria-pressed={view === 'table'} onClick={() => changeView('table')}>
                Таблица
              </button>
            </div>
          )}
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            + Добавить сервер
          </button>
        </div>
      </div>

      {loaded && servers.length === 0 && (
        <div className="glass empty rise">
          <h2>Пока ни одного сервера</h2>
          <p>Добавьте сервер, установите на него агента одной командой — и метрики появятся здесь через несколько секунд.</p>
          <button className="btn btn-primary" onClick={() => setAdding(true)}>
            + Добавить первый сервер
          </button>
        </div>
      )}

      {servers.length > 0 &&
        (view === 'cards' ? (
          <div className="grid">
            {servers.map((s, i) => (
              <ServerCard key={s.id} s={s} i={i} history={history[s.id] ?? []} />
            ))}
          </div>
        ) : (
          <ServerTable servers={servers} />
        ))}

      {adding && <AddServerDialog onClose={() => setAdding(false)} />}
    </main>
  );
}
