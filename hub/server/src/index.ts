import { existsSync } from 'node:fs';
import cookie from '@fastify/cookie';
import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { AgentHub } from './agents.js';
import { AlertEngine } from './alerts.js';
import { registerAlertApi } from './api-alerts.js';
import { registerProbeApi } from './api-probes.js';
import { registerApi } from './api.js';
import { registerAuth } from './auth.js';
import { startBackups } from './backup.js';
import { config } from './config.js';
import { openDb } from './db.js';
import { ProbeStore } from './probes.js';
import { prune, rollup } from './stats.js';
import { TelegramBot } from './telegram.js';

const app = Fastify({
  logger: { level: process.env.LOG_LEVEL ?? 'info' },
  bodyLimit: 1024 * 1024,
  disableRequestLogging: true,
});

const db = openDb(config.dbPath);
const agents = new AgentHub(db, app.log);
const probes = new ProbeStore(db);
agents.probes = probes;
const bot = new TelegramBot(db, agents, app.log);
const alerts = new AlertEngine(db, agents, bot, app.log);
bot.alerts = alerts;
alerts.probes = probes;

await app.register(cookie, { secret: config.sessionSecret });

app.addHook('onSend', async (_req, reply) => {
  reply.header('X-Content-Type-Options', 'nosniff');
  reply.header('Referrer-Policy', 'same-origin');
  reply.header('X-Frame-Options', 'DENY');
});

app.get('/api/health', async () => ({ ok: true, version: config.version }));
registerAuth(app, db);
registerApi(app, db, agents, alerts, probes);
registerAlertApi(app, db, alerts, bot);
registerProbeApi(app, db, probes, agents);

if (existsSync(config.webDir)) {
  await app.register(fastifyStatic, { root: config.webDir, wildcard: false, maxAge: '1h' });
  // SPA: unknown non-API paths render the app shell
  app.setNotFoundHandler((req, reply) => {
    if (req.url.startsWith('/api/')) return reply.code(404).send({ error: 'not found' });
    return reply.header('Cache-Control', 'no-cache').sendFile('index.html');
  });
} else {
  app.log.warn({ dir: config.webDir }, 'web build not found, serving API only');
}

agents.attach(app.server);
alerts.start();
void bot.start();

const jobs = [
  setInterval(() => {
    rollup(db);
    probes.rollup();
  }, 60_000),
  setInterval(() => {
    prune(db);
    probes.prune();
  }, 3600_000),
];
startBackups(db, config.dataDir, app.log);

await app.listen({ port: config.port, host: config.host });
app.log.info(`besigor hub ${config.version} listening on :${config.port}`);

for (const sig of ['SIGINT', 'SIGTERM'] as const) {
  process.on(sig, async () => {
    jobs.forEach(clearInterval);
    alerts.stop();
    bot.stop();
    agents.close();
    await app.close();
    db.close();
    process.exit(0);
  });
}
