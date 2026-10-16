import { useEffect, useRef } from 'react';
import uPlot from 'uplot';
import 'uplot/dist/uPlot.min.css';

export interface ChartLine {
  label: string;
  color: string;
  values: (number | null)[];
  fill?: boolean;
  dash?: boolean;
}

interface Props {
  ts: number[];
  step: number;
  lines: ChartLine[];
  format: (v: number) => string;
  yMax?: number;
  stacked?: boolean;
  height?: number;
}

/** Inserts a null after every hole longer than 2.5 steps so lines break. */
function withGaps(ts: number[], lines: (number | null)[][], step: number) {
  const outTs: number[] = [];
  const outLines: (number | null)[][] = lines.map(() => []);
  ts.forEach((t, i) => {
    const prev = ts[i - 1];
    if (prev !== undefined && t - prev > step * 2.5) {
      outTs.push(prev + step);
      outLines.forEach((l) => l.push(null));
    }
    outTs.push(t);
    outLines.forEach((l, j) => l.push(lines[j]![i] ?? null));
  });
  return [outTs, ...outLines] as uPlot.AlignedData;
}

function lastIdx(u: uPlot) {
  const n = u.data[0]?.length ?? 0;
  return n > 0 ? n - 1 : 0;
}

function showLatest(u: uPlot) {
  if (u.cursor.idx == null) u.setLegend({ idx: lastIdx(u) });
}

function hexToRgba(hex: string, a: number) {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${a})`;
}

// Tick steps never finer than the data (one point per minute).
const TIME_INCRS = [60, 300, 600, 900, 1800, 3600, 7200, 10800, 21600, 43200, 86400, 2 * 86400, 7 * 86400, 14 * 86400, 30 * 86400];

// Axis width follows the longest label so units never get clipped.
const ySize = (_u: uPlot, values: string[] | null) => (values?.length ? Math.max(...values.map((v) => v.length)) * 7 + 18 : 40);

const axisCommon: uPlot.Axis = {
  stroke: 'rgba(244,235,255,0.42)',
  grid: { stroke: 'rgba(244,235,255,0.06)', width: 1 },
  ticks: { show: false },
  font: '11px Geist Mono, monospace',
};

export function Chart({ ts, step, lines, format, yMax, height = 210 }: Props) {
  const box = useRef<HTMLDivElement>(null);
  const plot = useRef<uPlot | null>(null);
  const data = withGaps(ts, lines.map((l) => l.values), step);
  const dataRef = useRef(data);
  dataRef.current = data;
  const long = ts.length > 1 && ts[ts.length - 1]! - ts[0]! > 2 * 86400;
  // The plot is rebuilt only when its shape changes; new points go through
  // setData so the chart updates in place.
  const shape = [lines.map((l) => l.label + l.color).join(), yMax, height, long, step].join('|');

  useEffect(() => {
    plot.current?.setData(dataRef.current);
  }, [ts, lines]);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const opts: uPlot.Options = {
      width: el.clientWidth,
      height,
      padding: [8, 4, 0, 0],
      cursor: { drag: { x: false, y: false }, points: { size: 7 } },
      legend: { live: true },
      scales: {
        x: { time: true },
        y: { range: (_u, _min, max) => [0, yMax ?? (max > 0 ? max * 1.12 : 1)] },
      },
      axes: [
        {
          ...axisCommon,
          size: 28,
          space: 72,
          incrs: TIME_INCRS,
          values: (_u, splits) =>
            splits.map((s) =>
              new Date(s * 1000).toLocaleString('ru-RU', long ? { day: 'numeric', month: 'short' } : { hour: '2-digit', minute: '2-digit' }),
            ),
        },
        { ...axisCommon, size: ySize, values: (_u, splits) => splits.map((v) => format(v)) },
      ],
      hooks: {
        // with no cursor over the chart, the legend shows the latest values
        ready: [showLatest],
        setData: [showLatest],
        setCursor: [showLatest],
      },
      series: [
        {
          label: 'Время',
          value: (_u, v) =>
            v == null ? '—' : new Date(v * 1000).toLocaleString('ru-RU', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }),
        },
        ...lines.map<uPlot.Series>((l) => ({
          label: l.label,
          stroke: l.color,
          width: 1.6,
          dash: l.dash ? [4, 4] : undefined,
          fill: l.fill
            ? (u: uPlot) => {
                // bbox is NaN until the first layout pass
                if (!Number.isFinite(u.bbox.top) || !Number.isFinite(u.bbox.height)) return hexToRgba(l.color, 0.15);
                const g = u.ctx.createLinearGradient(0, u.bbox.top, 0, u.bbox.top + u.bbox.height);
                g.addColorStop(0, hexToRgba(l.color, 0.32));
                g.addColorStop(1, hexToRgba(l.color, 0));
                return g;
              }
            : undefined,
          points: { show: false },
          value: (_u, v) => (v == null ? '—' : format(v)),
        })),
      ],
    };
    plot.current?.destroy();
    plot.current = new uPlot(opts, dataRef.current, el);
    const ro = new ResizeObserver(() => plot.current?.setSize({ width: el.clientWidth, height }));
    ro.observe(el);
    return () => {
      ro.disconnect();
      plot.current?.destroy();
      plot.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  return <div ref={box} className="chart-plot" />;
}
