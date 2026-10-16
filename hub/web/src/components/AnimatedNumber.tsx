import { useEffect, useRef, useState } from 'react';

const reduced = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const ease = (t: number) => 1 - Math.pow(1 - t, 4);

/** Tweens a number toward each new value instead of jumping. */
export function useTweened(value: number, duration = 700) {
  const [shown, setShown] = useState(value);
  const from = useRef(value);
  const current = useRef(value);

  useEffect(() => {
    if (!Number.isFinite(value)) return;
    if (reduced() || current.current === value) {
      current.current = value;
      setShown(value);
      return;
    }
    from.current = current.current;
    const start = performance.now();
    let raf = 0;
    const step = (now: number) => {
      const t = Math.min(1, (now - start) / duration);
      current.current = from.current + (value - from.current) * ease(t);
      setShown(current.current);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, duration]);

  return shown;
}

export function AnimatedNumber({ value, format }: { value: number; format: (v: number) => string }) {
  const v = useTweened(value);
  return <span className="num">{format(v)}</span>;
}
