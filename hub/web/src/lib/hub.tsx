import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api } from './api';
import type { LiveEvent, Sample, Server } from './types';

const HISTORY = 36; // live samples kept per server for sparklines (6 minutes)

interface HubState {
  servers: Server[];
  loaded: boolean;
  history: Record<string, Sample[]>;
  reload: () => Promise<void>;
}

const HubContext = createContext<HubState | null>(null);

export function HubProvider({ children }: { children: ReactNode }) {
  const [servers, setServers] = useState<Server[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [history, setHistory] = useState<Record<string, Sample[]>>({});
  const reloadTimer = useRef<number>(0);

  const reload = useCallback(async () => {
    const list = await api<Server[]>('/api/servers');
    setServers(list);
    setLoaded(true);
  }, []);

  useEffect(() => {
    reload().catch(() => setLoaded(true));
    const es = new EventSource('/api/events');
    es.onmessage = (msg) => {
      const e = JSON.parse(msg.data) as LiveEvent;
      if (e.type === 'servers') {
        window.clearTimeout(reloadTimer.current);
        reloadTimer.current = window.setTimeout(() => void reload(), 150);
        return;
      }
      setServers((list) =>
        list.map((s) => {
          if (s.id !== e.serverId) return s;
          if (e.type === 'live') return { ...s, live: e.sample, online: true, lastSeen: e.sample.ts };
          if (e.type === 'status') return { ...s, online: e.online, lastSeen: Math.floor(e.at / 1000) };
          return { ...s, host: e.host };
        }),
      );
      if (e.type === 'live') {
        setHistory((h) => ({ ...h, [e.serverId]: [...(h[e.serverId] ?? []), e.sample].slice(-HISTORY) }));
      }
    };
    // after a reconnect, refresh everything we might have missed
    es.onopen = () => void reload().catch(() => {});
    return () => es.close();
  }, [reload]);

  const value = useMemo(() => ({ servers, loaded, history, reload }), [servers, loaded, history, reload]);
  return <HubContext.Provider value={value}>{children}</HubContext.Provider>;
}

export function useHub() {
  const ctx = useContext(HubContext);
  if (!ctx) throw new Error('useHub outside HubProvider');
  return ctx;
}
