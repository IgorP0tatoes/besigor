import { useEffect, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { AnimatedNumber } from './AnimatedNumber';
import { fmtNumber, level } from '../lib/format';

export function Logo({ size = 28 }: { size?: number }) {
  return (
    <svg className="brand-mark" width={size} height={size} viewBox="0 0 32 32" aria-hidden>
      <defs>
        <radialGradient id="lg" cx="50%" cy="40%" r="60%">
          <stop offset="0" stopColor="#b3a6ff" />
          <stop offset="1" stopColor="#5943ff" />
        </radialGradient>
      </defs>
      <rect x="0.5" y="0.5" width="31" height="31" rx="9" fill="rgba(244,235,255,0.04)" stroke="rgba(244,235,255,0.14)" />
      <path d="M8 20.5 12.5 14l4 4.5L24 9" fill="none" stroke="url(#lg)" strokeWidth="2.6" strokeLinecap="round" strokeLinejoin="round" />
      <circle cx="24" cy="9" r="2.2" fill="#f4ebff" />
    </svg>
  );
}

export function StatusDot({ online }: { online: boolean }) {
  return <span className={`dot ${online ? 'ok' : 'bad'}`} title={online ? 'В сети' : 'Не в сети'} />;
}

export function Meter({ label, value }: { label: string; value: number }) {
  const lv = level(value);
  return (
    <div className="meter-row">
      <span className="meter-label">{label}</span>
      <div className={`bar ${lv}`}>
        <i style={{ width: `${Math.min(100, Math.max(0, value))}%` }} />
      </div>
      <span className="meter-value">
        <AnimatedNumber value={value} format={(v) => fmtNumber(v, 1) + ' %'} />
      </span>
    </div>
  );
}

export function Dialog({ onClose, children, label }: { onClose: () => void; children: ReactNode; label: string }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    document.addEventListener('keydown', onKey);
    document.body.style.overflow = 'hidden';
    return () => {
      document.removeEventListener('keydown', onKey);
      document.body.style.overflow = '';
    };
  }, [onClose]);
  return createPortal(
    <div className="backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="dialog glass" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

export function useToast() {
  const [msg, setMsg] = useState<string | null>(null);
  useEffect(() => {
    if (!msg) return;
    const t = setTimeout(() => setMsg(null), 2200);
    return () => clearTimeout(t);
  }, [msg]);
  const node = msg ? createPortal(<div className="toast" role="status">{msg}</div>, document.body) : null;
  return [node, setMsg] as const;
}

export async function copyText(text: string) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    // http:// or older browsers: fall back to a hidden textarea
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  }
}

export function CodeBlock({ code, onCopied }: { code: string; onCopied?: () => void }) {
  return (
    <div style={{ position: 'relative' }}>
      <pre className="code">{code}</pre>
      <button
        type="button"
        className="btn btn-sm code-copy"
        onClick={async () => {
          if (await copyText(code)) onCopied?.();
        }}
      >
        Копировать
      </button>
    </div>
  );
}
