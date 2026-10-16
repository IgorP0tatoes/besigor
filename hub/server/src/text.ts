const NBSP = ' ';

export const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export const fmtNum = (v: number, digits = 1) =>
  v.toLocaleString('ru-RU', { maximumFractionDigits: digits, minimumFractionDigits: 0 });

export function fmtDuration(sec: number) {
  const d = Math.floor(sec / 86400);
  const h = Math.floor((sec % 86400) / 3600);
  const m = Math.max(0, Math.floor((sec % 3600) / 60));
  if (d > 0) return `${d}${NBSP}д ${h}${NBSP}ч`;
  if (h > 0) return `${h}${NBSP}ч ${m}${NBSP}мин`;
  return `${Math.max(1, m)}${NBSP}мин`;
}

export function fmtBytes(b: number) {
  const units = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let v = b;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i++;
  }
  return `${fmtNum(v, v >= 100 || i === 0 ? 0 : 1)}${NBSP}${units[i]}`;
}

export function fmtBits(bytesPerSec: number) {
  const units = ['бит/с', 'Кбит/с', 'Мбит/с', 'Гбит/с'];
  let v = bytesPerSec * 8;
  let i = 0;
  while (v >= 1000 && i < units.length - 1) {
    v /= 1000;
    i++;
  }
  return `${fmtNum(v, v >= 100 ? 0 : 1)}${NBSP}${units[i]}`;
}
