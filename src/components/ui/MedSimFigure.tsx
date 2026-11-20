import { useEffect, useRef, useState } from 'react';

/*
 * MedSimFigure: an isometric consultation room drawn as SVG.
 *
 * An older patient in a kurta sits on an exam couch, the doctor leans in
 * with a stethoscope, a wall monitor sweeps a live ECG, and the charge-nurse
 * cart lists the orders the doctor speaks, one tool call at a time.
 *
 * Static geometry is built once (module scope) with a small isometric kit:
 * extruded plans for slabs and cylinders, prisms for parts lying on their
 * side, four-tone shading by facing, painted back to front. Moving parts are
 * plain SVG nodes updated from one rAF loop through refs, never re-rendered.
 */

type P2 = [number, number];
type P3 = [number, number, number];

interface Paths {
  fill: string;
  outline: string;
  crease: string;
  top: string;
  shades: string[];
  bevel?: string;
}

interface Plan {
  x: number;
  y: number;
  w: number;
  d: number;
  r?: number;
}

/* ── camera ─────────────────────────────────────────────────────────── */

const DEG = Math.PI / 180;
const AZ = 58 * DEG;
const EL = 30 * DEG;
const sA = Math.sin(AZ);
const cA = Math.cos(AZ);
const sE = Math.sin(EL);
const cE = Math.cos(EL);
const VIEW: P3 = [cA * cE, sA * cE, sE];
const VH: P2 = [cA, sA];
const LIGHT: P2 = [-sA, cA];
const W = 600;
const PAD = 12;

let OX = 0;
let OY = 0;
let K = 1;

const iso = ([x, y, z]: P3): P2 => [OX + (x * sA - y * cA) * K, OY + ((x * cA + y * sA) * sE - z * cE) * K];
const vec = ([x, y, z]: P3): P2 => [(x * sA - y * cA) * K, ((x * cA + y * sA) * sE - z * cE) * K];
const n1 = (v: number) => {
  const r = Math.round(v * 10) / 10;
  return Object.is(r, -0) ? '0' : String(r);
};
const n3 = (v: number) => String(Math.round(v * 1000) / 1000);
const pathOf = (pts: P2[], closed = false) =>
  pts.length ? pts.map(([x, y], i) => `${i ? 'L' : 'M'}${n1(x)} ${n1(y)}`).join('') + (closed ? 'Z' : '') : '';
const poly3 = (pts: P3[], closed = false) => pathOf(pts.map(iso), closed);
const seg3 = (a: P3, b: P3) => poly3([a, b]);
const add3 = (a: P3, b: P3): P3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub3 = (a: P3, b: P3): P3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul3 = (a: P3, s: number): P3 => [a[0] * s, a[1] * s, a[2] * s];
const lerp3 = (a: P3, b: P3, t: number): P3 => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const len3 = (a: P3) => Math.hypot(a[0], a[1], a[2]);
const dot3 = (a: P3, b: P3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/* ── kit: plans, extrusions, prisms ─────────────────────────────────── */

function roundedPlan({ x, y, w, d, r = 0 }: Plan, steps = 6): P2[] {
  const rad = Math.max(0, Math.min(r, w / 2, d / 2));
  const cs: [number, number, number][] = [
    [x + w - rad, y + rad, -90],
    [x + w - rad, y + d - rad, 0],
    [x + rad, y + d - rad, 90],
    [x + rad, y + rad, 180],
  ];
  const out: P2[] = [];
  for (const [cx, cy, start] of cs) {
    const count = rad > 0 ? steps : 0;
    for (let s = 0; s <= count; s++) {
      const a = (start + (count ? (90 * s) / count : 45)) * DEG;
      out.push([cx + rad * Math.cos(a), cy + rad * Math.sin(a)]);
    }
  }
  return out;
}

const circleRing = (cx: number, cy: number, r: number, steps = 28): P2[] =>
  Array.from({ length: steps }, (_, i) => {
    const a = (i / steps) * Math.PI * 2;
    return [cx + r * Math.cos(a), cy + r * Math.sin(a)] as P2;
  });

function signedArea(pts: P2[]) {
  let a = 0;
  for (let i = 0; i < pts.length; i++) {
    const [ax, ay] = pts[i];
    const [bx, by] = pts[(i + 1) % pts.length];
    a += ax * by - bx * ay;
  }
  return a / 2;
}

function hull(points: P2[]): P2[] {
  const s = [...points].sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  if (s.length < 3) return s;
  const cross = (o: P2, a: P2, b: P2) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lo: P2[] = [];
  for (const p of s) {
    while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
    lo.push(p);
  }
  const up: P2[] = [];
  for (let i = s.length - 1; i >= 0; i--) {
    const p = s[i];
    while (up.length >= 2 && cross(up[up.length - 2], up[up.length - 1], p) <= 0) up.pop();
    up.push(p);
  }
  return [...lo.slice(0, -1), ...up.slice(0, -1)];
}

function runsOf(flags: boolean[], want: boolean) {
  const n = flags.length;
  const runs: number[][] = [];
  const start = flags.findIndex((f, i) => f !== flags[(i + n - 1) % n]);
  if (start < 0) return flags[0] === want ? [Array.from({ length: n + 1 }, (_, i) => i % n)] : [];
  let run: number[] | null = null;
  for (let s = 0; s < n; s++) {
    const i = (start + s) % n;
    if (flags[i] === want) {
      if (!run) run = [i];
      run.push((i + 1) % n);
    } else if (run) {
      runs.push(run);
      run = null;
    }
  }
  if (run) runs.push(run);
  return runs;
}

function bucketOf(nx: number, ny: number) {
  const hl = Math.hypot(nx, ny) || 1;
  const lit = ((nx * LIGHT[0] + ny * LIGHT[1]) / hl + 1) / 2;
  return Math.min(3, Math.max(0, Math.floor(lit * 4)));
}

/** Vertical extrusion of a plan ring: four side tones by facing, lighter top. */
function extrude(ring: P2[], z: number, h: number, bevel = 0): Paths {
  const n = ring.length;
  const ccw = signedArea(ring) > 0;
  const normals = ring.map(([ax, ay], i) => {
    const [bx, by] = ring[(i + 1) % n];
    const dx = bx - ax;
    const dy = by - ay;
    const l = Math.hypot(dx, dy) || 1;
    return (ccw ? [dy / l, -dx / l] : [-dy / l, dx / l]) as P2;
  });
  const facing = normals.map(([nx, ny]) => nx * VH[0] + ny * VH[1] > 1e-9);
  const top = ring.map(([x, y]) => iso([x, y, z + h]));
  const bot = ring.map(([x, y]) => iso([x, y, z]));
  const outline: string[] = [];
  const crease: string[] = [];
  for (const run of runsOf(facing, false)) outline.push(pathOf(run.map((i) => top[i])));
  for (const run of runsOf(facing, true)) {
    crease.push(pathOf(run.map((i) => top[i])));
    if (h > 0) outline.push(pathOf(run.map((i) => bot[i])));
  }
  if (h > 0) for (let i = 0; i < n; i++) if (facing[(i + n - 1) % n] !== facing[i]) outline.push(pathOf([top[i], bot[i]]));
  const shades: string[][] = [[], [], [], []];
  if (h > 0) {
    for (let i = 0; i < n; i++) {
      if (!facing[i]) continue;
      const j = (i + 1) % n;
      shades[bucketOf(normals[i][0], normals[i][1])].push(pathOf([top[i], top[j], bot[j], bot[i]], true));
    }
  }
  let bev: string | undefined;
  if (bevel > 0) {
    const inset = ring.map(([x, y], i) => {
      const [ax, ay] = normals[(i + n - 1) % n];
      const [bx, by] = normals[i];
      const mx = ax + bx;
      const my = ay + by;
      const l = Math.hypot(mx, my) || 1;
      return iso([x - (mx / l) * bevel, y - (my / l) * bevel, z + h]);
    });
    bev = runsOf(facing, true)
      .map((run) => pathOf([top[run[0]], ...run.slice(1, -1).map((i) => inset[i]), top[run[run.length - 1]]]))
      .join('');
  }
  return {
    fill: pathOf(hull([...top, ...bot]), true),
    outline: outline.join(''),
    crease: crease.join(''),
    top: pathOf(top, true),
    shades: shades.map((s) => s.join('')),
    bevel: bev,
  };
}

const slab = (p: Plan, z: number, h: number, bevel = 0, steps = 6) => extrude(roundedPlan(p, steps), z, h, bevel);
const cyl = (cx: number, cy: number, r: number, z: number, h: number, steps = 28, bevel = 0) =>
  extrude(circleRing(cx, cy, r, steps), z, h, bevel);

/** A convex profile in the (u, z) plane extruded along x or y: rollers, wheels, wedges. */
function prism(profile: P2[], axis: 'x' | 'y', a: number, b: number, smooth = false): Paths {
  const at = (u: number, w: number, t: number): P3 => (axis === 'y' ? [u, t, w] : [t, u, w]);
  const n = profile.length;
  const cu = profile.reduce((s, p) => s + p[0], 0) / n;
  const cw = profile.reduce((s, p) => s + p[1], 0) / n;
  const ax: P3 = axis === 'y' ? [0, 1, 0] : [1, 0, 0];
  const faces: { pts: P3[]; nrm: P3; cap: boolean }[] = [
    { pts: profile.map(([u, w]) => at(u, w, b)), nrm: ax, cap: true },
    { pts: profile.map(([u, w]) => at(u, w, a)), nrm: mul3(ax, -1), cap: true },
  ];
  for (let i = 0; i < n; i++) {
    const [u0, w0] = profile[i];
    const [u1, w1] = profile[(i + 1) % n];
    let nu = w1 - w0;
    let nw = -(u1 - u0);
    if (nu * ((u0 + u1) / 2 - cu) + nw * ((w0 + w1) / 2 - cw) < 0) {
      nu = -nu;
      nw = -nw;
    }
    const l = Math.hypot(nu, nw) || 1;
    const nrm: P3 = axis === 'y' ? [nu / l, 0, nw / l] : [0, nu / l, nw / l];
    faces.push({ pts: [at(u0, w0, a), at(u1, w1, a), at(u1, w1, b), at(u0, w0, b)], nrm, cap: false });
  }
  const shades: string[][] = [[], [], [], []];
  const tops: string[] = [];
  const crease: string[] = [];
  const all: P2[] = [];
  for (const f of faces) {
    const pr = f.pts.map(iso);
    all.push(...pr);
    if (dot3(f.nrm, VIEW) <= 1e-6) continue;
    const d = pathOf(pr, true);
    if (f.nrm[2] > 0.55) tops.push(d);
    else shades[f.nrm[2] < -0.3 ? 0 : bucketOf(f.nrm[0], f.nrm[1])].push(d);
    if (!smooth || f.cap) crease.push(d);
  }
  const h = pathOf(hull(all), true);
  return { fill: h, outline: h, crease: crease.join(''), top: tops.join(''), shades: shades.map((s) => s.join('')) };
}

const circleProfile = (cu: number, cw: number, r: number, steps = 18): P2[] => circleRing(cu, cw, r, steps);

/* ── markup helpers ─────────────────────────────────────────────────── */

interface SolidOpts {
  inner?: string;
  crease?: boolean;
  ref?: string;
  cls?: string;
}

function solid(p: Paths, mat: string, o: SolidOpts = {}) {
  let s = `<g class="s ${mat}${o.cls ? ` ${o.cls}` : ''}"${o.ref ? ` data-ref="${o.ref}"` : ''}>`;
  s += `<path class="f" d="${p.fill}"/>`;
  p.shades.forEach((d, i) => {
    if (d) s += `<path class="sh${i}" d="${d}"/>`;
  });
  if (p.top) s += `<path class="tp" d="${p.top}"/>`;
  if (o.crease !== false && p.crease) s += `<path class="c" d="${p.crease}"/>`;
  if (p.bevel) s += `<path class="c" d="${p.bevel}"/>`;
  if (o.inner) s += o.inner;
  s += `<path class="e" d="${p.outline}"/>`;
  return `${s}</g>`;
}

const flat = (d: string, cls: string) => `<path class="${cls}" d="${d}"/>`;
const line = (d: string, tone = 'lo', extra = '') => (d ? `<path class="ln t-${tone}"${extra} d="${d}"/>` : '');
const dot = (p: P2, r: number, cls = 'dt') => `<circle class="${cls}" cx="${n1(p[0])}" cy="${n1(p[1])}" r="${r}"/>`;
const planD = (p: Plan, z: number, steps = 6) => pathOf(roundedPlan(p, steps).map(([x, y]) => iso([x, y, z])), true);
const shadow = (p: Plan) => `<path class="shd" d="${planD(p, 0)}"/>`;

/** Visible near half of a horizontal ring (seams round a cylinder). */
function sideArc(cx: number, cy: number, r: number, z: number, steps = 18) {
  const f = Math.atan2(VH[1], VH[0]);
  const pts: P3[] = [];
  for (let s = 0; s <= steps; s++) {
    const a = f - Math.PI / 2 + (s / steps) * Math.PI;
    pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a), z]);
  }
  return poly3(pts);
}

/** Affine map from a face's (u right, v down) coordinates onto a vertical face. */
function faceMatrix(origin: P3, face: 'y' | 'x') {
  const o = iso(origin);
  const u = vec(face === 'y' ? [1, 0, 0] : [0, -1, 0]);
  const v = vec([0, 0, -1]);
  return `matrix(${n3(u[0])} ${n3(u[1])} ${n3(v[0])} ${n3(v[1])} ${n3(o[0])} ${n3(o[1])})`;
}

/** Limb as a shaded capsule: edge, body, highlight on the lit side. */
function limbPaths(a: P3, b: P3, r: number) {
  const A = iso(a);
  const B = iso(b);
  let px = -(B[1] - A[1]);
  let py = B[0] - A[0];
  const l = Math.hypot(px, py) || 1;
  px /= l;
  py /= l;
  if (px > 0) {
    px = -px;
    py = -py;
  }
  const o = r * K * 0.42;
  const dx = ((B[0] - A[0]) / l) * o * 0.6;
  const dy = ((B[1] - A[1]) / l) * o * 0.6;
  const short = l > o * 2.4;
  const d = `M${n1(A[0])} ${n1(A[1])}L${n1(B[0])} ${n1(B[1])}`;
  const h = short
    ? `M${n1(A[0] + px * o + dx)} ${n1(A[1] + py * o + dy)}L${n1(B[0] + px * o - dx)} ${n1(B[1] + py * o - dy)}`
    : `M${n1(A[0] + px * o)} ${n1(A[1] + py * o)}l0 0`;
  return { d, h };
}

function limb(a: P3, b: P3, r: number, mat: string, ref?: string) {
  const { d, h } = limbPaths(a, b, r);
  const w = 2 * r * K;
  return (
    `<g class="limb ${mat}"${ref ? ` data-ref="${ref}"` : ''}>` +
    `<path class="lo" d="${d}" stroke-width="${n1(w + 1.6)}"/>` +
    `<path class="lf" d="${d}" stroke-width="${n1(w)}"/>` +
    `<path class="lh" d="${h}" stroke-width="${n1(r * K * 0.5)}"/></g>`
  );
}

function knob(p: P3, r: number, mat: string, ref?: string) {
  const [x, y] = iso(p);
  return `<circle class="knob ${mat}"${ref ? ` data-ref="${ref}"` : ''} cx="${n1(x)}" cy="${n1(y)}" r="${n1(r * K)}"/>`;
}

/* ── the model: timeline ─────────────────────────────────────────────── */

const LOOP = 12;
const STEPS = [
  { at: 0, label: 'Doctor asks' },
  { at: 2.6, label: 'Patient answers' },
  { at: 5.4, label: 'Nurse runs orders' },
  { at: 9.0, label: 'Vitals settle' },
];
const CHIP_AT = [6.1, 6.9, 7.7, 8.5];
const CHIPS = [
  { label: 'CBC', tool: 'order_test', held: false },
  { label: 'CRP', tool: 'order_test', held: false },
  { label: 'AMOXICILLIN', tool: '', held: true },
  { label: 'FOLLOW-UP 7D', tool: 'follow_up', held: false },
];
const STILL_T = 11.1;

const clamp01 = (v: number) => Math.min(1, Math.max(0, v));
const smooth = (v: number) => {
  const t = clamp01(v);
  return t * t * (3 - 2 * t);
};
const ramp = (t: number, a: number, b: number) => smooth((t - a) / (b - a));
const windowed = (t: number, a: number, b: number) => ramp(t, a, a + 0.35) * (1 - ramp(t, b - 0.35, b));
const stepOf = (t: number) => (t >= 9 ? 3 : t >= 5.4 ? 2 : t >= 2.6 ? 1 : 0);

function vitalsAt(t: number) {
  const settle = ramp(t, 9.0, 11.0) * (1 - ramp(t, 11.4, 12.0));
  const calls = t < 11.55 ? CHIP_AT.filter((c) => t >= c).length : 0;
  return { settle, hr: Math.round(108 - 16 * settle), spo2: Math.round(95 + 2 * settle), calls };
}

const readoutOf = (t: number) => {
  const v = vitalsAt(t);
  return `HR ${v.hr} bpm · SpO2 ${v.spo2}% · ${v.calls} tool call${v.calls === 1 ? '' : 's'}`;
};

/* ECG and pleth shapes for one beat, phase p in [0, 1). */
const gauss = (x: number, m: number, s: number) => Math.exp(-((x - m) ** 2) / (2 * s * s));
const ecgAt = (p: number) =>
  0.12 * gauss(p, 0.16, 0.025) - 0.13 * gauss(p, 0.27, 0.008) + gauss(p, 0.295, 0.009) - 0.3 * gauss(p, 0.32, 0.01) + 0.27 * gauss(p, 0.55, 0.045);
const plethAt = (p: number) => {
  const q = (p + 0.75) % 1;
  return 0.95 * gauss(q, 0.2, 0.075) + 0.32 * gauss(q, 0.45, 0.06);
};

/* ── the scene ──────────────────────────────────────────────────────── */

// Doctor: stands at the couch foot, facing -x towards the patient.
const DX = 154;
const DY = 37;
const D_SHOULDER: P3 = [DX + 0.2, 46.6, 65.2];
const D_NECK: P3 = [DX - 1.2, 40.4, 70.2];
const D_REST: P3 = [DX - 2.6, 50.4, 45.4];
const DISC_ON_CHEST: P3 = [125.6, 40.2, 50.4];
const HAND_FROM_DISC: P3 = [3.2, 1.8, 0.6];
const LEAN: P3 = [-2.6, 0, -1.7];
const ARM_U = 14.5;
const ARM_F = 15.5;

// Monitor screen face (+y face of the wall monitor), u right, v down.
const MON_FACE: P3 = [22, 20.5, 88];
const ECG = { u0: 3, u1: 20.4, base: 8.4, amp: 4.4, n: 120, sweep: 2.6 };
const PL = { base: 19.4, amp: 3.1 };
// Cart screen face.
const CART_FACE: P3 = [3, 78, 84];
const CHIP_TOP = (i: number) => 9.8 + i * 5.0;
// Speech wave between the two faces.
const WAVE_X = [133.6, 141.4];
const WAVE_Y = 36.4;
const CLOCK: P3 = [96, 6.8, 82];

interface Scene {
  svg: string;
  H: number;
}

let SCENE: Scene | null = null;

function fit() {
  const pts: P3[] = [
    [0, 0, 98],
    [184, 0, 98],
    [0, 63, 98],
    [0, 96, -15],
    [184, 96, -15],
    [184, 0, -15],
    [3, 78, 84],
  ];
  OX = 0;
  OY = 0;
  K = 1;
  const f = pts.map(iso);
  const xs = f.map((p) => p[0]);
  const ys = f.map((p) => p[1]);
  const l = Math.min(...xs);
  const r = Math.max(...xs);
  const u = Math.min(...ys);
  const d = Math.max(...ys);
  K = (W - PAD * 2) / (r - l);
  const H = Math.round((d - u) * K + PAD * 2);
  OX = W / 2 - ((l + r) / 2) * K;
  OY = H / 2 - ((u + d) / 2) * K;
  return H;
}

function build(): Scene {
  const H = fit();
  const o: string[] = [];
  const FLOOR: Plan = { x: 0, y: 0, w: 184, d: 96, r: 3 };

  /* base: halo, feet, floor slab, vinyl, seams, screws, label plate */
  o.push(`<path class="halo" d="${slab(FLOOR, -14, 12).fill}"/>`);
  const feet: P2[] = [
    [14, 14],
    [170, 14],
    [14, 82],
    [170, 82],
  ];
  for (const [x, y] of feet) {
    o.push(solid(cyl(x, y, 7.4, -15, 1.6, 28), 'm-navy'));
    o.push(solid(cyl(x, y, 5.6, -13.4, 5.4, 28), 'm-steel'));
  }
  o.push(solid(slab(FLOOR, -8, 8, 1.4, 4), 'm-navy', { inner: line(sideSeamPlan(FLOOR, -4.2), 'faint') }));
  const VINYL: Plan = { x: 4, y: 4, w: 176, d: 88, r: 1.5 };
  o.push(flat(planD(VINYL, 0), 'vinyl'));
  let seams = '';
  for (const x of [44, 84, 124, 164]) seams += seg3([x, 5, 0], [x, 92, 0]);
  for (const y of [34, 63]) seams += seg3([5, y, 0], [180, y, 0]);
  o.push(line(seams, 'faint'));
  o.push(line(planD(VINYL, 0), 'lo'));
  for (const [x, y] of [
    [175, 91],
    [9, 91],
    [175, 9],
  ] as P2[]) {
    o.push(line(planD({ x: x - 1.8, y: y - 1.8, w: 3.6, d: 3.6, r: 1.8 }, 0, 4), 'lo'));
    o.push(dot(iso([x, y, 0]), 0.7));
  }
  // engraved plate on the floor's front face
  const plateM = faceMatrix([12, 96, 0], 'y');
  o.push(
    `<g transform="${plateM}"><rect class="plate" x="0" y="1.4" width="30" height="5" rx="0.6"/>` +
      `<circle class="pscrew" cx="1.6" cy="3.9" r="0.55"/><circle class="pscrew" cx="28.4" cy="3.9" r="0.55"/>` +
      `<text class="ptext" x="15" y="5.2" font-size="3.6" text-anchor="middle">EXAM 03</text></g>`,
  );

  /* walls: back (y = 0) and left (x = 0), with skirting and dado rail */
  const BACK: Plan = { x: 0, y: 0, w: 184, d: 5 };
  const LEFT: Plan = { x: 0, y: 5, w: 5, d: 58 };
  o.push(solid(slab(BACK, 0, 96, 0.8, 1), 'm-wall'));
  o.push(solid(slab(LEFT, 0, 96, 0.8, 1), 'm-wall'));
  o.push(solid(slab({ x: 5, y: 5, w: 179, d: 1 }, 0, 4.5), 'm-navy', { crease: false }));
  o.push(solid(slab({ x: 5, y: 6, w: 1, d: 57 }, 0, 4.5), 'm-navy', { crease: false }));
  o.push(solid(slab({ x: 5, y: 5, w: 179, d: 1.4 }, 34, 2.6), 'm-wallhi'));
  o.push(solid(slab({ x: 5, y: 6.4, w: 1.4, d: 56.6 }, 34, 2.6), 'm-wallhi'));
  // wall panel joints, floor to dado and dado to cap
  let joints = '';
  for (const x of [62, 124]) joints += seg3([x, 5, 4.5], [x, 5, 34]) + seg3([x, 5, 36.6], [x, 5, 96]);
  o.push(line(joints, 'faint'));

  // poster on the left wall: a cross and printed rules
  const posterM = faceMatrix([5.8, 34, 76], 'x');
  o.push(solid(slab({ x: 5, y: 15, w: 0.8, d: 19 }, 52, 24), 'm-cream'));
  o.push(
    `<g transform="${posterM}"><path class="pcross" d="M8 3.4h3v3h3v3h-3v3H8v-3H5v-3h3z"/>` +
      `<path class="prule" d="M3 15.4h13M3 17.8h10M3 20.2h12"/></g>`,
  );
  o.push(solid(slab({ x: 5, y: 47, w: 0.9, d: 3.6, r: 0.4 }, 45, 5.4), 'm-cream'));

  // gas rail, flowmeter and suction jar
  o.push(solid(slab({ x: 56, y: 5, w: 40, d: 2.2, r: 0.6 }, 55, 3), 'm-steel'));
  o.push(solid(slab({ x: 63.5, y: 7.2, w: 5, d: 3, r: 0.8 }, 46, 9), 'm-steel'));
  o.push(solid(cyl(66, 11.6, 1.5, 47.5, 6.5, 16), 'm-glass'));
  o.push(solid(cyl(66, 8.7, 1.6, 55, 2.2, 16), 'm-lime'));
  o.push(solid(slab({ x: 82.5, y: 7.2, w: 3, d: 2, r: 0.4 }, 52, 3), 'm-steel'));
  o.push(solid(cyl(84, 11.5, 3.4, 42, 10, 24, 0.5), 'm-glass', { inner: line(sideArc(84, 11.5, 3.4, 46), 'lo') }));
  o.push(solid(cyl(84, 11.5, 3.6, 52, 1.6, 24), 'm-navy'));

  // window with a night sky, frame, mullions and sill
  o.push(solid(slab({ x: 106, y: 5, w: 42, d: 1.2 }, 50, 38), 'm-wallhi'));
  const winM = faceMatrix([108, 6.4, 86], 'y');
  o.push(
    `<g transform="${winM}"><rect class="sky" x="0" y="0" width="38" height="34"/>` +
      `<circle class="moon" cx="29" cy="8" r="3.2"/><circle class="star" cx="8" cy="6" r="0.5"/><circle class="star" cx="17" cy="11" r="0.4"/><circle class="star" cx="34" cy="20" r="0.4"/>` +
      `<path class="city" d="M0 34V26h5v-3h4v5h5v-7h6v4h4v-2h6v6h4v-6h4V34Z"/>` +
      `<path class="glint" d="M3 30 13 4h3L6 30ZM20 30 27 12h1.6L21.6 30Z"/>` +
      `<path class="mullion" d="M19 0V34M0 17H38"/><rect class="wframe" x="0" y="0" width="38" height="34"/></g>`,
  );
  o.push(solid(slab({ x: 104.6, y: 5, w: 44.8, d: 3.4, r: 0.6 }, 48.4, 1.8, 0.4), 'm-cream'));

  // wall clock
  o.push(solid(prism(circleProfile(CLOCK[0], CLOCK[2], 6.6, 32), 'y', 5, 6.6, true), 'm-cream'));
  let ticks = '';
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const r0 = i % 3 === 0 ? 4.4 : 5.0;
    ticks += seg3([CLOCK[0] + Math.sin(a) * r0, 6.7, CLOCK[2] + Math.cos(a) * r0], [CLOCK[0] + Math.sin(a) * 5.7, 6.7, CLOCK[2] + Math.cos(a) * 5.7]);
  }
  o.push(line(ticks, 'dark'));
  o.push(line(seg3([CLOCK[0], 6.7, CLOCK[2]], [CLOCK[0] + 2.2, 6.7, CLOCK[2] + 2.6]), 'dark', ' stroke-width="1.4"'));
  o.push(line(seg3([CLOCK[0], 6.7, CLOCK[2]], [CLOCK[0] - 3.8, 6.7, CLOCK[2] + 1.1]), 'dark', ' stroke-width="1.1"'));
  o.push(`<path class="ln t-red" data-ref="clockS" d=""/>`);
  o.push(dot(iso([CLOCK[0], 6.7, CLOCK[2]]), 0.9, 'dt-dark'));

  /* wall monitor on its arm */
  let mon = '';
  mon += solid(slab({ x: 34, y: 5, w: 12, d: 1.5, r: 0.6 }, 68, 15), 'm-navy');
  mon += dot(iso([36, 6.5, 81]), 0.6) + dot(iso([44, 6.5, 81]), 0.6) + dot(iso([36, 6.5, 70]), 0.6) + dot(iso([44, 6.5, 70]), 0.6);
  mon += solid(slab({ x: 37.5, y: 6.5, w: 5, d: 6.4, r: 0.8 }, 72.5, 4), 'm-steel');
  mon += solid(cyl(40, 9.7, 2.6, 71.8, 5.4, 18), 'm-steel', { inner: line(sideArc(40, 9.7, 2.6, 74.5), 'lo') });
  mon += solid(slab({ x: 31, y: 14.5, w: 16, d: 3, r: 1.4 }, 88, 2.6), 'm-navy');
  mon += solid(slab({ x: 22, y: 12.5, w: 34, d: 8, r: 1.5 }, 62, 26, 0.8), 'm-case', { cls: 'mon-case' });
  mon += solid(cyl(51.8, 16.5, 1.3, 88, 1.5, 16), 'm-red', { ref: 'alarm' });
  mon += solid(prism(circleProfile(16.5, 70, 1.8, 16), 'x', 56, 57.8, true), 'm-steel');
  mon += solid(prism(circleProfile(16.5, 76, 1.2, 14), 'x', 56, 57.2, true), 'm-steel');
  // screen content in the face plane
  let ui = `<rect class="scr" x="1.6" y="1.6" width="30.8" height="20.2" rx="0.6"/>`;
  ui += `<path class="grid" d="M${ECG.u0} 4.8H${ECG.u1}M${ECG.u0} ${ECG.base}H${ECG.u1}M${ECG.u0} 12H${ECG.u1}M${ECG.u0} 16.2H${ECG.u1}M21.4 2.8V20.6"/>`;
  ui += `<text class="mt mt-mute" x="3.2" y="4" font-size="2.2">II</text>`;
  ui += `<path class="ecg" data-ref="ecg" d=""/><circle class="ecg-head" data-ref="ecgHead" r="0.55" cx="0" cy="0"/>`;
  ui += `<path class="pleth" data-ref="pleth" d=""/>`;
  ui += `<text class="mt" data-ref="hrLbl" x="22.4" y="4.9" font-size="2.6">HR</text>`;
  ui += `<g data-ref="heart" transform="translate(27.6 3.9)"><path class="heart" d="M0 1C-1.6-0.1-1.1-1.5 0-0.7C1.1-1.5 1.6-0.1 0 1Z"/></g>`;
  ui += `<text class="mt mt-big" data-ref="hr" x="31.6" y="11.9" font-size="7.2" text-anchor="end">108</text>`;
  ui += `<text class="mt mt-cyan" x="22.4" y="16" font-size="2.6">SpO2</text>`;
  ui += `<text class="mt mt-cyan" data-ref="spo2" x="31.6" y="20.9" font-size="5.6" text-anchor="end">95</text>`;
  for (let i = 0; i < 4; i++) ui += `<rect class="btn" x="${3 + i * 4.4}" y="22.7" width="3" height="1.5" rx="0.4"/>`;
  ui += `<circle class="pwr" cx="30.6" cy="23.5" r="0.7"/>`;
  mon += `<g transform="${faceMatrix(MON_FACE, 'y')}">${ui}</g>`;
  o.push(`<g data-hit="monitor">${mon}</g>`);

  // sharps box and sanitizer on the back wall, pedal bin below
  o.push(solid(slab({ x: 154, y: 5, w: 6.5, d: 4, r: 0.8 }, 50, 13), 'm-cream'));
  o.push(solid(slab({ x: 156, y: 9, w: 2.4, d: 1.4, r: 0.4 }, 49, 2.4), 'm-teal'));
  o.push(solid(slab({ x: 165, y: 5, w: 11, d: 4.4, r: 0.6 }, 38, 8), 'm-gold'));
  o.push(solid(slab({ x: 165, y: 5, w: 11, d: 4.4, r: 0.6 }, 46, 1.6), 'm-red'));
  o.push(shadow({ x: 165, y: 8, w: 13, d: 13, r: 6 }));
  o.push(solid(cyl(171.5, 14.5, 5.6, 0, 15, 28), 'm-steel', { inner: line(sideArc(171.5, 14.5, 5.6, 3), 'lo') }));
  o.push(solid(cyl(171.5, 14.5, 5.9, 15, 1.8, 28, 0.5), 'm-navy'));
  o.push(solid(slab({ x: 169.5, y: 19.6, w: 4, d: 2.4, r: 0.5 }, 0.4, 1.2), 'm-navy'));

  /* exam couch */
  o.push(shadow({ x: 40, y: 10, w: 98, d: 36, r: 3 }));
  o.push(solid(slab({ x: 66, y: 16, w: 46, d: 22, r: 3 }, 0, 2.6, 0.6), 'm-navy'));
  o.push(solid(cyl(89, 27, 5.5, 2.6, 11, 28), 'm-steel', { inner: line(sideArc(89, 27, 5.5, 7.6), 'lo') }));
  o.push(solid(cyl(89, 27, 6.6, 12.6, 3.4, 28), 'm-navy'));
  o.push(solid(prism(circleProfile(39.6, 30, 3.2, 18), 'y', 15, 41, true), 'm-cream'));
  o.push(solid(slab({ x: 37.6, y: 13.4, w: 4, d: 1.6, r: 0.4 }, 19, 12), 'm-steel'));
  o.push(solid(slab({ x: 42, y: 12, w: 94, d: 32, r: 2 }, 16, 4.5, 0.6), 'm-steel'));
  o.push(
    solid(
      prism(
        [
          [43, 20.5],
          [64, 20.5],
          [64, 27.5],
          [43, 35],
        ],
        'y',
        12.6,
        43.4,
      ),
      'm-blue',
    ),
  );
  o.push(solid(slab({ x: 37.6, y: 41, w: 4, d: 1.6, r: 0.4 }, 19, 12), 'm-steel'));
  o.push(solid(slab({ x: 64, y: 12.6, w: 71, d: 30.8, r: 3 }, 20.5, 7, 0.9), 'm-blue'));
  o.push(flat(planD({ x: 66, y: 16.6, w: 69, d: 23.6 }, 27.6, 2), 'paper'));
  o.push(line(planD({ x: 66, y: 16.6, w: 69, d: 23.6 }, 27.6, 2), 'paper-e'));
  // step stool
  o.push(shadow({ x: 106, y: 46, w: 31, d: 16, r: 2 }));
  o.push(solid(slab({ x: 108, y: 47, w: 28, d: 13, r: 1.5 }, 0, 9.5, 0.6), 'm-navy'));
  o.push(solid(slab({ x: 109, y: 48, w: 26, d: 11, r: 1.2 }, 9.5, 0.8), 'm-hair'));
  let tread = '';
  for (const y of [50.5, 53, 55.5]) tread += seg3([109.6, y, 10.3], [134.4, y, 10.3]);
  o.push(line(tread, 'faint'));

  /* SpO2 lead from the monitor to the patient's finger */
  const leadPts: P3[] = [];
  const L0: P3 = [56, 19, 63];
  const L1: P3 = [82, 48, 18];
  const L2: P3 = [114.6, 46.4, 36.4];
  for (let i = 0; i <= 24; i++) {
    const t = i / 24;
    leadPts.push(add3(add3(mul3(L0, (1 - t) ** 2), mul3(L1, 2 * t * (1 - t))), mul3(L2, t * t)));
  }
  o.push(`<path class="cable" d="${poly3(leadPts)}"/>`);
  o.push(dot(iso(L0), 1.2, 'plug'));

  /* patient: an older man in a mustard kurta, seated on the couch edge */
  const PX = 122;
  o.push(solid(slab({ x: 114.3, y: 45.4, w: 5.8, d: 9.8, r: 2 }, 10.3, 2.2), 'm-sandal'));
  o.push(solid(slab({ x: 124.3, y: 45.4, w: 5.8, d: 9.8, r: 2 }, 10.3, 2.2), 'm-sandal'));
  o.push(solid(slab({ x: 115, y: 48, w: 4.4, d: 6, r: 1.8 }, 12.5, 1.6), 'm-skinA'));
  o.push(solid(slab({ x: 125, y: 48, w: 4.4, d: 6, r: 1.8 }, 12.5, 1.6), 'm-skinA'));
  o.push(solid(cyl(117.2, 48.4, 3.0, 13.6, 16, 24), 'm-pyjama', { inner: line(sideArc(117.2, 48.4, 3, 16), 'faint') }));
  o.push(solid(cyl(127.2, 48.4, 3.0, 13.6, 16, 24), 'm-pyjama', { inner: line(sideArc(127.2, 48.4, 3, 16), 'faint') }));
  o.push(solid(slab({ x: 112, y: 26, w: 20, d: 14, r: 3 }, 27.8, 6.4, 0.6), 'm-kurta'));
  o.push(solid(slab({ x: 112.4, y: 33, w: 9.2, d: 15, r: 3 }, 27.8, 6.8, 0.6), 'm-kurta'));
  o.push(solid(slab({ x: 122.4, y: 33, w: 9.2, d: 15, r: 3 }, 27.8, 6.8, 0.6), 'm-kurta'));
  o.push(limb([112.6, 33.5, 54], [111.2, 37.6, 43.4], 2.5, 'm-kurta'));
  // torso with band collar, placket and buttons
  const TORSO: Plan = { x: 113, y: 27.5, w: 18, d: 11.5, r: 3.2 };
  const kurtaM = faceMatrix([113, 39, 56], 'y');
  const kurtaUi =
    `<g transform="${kurtaM}"><path class="kplacket" d="M7.6 0.2V9.4H10.4V0.2"/>` +
    `<circle class="kbtn" cx="9" cy="3" r="0.45"/><circle class="kbtn" cx="9" cy="5.4" r="0.45"/><circle class="kbtn" cx="9" cy="7.8" r="0.45"/>` +
    `<path class="kprint" d="M2.6 13.6h.01M5.6 15.4h.01M12.4 15.4h.01M15.4 13.6h.01M2.6 18.6h.01M5.6 20.4h.01M12.4 20.4h.01M15.4 18.6h.01"/></g>`;
  o.push(solid(slab(TORSO, 34, 22, 0.8), 'm-kurta', { inner: kurtaUi }));
  o.push(solid(slab({ x: 117, y: 29.2, w: 10, d: 8.4, r: 3 }, 56, 1.6), 'm-kurtadk'));
  o.push(solid(cyl(PX, 33.2, 2.6, 56.6, 3, 20), 'm-skinA'));
  o.push(solid(cyl(PX, 31.2, 6.0, 63, 7.6, 28), 'm-hair'));
  o.push(solid(cyl(PX, 33.4, 6.3, 58.8, 12.6, 30, 0.8), 'm-skinA'));
  o.push(solid(cyl(PX - 0.1, 32.4, 6.5, 70.2, 2.6, 30, 1.1), 'm-hair'));
  o.push(solid(slab({ x: 127.8, y: 32, w: 1.6, d: 2.8, r: 0.7 }, 63, 4), 'm-skinA'));
  // face: eyes, brows, moustache, mouth
  const headY = (x: number) => 33.4 + Math.sqrt(Math.max(0, 6.3 ** 2 - (x - PX) ** 2));
  for (const ex of [119.6, 124.4]) {
    o.push(dot(iso([ex, headY(ex) + 0.05, 66.2]), 0.85, 'eye'));
    o.push(line(seg3([ex - 1.1, headY(ex - 1.1) + 0.05, 67.8], [ex + 1.1, headY(ex + 1.1) + 0.05, 67.8]), 'brow'));
  }
  o.push(line(poly3([[119.9, headY(119.9) + 0.1, 64.4], [122, headY(122) + 0.1, 64.9], [124.1, headY(124.1) + 0.1, 64.4]]), 'stache'));
  o.push(
    `<g transform="${faceMatrix([120.7, headY(120.7) + 0.05, 63.5], 'y')}"><path class="mouth" data-ref="pMouth" d="M0 0h2.6v0.4H0z"/></g>`,
  );
  // right arm resting on the right thigh, left forearm with the SpO2 clip
  o.push(limb([131.4, 33.5, 54], [132.6, 37.6, 43.4], 2.5, 'm-kurta'));
  o.push(limb([132.6, 37.6, 43.4], [128.4, 44.6, 36.2], 2.1, 'm-skinA'));
  o.push(limb(lerp3([132.6, 37.6, 43.4], [128.4, 44.6, 36.2], 0.14), lerp3([132.6, 37.6, 43.4], [128.4, 44.6, 36.2], 0.24), 2.6, 'm-kurta'));
  o.push(knob([128.4, 44.6, 36.2], 2.2, 'm-skinA'));
  o.push(limb([111.2, 37.6, 43.4], [115.8, 44.6, 36.2], 2.1, 'm-skinA'));
  o.push(limb(lerp3([111.2, 37.6, 43.4], [115.8, 44.6, 36.2], 0.14), lerp3([111.2, 37.6, 43.4], [115.8, 44.6, 36.2], 0.24), 2.6, 'm-kurta'));
  o.push(knob([115.8, 44.6, 36.2], 2.2, 'm-skinA'));
  o.push(solid(slab({ x: 113.4, y: 45, w: 3.2, d: 3, r: 0.8 }, 35.4, 2.4), 'm-steel'));
  o.push(`<circle class="spo2led" data-ref="spo2Led" cx="${n1(iso([115, 48.05, 36.6])[0])}" cy="${n1(iso([115, 48.05, 36.6])[1])}" r="1.1"/>`);

  /* doctor: Indian, white coat over teal scrubs, stethoscope */
  o.push(shadow({ x: DX - 7, y: 27, w: 15, d: 20, r: 6 }));
  o.push(solid(slab({ x: DX - 6.4, y: 29, w: 11.8, d: 5, r: 1.8 }, 0, 3, 0.4), 'm-hair'));
  o.push(solid(cyl(DX + 0.5, 31.5, 3.2, 3, 37, 24), 'm-scrub'));
  o.push(solid(slab({ x: DX - 6.4, y: 40, w: 11.8, d: 5, r: 1.8 }, 0, 3, 0.4), 'm-hair'));
  o.push(solid(cyl(DX + 0.5, 42.5, 3.2, 3, 37, 24), 'm-scrub', { inner: line(sideArc(DX + 0.5, 42.5, 3.2, 8), 'faint') }));
  const tailM = faceMatrix([DX - 5.5, 47.5, 44], 'y');
  o.push(
    solid(slab({ x: DX - 5.5, y: 27, w: 12, d: 20.5, r: 3 }, 29, 15, 0.6), 'm-coat', {
      inner: `<g transform="${tailM}"><path class="pocket" d="M2.2 3.4h6v6.6h-6z"/></g>` + line(seg3([DX + 6.5, 37.25, 29], [DX + 6.5, 37.25, 44]), 'coat-l'),
    }),
  );
  o.push(solid(slab({ x: DX - 1.6, y: 47.5, w: 1, d: 0.8, r: 0.3 }, 38.6, 4.2), 'm-cyan'));
  o.push(`<path class="tube" data-ref="tube" d=""/>`);
  let up = '';
  up += limb([DX, 28, 65], [DX - 2, 25.4, 54], 2.7, 'm-coat');
  up += limb([DX - 2, 25.4, 54], [DX - 4, 26.6, 45.6], 2.4, 'm-coat');
  up += knob([DX - 4.2, 26.8, 44.6], 2.2, 'm-skinB');
  const backM = faceMatrix([DX + 6.5, 47, 68.5], 'x');
  up += solid(slab({ x: DX - 5.5, y: 27.5, w: 12, d: 19.5, r: 3.6 }, 42, 26.5, 0.8), 'm-coat', {
    inner: `<g transform="${backM}"><path class="coat-seam" d="M9.75 0V20.5"/></g>`,
  });
  up += solid(slab({ x: DX + 6.3, y: 31.2, w: 1, d: 12, r: 0.4 }, 46, 2.2), 'm-coat');
  up += dot(iso([DX + 7.3, 33, 47.1]), 0.6, 'dt-dark') + dot(iso([DX + 7.3, 41.4, 47.1]), 0.6, 'dt-dark');
  up += solid(slab({ x: DX - 4.5, y: 30, w: 11, d: 14, r: 3 }, 68.5, 2, 0.4), 'm-coat');
  up += solid(cyl(DX, DY, 2.9, 69, 3.6, 20), 'm-skinB');
  // stethoscope across the back of the neck
  const loop: P3[] = [];
  for (let a = -30; a <= 100; a += 10) loop.push([DX + 3.8 * Math.cos(a * DEG), DY + 3.8 * Math.sin(a * DEG), 70.9]);
  up += `<path class="tube" d="${poly3(loop)}"/>`;
  up += solid(cyl(DX - 0.4, DY, 6.6, 71.8, 13.2, 30, 0.8), 'm-skinB');
  up += solid(cyl(DX + 3.2, DY, 4.6, 77.5, 8, 28), 'm-hair');
  up += solid(cyl(DX + 0.2, DY, 6.8, 84.2, 2.8, 30, 1.1), 'm-hair');
  up += solid(slab({ x: DX + 0.6, y: 43.3, w: 2.6, d: 1.4, r: 0.6 }, 77, 4), 'm-skinB');
  const eyeA = 130 * DEG;
  const eye: P3 = [DX - 0.4 + 6.65 * Math.cos(eyeA), DY + 6.65 * Math.sin(eyeA), 80];
  const tan: P3 = [-Math.sin(eyeA), Math.cos(eyeA), 0];
  up += dot(iso(eye), 0.85, 'eye');
  up += line(poly3([add3(eye, add3(mul3(tan, 1.5), [0, 0, 1])), add3(eye, add3(mul3(tan, -1.5), [0, 0, 1])), add3(eye, add3(mul3(tan, -1.5), [0, 0, -1])), add3(eye, add3(mul3(tan, 1.5), [0, 0, -1]))], true), 'specs');
  up += line(poly3([add3(eye, add3(mul3(tan, -1.5), [0, 0, 0.6])), [DX + 0.7, 44.4, 80.6]]), 'specs');
  up += line(seg3(add3(eye, add3(mul3(tan, 1.6), [0, 0, 2])), add3(eye, add3(mul3(tan, -1.4), [0, 0, 2.2]))), 'brow');
  o.push(`<g data-ref="docUpper">${up}</g>`);
  o.push(
    `<g data-ref="disc">${solid(prism(circleProfile(DISC_ON_CHEST[0], DISC_ON_CHEST[2], 2.2, 18), 'y', DISC_ON_CHEST[1] - 1, DISC_ON_CHEST[1] + 1, true), 'm-steel', { cls: 'disc' })}</g>`,
  );
  o.push(limb(D_SHOULDER, D_REST, 2.7, 'm-coat', 'armU'));
  o.push(limb(D_SHOULDER, D_REST, 2.4, 'm-coat', 'armF'));
  o.push(knob(D_REST, 2.3, 'm-skinB', 'hand'));

  /* doctor's rolling stool */
  o.push(shadow({ x: 151, y: 71, w: 18, d: 18, r: 9 }));
  const legs = [18, 90, 162, 234, 306].map((a) => a * DEG).sort((p, q) => Math.cos(p - AZ) - Math.cos(q - AZ));
  for (const a of legs) {
    const [c, sn] = [Math.cos(a), Math.sin(a)];
    const at = (r: number, w: number): P2 => [160 + r * c - w * sn, 80 + r * sn + w * c];
    o.push(solid(cyl(160 + 7.2 * c, 80 + 7.2 * sn, 1.4, 0, 2.4, 12), 'm-hair'));
    o.push(solid(extrude([at(0, -0.9), at(7.6, -0.7), at(7.6, 0.7), at(0, 0.9)], 2.4, 1.4), 'm-navy'));
  }
  o.push(solid(cyl(160, 80, 2.6, 4, 2.4, 20), 'm-navy'));
  o.push(solid(cyl(160, 80, 1.4, 6.4, 10.6, 16), 'm-steel'));
  o.push(solid(cyl(160, 80, 7.2, 17, 1.4, 32), 'm-navy'));
  o.push(solid(cyl(160, 80, 7, 18.4, 3.4, 32, 1), 'm-teal', { inner: line(sideArc(160, 80, 7, 20.1), 'faint') }));

  /* charge-nurse cart: computer on wheels with the order list */
  let cart = '';
  cart += shadow({ x: 3, y: 70.0, w: 50, d: 27, r: 3 });
  const casters: P2[] = [
    [8, 74],
    [46, 74],
    [8, 90],
    [46, 90],
  ];
  for (const [x, y] of casters) {
    cart += solid(prism(circleProfile(y, 2.3, 2.3, 16), 'x', x - 0.9, x + 0.9, true), 'm-hair');
    cart += solid(slab({ x: x - 1.6, y: y - 1.3, w: 3.2, d: 2.6, r: 0.6 }, 3.6, 2.4), 'm-navy');
  }
  cart += solid(slab({ x: 4, y: 70.0, w: 46, d: 24, r: 2 }, 6, 3, 0.6), 'm-navy');
  let drawers = '';
  const tabs = ['lime', 'cyan', 'gold'];
  [1.5, 11.6, 21.7].forEach((v, i) => {
    drawers += `<rect class="drawer" x="1.6" y="${v}" width="38.8" height="8.6" rx="0.6"/>`;
    drawers += `<rect class="dtab dtab-${tabs[i]}" x="33" y="${v + 1.4}" width="5" height="2.2" rx="0.3"/>`;
  });
  cart += solid(slab({ x: 6, y: 72.0, w: 42, d: 20, r: 1.5 }, 9, 31, 0.6), 'm-steel', {
    inner: `<g transform="${faceMatrix([6, 92, 40], 'y')}">${drawers}</g>`,
  });
  for (const z of [34.4, 24.3, 14.2]) cart += solid(slab({ x: 15, y: 92.0, w: 12, d: 1.3, r: 0.5 }, z - 0.8, 1.6), 'm-navy');
  cart += solid(slab({ x: 48, y: 74.4, w: 3, d: 1.4, r: 0.4 }, 30.6, 1.8), 'm-steel');
  cart += solid(slab({ x: 48, y: 88.2, w: 3, d: 1.4, r: 0.4 }, 30.6, 1.8), 'm-steel');
  cart += solid(prism(circleProfile(51.4, 31.5, 1.15, 14), 'y', 73.6, 90.6, true), 'm-steel');
  cart += solid(slab({ x: 3, y: 69.0, w: 48, d: 26, r: 2.4 }, 40, 3, 0.8), 'm-cream');
  cart += line(planD({ x: 5.4, y: 71.4, w: 43.2, d: 21.2, r: 1.2 }, 43), 'faint-c');
  cart += solid(cyl(27, 73.6, 3, 43, 2, 20), 'm-navy');
  cart += solid(cyl(27, 73.6, 1.8, 45, 7, 18), 'm-steel');
  cart += solid(slab({ x: 3, y: 75.0, w: 48, d: 3, r: 1.2 }, 51, 33, 0.6), 'm-case', { cls: 'cart-case' });
  let cui = `<rect class="scr" x="1.8" y="1.8" width="44.4" height="28.6" rx="0.6"/>`;
  cui += `<text class="mt mt-mute" x="4" y="6.7" font-size="4">NURSE AGENT</text>`;
  cui += `<circle class="cled" data-ref="cartLed" cx="35.2" cy="5.4" r="0.95"/>`;
  cui += `<text class="mt mt-lime" data-ref="calls" x="44.2" y="6.7" font-size="4" text-anchor="end">0/4</text>`;
  cui += `<path class="grid" d="M3.4 8.4H44.6"/>`;
  CHIPS.forEach((c, i) => {
    const t = CHIP_TOP(i);
    let g = `<rect class="chip${c.held ? ' chip-held' : ''}" x="3.4" y="${t}" width="41.2" height="4.3" rx="0.5"/>`;
    g += `<rect class="tick ${c.held ? 'tick-gold' : 'tick-lime'}" x="4.3" y="${t + 0.65}" width="3" height="3" rx="0.3"/>`;
    g += c.held
      ? `<path class="tickmark" d="M5.8 ${t + 1.25}V${t + 2.55}M5.8 ${t + 3.05}V${t + 3.1}"/>`
      : `<path class="tickmark" d="M4.9 ${t + 2.2}L5.6 ${t + 2.95}L6.95 ${t + 1.35}"/>`;
    g += `<text class="mt mt-chip" x="8.8" y="${t + 3.5}" font-size="4.1">${c.label}</text>`;
    g += c.held
      ? `<rect class="tag" x="35.6" y="${t + 0.65}" width="8.2" height="3" rx="0.3"/><text class="mt mt-tag" x="39.7" y="${t + 2.95}" font-size="3" text-anchor="middle">HELD</text>`
      : `<text class="mono" x="43.8" y="${t + 3.1}" font-size="2.3" text-anchor="end">${c.tool}</text>`;
    const cx = 24;
    const cy = t + 2.15;
    cui += `<g data-ref="chip${i}" opacity="0"><g data-ref="chipIn${i}" data-c="${cx} ${cy}">${g}</g></g>`;
  });
  cui += `<circle class="cam" cx="24" cy="31.6" r="0.5"/>`;
  cart += `<g transform="${faceMatrix(CART_FACE, 'y')}">${cui}</g>`;
  cart += solid(slab({ x: 31, y: 82.0, w: 15, d: 10, r: 1 }, 43, 5.6, 0.5), 'm-cream', {});
  cart += line(planD({ x: 35, y: 85.6, w: 7, d: 2.8, r: 1.4 }, 48.6, 4), 'dark');
  cart += solid(cyl(11.5, 88, 2.6, 43, 8.6, 20), 'm-teal', { inner: line(sideArc(11.5, 88, 2.6, 46.6), 'lo') });
  cart += solid(cyl(11.5, 88, 1, 51.6, 2.4, 12), 'm-navy');
  cart += solid(slab({ x: 11, y: 88.5, w: 1.1, d: 3.6, r: 0.4 }, 53, 1), 'm-navy');
  o.push(`<g data-hit="cart">${cart}</g>`);

  /* voice: two speech waves in the plane between the faces */
  o.push(`<path class="wave wave-d" data-ref="waveD" d=""/><path class="wave wave-p" data-ref="waveP" d=""/>`);

  return { svg: o.join(''), H };
}

function sideSeamPlan(p: Plan, z: number) {
  const ring = roundedPlan(p, 4);
  const n = ring.length;
  const ccw = signedArea(ring) > 0;
  const facing = ring.map(([ax, ay], i) => {
    const [bx, by] = ring[(i + 1) % n];
    const dx = bx - ax;
    const dy = by - ay;
    const [nx, ny] = ccw ? [dy, -dx] : [-dy, dx];
    return nx * VH[0] + ny * VH[1] > 1e-9;
  });
  return runsOf(facing, true)
    .map((run) => poly3(run.map((i) => [ring[i][0], ring[i][1], z] as P3)))
    .join('');
}

const scene = () => (SCENE ??= build());

/* ── live layer ─────────────────────────────────────────────────────── */

function armIK(s: P3, h: P3): P3 {
  const d = sub3(h, s);
  const dist = Math.min(len3(d), ARM_U + ARM_F - 0.01);
  const dir = mul3(d, 1 / (len3(d) || 1));
  const a = (ARM_U * ARM_U - ARM_F * ARM_F + dist * dist) / (2 * dist);
  const hh = Math.sqrt(Math.max(0, ARM_U * ARM_U - a * a));
  const pole: P3 = [0.15, 0.75, -0.65];
  const perp = sub3(pole, mul3(dir, dot3(pole, dir)));
  const pl = len3(perp) || 1;
  return add3(add3(s, mul3(dir, a)), mul3(perp, hh / pl));
}

const mixHex = (a: string, b: string, t: number) => {
  const pa = [1, 3, 5].map((i) => parseInt(a.slice(i, i + 2), 16));
  const pb = [1, 3, 5].map((i) => parseInt(b.slice(i, i + 2), 16));
  return `rgb(${pa.map((v, i) => Math.round(v + (pb[i] - v) * t)).join(',')})`;
};

const HINTS: Record<string, string> = {
  idle: 'Hover the monitor or cart · click to step',
  monitor: 'Click the monitor: skip to stable vitals',
  cart: 'Click the cart: replay the orders',
};

export default function MedSimFigure({ className }: { className?: string }) {
  const sc = scene();
  const rootRef = useRef<HTMLElement>(null);
  const svgRef = useRef<SVGSVGElement>(null);
  const readRef = useRef<HTMLSpanElement>(null);
  const [step, setStep] = useState(3);
  const [hot, setHot] = useState<'idle' | 'monitor' | 'cart'>('idle');

  useEffect(() => {
    const svg = svgRef.current;
    const root = rootRef.current;
    if (!svg || !root) return;
    const q = <T extends Element>(name: string) => svg.querySelector(`[data-ref="${name}"]`) as T | null;
    const R = {
      ecg: q<SVGPathElement>('ecg'),
      ecgHead: q<SVGCircleElement>('ecgHead'),
      pleth: q<SVGPathElement>('pleth'),
      hr: q<SVGTextElement>('hr'),
      hrLbl: q<SVGTextElement>('hrLbl'),
      spo2: q<SVGTextElement>('spo2'),
      heart: q<SVGGElement>('heart'),
      alarm: q<SVGGElement>('alarm'),
      calls: q<SVGTextElement>('calls'),
      cartLed: q<SVGCircleElement>('cartLed'),
      waveD: q<SVGPathElement>('waveD'),
      waveP: q<SVGPathElement>('waveP'),
      mouth: q<SVGPathElement>('pMouth'),
      docUpper: q<SVGGElement>('docUpper'),
      armU: q<SVGGElement>('armU'),
      armF: q<SVGGElement>('armF'),
      hand: q<SVGCircleElement>('hand'),
      disc: q<SVGGElement>('disc'),
      tube: q<SVGPathElement>('tube'),
      clockS: q<SVGPathElement>('clockS'),
      spo2Led: q<SVGCircleElement>('spo2Led'),
      chips: CHIPS.map((_, i) => q<SVGGElement>(`chip${i}`)),
      chipIn: CHIPS.map((_, i) => q<SVGGElement>(`chipIn${i}`)),
    };
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    const st = {
      t: reduce ? STILL_T : 0,
      clock: 0,
      beat: 0,
      head: 0,
      idx: 0,
      buf: new Float32Array(ECG.n),
      pl: new Float32Array(ECG.n),
      pulse: 0,
      led: 0,
      calls: 0,
      read: '',
      step: -1,
      running: false,
      visible: true,
      raf: 0,
      last: 0,
    };

    const sample = (dt: number, hr: number) => {
      st.head += (dt / ECG.sweep) * ECG.n;
      const ds = ECG.sweep / ECG.n;
      while (st.head >= 1) {
        st.head -= 1;
        const before = Math.floor(st.beat - 0.295);
        st.beat += (ds * hr) / 60;
        if (Math.floor(st.beat - 0.295) > before) st.pulse = 1;
        st.idx = (st.idx + 1) % ECG.n;
        st.buf[st.idx] = ecgAt(st.beat % 1);
        st.pl[st.idx] = plethAt(st.beat % 1);
      }
    };

    const setLimb = (g: SVGGElement | null, a: P3, b: P3, r: number) => {
      if (!g) return;
      const { d, h } = limbPaths(a, b, r);
      const [lo, lf, lh] = Array.from(g.children);
      lo.setAttribute('d', d);
      lf.setAttribute('d', d);
      lh.setAttribute('d', h);
    };

    const draw = (dt: number) => {
      const t = st.t;
      const v = vitalsAt(t);
      sample(dt, 108 - 16 * v.settle);
      st.pulse *= Math.exp(-dt * 7);
      st.led *= Math.exp(-dt * 4);

      // ECG sweep with an erase gap ahead of the head
      const du = (ECG.u1 - ECG.u0) / (ECG.n - 1);
      const idx = st.idx;
      let e = '';
      let p = '';
      let pen = false;
      for (let i = 0; i < ECG.n; i++) {
        const ahead = (i - idx + ECG.n) % ECG.n;
        if (ahead > 0 && ahead <= 5) {
          pen = false;
          continue;
        }
        const u = (ECG.u0 + i * du).toFixed(2);
        e += `${pen ? 'L' : 'M'}${u} ${(ECG.base - ECG.amp * st.buf[i]).toFixed(2)}`;
        p += `${pen ? 'L' : 'M'}${u} ${(PL.base - PL.amp * st.pl[i]).toFixed(2)}`;
        pen = true;
      }
      const ecgCol = v.settle < 0.5 ? mixHex('#ff6568', '#d9a520', v.settle * 2) : mixHex('#d9a520', '#a8e27c', v.settle * 2 - 1);
      R.ecg?.setAttribute('d', e);
      R.ecg?.setAttribute('stroke', ecgCol);
      R.pleth?.setAttribute('d', p);
      R.ecgHead?.setAttribute('cx', (ECG.u0 + idx * du).toFixed(2));
      R.ecgHead?.setAttribute('cy', (ECG.base - ECG.amp * st.buf[idx]).toFixed(2));
      R.ecgHead?.setAttribute('fill', ecgCol);
      if (R.hr && R.hr.textContent !== String(v.hr)) R.hr.textContent = String(v.hr);
      R.hr?.setAttribute('fill', ecgCol);
      R.hrLbl?.setAttribute('fill', ecgCol);
      if (R.spo2 && R.spo2.textContent !== String(v.spo2)) R.spo2.textContent = String(v.spo2);
      R.heart?.setAttribute('transform', `translate(27.6 3.9) scale(${(1 + 0.35 * st.pulse).toFixed(3)})`);
      R.heart?.setAttribute('fill', ecgCol);
      R.alarm?.classList.toggle('ok', v.settle > 0.5);
      R.alarm?.setAttribute('opacity', v.settle > 0.5 ? '1' : (0.45 + 0.55 * (Math.sin(st.clock * 5) > 0 ? 1 : 0)).toFixed(2));
      R.spo2Led?.setAttribute('opacity', (0.35 + 0.65 * st.pulse).toFixed(2));

      // orders: chips pop in as tool calls return
      if (v.calls > st.calls) st.led = 1;
      st.calls = v.calls;
      if (R.calls && R.calls.textContent !== `${v.calls}/4`) R.calls.textContent = `${v.calls}/4`;
      R.cartLed?.setAttribute('opacity', (0.3 + 0.7 * Math.max(st.led, v.calls === 4 ? 0.6 : 0)).toFixed(2));
      CHIP_AT.forEach((at, i) => {
        const show = ramp(t, at, at + 0.4) * (1 - ramp(t, 11.25, 11.75));
        const k = clamp01((t - at) / 0.45);
        const pop = t < at ? 0.7 : 1 + 0.12 * Math.sin(Math.PI * k) * (1 - k);
        R.chips[i]?.setAttribute('opacity', show.toFixed(3));
        const c = R.chipIn[i]?.getAttribute('data-c')?.split(' ').map(Number) ?? [0, 0];
        const s = 0.82 + 0.18 * smooth(k);
        R.chipIn[i]?.setAttribute('transform', `translate(${c[0]} ${c[1]}) scale(${(s * pop).toFixed(3)}) translate(${-c[0]} ${-c[1]})`);
      });

      // doctor: reach, lean, listen
      const reach = ramp(t, 0.7, 2.1) * (1 - ramp(t, 5.7, 6.8));
      const lean = (0.35 * ramp(t, 0.7, 2.1) + 0.65 * ramp(t, 2.4, 3.2)) * (1 - ramp(t, 5.4, 6.4));
      const lv = mul3(LEAN, lean);
      const [lx, ly] = vec(lv);
      R.docUpper?.setAttribute('transform', `translate(${lx.toFixed(2)} ${ly.toFixed(2)})`);
      const breathe: P3 = [0, 0.25 * Math.sin(st.clock * 1.6), 0.2 * Math.sin(st.clock * 1.6)];
      const discAt = add3(lerp3(sub3(D_REST, HAND_FROM_DISC), DISC_ON_CHEST, reach), add3([0, 0, 4 * Math.sin(Math.PI * reach)], mul3(breathe, reach)));
      const hand = add3(discAt, HAND_FROM_DISC);
      const shoulder = add3(D_SHOULDER, lv);
      const elbow = armIK(shoulder, hand);
      setLimb(R.armU, shoulder, elbow, 2.7);
      setLimb(R.armF, elbow, hand, 2.4);
      const [hx, hy] = iso(hand);
      R.hand?.setAttribute('cx', hx.toFixed(1));
      R.hand?.setAttribute('cy', hy.toFixed(1));
      const [dx, dy] = vec(sub3(discAt, DISC_ON_CHEST));
      R.disc?.setAttribute('transform', `translate(${dx.toFixed(2)} ${dy.toFixed(2)})`);
      R.disc?.classList.toggle('lit', reach > 0.92 && t < 5.6);
      const neck = add3(D_NECK, lv);
      const end = add3(discAt, [1.4, 1.2, 0.6]);
      const c1 = add3(neck, [-3, 7, -12]);
      const c2 = add3(end, [9, 6, -9]);
      const tp: P3[] = [];
      for (let i = 0; i <= 20; i++) {
        const s = i / 20;
        const m = 1 - s;
        tp.push(add3(add3(mul3(neck, m * m * m), mul3(c1, 3 * m * m * s)), add3(mul3(c2, 3 * m * s * s), mul3(end, s * s * s))));
      }
      R.tube?.setAttribute('d', poly3(tp));

      // voice: waves travel from the speaker to the listener
      const dS = windowed(t, 0.2, 2.5) + windowed(t, 5.5, 8.9);
      const pS = windowed(t, 2.8, 5.3);
      const waveOf = (env: number, dir: number) => {
        if (env < 0.01) return '';
        let d = '';
        const n = 9;
        for (let i = 0; i < n; i++) {
          const f = i / (n - 1);
          const x = WAVE_X[0] + (WAVE_X[1] - WAVE_X[0]) * f;
          const zc = 66.5 + 7 * f - (lean * 1.2 * f);
          const taper = Math.sin(Math.PI * (i + 0.5) / n);
          const ph = st.clock * 9 - i * 0.85 * dir;
          const h = 0.35 + env * taper * (0.9 + 2.6 * (0.5 + 0.5 * Math.sin(ph)) * (0.65 + 0.35 * Math.sin(st.clock * 3.3 + i * 1.7)));
          d += seg3([x, WAVE_Y, zc - h], [x, WAVE_Y, zc + h]);
        }
        return d;
      };
      R.waveD?.setAttribute('d', waveOf(dS, -1));
      R.waveD?.setAttribute('opacity', dS.toFixed(2));
      R.waveP?.setAttribute('d', waveOf(pS, 1));
      R.waveP?.setAttribute('opacity', pS.toFixed(2));
      const open = pS * (0.25 + 0.75 * Math.abs(Math.sin(st.clock * 10.5) * Math.sin(st.clock * 3.7 + 1)));
      R.mouth?.setAttribute('d', `M0 0h2.6v${(0.4 + 1.3 * open).toFixed(2)}H0z`);

      // wall clock second hand
      const sa = ((st.clock % 60) / 60) * Math.PI * 2;
      R.clockS?.setAttribute('d', seg3([CLOCK[0] - Math.sin(sa) * 1.2, 6.75, CLOCK[2] - Math.cos(sa) * 1.2], [CLOCK[0] + Math.sin(sa) * 5.2, 6.75, CLOCK[2] + Math.cos(sa) * 5.2]));

      const text = readoutOf(t);
      if (text !== st.read && readRef.current) {
        st.read = text;
        readRef.current.textContent = text;
      }
      const s = stepOf(t);
      if (s !== st.step) {
        st.step = s;
        setStep(s);
      }
    };

    const frame = (now: number) => {
      const dt = Math.min(0.05, (now - st.last) / 1000 || 0);
      st.last = now;
      st.clock += dt;
      st.t = (st.t + dt) % LOOP;
      draw(dt);
      st.raf = st.running ? requestAnimationFrame(frame) : 0;
    };
    const start = () => {
      if (reduce || st.running || !st.visible || document.hidden) return;
      st.running = true;
      st.last = performance.now();
      st.raf = requestAnimationFrame(frame);
    };
    const stop = () => {
      st.running = false;
      cancelAnimationFrame(st.raf);
    };
    // Fill the trace once so a still frame (reduced motion, first paint) reads.
    const prime = () => {
      for (let i = 0; i < ECG.n; i++) sample(ECG.sweep / ECG.n, 108 - 16 * vitalsAt(st.t).settle);
      st.clock += 0.4;
      draw(0);
    };
    prime();

    const seek = (to: number) => {
      st.t = ((to % LOOP) + LOOP) % LOOP;
      if (reduce) {
        prime();
      }
    };
    const next = (dir = 1) => {
      const s = stepOf(st.t);
      const n = (s + dir + STEPS.length) % STEPS.length;
      seek(reduce ? STEPS[n].at + (n === 3 ? 1.6 : 1.2) : STEPS[n].at);
    };
    const hitOf = (el: EventTarget | null) => (el instanceof Element ? el.closest('[data-hit]')?.getAttribute('data-hit') ?? null : null);
    let hover: string | null = null;
    const onMove = (e: PointerEvent) => {
      const h = hitOf(e.target);
      if (h === hover) return;
      if (hover) svg.querySelector(`[data-hit="${hover}"]`)?.classList.remove('hot');
      hover = h;
      if (h) svg.querySelector(`[data-hit="${h}"]`)?.classList.add('hot');
      setHot(h === 'monitor' || h === 'cart' ? h : 'idle');
    };
    const onLeave = () => {
      if (hover) svg.querySelector(`[data-hit="${hover}"]`)?.classList.remove('hot');
      hover = null;
      setHot('idle');
    };
    const onClick = (e: MouseEvent) => {
      const h = hitOf(e.target);
      if (h === 'monitor') seek(reduce ? STILL_T : 9.0);
      else if (h === 'cart') seek(reduce ? 8.8 : 5.4);
      else next(1);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        next(1);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        next(-1);
      }
    };
    svg.addEventListener('pointermove', onMove);
    svg.addEventListener('pointerleave', onLeave);
    svg.addEventListener('click', onClick);
    root.addEventListener('keydown', onKey);
    const io = new IntersectionObserver(([entry]) => {
      st.visible = entry.isIntersecting;
      if (st.visible) start();
      else stop();
    });
    io.observe(root);
    const onVis = () => (document.hidden ? stop() : start());
    document.addEventListener('visibilitychange', onVis);
    start();
    return () => {
      stop();
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
      svg.removeEventListener('pointermove', onMove);
      svg.removeEventListener('pointerleave', onLeave);
      svg.removeEventListener('click', onClick);
      root.removeEventListener('keydown', onKey);
    };
  }, []);

  return (
    <figure
      ref={rootRef}
      className={`msf${className ? ` ${className}` : ''}`}
      tabIndex={0}
      aria-label="Animated consultation room: the doctor examines a patient while the vitals monitor and the nurse cart respond. Press the right arrow to step."
    >
      <style>{CSS}</style>
      <header className="msf-head">
        <span className="msf-title">Consultation room</span>
        <span className="msf-step" aria-live="polite">
          <span className="msf-pips" aria-hidden="true">
            {STEPS.map((s, i) => (
              <i key={s.label} className={i === step ? 'on' : i < step ? 'done' : ''} />
            ))}
          </span>
          <span>{STEPS[step].label}</span>
        </span>
      </header>
      <svg
        ref={svgRef}
        className="msf-svg"
        viewBox={`0 0 ${W} ${sc.H}`}
        role="img"
        aria-label="An older patient in a kurta on an exam couch, a doctor listening with a stethoscope, a wall monitor tracing his heart rhythm and a nurse cart listing orders."
        dangerouslySetInnerHTML={{ __html: sc.svg }}
      />
      <footer className="msf-foot">
        <span className="msf-hint">{HINTS[hot]}</span>
        <span className="msf-read" ref={readRef} aria-hidden="true">
          {readoutOf(STILL_T)}
        </span>
      </footer>
    </figure>
  );
}

/* ── styles (scoped by .msf) ────────────────────────────────────────── */

const CSS = `
.msf{
  --msf-bg:var(--surface,#112a60);--msf-line:var(--line,#2b4c8a);--msf-deep:var(--bg-deep,#061431);
  --msf-text:var(--text,#f3f1e2);--msf-muted:var(--muted,#a7b6d6);--msf-lime:var(--primary,#a8e27c);
  --msf-cyan:var(--accent2,#6ad5e7);--msf-gold:var(--gold,#d9a520);--msf-red:var(--destructive,#ff6568);
  --msf-night:var(--background,#0b1f4b);
  position:relative;display:flex;flex-direction:column;margin:0;width:100%;
  background:var(--msf-bg);color:var(--msf-text);border-radius:0;
  box-shadow:0 0 0 2px var(--msf-line),4px 4px 0 0 var(--msf-deep);outline:none;
}
.msf:focus-visible{box-shadow:0 0 0 2px var(--msf-lime),4px 4px 0 0 var(--msf-deep)}
.msf-head,.msf-foot{display:flex;align-items:center;justify-content:space-between;gap:8px 16px;padding:10px 14px;flex-wrap:wrap}
.msf-head{border-bottom:2px solid var(--msf-line)}
.msf-foot{border-top:2px solid var(--msf-line)}
.msf-title{font-family:'Jersey 10',var(--font-display,ui-monospace),monospace;font-size:24px;line-height:1;letter-spacing:.02em;color:var(--msf-text)}
.msf-step,.msf-hint,.msf-read{font-family:'Amarna',var(--font-sans,system-ui),system-ui,sans-serif;font-size:12px;font-weight:600;letter-spacing:.14em;text-transform:uppercase;line-height:1.3}
.msf-step{display:inline-flex;align-items:center;gap:10px;color:var(--msf-lime)}
.msf-pips{display:inline-flex;gap:4px}
.msf-pips i{width:7px;height:7px;background:var(--msf-line);display:block}
.msf-pips i.done{background:var(--msf-muted)}
.msf-pips i.on{background:var(--msf-lime)}
.msf-hint{color:var(--msf-muted)}
.msf-read{color:var(--msf-text);font-variant-numeric:tabular-nums}
.msf-svg{display:block;width:100%;height:auto;padding:6px 6px 2px;box-sizing:border-box;overflow:hidden;-webkit-user-select:none;user-select:none}
.msf-svg path,.msf-svg circle,.msf-svg rect{vector-effect:non-scaling-stroke}
.msf-svg .limb path{vector-effect:none}

/* materials: fill, top, four side tones, edge, crease */
.msf .m-navy{--p:#163470;--tp:#24498f;--s0:#0a1a40;--s1:#0d2252;--s2:#112a60;--s3:#163470;--e:#5f82c4;--c:#2b4c8a}
.msf .m-wall{--p:#183776;--tp:#2b4c8a;--s0:#0f2659;--s1:#132e67;--s2:#163371;--s3:#1a3a7b;--e:#3f62a6;--c:#2a4a88}
.msf .m-wallhi{--p:#24478a;--tp:#3d63a8;--s0:#173571;--s1:#1b3b7b;--s2:#204285;--s3:#26498f;--e:#4b6fb3;--c:#3d63a8}
.msf .m-steel{--p:#8fa3cb;--tp:#c7d3ec;--s0:#4d6292;--s1:#6078a8;--s2:#748dbd;--s3:#8fa3cb;--e:#0b1f4b;--c:#5a72a3}
.msf .m-case{--p:#1d3f82;--tp:#3d63a8;--s0:#0e2457;--s1:#122d66;--s2:#173571;--s3:#1d3f82;--e:#7d9bd4;--c:#2b4c8a}
.msf .m-cream{--p:#e6e2cc;--tp:#f7f5e8;--s0:#a3a08a;--s1:#bdb9a2;--s2:#d3cfb8;--s3:#e6e2cc;--e:#0b1f4b;--c:#b3af98}
.msf .m-coat{--p:#ecebe2;--tp:#fbfaf3;--s0:#a9adb8;--s1:#c3c6cd;--s2:#d9dade;--s3:#ecebe2;--e:#0b1f4b;--c:#bfc2c9}
.msf .m-teal{--p:#4fb4c8;--tp:#8fdcea;--s0:#1d6a80;--s1:#2a8197;--s2:#3a9aae;--s3:#4fb4c8;--e:#0b1f4b;--c:#2a8197}
.msf .m-scrub{--p:#3f9fb5;--tp:#6fc6d8;--s0:#185a6e;--s1:#226d83;--s2:#2d8399;--s3:#3f9fb5;--e:#0b1f4b;--c:#226d83}
.msf .m-cyan{--p:#6ad5e7;--tp:#9be6f2;--s0:#2a8197;--s1:#3a9aae;--s2:#4fb4c8;--s3:#6ad5e7;--e:#0b1f4b;--c:#3a9aae}
.msf .m-blue{--p:#3c62a8;--tp:#5c82c6;--s0:#1c3d80;--s1:#25488f;--s2:#30559d;--s3:#3c62a8;--e:#0b1f4b;--c:#25488f}
.msf .m-kurta{--p:#d4a43a;--tp:#ebc565;--s0:#7f5a14;--s1:#9b711e;--s2:#b88a2a;--s3:#d4a43a;--e:#0b1f4b;--c:#9b711e}
.msf .m-kurtadk{--p:#a8721c;--tp:#c48d2c;--s0:#5e3c0c;--s1:#744b10;--s2:#8c5c15;--s3:#a8721c;--e:#0b1f4b;--c:#744b10}
.msf .m-pyjama{--p:#e9e5d6;--tp:#f8f6ec;--s0:#a8a594;--s1:#c0bdab;--s2:#d6d2c1;--s3:#e9e5d6;--e:#0b1f4b;--c:#c0bdab}
.msf .m-sandal{--p:#6b4128;--tp:#8a5636;--s0:#341d10;--s1:#442717;--s2:#56321e;--s3:#6b4128;--e:#0b1f4b;--c:#442717}
.msf .m-skinA{--p:#8d5a3b;--tp:#a87050;--s0:#4a2b19;--s1:#5c3621;--s2:#73452b;--s3:#8d5a3b;--e:#0b1f4b;--c:#5c3621}
.msf .m-skinB{--p:#b47c55;--tp:#cc9670;--s0:#6a4128;--s1:#7f5033;--s2:#986243;--s3:#b47c55;--e:#0b1f4b;--c:#7f5033}
.msf .m-hair{--p:#141826;--tp:#242a3e;--s0:#07090f;--s1:#0b0e17;--s2:#10131f;--s3:#141826;--e:#5f82c4;--c:#242a3e}
.msf .m-glass{--p:#2f6f9a;--tp:#6ad5e7;--s0:#173f66;--s1:#1e4d78;--s2:#265d88;--s3:#2f6f9a;--e:#0b1f4b;--c:#3d63a8}
.msf .m-gold{--p:#d9a520;--tp:#f0c24a;--s0:#7d5c0c;--s1:#9c7412;--s2:#bb8c18;--s3:#d9a520;--e:#0b1f4b;--c:#9c7412}
.msf .m-lime{--p:#a8e27c;--tp:#c9f0a8;--s0:#5a8a38;--s1:#6ea347;--s2:#88c05e;--s3:#a8e27c;--e:#0b1f4b;--c:#6ea347}
.msf .m-red{--p:#ff6568;--tp:#ff9c9e;--s0:#9c2f33;--s1:#bb3b3f;--s2:#dd4d51;--s3:#ff6568;--e:#0b1f4b;--c:#bb3b3f}
.msf .m-red.ok{--p:#a8e27c;--tp:#c9f0a8;--s0:#5a8a38;--s1:#6ea347;--s2:#88c05e;--s3:#a8e27c}

.msf .s .f{fill:var(--p);stroke:none}
.msf .s .sh0{fill:var(--s0)}.msf .s .sh1{fill:var(--s1)}.msf .s .sh2{fill:var(--s2)}.msf .s .sh3{fill:var(--s3)}
.msf .s .tp{fill:var(--tp)}
.msf .s .c{fill:none;stroke:var(--c);stroke-width:.7;stroke-linejoin:round;stroke-linecap:round}
.msf .s .e{fill:none;stroke:var(--e);stroke-width:1;stroke-linejoin:round;stroke-linecap:round}
.msf .s .sh0,.msf .s .sh1,.msf .s .sh2,.msf .s .sh3,.msf .s .tp{stroke:none}
.msf .limb path{fill:none;stroke-linecap:round}
.msf .limb .lo{stroke:var(--e)}
.msf .limb .lf{stroke:var(--s3)}
.msf .limb .lh{stroke:var(--tp);opacity:.85}
.msf .knob{fill:var(--s3);stroke:var(--e);stroke-width:1}

.msf .halo{fill:#030a1c;opacity:.75;filter:blur(10px);transform:translateY(6px)}
.msf .shd{fill:#061431;opacity:.55;filter:blur(2.5px)}
.msf .vinyl{fill:#1a3b7c}
.msf .sky{fill:#0d2a63}.msf .moon{fill:#f3f1e2;opacity:.9}.msf .star{fill:#a7b6d6}.msf .city{fill:#0a1d4a}
.msf .glint{fill:#6ad5e7;opacity:.08}.msf .mullion{fill:none;stroke:#e6e2cc;stroke-width:1.4}.msf .wframe{fill:none;stroke:#0b1f4b;stroke-width:1}
.msf .paper{fill:#f3f1e2;opacity:.92}
.msf .ln{fill:none;stroke-width:.8;stroke-linecap:round;stroke-linejoin:round}
.msf .t-faint{stroke:#24447f}.msf .t-lo{stroke:#3d63a8}.msf .t-mid{stroke:#a7b6d6}.msf .t-dark{stroke:#0b1f4b}
.msf .t-red{stroke:var(--msf-red);stroke-width:.9}
.msf .t-faint-c{stroke:#c9c5ae}.msf .t-paper-e{stroke:#b9b59e;stroke-width:.6}
.msf .t-brow{stroke:#141826;stroke-width:1.2}.msf .t-stache{stroke:#141826;stroke-width:2.2}
.msf .t-specs{stroke:#0b1f4b;stroke-width:.9}.msf .t-coat-l{stroke:#bfc2c9}
.msf .dt{fill:#a7b6d6}.msf .dt-dark{fill:#0b1f4b}.msf .eye{fill:#0b0e17}
.msf .plug{fill:#8fa3cb;stroke:#0b1f4b;stroke-width:.8}
.msf .cable{fill:none;stroke:#0b1f4b;stroke-width:2.4;stroke-linecap:round}
.msf .tube{fill:none;stroke:#0b1f4b;stroke-width:1.9;stroke-linecap:round;stroke-linejoin:round}
.msf .mouth{fill:#2a120a}
.msf .spo2led{fill:var(--msf-red);filter:drop-shadow(0 0 2px var(--msf-red))}
.msf .plate{fill:#0e2457;stroke:#3d63a8;stroke-width:.8}
.msf .pscrew{fill:#a7b6d6}
.msf .ptext{fill:#a7b6d6;font-family:'Jersey 10',ui-monospace,monospace;letter-spacing:.06em}
.msf .pcross{fill:var(--msf-red);stroke:#0b1f4b;stroke-width:.6}
.msf .prule{fill:none;stroke:#a7a58f;stroke-width:.9;stroke-linecap:round}
.msf .kplacket{fill:none;stroke:#7f5a14;stroke-width:.8}
.msf .kbtn{fill:#f3f1e2;stroke:#7f5a14;stroke-width:.4}
.msf .kprint{fill:none;stroke:#9b711e;stroke-width:1.6;stroke-linecap:round}
.msf .pocket,.msf .coat-seam{fill:none;stroke:#b3b6bf;stroke-width:.8}
.msf .disc.lit .e{stroke:var(--msf-lime);stroke-width:1.4}

.msf .scr{fill:#04102a;stroke:#2b4c8a;stroke-width:.8}
.msf .grid{fill:none;stroke:#16336b;stroke-width:.6}
.msf .ecg{fill:none;stroke-width:1.3;stroke-linejoin:round;stroke-linecap:round}
.msf .pleth{fill:none;stroke:var(--msf-cyan);stroke-width:1.1;stroke-linejoin:round;stroke-linecap:round;opacity:.9}
.msf .mt{font-family:'Jersey 10',ui-monospace,monospace;fill:var(--msf-text)}
.msf .mt-mute{fill:#7f93bd}.msf .mt-cyan{fill:var(--msf-cyan)}.msf .mt-lime{fill:var(--msf-lime)}
.msf .mt-chip{fill:var(--msf-text);letter-spacing:.03em}.msf .mt-tag{fill:#0b1f4b}
.msf .mono{font-family:'IBM Plex Mono',ui-monospace,Consolas,monospace;fill:#7f93bd}
.msf .btn{fill:none;stroke:#3d63a8;stroke-width:.6}
.msf .pwr{fill:var(--msf-lime)}.msf .cam{fill:#2b4c8a}
.msf .heart{stroke:none}
.msf .cled{fill:var(--msf-lime)}
.msf .chip{fill:#0e2457;stroke:#2b4c8a;stroke-width:.7}
.msf .chip-held{stroke:var(--msf-gold)}
.msf .tick-lime{fill:var(--msf-lime)}.msf .tick-gold{fill:var(--msf-gold)}
.msf .tickmark{fill:none;stroke:#0b1f4b;stroke-width:1.1;stroke-linecap:round;stroke-linejoin:round}
.msf .tag{fill:var(--msf-gold)}
.msf .drawer{fill:none;stroke:#4d6292;stroke-width:.7}
.msf .dtab-lime{fill:var(--msf-lime)}.msf .dtab-cyan{fill:var(--msf-cyan)}.msf .dtab-gold{fill:var(--msf-gold)}
.msf .wave{fill:none;stroke-width:2.2;stroke-linecap:round}
.msf .wave-d{stroke:var(--msf-cyan)}.msf .wave-p{stroke:var(--msf-gold)}

.msf [data-hit]{cursor:pointer}
.msf [data-hit] .e{transition:stroke .25s ease}
.msf [data-hit].hot .mon-case .e,.msf [data-hit].hot .cart-case .e{stroke:var(--msf-lime);stroke-width:1.6}
.msf [data-hit].hot .scr{stroke:var(--msf-lime)}

@media (max-width:520px){
  .msf-head,.msf-foot{padding:8px 10px}
  .msf-title{font-size:20px}
  .msf-step,.msf-hint,.msf-read{font-size:11px;letter-spacing:.1em}
}
`;
