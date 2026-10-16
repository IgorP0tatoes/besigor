import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { config } from './config.js';
import type { DB } from './db.js';
import { clientIp, isHttps } from './net.js';

const COOKIE = 'besigor_session';
const SESSION_TTL = 30 * 86400;
const MAX_FAILS = 5;
const LOCK_SECONDS = 15 * 60;

export const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');

function safeEqual(a: string, b: string) {
  // hash first so lengths always match and nothing leaks through timing
  return timingSafeEqual(Buffer.from(sha256(a), 'hex'), Buffer.from(sha256(b), 'hex'));
}

// Failures are counted per IP within a window; a global counter is the
// backstop against attackers rotating addresses.
const fails = new Map<string, { count: number; since: number; until: number }>();
const GLOBAL_KEY = '*';
const GLOBAL_MAX = 30;

function entry(key: string, now: number) {
  let f = fails.get(key);
  if (!f || (f.until <= now && now - f.since > LOCK_SECONDS)) {
    f = { count: 0, since: now, until: 0 };
    fails.set(key, f);
  }
  return f;
}

function locked(ip: string, now: number) {
  return Math.max(0, entry(GLOBAL_KEY, now).until - now, entry(ip, now).until - now);
}

function recordFail(ip: string, now: number) {
  for (const [key, max] of [[ip, MAX_FAILS], [GLOBAL_KEY, GLOBAL_MAX]] as const) {
    const f = entry(key, now);
    if (++f.count >= max) f.until = now + LOCK_SECONDS;
  }
  if (fails.size > 10_000) fails.clear(); // bound memory under a flood
}

export function sessionValid(db: DB, req: FastifyRequest): boolean {
  const raw = req.cookies[COOKIE];
  if (!raw) return false;
  const unsigned = req.unsignCookie(raw);
  if (!unsigned.valid || !unsigned.value) return false;
  const row = db.prepare('SELECT expires_at FROM sessions WHERE id_hash = ?').get(sha256(unsigned.value)) as
    | { expires_at: number }
    | undefined;
  return !!row && row.expires_at > Date.now() / 1000;
}

export async function requireSession(db: DB, req: FastifyRequest, reply: FastifyReply) {
  if (!sessionValid(db, req)) {
    await reply.code(401).send({ error: 'unauthorized' });
  }
}

export function registerAuth(app: FastifyInstance, db: DB) {
  app.post<{ Body: { username?: string; password?: string } }>('/api/login', async (req, reply) => {
    const now = Math.floor(Date.now() / 1000);
    const ip = clientIp(req);
    const wait = locked(ip, now);
    if (wait) {
      return reply.code(429).send({ error: 'locked', retryAfter: wait });
    }
    const { username = '', password = '' } = req.body ?? {};
    const ok = safeEqual(username, config.adminUser) && safeEqual(password, config.adminPassword);
    if (!ok) {
      recordFail(ip, now);
      req.log.warn({ ip }, 'failed login');
      return reply.code(401).send({ error: 'invalid' });
    }
    fails.delete(ip);
    const id = randomBytes(32).toString('base64url');
    db.prepare('INSERT INTO sessions (id_hash, created_at, expires_at) VALUES (?, ?, ?)').run(sha256(id), now, now + SESSION_TTL);
    reply.setCookie(COOKIE, id, {
      path: '/',
      httpOnly: true,
      sameSite: 'strict',
      secure: isHttps(req),
      signed: true,
      maxAge: SESSION_TTL,
    });
    return { ok: true };
  });

  app.post('/api/logout', async (req, reply) => {
    const raw = req.cookies[COOKIE];
    const unsigned = raw ? req.unsignCookie(raw) : null;
    if (unsigned?.valid && unsigned.value) {
      db.prepare('DELETE FROM sessions WHERE id_hash = ?').run(sha256(unsigned.value));
    }
    reply.clearCookie(COOKIE, { path: '/' });
    return { ok: true };
  });

  app.get('/api/me', async (req, reply) => {
    if (!sessionValid(db, req)) return reply.code(401).send({ error: 'unauthorized' });
    return { user: config.adminUser };
  });
}
