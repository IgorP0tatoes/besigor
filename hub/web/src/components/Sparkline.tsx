import { useId } from 'react';

export function Sparkline({ values, width = 96, height = 28, max = 100 }: { values: number[]; width?: number; height?: number; max?: number }) {
  const id = useId();
  if (values.length < 2) return <svg className="spark" width={width} height={height} aria-hidden />;
  const top = Math.max(max, ...values);
  const step = width / (values.length - 1);
  const pts = values.map((v, i) => [i * step, height - 2 - (v / top) * (height - 4)] as const);
  const line = pts.map(([x, y], i) => `${i ? 'L' : 'M'}${x.toFixed(1)},${y.toFixed(1)}`).join('');
  const area = `${line}L${width},${height}L0,${height}Z`;
  return (
    <svg className="spark" width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden>
      <defs>
        <linearGradient id={id} x1="0" x2="0" y1="0" y2="1">
          <stop offset="0" stopColor="#7c6bff" stopOpacity="0.45" />
          <stop offset="1" stopColor="#7c6bff" stopOpacity="0" />
        </linearGradient>
      </defs>
      <path d={area} fill={`url(#${id})`} />
      <path d={line} fill="none" stroke="#a99cff" strokeWidth="1.5" strokeLinejoin="round" />
    </svg>
  );
}
