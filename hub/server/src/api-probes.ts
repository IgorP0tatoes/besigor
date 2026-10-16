import type { FastifyInstance } from 'fastify';
import type { AgentHub } from './agents.js';
import { requireSession } from './auth.js';
import type { DB } from './db.js';
import { validateProbe, type Probe, type ProbeStore } from './probes.js';
import { RANGES, type RangeKey } from './stats.js';

export function registerProbeApi(app: FastifyInstance, db: DB, probes: ProbeStore, agents: AgentHub) {
  app.register(async (api) => {
    api.addHook('preHandler', (req, reply) => requireSession(db, req, reply));

    const view = (p: Probe) => {
      const st = probes.stateOf(p.id);
      return { ...p, last: st.last ?? null, fails: st.fails };
    };

    api.get<{ Params: { id: string } }>('/api/servers/:id/probes', async (req) => probes.list(req.params.id).map(view));

    // Several targets at once: one probe per target, all validated before any is saved.
    // For TCP a target may carry its own port ("host:443").
    api.post<{ Params: { id: string }; Body: Partial<Probe> & { targets?: string[] } }>('/api/servers/:id/probes', async (req, reply) => {
      if (!db.prepare('SELECT 1 FROM servers WHERE id = ?').get(req.params.id)) return reply.code(404).send({ error: 'not found' });
      const body = req.body ?? {};
      const targets = (body.targets ?? [body.target ?? '']).map((t) => String(t).trim()).filter(Boolean);
      if (!targets.length) return reply.code(400).send({ error: 'Укажите хотя бы одну цель' });
      if (probes.list(req.params.id).length + targets.length > 50) return reply.code(400).send({ error: 'Не больше 50 проверок на сервер' });
      const valid: Omit<Probe, 'id' | 'serverId'>[] = [];
      for (const t of targets) {
        const m = body.type === 'tcp' ? /^(.+):(\d{1,5})$/.exec(t) : null;
        const p = validateProbe({
          ...body,
          target: m ? m[1] : t,
          port: m ? Number(m[2]) : body.port,
          name: targets.length > 1 ? '' : body.name,
        });
        if (typeof p === 'string') return reply.code(400).send({ error: `${t}: ${p}` });
        valid.push(p);
      }
      const ids = db.transaction(() => valid.map((p) => probes.create(req.params.id, p)))();
      agents.pushConfig(req.params.id);
      return ids.map((id) => view(probes.get(id)!));
    });

    api.put<{ Params: { pid: string }; Body: Partial<Probe> }>('/api/probes/:pid', async (req, reply) => {
      const cur = probes.get(req.params.pid);
      if (!cur) return reply.code(404).send({ error: 'not found' });
      const p = validateProbe(req.body ?? {});
      if (typeof p === 'string') return reply.code(400).send({ error: p });
      probes.update(cur.id, p);
      agents.pushConfig(cur.serverId);
      return view(probes.get(cur.id)!);
    });

    api.delete<{ Params: { pid: string } }>('/api/probes/:pid', async (req, reply) => {
      const cur = probes.get(req.params.pid);
      if (!cur) return reply.code(404).send({ error: 'not found' });
      probes.remove(cur.id);
      agents.pushConfig(cur.serverId);
      return { ok: true };
    });

    api.get<{ Params: { pid: string }; Querystring: { range?: string } }>('/api/probes/:pid/stats', async (req, reply) => {
      const range = (req.query.range ?? '24h') as RangeKey;
      if (!(range in RANGES) || !probes.get(req.params.pid)) return reply.code(400).send({ error: 'bad request' });
      return probes.series(req.params.pid, RANGES[range].seconds);
    });
  });
}
