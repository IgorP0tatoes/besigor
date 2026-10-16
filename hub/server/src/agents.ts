import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import type { FastifyBaseLogger } from 'fastify';
import { WebSocketServer, type WebSocket } from 'ws';
import { sha256 } from './auth.js';
import type { DB } from './db.js';
import { bus } from './live.js';
import { clientIpFrom } from './net.js';
import type { ProbeResult, ProbeStore } from './probes.js';
import { insertMinutes } from './stats.js';
import type { Envelope, HostInfo, Sample } from './types.js';

const PING_EVERY = 20_000;
const PONG_TIMEOUT = 45_000;
const MAX_BATCH = 120;

interface AgentConn {
  ws: WebSocket;
  serverId: string;
  ip: string;
  lastPong: number;
  connectedAt: number;
}

export interface AgentState {
  online: boolean;
  ip?: string;
  connectedAt?: number;
  live?: Sample;
}

/** Tracks connected agents and the latest live sample of every server. */
interface LogRequest {
  serverId: string;
  onData: (lines: string[]) => void;
  onEnd: (error?: string) => void;
}

export class AgentHub {
  private conns = new Map<string, AgentConn>();
  private logReqs = new Map<string, LogRequest>();
  private latest = new Map<string, Sample>();
  private wss = new WebSocketServer({ noServer: true, maxPayload: 4 * 1024 * 1024 });
  private timer?: NodeJS.Timeout;
  probes?: ProbeStore;

  constructor(
    private db: DB,
    private log: FastifyBaseLogger,
  ) {}

  attach(server: Server, path = '/api/agent') {
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url ?? '/', 'http://x');
      if (url.pathname !== path) return; // not ours; Fastify ignores upgrades
      this.handleUpgrade(req, socket, head);
    });
    this.timer = setInterval(() => this.heartbeat(), PING_EVERY);
  }

  close() {
    clearInterval(this.timer);
    for (const c of this.conns.values()) c.ws.close(1001, 'hub stopping');
    this.wss.close();
  }

  state(serverId: string): AgentState {
    const c = this.conns.get(serverId);
    return { online: !!c, ip: c?.ip, connectedAt: c?.connectedAt, live: this.latest.get(serverId) };
  }

  isOnline(serverId: string) {
    return this.conns.has(serverId);
  }

  /** Sends the current probe list to a connected agent. */
  pushConfig(serverId: string) {
    const conn = this.conns.get(serverId);
    if (conn && this.probes) conn.ws.send(JSON.stringify({ t: 'config', d: { interval: 10, probes: this.probes.agentConfig(serverId) } }));
  }

  /** Drops the agent of a deleted server or a rotated token. */
  kick(serverId: string) {
    this.conns.get(serverId)?.ws.close(4001, 'token revoked');
  }

  forget(serverId: string) {
    this.kick(serverId);
    this.latest.delete(serverId);
  }

  /**
   * Asks the agent to stream a container log. Returns a stop function, or
   * null when the server is offline.
   */
  requestLogs(serverId: string, container: string, tail: number, follow: boolean, onData: LogRequest['onData'], onEnd: LogRequest['onEnd']) {
    const conn = this.conns.get(serverId);
    if (!conn) return null;
    const req = randomUUID();
    this.logReqs.set(req, { serverId, onData, onEnd });
    conn.ws.send(JSON.stringify({ t: 'logs', d: { req, container, tail, follow } }));
    return () => {
      if (!this.logReqs.delete(req)) return;
      this.conns.get(serverId)?.ws.send(JSON.stringify({ t: 'logs.stop', d: { req } }));
    };
  }

  private endLogs(serverId: string, error: string) {
    for (const [req, r] of this.logReqs) {
      if (r.serverId !== serverId) continue;
      this.logReqs.delete(req);
      r.onEnd(error);
    }
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
    const auth = req.headers.authorization ?? '';
    const token = auth.startsWith('Bearer ') ? auth.slice(7).trim() : '';
    const row = token
      ? (this.db.prepare('SELECT id, name FROM servers WHERE token_hash = ?').get(sha256(token)) as { id: string; name: string } | undefined)
      : undefined;
    const ip = clientIpFrom(req.socket.remoteAddress, req.headers);
    if (!row) {
      this.log.warn({ ip }, 'agent rejected: unknown token');
      socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.onConnect(ws, row.id, row.name, ip));
  }

  private onConnect(ws: WebSocket, serverId: string, name: string, ip: string) {
    const prev = this.conns.get(serverId);
    if (prev) {
      // a newer connection wins (agent restarted, network flapped)
      this.conns.delete(serverId);
      prev.ws.close(4009, 'replaced by a newer connection');
    }
    const conn: AgentConn = { ws, serverId, ip, lastPong: Date.now(), connectedAt: Date.now() };
    this.conns.set(serverId, conn);
    this.touch(serverId);
    this.log.info({ server: name, ip }, 'agent connected');
    bus.publish({ type: 'status', serverId, online: true, at: Date.now() });

    ws.on('pong', () => (conn.lastPong = Date.now()));
    ws.on('message', (data, isBinary) => {
      if (isBinary) return;
      try {
        this.onMessage(conn, JSON.parse(data.toString()) as Envelope);
      } catch (err) {
        this.log.warn({ server: name, err }, 'bad agent message');
      }
    });
    ws.on('close', () => {
      if (this.conns.get(serverId) !== conn) return; // already replaced
      this.conns.delete(serverId);
      this.touch(serverId);
      this.endLogs(serverId, 'агент отключился');
      this.log.info({ server: name }, 'agent disconnected');
      bus.publish({ type: 'status', serverId, online: false, at: Date.now() });
    });
    ws.on('error', (err) => this.log.warn({ server: name, err: err.message }, 'agent socket error'));
  }

  private onMessage(conn: AgentConn, env: Envelope) {
    const { serverId } = conn;
    switch (env.t) {
      case 'hello': {
        const host = env.d as HostInfo;
        this.db.prepare('UPDATE servers SET host_info = ? WHERE id = ?').run(JSON.stringify(host), serverId);
        bus.publish({ type: 'hello', serverId, host });
        this.pushConfig(serverId);
        break;
      }
      case 'live': {
        const sample = env.d as Sample;
        this.latest.set(serverId, sample);
        this.touch(serverId);
        bus.publish({ type: 'live', serverId, sample });
        break;
      }
      case 'probe': {
        const results = (Array.isArray(env.d) ? env.d : []).slice(-2000) as ProbeResult[];
        this.probes?.ingest(serverId, results);
        if (results.length) bus.publish({ type: 'probe', serverId });
        break;
      }
      case 'logs.data': {
        const d = env.d as { req?: string; lines?: string[] };
        const r = d?.req ? this.logReqs.get(d.req) : undefined;
        if (r?.serverId === serverId && Array.isArray(d.lines)) r.onData(d.lines);
        break;
      }
      case 'logs.end': {
        const d = env.d as { req?: string; error?: string };
        const r = d?.req ? this.logReqs.get(d.req) : undefined;
        if (r?.serverId === serverId) {
          this.logReqs.delete(d.req!);
          r.onEnd(d.error);
        }
        break;
      }
      case 'minute': {
        const recs = (Array.isArray(env.d) ? env.d : []).slice(-MAX_BATCH) as Sample[];
        const upTo = insertMinutes(this.db, serverId, recs);
        if (upTo) conn.ws.send(JSON.stringify({ t: 'ack', d: { upTo } }));
        break;
      }
    }
  }

  private touch(serverId: string) {
    this.db.prepare('UPDATE servers SET last_seen = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), serverId);
  }

  private heartbeat() {
    const now = Date.now();
    for (const c of this.conns.values()) {
      if (now - c.lastPong > PONG_TIMEOUT) {
        this.log.warn({ serverId: c.serverId }, 'agent stopped answering pings');
        c.ws.terminate();
        continue;
      }
      c.ws.ping();
    }
  }
}
