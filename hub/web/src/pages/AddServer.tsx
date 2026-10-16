import { useState, type FormEvent } from 'react';
import { CodeBlock, Dialog, useToast } from '../components/ui';
import { api, ApiError } from '../lib/api';

export interface TokenResult {
  docker: boolean;
  token: string;
  install: string;
  compose: string;
  hubUrl: string;
}

export function DockerChoice({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <div className="choice" role="radiogroup" aria-label="Доступ к Docker">
      <button type="button" role="radio" aria-checked={value} className={`choice-card ${value ? 'on' : ''}`} onClick={() => onChange(true)}>
        <b>С доступом к Docker</b>
        <span>Список контейнеров, их CPU, память и сеть, логи по кнопке, алерты «контейнер упал». Агент получает docker.sock только на чтение.</span>
      </button>
      <button type="button" role="radio" aria-checked={!value} className={`choice-card ${!value ? 'on' : ''}`} onClick={() => onChange(false)}>
        <b>Без Docker</b>
        <span>Только метрики сервера: CPU, память, диски, сеть, проверки. К контейнерам агент доступа не получит.</span>
      </button>
    </div>
  );
}

export function InstallSteps({ result }: { result: TokenResult }) {
  const [toast, show] = useToast();
  const [manual, setManual] = useState(false);
  return (
    <>
      <p style={{ marginBottom: 10 }}>Выполните на сервере одну команду — она поставит Docker (если его нет), скачает и запустит агента:</p>
      <CodeBlock code={result.install} onCopied={() => show('Скопировано')} wrap />
      <p className="faint" style={{ fontSize: 13, margin: '12px 0 0' }}>
        Через несколько секунд сервер появится в&nbsp;панели. Токен показывается только сейчас — если потеряете, выпустите новый на странице сервера.
      </p>
      <button type="button" className="btn btn-ghost btn-sm" style={{ marginTop: 12, paddingLeft: 0 }} onClick={() => setManual((v) => !v)}>
        {manual ? '▾' : '▸'} Вручную через docker-compose
      </button>
      {manual && (
        <div style={{ marginTop: 8 }}>
          <ol className="steps">
            <li>
              Создайте папку, например <code>/opt/besigor-agent</code>, и положите в неё <code>docker-compose.yml</code>:
            </li>
          </ol>
          <CodeBlock code={result.compose} onCopied={() => show('Скопировано')} />
          <ol className="steps" start={2} style={{ marginTop: 16 }}>
            <li>
              Запустите: <code>docker compose up -d</code>
            </li>
          </ol>
        </div>
      )}
      {toast}
    </>
  );
}

export function AddServerDialog({ onClose }: { onClose: () => void }) {
  const [name, setName] = useState('');
  const [docker, setDocker] = useState(true);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<TokenResult | null>(null);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      setResult(await api<TokenResult>('/api/servers', { method: 'POST', json: { name, docker } }));
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
          <div className="field" style={{ marginTop: 16 }}>
            <label>Давать агенту доступ к Docker-контейнерам?</label>
            <DockerChoice value={docker} onChange={setDocker} />
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
