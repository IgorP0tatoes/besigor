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

    api.post<{ Params: { id: string }; Body: Partial<Probe> }>('/api/servers/:id/probes', async (req, reply) => {
      if (!db.prepare('SELECT 1 FROM servers WHERE id = ?').get(req.params.id)) return reply.code(404).send({ error: 'not found' });
      if (probes.list(req.params.id).length >= 50) return reply.code(400).send({ error: 'Не больше 50 проверок на сервер' });
      const p = validateProbe(req.body ?? {});
      if (typeof p === 'string') return reply.code(400).send({ error: p });
      const id = probes.create(req.params.id, p);
      agents.pushConfig(req.params.id);
      return view(probes.get(id)!);
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
