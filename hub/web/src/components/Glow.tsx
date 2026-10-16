import { useEffect, useRef } from 'react';

const VERT = `attribute vec2 p; void main(){ gl_Position = vec4(p, 0., 1.); }`;

// Three soft violet blobs, edges warped by value noise so the light slowly
// "flows". Rendered small and stretched by CSS — the image has no fine detail.
const FRAG = `
precision mediump float;
uniform vec2 uRes;
uniform float uTime;
uniform float uIntensity;
uniform float uFlip;

float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  f = f * f * (3. - 2. * f);
  return mix(mix(hash(i), hash(i + vec2(1., 0.)), f.x), mix(hash(i + vec2(0., 1.)), hash(i + vec2(1., 1.)), f.x), f.y);
}

void main() {
  vec2 uv = gl_FragCoord.xy / uRes;
  if (uFlip > .5) uv.y = 1. - uv.y;
  float aspect = uRes.x / uRes.y;
  vec2 p = vec2(uv.x * aspect, uv.y);
  float t = uTime * .06;
  vec2 warp = vec2(noise(p * 1.7 + t), noise(p * 1.7 - t + 3.1)) - .5;
  p += warp * .38;

  vec2 c1 = vec2(aspect * (.5 + .16 * sin(t * 1.3)), 1.06 + .05 * cos(t * 1.7));
  vec2 c2 = vec2(aspect * (.26 + .12 * cos(t * .9)), .94 + .06 * sin(t * 1.1));
  vec2 c3 = vec2(aspect * (.76 + .12 * sin(t * .8 + 1.)), .97 + .05 * sin(t * 1.4));
  float f = exp(-pow(distance(p, c1) * 1.8, 2.))
          + exp(-pow(distance(p, c2) * 2.5, 2.)) * .7
          + exp(-pow(distance(p, c3) * 2.3, 2.)) * .7;

  vec3 violet = vec3(.349, .263, 1.);
  vec3 lilac = vec3(.66, .58, 1.);
  vec3 col = mix(violet, lilac, smoothstep(.9, 1.8, f)) * f * uIntensity;
  // soft shoulder on brightness only: overlaps stay violet instead of washing out
  float L = max(col.r, max(col.g, col.b));
  col *= (1. - exp(-L * 1.25)) / max(L, 1e-4);
  col +=(hash(gl_FragCoord.xy + fract(uTime)) - .5) / 255.;
  gl_FragColor = vec4(col, 1.);
}`;

interface Props {
  intensity?: number;
  flip?: boolean;
  className?: string;
}

export function Glow({ intensity = 1, flip = false, className }: Props) {
  const ref = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = ref.current;
    if (!canvas) return;
    const gl = canvas.getContext('webgl', { antialias: false, alpha: false, powerPreference: 'low-power' });
    if (!gl) {
      canvas.style.background = `radial-gradient(60% 70% at 50% ${flip ? '110%' : '-10%'}, rgba(89,67,255,${0.55 * intensity}), transparent 70%)`;
      return;
    }
    const compile = (type: number, src: string) => {
      const s = gl.createShader(type)!;
      gl.shaderSource(s, src);
      gl.compileShader(s);
      return s;
    };
    const prog = gl.createProgram()!;
    gl.attachShader(prog, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(prog, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(prog);
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    const uRes = gl.getUniformLocation(prog, 'uRes');
    const uTime = gl.getUniformLocation(prog, 'uTime');
    gl.uniform1f(gl.getUniformLocation(prog, 'uIntensity'), intensity);
    gl.uniform1f(gl.getUniformLocation(prog, 'uFlip'), flip ? 1 : 0);

    const resize = () => {
      const w = Math.min(480, Math.max(64, Math.round(canvas.clientWidth / 4)));
      const h = Math.max(32, Math.round((w * canvas.clientHeight) / Math.max(1, canvas.clientWidth)));
      if (canvas.width !== w || canvas.height !== h) {
        canvas.width = w;
        canvas.height = h;
        gl.viewport(0, 0, w, h);
        gl.uniform2f(uRes, w, h);
      }
    };
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now() - Math.random() * 60_000;
    let raf = 0;
    let last = 0;
    let visible = true;
    const draw = (now: number) => {
      raf = 0;
      if (!visible || document.hidden) return;
      if (now - last >= 1000 / 30) {
        last = now;
        resize();
        gl.uniform1f(uTime, (now - start) / 1000);
        gl.drawArrays(gl.TRIANGLES, 0, 3);
      }
      if (!reduced) raf = requestAnimationFrame(draw);
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(draw);
    };
    const io = new IntersectionObserver(([e]) => {
      visible = !!e?.isIntersecting;
      if (visible) kick();
    });
    io.observe(canvas);
    const ro = new ResizeObserver(() => (reduced ? requestAnimationFrame(draw) : kick()));
    ro.observe(canvas);
    document.addEventListener('visibilitychange', kick);
    kick();
    return () => {
      cancelAnimationFrame(raf);
      io.disconnect();
      ro.disconnect();
      document.removeEventListener('visibilitychange', kick);
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    };
  }, [intensity, flip]);

  return <canvas ref={ref} className={className} style={{ width: '100%', height: '100%', display: 'block' }} aria-hidden />;
}
