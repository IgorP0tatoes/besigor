const NBSP = ' ';

const BYTE_UNITS = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ', 'ПБ'];
const BIT_UNITS = ['бит/с', 'Кбит/с', 'Мбит/с', 'Гбит/с', 'Тбит/с'];

function scale(value: number, base: number, units: string[]): [number, string] {
  let v = Math.abs(value);
  let i = 0;
  while (v >= base && i < units.length - 1) {
    v /= base;
    i++;
  }
  return [Math.sign(value) * v, units[i]!];
}

export function fmtNumber(v: number, digits = 1) {
  return v.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: 0 });
}

function digitsFor(v: number) {
  return Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2;
}

/** 1.5 ГБ — binary multiples, labelled the way Russian UIs usually do. */
export function bytesParts(b: number): [string, string] {
  const [v, u] = scale(b, 1024, BYTE_UNITS);
  return [fmtNumber(v, u === 'Б' ? 0 : digitsFor(v)), u];
}

export const fmtBytes = (b: number) => bytesParts(b).join(NBSP);

/** Network rates are shown in bits per second, like providers and alerts. */
export function bitsParts(bytesPerSec: number): [string, string] {
  const [v, u] = scale(bytesPerSec * 8, 1000, BIT_UNITS);
  return [fmtNumber(v, digitsFor(v)), u];
}

export const fmtBits = (bps: number) => bitsParts(bps).join(NBSP);

export const fmtRate = (bytesPerSec: number) => fmtBytes(bytesPerSec) + '/с';

export const fmtPct = (v: number, digits = 1) => fmtNumber(v, digits) + NBSP + '%';

export function pct(used: number, total: number) {
  return total > 0 ? (used / total) * 100 : 0;
}

export function fmtUptime(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.floor((sec % 3600) / 60);
  if (d > 0) return `${d}${NBSP}д ${h}${NBSP}ч`;
  if (h > 0) return `${h}${NBSP}ч ${m}${NBSP}мин`;
  return `${m}${NBSP}мин`;
}

export function fmtAgo(unix: number | null) {
  if (!unix) return 'никогда';
  const s = Math.max(0, Math.floor(Date.now() / 1000 - unix));
  if (s < 60) return 'только что';
  if (s < 3600) return `${Math.floor(s / 60)}${NBSP}мин назад`;
  if (s < 86400) return `${Math.floor(s / 3600)}${NBSP}ч назад`;
  return new Date(unix * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

export function level(p: number, warn = 75, bad = 90): '' | 'warn' | 'bad' {
  return p >= bad ? 'bad' : p >= warn ? 'warn' : '';
}

export function plural(n: number, one: string, few: string, many: string) {
  const m10 = n % 10;
  const m100 = n % 100;
  if (m10 === 1 && m100 !== 11) return one;
  if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
  return many;
}
