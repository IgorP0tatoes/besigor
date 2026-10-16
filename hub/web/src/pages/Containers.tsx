import { useEffect, useRef, useState } from 'react';
import { Dialog } from '../components/ui';
import { fmtBits, fmtBytes, fmtNumber, fmtUptime } from '../lib/format';
import type { Container } from '../lib/types';

const MAX_LINES = 3000;

function stateTag(c: Container) {
  if (c.state === 'running') {
    if (c.health === 'unhealthy') return <span className="tag warn">unhealthy</span>;
    return <span className="tag ok">{c.health === 'healthy' ? 'healthy' : 'работает'}</span>;
  }
  if (c.state === 'restarting') return <span className="tag warn">перезапуск</span>;
  if (c.state === 'exited') return <span className={`tag ${c.exitCode ? 'bad' : ''}`}>остановлен · {c.exitCode}</span>;
  return <span className="tag">{c.state}</span>;
}

/** Splits Docker's RFC3339 timestamp prefix off a log line. */
function splitLine(line: string): [string, string] {
  const sp = line.indexOf(' ');
  if (sp > 20 && /^\d{4}-\d\d-\d\dT/.test(line)) {
    const d = new Date(line.slice(0, sp));
    if (!Number.isNaN(d.getTime())) {
      return [d.toLocaleString('ru-RU', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }), line.slice(sp + 1)];
    }
  }
  return ['', line];
}

function LogsDialog({ serverId, name, onClose }: { serverId: string; name: string; onClose: () => void }) {
  const [lines, setLines] = useState<string[]>([]);
  const [follow, setFollow] = useState(true);
  const [status, setStatus] = useState<'loading' | 'live' | 'ended'>('loading');
  const [error, setError] = useState('');
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    setLines([]);
    setError('');
    setStatus('loading');
    const es = new EventSource(`/api/servers/${serverId}/containers/${encodeURIComponent(name)}/logs?tail=300${follow ? '&follow=1' : ''}`);
    es.addEventListener('lines', (e) => {
      const batch = JSON.parse((e as MessageEvent).data) as string[];
      setStatus(follow ? 'live' : 'loading');
      setLines((prev) => {
        const next = prev.concat(batch);
        return next.length > MAX_LINES ? next.slice(-MAX_LINES) : next;
      });
    });
    es.addEventListener('end', (e) => {
      const { error: err } = JSON.parse((e as MessageEvent).data) as { error: string | null };
      if (err) setError(err);
      setStatus('ended');
      es.close();
    });
    es.onerror = () => {
      setStatus('ended');
      es.close();
    };
    return () => es.close();
  }, [serverId, name, follow]);

  // keep the view pinned to the bottom unless the user scrolled up
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [lines]);

  return (
    <Dialog onClose={onClose} label={`Логи ${name}`}>
      <div className="logs-head">
        <h2>
          Логи <span className="num">{name}</span>
        </h2>
        <span className={`dot ${status === 'live' ? 'ok' : ''}`} title={status === 'live' ? 'В реальном времени' : ''} />
        <label className="logs-follow">
          <span className="switch">
            <input type="checkbox" checked={follow} onChange={(e) => setFollow(e.target.checked)} />
            <span />
          </span>
          Следить
        </label>
      </div>
      <div
        ref={box}
        className="logs"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {lines.map((l, i) => {
          const [ts, text] = splitLine(l);
          return (
            <div key={i} className="log-line">
              {ts && <span className="log-ts">{ts}</span>}
              <span>{text}</span>
            </div>
          );
        })}
        {status === 'loading' && !lines.length && <div className="faint">Загружаем…</div>}
        {status === 'ended' && !lines.length && !error && <div className="faint">Лог пуст.</div>}
        {error && <div className="form-error">{error}</div>}
      </div>
      <div className="dialog-actions">
        <button className="btn" onClick={onClose}>
          Закрыть
        </button>
      </div>
    </Dialog>
  );
}

export function Containers({ serverId, list, online }: { serverId: string; list: Container[]; online: boolean }) {
  const [logs, setLogs] = useState<string | null>(null);
  const sorted = [...list].sort((a, b) => Number(b.state === 'running') - Number(a.state === 'running') || a.name.localeCompare(b.name));
  const running = list.filter((c) => c.state === 'running').length;
  const now = Date.now() / 1000;

  return (
    <section className="glass containers rise">
      <div className="chart-head">
        <h2>Контейнеры</h2>
        <span className="hint">
          {running} из {list.length} работают
        </span>
      </div>
      <div className="table-wrap" style={{ padding: 0 }}>
        <table className="servers">
          <thead>
            <tr>
              <th>Контейнер</th>
              <th>Состояние</th>
              <th className="r">CPU</th>
              <th className="r">Память</th>
              <th className="r">Сеть ↓ / ↑</th>
              <th className="r">Рестарты</th>
              <th className="r">Работает</th>
              <th />
            </tr>
          </thead>
          <tbody>
            {sorted.map((c) => (
              <tr key={c.name} style={{ cursor: 'default' }}>
                <td>
                  <div className="ct-name">{c.name}</div>
                  <div className="faint ct-image">{c.image}</div>
                </td>
                <td>{stateTag(c)}</td>
                <td className="r num">{c.state === 'running' ? `${fmtNumber(c.cpu, 1)} %` : '—'}</td>
                <td className="r num">{c.state === 'running' ? fmtBytes(c.mem) : '—'}</td>
                <td className="r num">{c.state === 'running' ? `${fmtBits(c.rx)} / ${fmtBits(c.tx)}` : '—'}</td>
                <td className={`r num ${c.restarts > 0 ? 'warn-text' : ''}`}>{c.restarts}</td>
                <td className="r num">{c.state === 'running' && c.started ? fmtUptime(now - c.started) : '—'}</td>
                <td className="r">
                  <button className="btn btn-sm" disabled={!online} onClick={() => setLogs(c.name)}>
                    Логи
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {logs && <LogsDialog serverId={serverId} name={logs} onClose={() => setLogs(null)} />}
    </section>
  );
}
