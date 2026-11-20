import { useEffect, useRef, type CSSProperties } from 'react';
import { disc, makeCanvas, rect, rng, sprite, type Ctx } from './draw';
import { prefersReducedMotion } from '../chrome';

/* A pixel-art hospital campus at night, drawn procedurally at 384×216 and
 * upscaled with image-rendering: pixelated. Five layers move at different
 * rates on scroll (parallax); stars twinkle, the rooftop cross glows, the
 * ambulance beacon flashes. All motion stops under reduced motion. */

export const W = 384;
export const H = 216;

const C = {
  sky0: '#0b1f4b',
  sky1: '#133d7e',
  sky2: '#1c61a1',
  sky3: '#2481aa',
  moon: '#e4f2b0',
  moonHi: '#f6fbdc',
  moonLo: '#c9df92',
  glow: '#e9f5b8',
  cross: '#e8505b',
  crossHi: '#ff8a8f',
  wall: '#8ea4d2',
  wallHi: '#a9bce3',
  wallLo: '#6c83b8',
  roof: '#4e669e',
  winOn: '#ffd76a',
  winOn2: '#ffeaa8',
  winOff: '#2f4a85',
  door: '#6ad5e7',
  far: '#16376f',
  farHi: '#1f4a8a',
  farWin: '#3f6fb3',
  lawn: '#2c5d33',
  lawnHi: '#3f7f40',
  tree: '#24502f',
  treeHi: '#3a7a3e',
  road: '#101d40',
  roadLine: '#c7cd9a',
  grass: '#5fa83a',
  grassHi: '#8fd15a',
  dirt: '#6b4a2a',
  dirtHi: '#8a6236',
  dirtLo: '#4a321c',
};

function mix(a: string, b: string, t: number): string {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',')})`;
}

function drawSky(ctx: Ctx) {
  // Posterised gradient: 14 flat steps, each a few pixels tall, the way
  // a pixel artist bands a sky instead of blending it.
  const stops = [C.sky0, C.sky1, C.sky2, C.sky3];
  const steps = 14;
  const top = 0;
  const bottom = 184;
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1);
    const seg = Math.min(stops.length - 2, Math.floor(t * (stops.length - 1)));
    const local = t * (stops.length - 1) - seg;
    const y0 = Math.round(top + ((bottom - top) * i) / steps);
    const y1 = Math.round(top + ((bottom - top) * (i + 1)) / steps);
    rect(ctx, 0, y0, W, y1 - y0, mix(stops[seg], stops[seg + 1], local));
  }
  rect(ctx, 0, bottom, W, H - bottom, C.sky3);

  // Moon glow: stacked translucent discs read as a soft halo once upscaled.
  const mx = 118;
  const my = 92;
  ctx.globalAlpha = 0.07;
  disc(ctx, mx, my, 74, C.glow);
  ctx.globalAlpha = 0.1;
  disc(ctx, mx, my, 62, C.glow);
  ctx.globalAlpha = 0.14;
  disc(ctx, mx, my, 53, C.glow);
  ctx.globalAlpha = 1;
  disc(ctx, mx, my, 46, C.moonLo);
  disc(ctx, mx - 2, my - 2, 44, C.moon);
  disc(ctx, mx - 14, my - 16, 14, C.moonHi);
  disc(ctx, mx - 18, my - 20, 6, '#fbfef0');
}

function drawFar(ctx: Ctx) {
  const r = rng(7);
  let x = 0;
  while (x < W) {
    const w = 10 + Math.floor(r() * 18);
    const h = 8 + Math.floor(r() * 22);
    const top = 170 - h;
    rect(ctx, x, top, w, H - top, r() > 0.5 ? C.far : C.farHi);
    for (let wy = top + 3; wy < 168; wy += 4) {
      for (let wx = x + 2; wx < x + w - 2; wx += 3) {
        if (r() > 0.78) rect(ctx, wx, wy, 1, 1, C.farWin);
      }
    }
    x += w + (r() > 0.7 ? 2 : 0);
  }
  // treeline in front of the far city
  for (let tx = 0; tx < W; tx += 3) {
    const th = 3 + Math.floor(r() * 5);
    rect(ctx, tx, 172 - th, 3, th + 6, C.tree);
  }
}

function windows(ctx: Ctx, x0: number, y0: number, x1: number, y1: number, seed: number, step = 6) {
  const r = rng(seed);
  for (let y = y0; y + 3 <= y1; y += step) {
    for (let x = x0; x + 3 <= x1; x += 5) {
      const lit = r() > 0.52;
      rect(ctx, x, y, 3, 3, lit ? (r() > 0.6 ? C.winOn2 : C.winOn) : C.winOff);
    }
  }
}

function block(ctx: Ctx, x: number, y: number, w: number, h: number, seed: number) {
  rect(ctx, x, y - 4, w, 4, C.roof);
  rect(ctx, x, y - 5, w, 1, C.wallHi);
  rect(ctx, x, y, w, h, C.wall);
  rect(ctx, x + w - 4, y, 4, h, C.wallLo);
  rect(ctx, x, y, 1, h, C.wallHi);
  windows(ctx, x + 4, y + 5, x + w - 6, y + h - 6, seed);
  // pilasters break the window grid into bays
  for (let px = x + 24; px < x + w - 8; px += 25) rect(ctx, px, y, 2, h, C.wallLo);
  // floor slabs
  for (let fy = y + 9; fy < y + h - 4; fy += 12) rect(ctx, x, fy, w - 4, 1, C.wallHi);
  // rooftop plant boxes
  const r = rng(seed + 100);
  for (let i = 0; i < 2; i++) {
    const bx = x + 4 + Math.floor(r() * (w - 14));
    rect(ctx, bx, y - 8, 6, 4, '#5f6f92');
    rect(ctx, bx, y - 8, 6, 1, '#8b9bbd');
  }
}

const TREE = ['..aaa..', '.aabaa.', 'aabbaaa', 'aaaaaaa', '.aaaaa.', '...t...', '...t...'];

const AMBULANCE = [
  '..wwwwwwwwwwwwww........',
  '..wwwwwwwwwwwwwwwwww....',
  '..wwwwwwwwwwwwwwwgggww..',
  '..wwwwrwwwwwwwwwwgggwww.',
  '..wwwrrrwwwwwwwwwwwwwww.',
  '..wwwwrwwwwwwwwwwwwwwww.',
  '..RRRRRRRRRRRRRRRRRRRRR.',
  '..wwwwwwwwwwwwwwwwwwwww.',
  '....kk..........kk......',
];

function drawCampus(ctx: Ctx) {
  // lawn plateau + road
  rect(ctx, 0, 176, W, 14, C.lawn);
  rect(ctx, 0, 176, W, 1, C.lawnHi);
  rect(ctx, 0, 190, W, 12, C.road);
  for (let x = 4; x < W; x += 12) rect(ctx, x, 195, 6, 1, C.roadLine);
  rect(ctx, 0, 202, W, H - 202, C.lawn);

  // wings, main block, tower
  block(ctx, 40, 130, 34, 46, 11);
  block(ctx, 196, 124, 42, 52, 12);
  block(ctx, 70, 112, 128, 64, 13);
  // tower
  rect(ctx, 112, 66, 40, 4, C.roof);
  rect(ctx, 112, 70, 40, 42, C.wall);
  rect(ctx, 146, 70, 6, 42, C.wallLo);
  rect(ctx, 112, 70, 1, 42, C.wallHi);
  windows(ctx, 128, 92, 146, 110, 21);
  // rooftop sign with the cross
  rect(ctx, 115, 73, 15, 15, '#f3f1e2');
  rect(ctx, 116, 74, 13, 13, '#ffffff');
  rect(ctx, 120, 75, 5, 11, C.cross);
  rect(ctx, 117, 78, 11, 5, C.cross);
  rect(ctx, 121, 76, 1, 3, C.crossHi);
  // helipad on the right wing
  rect(ctx, 206, 116, 22, 4, '#3c4f7d');
  rect(ctx, 213, 117, 1, 2, '#ffd76a');
  rect(ctx, 217, 117, 1, 2, '#ffd76a');
  rect(ctx, 214, 118, 3, 1, '#ffd76a');
  // entrance canopy + lit doors
  rect(ctx, 114, 160, 38, 3, C.cross);
  rect(ctx, 114, 163, 38, 1, '#a8323b');
  rect(ctx, 124, 165, 18, 11, C.door);
  rect(ctx, 132, 165, 1, 11, '#3aa6b8');
  rect(ctx, 124, 165, 18, 1, '#b8f1fa');
  // trees on the lawn
  const treePal = { a: C.tree, b: C.treeHi, t: '#3b2a1a' };
  [[18, 170], [30, 172], [246, 170], [262, 172], [278, 169]].forEach(([x, y]) =>
    sprite(ctx, TREE, treePal, x, y - 6),
  );
  // ambulance on the road
  sprite(ctx, AMBULANCE, { w: '#f3f1e2', r: C.cross, R: C.cross, g: '#6ad5e7', k: '#0a0f1e' }, 252, 184);
}

const DOCTOR = [
  '...hhh...',
  '..hhhhh..',
  '..hssss..',
  '..sssss..',
  '...sss...',
  '..wwcww..',
  '.wwwcwww.',
  '.wwtctww.',
  '.wwwcwww.',
  '.swwcwws.',
  '.swwwwws.',
  '..wwwww..',
  '..wwwww..',
  '..pp.pp..',
  '..pp.pp..',
  '..pp.pp..',
  '..pp.pp..',
  '.kkk.kkk.',
];

const PATIENT = [
  '..hhhh....',
  '.hhhhhh...',
  '.hsssss...',
  '.sssss....',
  '..sss.....',
  '.ggggg....',
  'gggggg....',
  'gsgggg....',
  'gggggggg..',
  '.gggggggg.',
  '......ss..',
  '......ss..',
  '......ss..',
  '.....kkk..',
];

function drawLedge(ctx: Ctx) {
  const r = rng(31);
  // stepped cliff: grass cap + dirt blocks
  const top = 188;
  const edge = 150;
  for (let x = 0; x < edge; x += 6) {
    const dip = x > edge - 24 ? Math.floor((x - (edge - 24)) / 6) * 3 : 0;
    const y = top + dip;
    rect(ctx, x, y, 6, H - y, C.dirt);
    for (let by = y + 5; by < H; by += 5) {
      rect(ctx, x, by, 6, 1, C.dirtLo);
      if (r() > 0.6) rect(ctx, x + 1, by + 1, 2, 2, C.dirtHi);
    }
    rect(ctx, x, y, 6, 3, C.grass);
    rect(ctx, x, y, 6, 1, C.grassHi);
    if (r() > 0.55) rect(ctx, x + 1 + Math.floor(r() * 4), y - 1, 1, 1, C.grassHi);
    // hanging moss
    if (r() > 0.6) rect(ctx, x + Math.floor(r() * 5), y + 3, 1, 2 + Math.floor(r() * 3), C.grass);
  }
  // flowers
  [[14, 186], [40, 187], [96, 187]].forEach(([x, y], i) => {
    rect(ctx, x, y, 1, 2, C.grass);
    rect(ctx, x - 1, y - 1, 3, 1, i % 2 ? '#f3c4dc' : '#9fd7f5');
  });
  // the doctor and the patient on the ledge, looking at the hospital
  sprite(ctx, DOCTOR, { h: '#2a1a10', s: '#e0a878', w: '#f3f1e2', c: '#6ad5e7', t: '#1d2433', p: '#1c2f5e', k: '#0a0f1e' }, 78, top - 18);
  sprite(ctx, PATIENT, { h: '#5b3a1e', s: '#c98d62', g: '#8fc6e8', k: '#e6e1cf' }, 58, top - 10);
}

/* Cloud: overlapping discs in four tones, bottom flattened. */
function drawCloud(w: number, h: number, seed: number): HTMLCanvasElement {
  const c = makeCanvas(w, h);
  const ctx = c.getContext('2d')!;
  const r = rng(seed);
  const puffs: Array<[number, number, number]> = [];
  const n = Math.max(5, Math.round(w / 9));
  for (let i = 0; i < n; i++) {
    const centre = 1 - Math.abs((i + 0.5) / n - 0.5) * 2; // taller in the middle
    const pr = Math.floor(h * (0.22 + centre * 0.26) + r() * 2);
    const x = Math.floor(((i + 0.5) / n) * (w - 4) + 2);
    puffs.push([Math.max(pr, Math.min(w - pr - 1, x)), h - pr - 1, pr]);
  }
  const tones = ['#8ea6d8', '#c3d2f0', '#ead9ea', '#fbf7ee'];
  tones.forEach((t, i) => puffs.forEach(([x, y, pr]) => disc(ctx, x - i, y - i, Math.max(1, pr - i), t)));
  ctx.clearRect(0, h - 2, w, 2);
  return c;
}

interface Cloud {
  x: number;
  y: number;
  w: number;
  h: number;
  seed: number;
  drift: number;
}

// All clouds live in the sky band, clear of every rooftop (tower top y 66,
// wings y 112+, far city y 140+), so none ever sits on the campus, road or
// grass. The hero crops the top ~40 rows on wide screens, so most sit low
// enough in the sky to stay visible there.
const CLOUDS: Cloud[] = [
  { x: 4, y: 50, w: 64, h: 18, seed: 3, drift: 14 },
  { x: 196, y: 14, w: 64, h: 18, seed: 5, drift: 18 },
  { x: 344, y: 92, w: 44, h: 14, seed: 6, drift: 10 },
  { x: 236, y: 42, w: 64, h: 20, seed: 8, drift: 10 },
  { x: 166, y: 55, w: 58, h: 18, seed: 12, drift: 8 },
];

const STARS = (() => {
  const r = rng(99);
  const out: Array<{ x: number; y: number; big: boolean; d: number }> = [];
  for (let i = 0; i < 46; i++) {
    const x = r() * W;
    const y = r() * 120;
    // keep the moon clear
    if (Math.hypot(x - 118, y - 92) < 56) continue;
    out.push({ x, y, big: r() > 0.86, d: r() * 4 });
  }
  return out;
})();

const pct = (v: number, of: number) => `${(v / of) * 100}%`;

function LayerCanvas({ draw }: { draw: (ctx: Ctx) => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const ctx = c.getContext('2d');
    if (!ctx) return;
    ctx.clearRect(0, 0, W, H);
    draw(ctx);
  }, [draw]);
  return <canvas ref={ref} width={W} height={H} className="px-canvas" aria-hidden="true" />;
}

function CloudSprite({ cloud }: { cloud: Cloud }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    ctx.drawImage(drawCloud(cloud.w, cloud.h, cloud.seed), 0, 0);
  }, [cloud]);
  const style: CSSProperties = {
    left: pct(cloud.x, W),
    top: pct(cloud.y, H),
    width: pct(cloud.w, W),
    ['--drift' as string]: `${cloud.drift}px`,
    animationDuration: `${8 + cloud.seed}s`,
  };
  return <canvas ref={ref} width={cloud.w} height={cloud.h} className="px-cloud" style={style} aria-hidden="true" />;
}

/** Parallax factors: how far each layer drifts per pixel scrolled. */
const DEPTH = { sky: 0.55, far: 0.42, campus: 0.3, clouds: 0.36, ledge: 0.08 } as const;

export function HospitalScene() {
  const layers = useRef<Record<keyof typeof DEPTH, HTMLDivElement | null>>({
    sky: null,
    far: null,
    campus: null,
    clouds: null,
    ledge: null,
  });

  useEffect(() => {
    if (prefersReducedMotion()) return;
    let raf = 0;
    const apply = () => {
      raf = 0;
      const y = Math.min(window.scrollY, window.innerHeight * 1.2);
      (Object.keys(DEPTH) as Array<keyof typeof DEPTH>).forEach((k) => {
        const el = layers.current[k];
        if (el) el.style.transform = `translate3d(0, ${(y * DEPTH[k]).toFixed(1)}px, 0)`;
      });
    };
    const onScroll = () => {
      if (!raf) raf = requestAnimationFrame(apply);
    };
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      window.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  const set = (k: keyof typeof DEPTH) => (el: HTMLDivElement | null) => {
    layers.current[k] = el;
  };

  return (
    <div className="px-scene" aria-hidden="true">
      <div className="px-stage">
        <div className="px-layer" ref={set('sky')}>
          <LayerCanvas draw={drawSky} />
          {STARS.map((s, i) => (
            <span
              key={i}
              className={`px-star ${s.big ? 'px-star--big' : ''}`}
              style={{ left: pct(s.x, W), top: pct(s.y, H), animationDelay: `${s.d}s` }}
            />
          ))}
        </div>
        <div className="px-layer" ref={set('far')}>
          <LayerCanvas draw={drawFar} />
        </div>
        <div className="px-layer" ref={set('campus')}>
          <LayerCanvas draw={drawCampus} />
          <span className="px-sign-glow" style={{ left: pct(122.5, W), top: pct(80.5, H) }} />
          <span className="px-beacon" style={{ left: pct(262, W), top: pct(182, H) }} />
          <span className="px-flicker" style={{ left: pct(84, W), top: pct(129, H) }} />
          <span className="px-flicker px-flicker--b" style={{ left: pct(209, W), top: pct(141, H) }} />
        </div>
        <div className="px-layer" ref={set('clouds')}>
          {CLOUDS.map((c) => (
            <CloudSprite key={c.seed} cloud={c} />
          ))}
        </div>
        <div className="px-layer" ref={set('ledge')}>
          <LayerCanvas draw={drawLedge} />
        </div>
      </div>
    </div>
  );
}
