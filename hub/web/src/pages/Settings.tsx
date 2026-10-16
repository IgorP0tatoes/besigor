import { useCallback, useEffect, useState, type FormEvent , type CSSProperties } from 'react';
import { useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';

type Category = 'offline' | 'resources' | 'traffic' | 'containers' | 'probes';

interface Recipient {
  id: string;
  name: string;
  chatId: string;
  threadId: number | null;
  categories: Category[];
}

interface TelegramInfo {
  configured: boolean;
  username: string;
  recipients: Recipient[];
  seen: { chatId: string; threadId: number | null; title: string; at: number }[];
  categories: Record<Category, string>;
}

const ALL: Category[] = ['offline', 'resources', 'traffic', 'containers', 'probes'];

function errText(err: unknown) {
  return err instanceof ApiError ? err.message : 'Не удалось сохранить';
}

function CategoryPicker({ value, onChange, labels }: { value: Category[]; onChange: (v: Category[]) => void; labels: Record<Category, string> }) {
  return (
    <div className="chips">
      {ALL.map((c) => {
        const on = value.includes(c);
        return (
          <button key={c} type="button" className={`chip ${on ? 'on' : ''}`} aria-pressed={on} onClick={() => onChange(on ? value.filter((x) => x !== c) : [...value, c])}>
            {labels[c]}
          </button>
        );
      })}
    </div>
  );
}

function RecipientForm({ initial, labels, onSaved, onCancel }: { initial?: Partial<Recipient>; labels: Record<Category, string>; onSaved: () => void; onCancel?: () => void }) {
  const [chatId, setChatId] = useState(initial?.chatId ?? '');
  const [threadId, setThreadId] = useState(initial?.threadId != null ? String(initial.threadId) : '');
  const [cats, setCats] = useState<Category[]>(initial?.categories ?? ALL);
  const [error, setError] = useState('');

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError('');
    const body = { chatId, threadId: threadId.trim() === '' ? null : Number(threadId), categories: cats };
    try {
      if (initial?.id) await api(`/api/telegram/recipients/${initial.id}`, { method: 'PUT', json: body });
      else await api('/api/telegram/recipients', { method: 'POST', json: body });
      onSaved();
    } catch (err) {
      setError(errText(err));
    }
  };

  return (
    <form className="recipient-form" onSubmit={submit}>
      <div className="form-grid">
        <div className="field">
          <label>chat_id</label>
          <input className="input num" value={chatId} onChange={(e) => setChatId(e.target.value)} placeholder="ID чата" required />
        </div>
        <div className="field">
          <label>Тред (необязательно)</label>
          <input className="input num" value={threadId} onChange={(e) => setThreadId(e.target.value)} placeholder="Номер темы" inputMode="numeric" />
        </div>
      </div>
      <div className="field" style={{ marginTop: 14 }}>
        <label>Что присылать</label>
        <CategoryPicker value={cats} onChange={setCats} labels={labels} />
      </div>
      <div className="form-error" style={{ marginTop: 8 }}>
        {error}
      </div>
      <div className="dialog-actions" style={{ marginTop: 6 }}>
        {onCancel && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onCancel}>
            Отмена
          </button>
        )}
        <button className="btn btn-primary btn-sm">{initial?.id ? 'Сохранить' : 'Добавить получателя'}</button>
      </div>
    </form>
  );
}

export function Settings() {
  const [info, setInfo] = useState<TelegramInfo | null>(null);
  const [token, setToken] = useState('');
  const [tokenError, setTokenError] = useState('');
  const [editing, setEditing] = useState<string | null>(null);
  const [prefill, setPrefill] = useState<Partial<Recipient> | null>(null);
  const [toast, show] = useToast();

  const load = useCallback(() => api<TelegramInfo>('/api/telegram').then(setInfo), []);
  useEffect(() => {
    void load();
    const t = setInterval(load, 10_000); // pick up chats that just wrote to the bot
    return () => clearInterval(t);
  }, [load]);

  const saveToken = async (e: FormEvent) => {
    e.preventDefault();
    setTokenError('');
    try {
      await api('/api/telegram/token', { method: 'PUT', json: { token } });
      setToken('');
      show('Бот подключён');
      void load();
    } catch (err) {
      setTokenError(errText(err));
    }
  };

  if (!info) return <main className="page" />;
  const known = new Set(info.recipients.map((r) => `${r.chatId}|${r.threadId ?? ''}`));
  const fresh = info.seen.filter((s) => !known.has(`${s.chatId}|${s.threadId ?? ''}`));

  return (
    <main className="page">
      <div className="page-head">
        <div>
          <div className="eyebrow">03 · Настройки</div>
          <h1>Уведомления</h1>
        </div>
      </div>

      <section className="glass settings-card rise">
        <div className="settings-head">
          <h2>Telegram-бот</h2>
          {info.configured ? <span className="tag">🟢 @{info.username}</span> : <span className="tag warn">не подключён</span>}
        </div>
        <p className="muted">
          Создайте бота у&nbsp;@BotFather и вставьте его токен. Бот присылает алерты и отвечает на кнопки меню (команда <code>/menu</code>) только в чатах из списка ниже.
        </p>
        <form className="token-form" onSubmit={saveToken}>
          <input className="input num" type="password" value={token} onChange={(e) => setToken(e.target.value)} placeholder={info.configured ? 'Новый токен, чтобы заменить текущий' : '123456789:AA…'} autoComplete="off" />
          <button className="btn btn-primary" disabled={!token.trim()}>
            Сохранить
          </button>
        </form>
        <div className="form-error">{tokenError}</div>
      </section>

      <section className="glass settings-card rise" style={{ '--i': 1 } as CSSProperties}>
        <div className="settings-head">
          <h2>Получатели</h2>
        </div>
        <p className="muted">
          Личный чат, группа или отдельная тема в группе. Напишите боту <code>/start</code> в нужном чате или теме — он появится ниже в «Новых чатах», останется нажать «Добавить». Название подтянется из Telegram.
        </p>

        {fresh.length > 0 && (
          <div className="seen">
            <div className="faint" style={{ fontSize: 12.5, marginBottom: 8 }}>
              Новые чаты, писавшие боту
            </div>
            {fresh.map((s) => (
              <div key={`${s.chatId}|${s.threadId}`} className="seen-row">
                <span>{s.title}</span>
                <span className="faint num">
                  {s.chatId}
                  {s.threadId ? ` · тред ${s.threadId}` : ''}
                </span>
                <button className="btn btn-sm" onClick={() => setPrefill({ chatId: s.chatId, threadId: s.threadId })}>
                  Добавить
                </button>
              </div>
            ))}
          </div>
        )}

        <div className="recipients">
          {info.recipients.map((r) =>
            editing === r.id ? (
              <div key={r.id} className="recipient editing">
                <RecipientForm initial={r} labels={info.categories} onCancel={() => setEditing(null)} onSaved={() => (setEditing(null), void load())} />
              </div>
            ) : (
              <div key={r.id} className="recipient">
                <div className="recipient-main">
                  <b>{r.name}</b>
                  <span className="faint num">
                    {r.chatId}
                    {r.threadId != null ? ` · тред ${r.threadId}` : ''}
                  </span>
                  <div className="chips" style={{ marginTop: 8 }}>
                    {r.categories.length ? r.categories.map((c) => <span key={c} className="tag">{info.categories[c]}</span>) : <span className="tag warn">ничего не выбрано</span>}
                  </div>
                </div>
                <div className="recipient-actions">
                  <button
                    className="btn btn-sm"
                    onClick={async () => {
                      try {
                        await api(`/api/telegram/recipients/${r.id}/test`, { method: 'POST' });
                        show('Тестовое сообщение отправлено');
                      } catch (err) {
                        show(errText(err));
                      }
                    }}
                  >
                    Тест
                  </button>
                  <button className="btn btn-sm btn-ghost" onClick={() => setEditing(r.id)}>
                    Изменить
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={async () => {
                      await api(`/api/telegram/recipients/${r.id}`, { method: 'DELETE' });
                      void load();
                    }}
                  >
                    Удалить
                  </button>
                </div>
              </div>
            ),
          )}
        </div>

        <div className="recipient editing">
          <RecipientForm
            key={prefill ? `${prefill.chatId}|${prefill.threadId}` : 'new'}
            initial={prefill ?? undefined}
            labels={info.categories}
            onSaved={() => {
              setPrefill(null);
              show('Получатель добавлен');
              void load();
            }}
          />
        </div>
      </section>
      {toast}
    </main>
  );
}
