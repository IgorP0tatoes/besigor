import { useState, type FormEvent } from 'react';
import { CodeBlock, Dialog, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';

export interface TokenResult {
  token: string;
  compose: string;
  hubUrl: string;
}

export function InstallSteps({ result }: { result: TokenResult }) {
  const [toast, show] = useToast();
  return (
    <>
      <ol className="steps">
        <li>
          На сервере создайте папку, например <code>/opt/besigor-agent</code>, и положите в неё <code>docker-compose.yml</code>:
        </li>
      </ol>
      <CodeBlock code={result.compose} onCopied={() => show('Скопировано')} />
      <ol className="steps" start={2} style={{ marginTop: 16 }}>
        <li>
          Запустите: <code>docker compose up -d</code>
        </li>
        <li>Через несколько секунд сервер появится в&nbsp;панели.</li>
      </ol>
      <p className="faint" style={{ fontSize: 13, margin: 0 }}>
        Токен показывается только сейчас. Если потеряете — выпустите новый на странице сервера.
      </p>
      {toast}
    </>
  );
}

export function AddServerDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TokenResult | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setResult(await api<TokenResult>('/api/servers', { method: 'POST', json: { name } }));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Не удалось создать сервер');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog onClose={onClose} label="Добавить сервер">
      {!result ? (
        <form onSubmit={submit}>
          <h2>Добавить сервер</h2>
          <p>Дайте серверу понятное имя — его можно поменять позже.</p>
          <div className="field">
            <label htmlFor="sname">Имя</label>
            <input id="sname" className="input" placeholder="Например, nl-1" value={name} onChange={(e) => setName(e.target.value)} autoFocus required maxLength={64} />
          </div>
          <div className="form-error" style={{ marginTop: 10 }}>
            {error}
          </div>
          <div className="dialog-actions">
            <button type="button" className="btn btn-ghost" onClick={onClose}>
              Отмена
            </button>
            <button className="btn btn-primary" disabled={busy || !name.trim()}>
              Создать
            </button>
          </div>
        </form>
      ) : (
        <>
          <h2>Установите агента на «{name}»</h2>
          <p>Агент сам подключится к хабу по адресу {result.hubUrl}. Открывать порты на сервере не нужно.</p>
          <InstallSteps result={result} />
          <div className="dialog-actions">
            <button className="btn btn-primary" onClick={onClose}>
              Готово
            </button>
          </div>
        </>
      )}
    </Dialog>
  );
}
