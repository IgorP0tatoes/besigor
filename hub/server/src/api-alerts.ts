import type { FastifyInstance } from 'fastify';
import { ALERT_DEFS, ALERT_TYPES, CATEGORIES, getAlerts, mutedUntil, setAlert, setMute, type AlertEngine, type AlertType, type Category } from './alerts.js';
import { requireSession } from './auth.js';
import type { DB } from './db.js';
import { listRecipients, saveRecipient, type TelegramBot } from './telegram.js';

interface AlertBody {
  enabled?: boolean;
  value?: number;
  minutes?: number;
}

interface RecipientBody {
  name?: string;
  chatId?: string;
  threadId?: number | null;
  categories?: Category[];
}

function exists(db: DB, id: string) {
  return !!db.prepare('SELECT 1 FROM servers WHERE id = ?').get(id);
}

function recipientInput(b: RecipientBody | undefined) {
  const chatId = String(b?.chatId ?? '').trim();
  if (!/^-?\d+$/.test(chatId) && !/^@\w{4,}$/.test(chatId)) return null;
  const thread = b?.threadId == null || String(b.threadId) === '' ? null : Number(b.threadId);
  if (thread !== null && !Number.isInteger(thread)) return null;
  return {
    name: (b?.name ?? '').trim() || chatId,
    chatId,
    threadId: thread,
    categories: (b?.categories ?? []).filter((c): c is Category => c in CATEGORIES),
  };
}

export function registerAlertApi(app: FastifyInstance, db: DB, engine: AlertEngine, bot: TelegramBot) {
  app.register(async (api) => {
    api.addHook('preHandler', (req, reply) => requireSession(db, req, reply));

    api.get('/api/alerts/defs', async () => ({ defs: ALERT_DEFS, categories: CATEGORIES }));

    api.get('/api/alerts/active', async () => engine.active());

    api.get<{ Params: { id: string } }>('/api/servers/:id/alerts', async (req, reply) => {
      if (!exists(db, req.params.id)) return reply.code(404).send({ error: 'not found' });
      return { alerts: getAlerts(db, req.params.id), mutedUntil: mutedUntil(db, req.params.id) ?? false };
    });

    api.put<{ Params: { id: string; type: string }; Body: AlertBody }>('/api/servers/:id/alerts/:type', async (req, reply) => {
      const type = req.params.type as AlertType;
      if (!ALERT_TYPES.includes(type)) return reply.code(400).send({ error: 'unknown alert' });
      if (!exists(db, req.params.id)) return reply.code(404).send({ error: 'not found' });
      const cur = getAlerts(db, req.params.id).find((a) => a.type === type)!;
      setAlert(db, req.params.id, { ...cur, ...req.body, type });
      return getAlerts(db, req.params.id).find((a) => a.type === type);
    });

    // "Применить ко всем": copy one server's setting of a type to every server
    api.post<{ Body: AlertBody & { type?: string } }>('/api/alerts/apply-all', async (req, reply) => {
      const type = req.body?.type as AlertType;
      if (!ALERT_TYPES.includes(type)) return reply.code(400).send({ error: 'unknown alert' });
      const ids = (db.prepare('SELECT id FROM servers').all() as { id: string }[]).map((r) => r.id);
      const d = ALERT_DEFS[type].defaults;
      db.transaction(() => {
        for (const id of ids) setAlert(db, id, { type, enabled: req.body.enabled ?? d.enabled, value: req.body.value ?? d.value, minutes: req.body.minutes ?? d.minutes });
      })();
      return { ok: true, servers: ids.length };
    });

    api.post<{ Params: { id: string }; Body: { hours?: number | null } }>('/api/servers/:id/mute', async (req, reply) => {
      if (!exists(db, req.params.id)) return reply.code(404).send({ error: 'not found' });
      const h = req.body?.hours;
      setMute(db, req.params.id, h === null ? null : Math.max(0, Number(h) || 0));
      return { mutedUntil: mutedUntil(db, req.params.id) ?? false };
    });

    api.get('/api/telegram', async () => ({
      configured: bot.configured,
      username: bot.botUsername,
      recipients: listRecipients(db),
      seen: bot.seen,
      categories: CATEGORIES,
    }));

    api.put<{ Body: { token?: string } }>('/api/telegram/token', async (req, reply) => {
      const token = (req.body?.token ?? '').trim();
      if (token && !/^\d+:[\w-]{30,}$/.test(token)) return reply.code(400).send({ error: 'Это не похоже на токен бота от @BotFather' });
      const ok = await bot.setToken(token);
      if (token && !ok) return reply.code(400).send({ error: 'Telegram не принял токен' });
      return { configured: bot.configured, username: bot.botUsername };
    });

    api.post<{ Body: RecipientBody }>('/api/telegram/recipients', async (req, reply) => {
      const r = recipientInput(req.body);
      if (!r) return reply.code(400).send({ error: 'Проверьте chat_id и номер треда' });
      return { id: saveRecipient(db, r) };
    });

    api.put<{ Params: { id: string }; Body: RecipientBody }>('/api/telegram/recipients/:id', async (req, reply) => {
      const r = recipientInput(req.body);
      if (!r) return reply.code(400).send({ error: 'Проверьте chat_id и номер треда' });
      saveRecipient(db, { ...r, id: req.params.id });
      return { ok: true };
    });

    api.delete<{ Params: { id: string } }>('/api/telegram/recipients/:id', async (req) => {
      db.prepare('DELETE FROM recipients WHERE id = ?').run(req.params.id);
      return { ok: true };
    });

    api.post<{ Params: { id: string } }>('/api/telegram/recipients/:id/test', async (req, reply) => {
      const r = listRecipients(db).find((x) => x.id === req.params.id);
      if (!r) return reply.code(404).send({ error: 'not found' });
      if (!bot.configured) return reply.code(400).send({ error: 'Сначала укажите токен бота' });
      try {
        await bot.send(r.chatId, r.threadId, `✅ <b>besigor</b> на связи. Сюда будут приходить: ${r.categories.map((c) => CATEGORIES[c].toLowerCase()).join(', ') || 'пока ничего — выберите категории'}.`);
        return { ok: true };
      } catch (err) {
        return reply.code(400).send({ error: (err as Error).message });
      }
    });
  });
}
