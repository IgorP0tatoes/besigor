import { useState, type FormEvent } from 'react';
import { Glow } from '../components/Glow';
import { Logo } from '../components/ui';
import { api, ApiError } from '../lib/api';

export function Login({ onLogin }: { onLogin: () => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api('/api/login', { method: 'POST', json: { username, password } });
      onLogin();
    } catch (err) {
      if (err instanceof ApiError && err.status === 429) {
        const wait = Math.ceil(((err.body as { retryAfter?: number })?.retryAfter ?? 900) / 60);
        setError(`Слишком много попыток. Попробуйте через ${wait} мин.`);
      } else if (err instanceof ApiError && err.status === 401) {
        setError('Неверный логин или пароль');
      } else {
        setError('Хаб недоступен, попробуйте ещё раз');
      }
    } finally {
      setBusy(false);
    }
  };

  return (
    <main className="login">
      <div className="login-glow">
        <Glow flip intensity={0.85} />
      </div>
      <form className="login-card glass rise" onSubmit={submit}>
        <div className="brand">
          <Logo size={34} />
          besigor
        </div>
        <h1>Вход в панель</h1>
        <p>Мониторинг ваших серверов в реальном времени.</p>
        <div className="login-form">
          <div className="field">
            <label htmlFor="u">Логин</label>
            <input id="u" className="input" autoComplete="username" value={username} onChange={(e) => setUsername(e.target.value)} required autoFocus />
          </div>
          <div className="field">
            <label htmlFor="p">Пароль</label>
            <input
              id="p"
              className="input"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <div className="form-error" role="alert">
            {error}
          </div>
          <button className="btn btn-primary" style={{ height: 46 }} disabled={busy}>
            {busy ? 'Проверяем…' : 'Войти'}
          </button>
        </div>
      </form>
      <div className="marquee" aria-hidden>
        <span>besigor · cpu · memory · disk · network · uptime · besigor · cpu · memory · disk · network · uptime ·</span>
        <span>besigor · cpu · memory · disk · network · uptime · besigor · cpu · memory · disk · network · uptime ·</span>
      </div>
    </main>
  );
}
