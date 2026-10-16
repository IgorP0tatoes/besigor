import { randomBytes, randomUUID } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import type { AgentHub } from './agents.js';
import type { AlertEngine } from './alerts.js';
import type { ProbeStore } from './probes.js';
import { setSettings as setTraffic, summary as trafficSummary, TRAFFIC_MODES, type TrafficMode } from './traffic.js';
import { requireSession, sha256 } from './auth.js';
import { config } from './config.js';
import type { DB } from './db.js';
import { bus, type LiveEvent } from './live.js';
import { querySeries, RANGES, type RangeKey } from './stats.js';
import { installCommand, installScript } from './install.js';
import type { HostInfo } from './types.js';

interface ServerRow {
  id: string;
  name: string;
  created_at: number;
  host_info: string | null;
  last_seen: number | null;
  sort: number;
}

const newToken = () => 'bsg_' + randomBytes(24).toString('base64url');

function hubUrl(req: { headers: Record<string, unknown>; protocol: string }) {
  if (config.appUrl) return config.appUrl;
  const host = String(req.headers['x-forwarded-host'] ?? req.headers.host ?? 'localhost');
  const proto = String(req.headers['x-forwarded-proto'] ?? req.protocol).split(',')[0];
  return `${proto}://${host}`;
}

export function agentCompose(url: string, token: string) {
  return `services:
  besigor-agent:
    image: ${config.agentImage}:${config.version}
    container_name: besigor-agent
    restart: unless-stopped
    network_mode: host
    pid: host
    cap_add: [NET_RAW]
    security_opt: [no-new-privileges:true]
    environment:
      HUB_URL: ${url}
      TOKEN: ${token}
    volumes:
      - /:/host:ro,rslave
      - /var/run/docker.sock:/var/run/docker.sock:ro
    logging:
      driver: json-file
      options: { max-size: "5m", max-file: "2" }
`;
}

/** Semver-ish comparison; dev builds are never "outdated". */
export function isOutdated(agent: string | undefined, hub: string) {
  if (!agent || !/^\d+\.\d+\.\d+/.test(agent)) return false;
  const a = agent.split(/[.-]/).map(Number);
  const h = hub.split(/[.-]/).map(Number);
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (h[i] ?? 0)) return (a[i] ?? 0) < (h[i] ?? 0);
  }
  return false;
}

export function registerApi(app: FastifyInstance, db: DB, agents: AgentHub, alerts: AlertEngine, probes: ProbeStore) {
  // public: the installer holds no secrets, the token is passed as an argument
  app.get('/install.sh', async (req, reply) => {
    reply.header('Content-Type', 'text/x-shellscript; charset=utf-8').header('Cache-Control', 'no-cache');
    return installScript(hubUrl(req), config.agentImage, config.version);
  });

  app.register(async (api) => {
    api.addHook('preHandler', (req, reply) => requireSession(db, req, reply));

    const view = (row: ServerRow) => {
      const host = row.host_info ? (JSON.parse(row.host_info) as HostInfo) : null;
      const st = agents.state(row.id);
      return {
        id: row.id,
        name: row.name,
        createdAt: row.created_at,
        lastSeen: row.last_seen,
        online: st.online,
        ip: st.ip ?? null,
        connectedAt: st.connectedAt ?? null,
        host,
        live: st.live ?? null,
        outdated: isOutdated(host?.version, config.version),
        traffic: (() => {
          const t = trafficSummary(db, row.id);
          return t ? { used: t.used, limit: t.limit } : null;
        })(),
      };
    };

    api.get('/api/info', async () => ({ version: config.version, agentImage: config.agentImage }));

    api.get('/api/servers', async () => {
      const rows = db.prepare('SELECT * FROM servers ORDER BY sort, name').all() as ServerRow[];
      return rows.map(view);
    });

    api.get<{ Params: { id: string } }>('/api/servers/:id', async (req, reply) => {
      const row = db.prepare('SELECT * FROM servers WHERE id = ?').get(req.params.id) as ServerRow | undefined;
      if (!row) return reply.code(404).send({ error: 'not found' });
      return view(row);
    });

    api.post<{ Body: { name?: string } }>('/api/servers', async (req, reply) => {
      const name = (req.body?.name ?? '').trim().slice(0, 64);
      if (!name) return reply.code(400).send({ error: 'Укажите имя сервера' });
      const id = randomUUID();
      const token = newToken();
      const sort = (db.prepare('SELECT COALESCE(MAX(sort), 0) + 1 AS s FROM servers').get() as { s: number }).s;
      db.prepare('INSERT INTO servers (id, name, token_hash, created_at, sort) VALUES (?, ?, ?, ?, ?)').run(
        id, name, sha256(token), Math.floor(Date.now() / 1000), sort,
      );
      bus.publish({ type: 'servers' });
      const url = hubUrl(req);
      return { id, name, token, install: installCommand(url, token), compose: agentCompose(url, token), hubUrl: url };
    });

    api.patch<{ Params: { id: string }; Body: { name?: string } }>('/api/servers/:id', async (req, reply) => {
      const name = (req.body?.name ?? '').trim().slice(0, 64);
      if (!name) return reply.code(400).send({ error: 'Укажите имя сервера' });
      const res = db.prepare('UPDATE servers SET name = ? WHERE id = ?').run(name, req.params.id);
      if (!res.changes) return reply.code(404).send({ error: 'not found' });
      bus.publish({ type: 'servers' });
      return { ok: true };
    });

    api.post<{ Params: { id: string } }>('/api/servers/:id/token', async (req, reply) => {
      const token = newToken();
      const res = db.prepare('UPDATE servers SET token_hash = ? WHERE id = ?').run(sha256(token), req.params.id);
      if (!res.changes) return reply.code(404).send({ error: 'not found' });
      agents.kick(req.params.id);
      const url = hubUrl(req);
      return { token, install: installCommand(url, token), compose: agentCompose(url, token), hubUrl: url };
    });

    api.delete<{ Params: { id: string } }>('/api/servers/:id', async (req, reply) => {
      const id = req.params.id;
      const res = db.transaction(() => {
        for (const t of ['stats_1m', 'stats_15m', 'stats_1h', 'traffic_daily']) db.prepare(`DELETE FROM ${t} WHERE server_id = ?`).run(id);
        return db.prepare('DELETE FROM servers WHERE id = ?').run(id);
      })();
      if (!res.changes) return reply.code(404).send({ error: 'not found' });
      agents.forget(id);
      alerts.forget(id);
      probes.removeServer(id);
      bus.publish({ type: 'servers' });
      return { ok: true };
    });

    api.get<{ Params: { id: string } }>('/api/servers/:id/traffic', async (req, reply) => {
      const t = trafficSummary(db, req.params.id);
      if (!t) return reply.code(404).send({ error: 'not found' });
      return { ...t, modes: TRAFFIC_MODES };
    });

    api.put<{ Params: { id: string }; Body: { limit?: number | null; resetDay?: number; mode?: TrafficMode } }>('/api/servers/:id/traffic', async (req, reply) => {
      if (!setTraffic(db, req.params.id, req.body ?? {})) return reply.code(404).send({ error: 'not found' });
      return trafficSummary(db, req.params.id);
    });

    api.get<{ Params: { id: string }; Querystring: { range?: string } }>('/api/servers/:id/stats', async (req, reply) => {
      const range = (req.query.range ?? '1h') as RangeKey;
      if (!(range in RANGES)) return reply.code(400).send({ error: 'bad range' });
      return querySeries(db, req.params.id, range);
    });

    // Container log over SSE: last lines, then (with follow) new ones live.
    api.get<{ Params: { id: string; name: string }; Querystring: { follow?: string; tail?: string } }>(
      '/api/servers/:id/containers/:name/logs',
      (req, reply) => {
        const tail = Math.min(1000, Math.max(10, Number(req.query.tail) || 200));
        const write = (event: string, data: unknown) => reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
        reply.raw.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache, no-transform',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
        });
        reply.hijack();
        let done = false;
        const finish = (error?: string) => {
          if (done) return;
          done = true;
          write('end', { error: error ?? null });
          reply.raw.end();
        };
        const stop = agents.requestLogs(req.params.id, req.params.name, tail, req.query.follow === '1', (lines) => write('lines', lines), finish);
        if (!stop) return finish('сервер не в сети');
        const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
        req.raw.on('close', () => {
          clearInterval(ping);
          done = true;
          stop();
        });
      },
    );

    // Server-sent events: live samples and status changes for the panel.
    api.get('/api/events', (req, reply) => {
      reply.raw.writeHead(200, {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache, no-transform',
        Connection: 'keep-alive',
        'X-Accel-Buffering': 'no', // nginx: do not buffer the stream
      });
      const send = (e: LiveEvent) => reply.raw.write(`data: ${JSON.stringify(e)}\n\n`);
      const off = bus.subscribe(send);
      const ping = setInterval(() => reply.raw.write(': ping\n\n'), 25_000);
      req.raw.on('close', () => {
        off();
        clearInterval(ping);
      });
      reply.hijack();
    });
  });
}
