import { useEffect, useRef } from 'react';
import { makeCanvas, rect, rng, sprite, type Ctx } from './draw';
import { prefersReducedMotion } from '../chrome';

/* The footer signature: a night street drawn at 84 art pixels tall and
 * upscaled 2x/3x/4x with image-rendering: pixelated. The width in art pixels
 * follows the viewport, so the street always runs edge to edge.
 *
 * Story, left to right: a city skyline under stars, an ECG trace sweeping
 * across the sky like a bedside monitor, the MedSim hospital (its cross
 * pulses on every R wave), a doctor and a nurse at the ER doors, and the
 * trace turning into a voice waveform at the far end. An ambulance with a
 * flashing beacon drives the road. One rAF loop, ~20 fps, paused off-screen;
 * a single still frame under reduced motion. */

const H = 84;
const GROUND = 68;
const ROAD = 72;
const ECG_Y = 26;
const BEAT = 72;
const FPS = 20;

const C = {
  far0: '#0e2457',
  far1: '#112a60',
  farEdge: '#173571',
  farLit: '#3d63a8',
  warm: '#ffd76a',
  warm2: '#ffeaa8',
  wall: '#8ea4d2',
  wallHi: '#a9bce3',
  wallLo: '#6c83b8',
  roof: '#4e669e',
  winOff: '#2f4a85',
  cross: '#e8505b',
  crossHi: '#ff8a8f',
  crossLo: '#a8323b',
  white: '#f3f1e2',
  door: '#6ad5e7',
  doorLo: '#3aa6b8',
  doorHi: '#b8f1fa',
  walk: '#173571',
  walkHi: '#2b4c8a',
  road: '#061431',
  lane: '#2b4c8a',
  lime: '#a8e27c',
  limeDim: '#41713f',
  limeHead: '#f4ffe6',
  cyan: '#6ad5e7',
  blue: '#4aa8ff',
  post: '#2b4c8a',
  bush: '#24502f',
  bushHi: '#3a7a3e',
  lampGlow: '#8a7b45',
  lampPool: '#45507a',
  lampPoolHi: '#6f6f6a',
};

const AMBULANCE = [
  '..wwwwwwwwwwwwww........',
  '..wwwwwwwwwwwwwwwwww....',
  '..wwwwwwwwwwwwwwwgggww..',
  '..wwwwrwwwwwwwwwwgggwww.',
  '..wwwrrrwwwwwwwwwwwwwww.',
  '..wwwwrwwwwwwwwwwwwwwww.',
  '..RRRRRRRRRRRRRRRRRRRRR.',
  '.twwwwwwwwwwwwwwwwwwwwwy',
  '....kk..........kk......',
];
const AMB_PAL = { w: C.white, r: C.cross, R: C.cross, g: C.cyan, k: '#0a0f1e', y: C.warm, t: C.cross };

const DOCTOR = ['..hh..', '.hhhh.', '.ssss.', '..ss..', '.wcww.', 'wwcwww', 'wwcwww', 's.ww.s', '.wwww.', '.p..p.', '.k..k.'];
const DOCTOR_WAVE = ['..hh..s', '.hhhh.s', '.ssss.w', '..ss..w', '.wcwww.', 'wwcww..', 'wwcww..', 's.ww...', '.wwww..', '.p..p..', '.k..k..'];
const DOCTOR_PAL = { h: '#2a1a10', s: '#e0a878', w: C.white, c: C.cyan, p: '#1c2f5e', k: '#0a0f1e' };
const NURSE = ['.wwww.', '.hhhh.', '.ssss.', '..ss..', '.nnnn.', 'nnnnnn', 'nnnbbn', 's.nbb.', '.nnnn.', '.n..n.', '.k..k.'];
const NURSE_PAL = { w: C.white, h: '#1a1210', s: '#c98d62', n: C.cyan, b: '#d9a520', k: '#0a0f1e' };

/** 3x5 / 5x5 pixel letters for the rooftop sign. */
const GLYPHS: Record<string, string[]> = {
  M: ['x...x', 'xx.xx', 'x.x.x', 'x...x', 'x...x'],
  E: ['xxx', 'x..', 'xx.', 'x..', 'xxx'],
  D: ['xx.', 'x.x', 'x.x', 'x.x', 'xx.'],
  S: ['xxx', 'x..', 'xxx', '..x', 'xxx'],
  I: ['x', 'x', 'x', 'x', 'x'],
};

interface Layout {
  hx: number; // hospital centre
  voiceX: number; // where the ECG becomes a voice waveform
}

function layout(W: number): Layout {
  const hx = W < 260 ? Math.round(W * 0.5) : Math.round(W * 0.6);
  return { hx, voiceX: Math.max(hx + 54, Math.round(W * 0.82)) };
}

/** Lead II-ish beat: P wave, sharp QRS, rounded T wave. Negative is up. */
function ecg(x: number): number {
  const p = ((x % BEAT) + BEAT) % BEAT;
  if (p >= 3 && p <= 6) return [-1, -2, -2, -1][p - 3];
  if (p === 12) return 1;
  if (p === 13) return -6;
  if (p === 14) return -12;
  if (p === 15) return -3;
  if (p === 16) return 4;
  if (p === 17) return 1;
  if (p >= 24 && p <= 31) return [-1, -1, -2, -3, -3, -2, -1, -1][p - 24];
  return 0;
}

function windows(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, seed: number) {
  const r = rng(seed);
  for (let y = y0; y + 2 <= y1; y += 5) {
    for (let x = x0; x + 2 <= x1; x += 4) {
      const q = r();
      rect(ctx, x, y, 2, 2, q > 0.45 ? (q > 0.8 ? C.warm2 : C.warm) : C.winOff);
    }
  }
}

function wing(ctx: Ctx, x: number, top: number, w: number, seed: number) {
  rect(ctx, x, top - 2, w, 2, C.roof);
  rect(ctx, x, top, w, GROUND - top, C.wall);
  rect(ctx, x + w - 2, top, 2, GROUND - top, C.wallLo);
  rect(ctx, x, top, 1, GROUND - top, C.wallHi);
  windows(ctx, x + 3, top + 3, x + w - 3, GROUND - 3, seed);
}

function signWidth(word: string) {
  return [...word].reduce((n, ch) => n + GLYPHS[ch][0].length + 1, -1);
}

function sign(ctx: Ctx, word: string, x: number, y: number) {
  let cx = x;
  for (const ch of word) {
    const g = GLYPHS[ch];
    sprite(ctx, g, { x: C.lime }, cx, y);
    cx += g[0].length + 1;
  }
  return cx - x - 1;
}

function drawHospital(ctx: Ctx, hx: number) {
  wing(ctx, hx - 64, 52, 26, 3);
  wing(ctx, hx + 38, 50, 24, 4);

  // main block
  const mx = hx - 40;
  const mw = 80;
  const mt = 40;
  rect(ctx, mx, mt - 3, mw, 3, C.roof);
  rect(ctx, mx, mt - 4, mw, 1, C.wallHi);
  rect(ctx, mx, mt, mw, GROUND - mt, C.wall);
  rect(ctx, mx + mw - 3, mt, 3, GROUND - mt, C.wallLo);
  rect(ctx, mx, mt, 1, GROUND - mt, C.wallHi);
  for (let fy = mt + 6; fy < GROUND - 6; fy += 5) rect(ctx, mx, fy - 1, mw - 3, 1, C.wallHi);
  windows(ctx, mx + 4, mt + 3, hx - 13, GROUND - 8, 5);
  windows(ctx, hx + 13, mt + 3, mx + mw - 4, GROUND - 8, 6);

  // rooftop sign on the left of the roof, on two legs
  const sx = mx + 2;
  const w = signWidth('MEDSIM');
  ctx.globalAlpha = 0.18;
  rect(ctx, sx - 1, mt - 11, w + 2, 7, C.lime);
  ctx.globalAlpha = 1;
  sign(ctx, 'MEDSIM', sx, mt - 10);
  rect(ctx, sx + 3, mt - 5, 1, 1, C.post);
  rect(ctx, sx + w - 4, mt - 5, 1, 1, C.post);

  // tower with the cross
  const tx = hx - 12;
  const tw = 24;
  const tt = 20;
  rect(ctx, tx, tt - 2, tw, 2, C.roof);
  rect(ctx, tx, tt, tw, mt - tt, C.wall);
  rect(ctx, tx + tw - 2, tt, 2, mt - tt, C.wallLo);
  rect(ctx, tx, tt, 1, mt - tt, C.wallHi);
  rect(ctx, hx - 1, tt - 7, 1, 5, C.post);
  rect(ctx, hx - 1, tt - 8, 1, 1, C.cross);
  drawCross(ctx, hx, false);
  for (let y = mt + 3; y < GROUND - 12; y += 5) rect(ctx, hx - 1, y, 3, 2, C.warm2);

  // ER canopy and lit doors
  rect(ctx, hx - 11, 58, 22, 2, C.cross);
  rect(ctx, hx - 11, 60, 22, 1, C.crossLo);
  rect(ctx, hx - 10, 61, 1, 7, C.wallLo);
  rect(ctx, hx + 9, 61, 1, 7, C.wallLo);
  rect(ctx, hx - 6, 61, 12, 7, C.door);
  rect(ctx, hx, 61, 1, 7, C.doorLo);
  rect(ctx, hx - 6, 61, 12, 1, C.doorHi);
  ctx.globalAlpha = 0.35;
  rect(ctx, hx - 8, GROUND, 16, 2, C.door);
  ctx.globalAlpha = 0.18;
  rect(ctx, hx - 11, GROUND + 2, 22, 2, C.door);
  ctx.globalAlpha = 1;

  // bushes along the front
  for (const bx of [hx - 54, hx - 30, hx + 24, hx + 46]) {
    rect(ctx, bx, GROUND - 3, 6, 3, C.bush);
    rect(ctx, bx + 1, GROUND - 4, 4, 1, C.bushHi);
  }
}

function drawCross(ctx: Ctx, hx: number, lit: boolean) {
  const y = 23;
  rect(ctx, hx - 6, y, 13, 13, C.white);
  const c = lit ? C.crossHi : C.cross;
  rect(ctx, hx - 2, y + 2, 5, 9, c);
  rect(ctx, hx - 4, y + 4, 9, 5, c);
  rect(ctx, hx - 1, y + 3, 1, 2, lit ? C.white : C.crossHi);
}

function drawStatic(ctx: Ctx, W: number) {
  const { hx } = layout(W);
  const r = rng(11);

  // far skyline, dark and quiet so the hospital carries the scene
  let x = -4;
  while (x < W) {
    const w = 8 + Math.floor(r() * 16);
    const top = 40 + Math.floor(r() * 18);
    rect(ctx, x, top, w, GROUND - top, r() > 0.5 ? C.far0 : C.far1);
    rect(ctx, x, top, w, 1, C.farEdge);
    if (r() > 0.7) rect(ctx, x + Math.floor(w / 2), top - 4, 1, 4, C.farEdge);
    for (let wy = top + 3; wy < GROUND - 3; wy += 4) {
      for (let wx = x + 2; wx < x + w - 2; wx += 3) {
        const q = r();
        if (q > 0.94) rect(ctx, wx, wy, 1, 2, C.warm);
        else if (q > 0.76) rect(ctx, wx, wy, 1, 2, C.farLit);
      }
    }
    x += w;
  }

  // pavement and road
  rect(ctx, 0, GROUND, W, ROAD - GROUND, C.walk);
  rect(ctx, 0, GROUND, W, 1, C.walkHi);
  rect(ctx, 0, ROAD, W, H - ROAD, C.road);
  for (let lx = 2; lx < W; lx += 10) rect(ctx, lx, 78, 5, 1, C.lane);

  // street lamps, kept clear of the hospital
  for (let lx = 20; lx < W - 4; lx += 56) {
    if (Math.abs(lx - hx) < 72) continue;
    rect(ctx, lx, 50, 1, GROUND - 50, C.post);
    rect(ctx, lx, 49, 4, 1, C.post);
    rect(ctx, lx + 2, 50, 2, 1, C.warm2);
    rect(ctx, lx + 1, 51, 4, 1, C.lampGlow);
    rect(ctx, lx - 1, GROUND, 9, 1, C.lampPool);
    rect(ctx, lx + 1, GROUND, 5, 1, C.lampPoolHi);
  }

  drawHospital(ctx, hx);
}

interface Star {
  x: number;
  y: number;
  big: boolean;
  phase: number;
  speed: number;
}

const STARS: Star[] = (() => {
  const r = rng(99);
  const out: Star[] = [];
  for (let i = 0; i < 110; i++) {
    out.push({ x: r(), y: 2 + Math.floor(r() * 32), big: r() > 0.9, phase: r() * 6.28, speed: 0.5 + r() * 1.5 });
  }
  return out;
})();

function drawFrame(ctx: Ctx, W: number, t: number, base: HTMLCanvasElement, still: boolean) {
  const { hx, voiceX } = layout(W);
  ctx.clearRect(0, 0, W, H);

  // stars
  for (const s of STARS) {
    const x = Math.floor(s.x * W);
    const tw = still ? 0.8 : 0.5 + 0.5 * Math.sin(t * s.speed + s.phase);
    if (tw < 0.12) continue;
    ctx.globalAlpha = 0.3 + 0.7 * tw;
    rect(ctx, x, s.y, 1, 1, C.white);
    if (s.big && tw > 0.7) {
      ctx.globalAlpha = 0.45 * tw;
      rect(ctx, x - 1, s.y, 3, 1, C.white);
      rect(ctx, x, s.y - 1, 1, 3, C.white);
    }
  }
  ctx.globalAlpha = 1;

  // ECG: a dim full trace, a bright phosphor tail behind the sweep head and
  // a short erased gap in front of it, like a bedside monitor.
  const head = still ? voiceX : (t * 46) % (voiceX + 36);
  let prevY = ECG_Y;
  for (let x = 0; x < voiceX; x++) {
    const y = ECG_Y + ecg(x);
    const behind = head - x;
    if (!still && behind < 0 && behind > -6) {
      prevY = y;
      continue;
    }
    const hot = still || (behind >= 0 && behind < 80);
    ctx.globalAlpha = hot && !still ? Math.max(0.35, 1 - behind / 90) : 1;
    const y0 = Math.min(prevY, y);
    rect(ctx, x, y0, 1, Math.max(prevY, y) - y0 + 1, hot ? C.lime : C.limeDim);
    prevY = y;
  }
  ctx.globalAlpha = 1;
  if (!still && head < voiceX) {
    const hxh = Math.floor(head);
    const hy = ECG_Y + ecg(hxh);
    ctx.globalAlpha = 0.35;
    rect(ctx, hxh - 1, hy - 1, 3, 3, C.lime);
    ctx.globalAlpha = 1;
    rect(ctx, hxh, hy, 1, 1, C.limeHead);
  }

  // the trace becomes a voice: symmetric bars, enveloped at both ends
  for (let x = voiceX + 1; x < W; x += 2) {
    const i = (x - voiceX) / 2;
    const env = Math.min(1, i / 6) * Math.min(1, (W - x) / 24 + 0.3);
    const ph = still ? 0 : t;
    const n = 0.5 + 0.5 * Math.sin(i * 1.7 + ph * 8) * Math.sin(i * 0.31 - ph * 2.7);
    const h = Math.max(1, Math.round(env * n * 9));
    rect(ctx, x, ECG_Y - h, 1, h * 2 + 1, C.cyan);
  }

  ctx.drawImage(base, 0, 0);

  // the cross pulses each time the sweep passes an R wave
  const sinceR = (((head - 14) % BEAT) + BEAT) % BEAT;
  const glow = still ? 0.3 : head < voiceX ? Math.max(0, 1 - sinceR / 20) : 0;
  if (glow > 0.15) {
    const ring = glow > 0.55 ? C.crossHi : C.cross;
    rect(ctx, hx - 7, 22, 15, 1, ring);
    rect(ctx, hx - 7, 36, 15, 1, ring);
    rect(ctx, hx - 7, 22, 1, 15, ring);
    rect(ctx, hx + 7, 22, 1, 15, ring);
    if (glow > 0.55) {
      // second, broken ring for the peak of the beat
      for (let i = 0; i < 17; i += 2) {
        rect(ctx, hx - 8 + i, 21, 1, 1, C.cross);
        rect(ctx, hx - 8 + i, 37, 1, 1, C.cross);
        rect(ctx, hx - 8, 21 + i, 1, 1, C.cross);
        rect(ctx, hx + 8, 21 + i, 1, 1, C.cross);
      }
    }
    drawCross(ctx, hx, glow > 0.55);
  }

  // staff at the ER doors; the doctor waves now and then
  const waving = !still && t % 6 < 1.4 && Math.floor(t * 5) % 2 === 0;
  sprite(ctx, waving ? DOCTOR_WAVE : DOCTOR, DOCTOR_PAL, hx + 14, GROUND - 10);
  sprite(ctx, NURSE, NURSE_PAL, hx + 22, GROUND - 10);

  // ambulance: drives the road on a loop, parks by the doors when still
  const ax = still ? hx - 40 : Math.floor((t * 22) % (W + 120)) - 60;
  const ay = ROAD + 1;
  for (let i = 1; i < 14; i++) {
    const half = Math.floor(i / 5);
    for (let j = -half; j <= half; j++) {
      if ((i + j) % 2 === 0 && (i < 6 || (i * 7 + j * 3) % 5 < 2)) rect(ctx, ax + 23 + i, ay + 7 + j, 1, 1, i < 5 ? C.warm2 : C.warm);
    }
  }
  sprite(ctx, AMBULANCE, AMB_PAL, ax, ay);
  const beacon = still || Math.floor(t * 6) % 2 === 0 ? C.cross : C.blue;
  rect(ctx, ax + 7, ay - 1, 2, 1, beacon);
  rect(ctx, ax + 6, ay - 1, 1, 1, beacon);
  rect(ctx, ax + 9, ay - 1, 1, 1, beacon);
  rect(ctx, ax + 7, ay - 2, 2, 1, beacon);
}

/** Art-pixel size in CSS px: chunkier on wide screens, finer on phones. */
function pickScale(cssW: number) {
  if (cssW >= 1100) return 4;
  if (cssW >= 560) return 3;
  return 2;
}

export function FooterScene() {
  const wrapRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const wrap = wrapRef.current;
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!wrap || !canvas || !ctx) return;

    const motion = window.matchMedia('(prefers-reduced-motion: reduce)');
    let still = prefersReducedMotion();
    let W = 0;
    let base: HTMLCanvasElement | null = null;
    let raf = 0;
    let visible = false;
    let last = 0;
    let t = 3.2; // start mid-sweep so the first frame already reads
    let prevNow = 0;

    const paint = () => {
      if (base) drawFrame(ctx, W, t, base, still);
    };

    const size = () => {
      const cssW = wrap.clientWidth;
      if (!cssW) return;
      const scale = pickScale(cssW);
      const next = Math.ceil(cssW / scale);
      canvas.style.width = `${next * scale}px`;
      canvas.style.height = `${H * scale}px`;
      if (next === W && base) return;
      W = next;
      canvas.width = W;
      canvas.height = H;
      base = makeCanvas(W, H);
      const bctx = base.getContext('2d');
      if (bctx) drawStatic(bctx, W);
      paint();
    };

    const tick = (now: number) => {
      raf = requestAnimationFrame(tick);
      if (now - last < 1000 / FPS) return;
      // advance by real elapsed time, capped so a long pause does not jump
      t += Math.min(0.1, prevNow ? (now - prevNow) / 1000 : 0);
      prevNow = now;
      last = now;
      paint();
    };

    const start = () => {
      if (raf || still || !visible) return;
      prevNow = 0;
      raf = requestAnimationFrame(tick);
    };
    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
    };

    const onMotion = () => {
      still = motion.matches;
      if (still) stop();
      paint();
      start();
    };

    size();
    const ro = new ResizeObserver(size);
    ro.observe(wrap);
    const io = new IntersectionObserver(
      ([entry]) => {
        visible = entry.isIntersecting;
        if (visible) start();
        else stop();
      },
      { rootMargin: '80px 0px' },
    );
    io.observe(wrap);
    motion.addEventListener('change', onMotion);

    return () => {
      stop();
      ro.disconnect();
      io.disconnect();
      motion.removeEventListener('change', onMotion);
    };
  }, []);

  return (
    <div ref={wrapRef} className="footer-scene" aria-hidden="true">
      <canvas ref={canvasRef} className="footer-scene-canvas" />
    </div>
  );
}
