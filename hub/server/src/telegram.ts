import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import type { AgentHub } from './agents.js';
import { ALERT_DEFS, CATEGORIES, mutedUntil, setMute, worstDiskPct, type AlertEngine, type Category, type Notifier } from './alerts.js';
import { getSetting, setSetting, type DB } from './db.js';
import { esc, fmtBits, fmtBytes, fmtDuration, fmtNum } from './text.js';
import { summary as trafficSummary } from './traffic.js';
import type { HostInfo } from './types.js';

export interface Recipient {
  id: string;
  name: string;
  chatId: string;
  threadId: number | null;
  categories: Category[];
}

interface TgChat {
  id: number;
  title?: string;
  username?: string;
  first_name?: string;
  type: string;
}

interface TgMessage {
  message_id: number;
  message_thread_id?: number;
  is_topic_message?: boolean;
  chat: TgChat;
  text?: string;
}

interface TgUpdate {
  update_id: number;
  message?: TgMessage;
  callback_query?: { id: string; data?: string; message?: TgMessage };
}

type Button = { text: string; callback_data: string };
type Keyboard = Button[][];

export interface SeenChat {
  chatId: string;
  threadId: number | null;
  title: string;
  at: number;
}

const API = 'https://api.telegram.org';

export function listRecipients(db: DB): Recipient[] {
  return (db.prepare('SELECT * FROM recipients ORDER BY name').all() as {
    id: string;
    name: string;
    chat_id: string;
    thread_id: number | null;
    categories: string;
  }[]).map((r) => ({ id: r.id, name: r.name, chatId: r.chat_id, threadId: r.thread_id, categories: JSON.parse(r.categories) as Category[] }));
}

export function saveRecipient(db: DB, r: Omit<Recipient, 'id'> & { id?: string }) {
  const id = r.id ?? randomUUID();
  const categories = r.categories.filter((c) => c in CATEGORIES);
  db.prepare(
    `INSERT INTO recipients (id, name, chat_id, thread_id, categories) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET name = excluded.name, chat_id = excluded.chat_id, thread_id = excluded.thread_id, categories = excluded.categories`,
  ).run(id, r.name.slice(0, 64), String(r.chatId).trim(), r.threadId ?? null, JSON.stringify(categories));
  return id;
}

/** Telegram bot: sends alerts and answers the button menu (long polling). */
export class TelegramBot implements Notifier {
  private token = '';
  private username = '';
  private offset = 0;
  private abort?: AbortController;
  private queue: Promise<unknown> = Promise.resolve();
  readonly seen: SeenChat[] = [];
  alerts?: AlertEngine;

  constructor(
    private db: DB,
    private agents: AgentHub,
    private log: FastifyBaseLogger,
  ) {}

  get configured() {
    return !!this.token;
  }

  get botUsername() {
    return this.username;
  }

  async start() {
    this.stop();
    this.token = getSetting<string>(this.db, 'telegram.token', '') || process.env.TELEGRAM_BOT_TOKEN || '';
    if (!this.token) return;
    try {
      const me = await this.call<{ username: string }>('getMe', {});
      this.username = me.username;
      await this.call('setMyCommands', {
        commands: [
          { command: 'menu', description: 'Главное меню' },
          { command: 'status', description: 'Общий статус' },
          { command: 'servers', description: 'Список серверов' },
          { command: 'alerts', description: 'Активные алерты' },
        ],
      });
      this.log.info({ bot: this.username }, 'telegram bot started');
      void this.nameRecipients();
    } catch (err) {
      this.log.error({ err: (err as Error).message }, 'telegram bot token rejected');
      this.token = '';
      return;
    }
    void this.poll();
  }

  stop() {
    this.abort?.abort();
    this.abort = undefined;
  }

  /** Human name of a chat: group title or the user's name; null if unknown. */
  async chatTitle(chatId: string): Promise<string | null> {
    if (!this.token) return null;
    try {
      const c = await this.call<{ title?: string; first_name?: string; last_name?: string; username?: string }>('getChat', { chat_id: chatId });
      return c.title ?? ([c.first_name, c.last_name].filter(Boolean).join(' ') || (c.username ? `@${c.username}` : null));
    } catch {
      return this.seen.find((s) => s.chatId === chatId)?.title ?? null;
    }
  }

  /** Recipient label: chat name plus the topic number, if any. */
  async recipientName(chatId: string, threadId: number | null) {
    const title = (await this.chatTitle(chatId)) ?? chatId;
    return threadId != null ? `${title} · тред ${threadId}` : title;
  }

  /** Recipients saved before names were looked up get one now. */
  private async nameRecipients() {
    for (const r of listRecipients(this.db)) {
      if (r.name !== r.chatId) continue;
      const name = await this.recipientName(r.chatId, r.threadId);
      if (name !== r.chatId) saveRecipient(this.db, { ...r, name });
    }
  }

  async setToken(token: string) {
    setSetting(this.db, 'telegram.token', token.trim());
    await this.start();
    return this.configured;
  }

  // ---------- outgoing ----------

  notify(category: Category, html: string) {
    if (!this.token) return;
    for (const r of listRecipients(this.db)) {
      if (!r.categories.includes(category)) continue;
      void this.send(r.chatId, r.threadId, html).catch((err) => this.log.warn({ err: (err as Error).message, to: r.name }, 'telegram send failed'));
    }
  }

  send(chatId: string | number, threadId: number | null | undefined, html: string, keyboard?: Keyboard) {
    return this.enqueue(() =>
      this.call('sendMessage', {
        chat_id: chatId,
        message_thread_id: threadId ?? undefined,
        text: html,
        parse_mode: 'HTML',
        link_preview_options: { is_disabled: true },
        reply_markup: keyboard ? { inline_keyboard: keyboard } : undefined,
      }),
    );
  }

  /** Serialises sends so a burst of alerts does not hit the rate limit. */
  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => {});
    return run;
  }

  private async call<T>(method: string, body: object, signal?: AbortSignal): Promise<T> {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch(`${API}/bot${this.token}/${method}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal,
      });
      const data = (await res.json()) as { ok: boolean; result: T; description?: string; parameters?: { retry_after?: number } };
      if (data.ok) return data.result;
      if (res.status === 429 && attempt < 3) {
        await new Promise((r) => setTimeout(r, ((data.parameters?.retry_after ?? 1) + 0.5) * 1000));
        continue;
      }
      throw new Error(`${method}: ${data.description ?? res.status}`);
    }
  }

  // ---------- incoming ----------

  private async poll() {
    const ctrl = new AbortController();
    this.abort = ctrl;
    let backoff = 1000;
    while (!ctrl.signal.aborted) {
      try {
        const updates = await this.call<TgUpdate[]>(
          'getUpdates',
          { offset: this.offset, timeout: 50, allowed_updates: ['message', 'callback_query'] },
          ctrl.signal,
        );
        backoff = 1000;
        for (const u of updates) {
          this.offset = u.update_id + 1;
          await this.handle(u).catch((err) => this.log.warn({ err: (err as Error).message }, 'telegram update failed'));
        }
      } catch (err) {
        if (ctrl.signal.aborted) return;
        this.log.warn({ err: (err as Error).message }, 'telegram polling error');
        await new Promise((r) => setTimeout(r, backoff));
        backoff = Math.min(backoff * 2, 60_000);
      }
    }
  }

  private allowed(chatId: number) {
    return listRecipients(this.db).some((r) => r.chatId === String(chatId));
  }

  private remember(msg: TgMessage) {
    const chatId = String(msg.chat.id);
    const threadId = msg.is_topic_message ? (msg.message_thread_id ?? null) : null;
    const title = msg.chat.title ?? msg.chat.username ?? msg.chat.first_name ?? chatId;
    const i = this.seen.findIndex((s) => s.chatId === chatId && s.threadId === threadId);
    if (i >= 0) this.seen.splice(i, 1);
    this.seen.unshift({ chatId, threadId, title, at: Date.now() });
    this.seen.length = Math.min(this.seen.length, 10);
  }

  private async handle(u: TgUpdate) {
    if (u.message?.text) {
      const msg = u.message;
      const thread = msg.is_topic_message ? msg.message_thread_id : undefined;
      const cmd = msg.text!.trim().split(/\s+/)[0]!.split('@')[0]!.toLowerCase();
      if (!cmd.startsWith('/')) return;
      if (!this.allowed(msg.chat.id)) {
        this.remember(msg);
        await this.send(
          msg.chat.id,
          thread,
          `Этот чат не подключён к besigor.\n\nchat_id: <code>${msg.chat.id}</code>${thread ? `\nтред: <code>${thread}</code>` : ''}\n\nДобавьте его в панели: Настройки → Telegram.`,
        );
        return;
      }
      const screen =
        cmd === '/status' ? this.screenStatus() : cmd === '/servers' ? this.screenServers() : cmd === '/alerts' ? this.screenAlerts() : this.screenMain();
      await this.send(msg.chat.id, thread, screen.text, screen.keyboard);
      return;
    }

    const cq = u.callback_query;
    if (!cq?.message || !cq.data) return;
    if (!this.allowed(cq.message.chat.id)) {
      await this.call('answerCallbackQuery', { callback_query_id: cq.id, text: 'Чат не подключён' });
      return;
    }
    const [action, id, arg] = cq.data.split(':');
    let toast = '';
    if (action === 'mt' && id) {
      setMute(this.db, id, arg === 'f' ? null : Number(arg));
      toast = arg === 'f' ? 'Алерты выключены до включения' : `Алерты заглушены на ${arg} ч`;
    } else if (action === 'um' && id) {
      setMute(this.db, id, 0);
      toast = 'Алерты снова включены';
    }
    const screen =
      action === 'st'
        ? this.screenStatus()
        : action === 'sl'
          ? this.screenServers()
          : action === 'al'
            ? this.screenAlerts()
            : action === 'mu' && id
              ? this.screenMute(id)
              : action === 'c' && id
                ? this.screenContainers(id)
              : (action === 's' || action === 'mt' || action === 'um') && id
                ? this.screenServer(id)
                : this.screenMain();
    await this.call('answerCallbackQuery', { callback_query_id: cq.id, text: toast || undefined }).catch(() => {});
    await this.call('editMessageText', {
      chat_id: cq.message.chat.id,
      message_id: cq.message.message_id,
      text: screen.text,
      parse_mode: 'HTML',
      link_preview_options: { is_disabled: true },
      reply_markup: { inline_keyboard: screen.keyboard },
    }).catch((err: Error) => {
      if (!err.message.includes('not modified')) throw err;
    });
  }

  // ---------- screens ----------

  private servers() {
    return (this.db.prepare('SELECT id, name, host_info, last_seen FROM servers ORDER BY sort, name').all() as {
      id: string;
      name: string;
      host_info: string | null;
      last_seen: number | null;
    }[]).map((s) => ({ ...s, host: s.host_info ? (JSON.parse(s.host_info) as HostInfo) : null, st: this.agents.state(s.id) }));
  }

  private screenMain() {
    const list = this.servers();
    const online = list.filter((s) => s.st.online).length;
    const active = this.alerts?.active().length ?? 0;
    return {
      text: `<b>besigor</b>\n\nВ сети: <b>${online}</b> из ${list.length}\nАктивных алертов: <b>${active}</b>`,
      keyboard: [
        [{ text: '📊 Общий статус', callback_data: 'st' }],
        [
          { text: '🖥 Серверы', callback_data: 'sl' },
          { text: '🔔 Алерты', callback_data: 'al' },
        ],
      ],
    };
  }

  private screenStatus() {
    const lines = this.servers().map((s) => {
      const muted = mutedUntil(this.db, s.id) !== undefined ? ' 🔕' : '';
      const l = s.st.online ? s.st.live : undefined;
      if (!l) {
        const ago = s.last_seen ? `не в сети ${fmtDuration(Math.floor(Date.now() / 1000) - s.last_seen)}` : 'ещё не подключался';
        return `🔴 <b>${esc(s.name)}</b>${muted} · ${ago}`;
      }
      const ram = l.memTotal ? (l.memUsed / l.memTotal) * 100 : 0;
      return `🟢 <b>${esc(s.name)}</b>${muted}\n     CPU ${fmtNum(l.cpu, 0)}% · RAM ${fmtNum(ram, 0)}% · Диск ${fmtNum(worstDiskPct(l), 0)}%`;
    });
    return {
      text: `<b>Общий статус</b>\n\n${lines.join('\n') || 'Серверов пока нет.'}`,
      keyboard: [[{ text: '🔄 Обновить', callback_data: 'st' }], [{ text: '← Меню', callback_data: 'm' }]],
    };
  }

  private screenServers() {
    const list = this.servers();
    const rows: Keyboard = [];
    list.forEach((s, i) => {
      const btn = { text: `${s.st.online ? '🟢' : '🔴'} ${s.name}`, callback_data: `s:${s.id}` };
      if (i % 2 === 0) rows.push([btn]);
      else rows[rows.length - 1]!.push(btn);
    });
    rows.push([{ text: '← Меню', callback_data: 'm' }]);
    return { text: list.length ? '<b>Серверы</b>\n\nВыберите сервер:' : 'Серверов пока нет.', keyboard: rows };
  }

  private screenServer(id: string) {
    const s = this.servers().find((x) => x.id === id);
    if (!s) return { text: 'Сервер не найден — возможно, его удалили.', keyboard: [[{ text: '← Серверы', callback_data: 'sl' }]] };
    const mute = mutedUntil(this.db, id);
    const l = s.st.online ? s.st.live : undefined;
    const lines = [`<b>${esc(s.name)}</b> ${s.st.online ? '🟢 в сети' : '🔴 не в сети'}`];
    if (s.host) lines.push(`${esc(s.host.os)} · ${s.host.cores} vCPU · ${fmtBytes(s.host.memTotal)}`);
    lines.push('');
    if (l) {
      const root = l.disks?.find((d) => d.mount === '/') ?? l.disks?.[0];
      lines.push(
        `CPU: <b>${fmtNum(l.cpu, 1)}%</b> · steal ${fmtNum(l.cpuSteal, 1)}%`,
        `RAM: <b>${fmtBytes(l.memUsed)}</b> из ${fmtBytes(l.memTotal)}`,
        root ? `Диск: <b>${fmtBytes(root.used)}</b> из ${fmtBytes(root.total)} (${fmtNum(worstDiskPct(l), 0)}%)` : 'Диск: —',
        `Сеть: ↓ ${fmtBits(l.rx)} · ↑ ${fmtBits(l.tx)}`,
        `Load: ${l.load.map((v) => fmtNum(v, 2)).join(' · ')}`,
        `Аптайм: ${fmtDuration(l.uptime)}`,
      );
    } else if (s.last_seen) {
      lines.push(`Последний раз в сети ${fmtDuration(Math.floor(Date.now() / 1000) - s.last_seen)} назад`);
    } else {
      lines.push('Агент ещё не подключался.');
    }
    const t = trafficSummary(this.db, id);
    if (t && t.used > 0) {
      lines.push(`Трафик за месяц: <b>${fmtBytes(t.used)}</b>${t.limit ? ` из ${fmtBytes(t.limit)} (${fmtNum((t.used / t.limit) * 100, 0)}%)` : ''}`);
    }
    const firing = (this.alerts?.active() ?? []).filter((a) => a.serverId === id);
    if (firing.length) lines.push('', '⚠️ ' + firing.map((a) => ALERT_DEFS[a.type].label + (a.key ? ` (${esc(a.key)})` : '')).join(', '));
    if (mute !== undefined) {
      lines.push('', mute === null ? '🔕 Алерты выключены до включения' : `🔕 Алерты заглушены до ${new Date(mute * 1000).toLocaleString('ru-RU', { timeZone: process.env.TZ || 'Europe/Moscow', hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}`);
    }
    return {
      text: lines.join('\n'),
      keyboard: [
        [
          { text: '🔄 Обновить', callback_data: `s:${id}` },
          ...(l?.containers?.length ? [{ text: '🐳 Контейнеры', callback_data: `c:${id}` }] : []),
        ],
        [mute !== undefined ? { text: '🔔 Включить алерты', callback_data: `um:${id}` } : { text: '🔕 Заглушить', callback_data: `mu:${id}` }],
        [{ text: '← Серверы', callback_data: 'sl' }],
      ],
    };
  }

  private screenContainers(id: string) {
    const s = this.servers().find((x) => x.id === id);
    const list = (s?.st.online ? s.st.live?.containers : undefined) ?? [];
    const icon = (state: string, health: string) =>
      state !== 'running' ? (state === 'restarting' ? '🔁' : '⚫️') : health === 'unhealthy' ? '🟠' : '🟢';
    const lines = list
      .slice()
      .sort((a, b) => Number(a.state === 'running') - Number(b.state === 'running') || b.cpu - a.cpu)
      .map((c) =>
        c.state === 'running'
          ? `${icon(c.state, c.health)} <code>${esc(c.name)}</code> · CPU ${fmtNum(c.cpu, 1)}% · ${fmtBytes(c.mem)}`
          : `${icon(c.state, c.health)} <code>${esc(c.name)}</code> · ${c.state}${c.state === 'exited' ? ` (${c.exitCode})` : ''}`,
      );
    return {
      text: `<b>${esc(s?.name ?? '')}</b> · контейнеры\n\n${lines.join('\n') || 'Нет данных о контейнерах.'}`,
      keyboard: [
        [{ text: '🔄 Обновить', callback_data: `c:${id}` }],
        [{ text: '← Сервер', callback_data: `s:${id}` }],
      ],
    };
  }

  private screenMute(id: string) {
    const s = this.servers().find((x) => x.id === id);
    return {
      text: `Заглушить алерты <b>${esc(s?.name ?? '')}</b>?`,
      keyboard: [
        [
          { text: '1 ч', callback_data: `mt:${id}:1` },
          { text: '4 ч', callback_data: `mt:${id}:4` },
          { text: '24 ч', callback_data: `mt:${id}:24` },
        ],
        [{ text: 'До включения', callback_data: `mt:${id}:f` }],
        [{ text: '← Назад', callback_data: `s:${id}` }],
      ],
    };
  }

  private screenAlerts() {
    const names = new Map(this.servers().map((s) => [s.id, s.name]));
    const now = Math.floor(Date.now() / 1000);
    const active = (this.alerts?.active() ?? []).map(
      (a) => `⚠️ <b>${esc(names.get(a.serverId) ?? '?')}</b> · ${ALERT_DEFS[a.type].label}${a.key ? ` <code>${esc(a.key)}</code>` : ''} · ${fmtDuration(now - a.since)}`,
    );
    const muted = [...names.entries()].filter(([id]) => mutedUntil(this.db, id) !== undefined).map(([, n]) => `🔕 ${esc(n)}`);
    const text = ['<b>Алерты</b>', '', active.length ? active.join('\n') : 'Сейчас всё спокойно ✅', ...(muted.length ? ['', 'Заглушены:', muted.join('\n')] : [])];
    return {
      text: text.join('\n'),
      keyboard: [[{ text: '🔄 Обновить', callback_data: 'al' }], [{ text: '← Меню', callback_data: 'm' }]],
    };
  }
}
