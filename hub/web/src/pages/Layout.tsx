import type { ReactNode } from 'react';
import { NavLink } from 'react-router-dom';
import { Glow } from '../components/Glow';
import { Logo } from '../components/ui';
import { api } from '../lib/api';
import { useHub } from '../lib/hub';

export function Layout({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  const { servers } = useHub();
  const online = servers.filter((s) => s.online).length;
  const down = servers.length - online;

  return (
    <div className="shell">
      <div className="shell-glow">
        <Glow intensity={0.6} />
      </div>
      <header className="topbar">
        <NavLink to="/" className="brand">
          <Logo />
          besigor
        </NavLink>
        <nav className="topbar-nav">
          <NavLink to="/" end>
            Серверы
          </NavLink>
        </nav>
        <div className="topbar-right">
          {servers.length > 0 && (
            <span className="summary-pill" title={`${online} из ${servers.length} в сети`}>
              <span className={`dot ${down ? 'bad' : 'ok'}`} />
              <span className="num">
                {online}/{servers.length}
              </span>
              <span className="label">в&nbsp;сети</span>
            </span>
          )}
          <button
            className="btn btn-ghost btn-sm"
            onClick={async () => {
              await api('/api/logout', { method: 'POST' }).catch(() => {});
              onLogout();
            }}
          >
            Выйти
          </button>
        </div>
      </header>
      {children}
    </div>
  );
}
