// Code-drawn physiology curves for the whiteboard. The lesson model only
// names a preset; every curve here is generated deterministically with the
// right textbook shape and labelled landmarks. Pure module (no DOM).

import type { WaveformPreset } from './lesson';

export type WaveColor = 'blue' | 'red' | 'green' | 'purple' | 'orange' | 'black' | 'grey';
export type Pt = [number, number];

export interface WaveLane {
  /** Fraction of the plot height. */
  frac: number;
  yRange: [number, number];
  yLabel: string;
  yTicks: Array<{ v: number; label: string }>;
}
export interface WaveCurve {
  name?: string;
  color: WaveColor;
  pts: Pt[];
  lane?: number;
  /** Draw as a closed loop (pv-loop). */
  closed?: boolean;
}
/** Label with a leader dot at data point (x,y); (dx,dy) is the text offset in px. */
export interface WaveLandmark {
  x: number;
  y: number;
  text: string;
  dx: number;
  dy: number;
  lane?: number;
  color?: WaveColor;
  anchor?: 'start' | 'middle' | 'end';
  dot?: boolean;
}
export interface WaveBracket {
  x1: number;
  x2: number;
  y: number;
  text: string;
  color: WaveColor;
  lane?: number;
  /** Text above (-1) or below (1) the bracket line. */
  side?: 1 | -1;
}
export interface WaveVLine {
  x: number;
  text?: string;
  /** Stagger row for the label (0 or 1). */
  row?: number;
  /** Only draw within this lane (default: all lanes). */
  lane?: number;
  /** Stop the line at this y in its lane. */
  yTo?: number;
}
export interface WaveHLine {
  y: number;
  text: string;
  lane?: number;
  color?: WaveColor;
}
export interface WaveHighlight {
  x1: number;
  x2: number;
  label: string;
  color: WaveColor;
  /** Index of the curve to re-stroke thickly. */
  curve?: number;
}
export interface WaveSpec {
  preset: WaveformPreset;
  title: string;
  xLabel: string;
  xRange: [number, number];
  xTicks: Array<{ v: number; label: string }>;
  lanes: WaveLane[];
  curves: WaveCurve[];
  landmarks: WaveLandmark[];
  brackets: WaveBracket[];
  vlines: WaveVLine[];
  hlines: WaveHLine[];
  highlight?: WaveHighlight;
  caption: string;
  /** Where curve names are listed (default left). */
  legend?: 'left' | 'right';
}

// ───────── numeric helpers ─────────

const gauss = (t: number, mu: number, sigma: number, amp: number) => amp * Math.exp(-0.5 * ((t - mu) / sigma) ** 2);
const r3 = (n: number) => Math.round(n * 1000) / 1000;

function sample(f: (x: number) => number, x0: number, x1: number, n: number): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= n; i++) {
    const x = x0 + ((x1 - x0) * i) / n;
    out.push([r3(x), r3(f(x))]);
  }
  return out;
}

/** Smooth (cosine eased) interpolation through knots sorted by x. */
function knotFn(knots: Pt[]): (x: number) => number {
  return (x) => {
    if (x <= knots[0][0]) return knots[0][1];
    for (let i = 1; i < knots.length; i++) {
      if (x <= knots[i][0]) {
        const [xa, ya] = knots[i - 1];
        const [xb, yb] = knots[i];
        const u = (x - xa) / (xb - xa || 1);
        const e = (1 - Math.cos(Math.PI * u)) / 2;
        return ya + (yb - ya) * e;
      }
    }
    return knots[knots.length - 1][1];
  };
}

/** Catmull-Rom resample of a polyline (closed or open) into dense points. */
function smoothPath(ctrl: Pt[], closed: boolean, per = 14): Pt[] {
  const n = ctrl.length;
  const at = (i: number): Pt => (closed ? ctrl[((i % n) + n) % n] : ctrl[Math.max(0, Math.min(n - 1, i))]);
  const out: Pt[] = [];
  const segs = closed ? n : n - 1;
  for (let i = 0; i < segs; i++) {
    const p0 = at(i - 1), p1 = at(i), p2 = at(i + 1), p3 = at(i + 2);
    for (let k = 0; k < per; k++) {
      const t = k / per, t2 = t * t, t3 = t2 * t;
      const c = (a: number, b: number, cc: number, d: number) =>
        0.5 * (2 * b + (-a + cc) * t + (2 * a - 5 * b + 4 * cc - d) * t2 + (-a + 3 * b - 3 * cc + d) * t3);
      out.push([r3(c(p0[0], p1[0], p2[0], p3[0])), r3(c(p0[1], p1[1], p2[1], p3[1]))]);
    }
  }
  out.push(closed ? out[0] : at(n - 1));
  return out;
}

const hill = (x: number, k: number, n: number) => (x ** n) / (k ** n + x ** n);

// ───────── ECG ─────────

interface BeatOpts {
  pr?: number; // P onset to QRS onset, seconds
  p?: boolean;
  stElev?: number;
  tAmp?: number;
  u?: boolean;
  wide?: boolean;
}
/** Key times of a beat whose QRS starts at q0. */
function beatTimes(q0: number, o: BeatOpts = {}) {
  const pr = o.pr ?? 0.16;
  return {
    pOnset: q0 - pr,
    pPeak: q0 - pr + 0.05,
    pEnd: q0 - pr + 0.1,
    q0,
    r: q0 + 0.03,
    s: q0 + 0.055,
    j: q0 + 0.09,
    tPeak: q0 + 0.26,
    tEnd: q0 + 0.36,
    uPeak: q0 + 0.46,
  };
}
function beatY(t: number, q0: number, o: BeatOpts = {}): number {
  const k = beatTimes(q0, o);
  let y = 0;
  if (o.p !== false) y += gauss(t, k.pPeak, 0.022, 0.16);
  y += gauss(t, q0 + 0.012, 0.007, -0.1); // Q
  y += gauss(t, k.r, 0.0095, 1.0); // R
  y += gauss(t, k.s, 0.009, -0.22); // S
  const st = o.stElev ?? 0;
  if (st > 0) {
    // J point lifted, convex dome rising into the T wave
    y += st * (1 / (1 + Math.exp(-(t - k.j) / 0.012))) * (1 / (1 + Math.exp((t - (k.tEnd + 0.04)) / 0.02)));
    y += gauss(t, k.tPeak - 0.02, 0.06, st * 0.55 + 0.12);
  } else {
    y += gauss(t, k.tPeak, 0.042, o.tAmp ?? 0.32);
  }
  if (o.u) y += gauss(t, k.uPeak, 0.03, 0.06);
  return y;
}

const ECG_LANE = (xs: string): WaveLane => ({ frac: 1, yRange: [-0.45, 1.35], yLabel: xs, yTicks: [{ v: 0, label: '0' }, { v: 1, label: '1 mV' }] });

function ecgNormal(highlight?: string): WaveSpec {
  const q0 = 0.4;
  const k = beatTimes(q0, { u: true });
  const pts = sample((t) => beatY(t, q0, { u: true }), 0, 1.0, 320);
  const seg: Record<string, [number, number, string]> = {
    p: [k.pOnset, k.pEnd, 'P wave: atrial depolarisation'],
    pr: [k.pEnd, q0, 'PR segment: AV node delay'],
    qrs: [q0, k.j, 'QRS: ventricular depolarisation'],
    st: [k.j, k.tPeak - 0.08, 'ST segment: plateau'],
    t: [k.tPeak - 0.08, k.tEnd, 'T wave: ventricular repolarisation'],
    qt: [q0, k.tEnd, 'QT: ventricular systole'],
  };
  const h = highlight && seg[highlight] ? seg[highlight] : undefined;
  return {
    preset: 'ecg-normal',
    title: 'Normal ECG',
    xLabel: 'Time (s)',
    xRange: [0, 1.0],
    xTicks: [{ v: 0, label: '0' }, { v: 0.5, label: '0.5' }, { v: 1, label: '1.0' }],
    lanes: [ECG_LANE('Voltage')],
    curves: [{ color: 'blue', pts }],
    landmarks: [
      { x: k.pPeak, y: 0.16, text: 'P', dx: 0, dy: -22, color: 'green', anchor: 'middle' },
      { x: q0 + 0.012, y: -0.1, text: 'Q', dx: -22, dy: 18, color: 'purple', anchor: 'middle' },
      { x: k.r, y: 1.0, text: 'R', dx: 22, dy: 6, color: 'red', anchor: 'start' },
      { x: k.s, y: -0.22, text: 'S', dx: 20, dy: 18, color: 'purple', anchor: 'middle' },
      { x: k.tPeak, y: 0.32, text: 'T', dx: 0, dy: -24, color: 'orange', anchor: 'middle' },
      { x: k.uPeak, y: 0.06, text: 'U (small)', dx: 6, dy: -22, color: 'grey', anchor: 'start' },
    ],
    brackets: [
      { x1: k.pOnset, x2: q0, y: -0.3, text: 'PR 0.12-0.20 s', color: 'green', side: 1 },
      { x1: q0, x2: k.j, y: 1.15, text: 'QRS <0.12 s', color: 'red', side: -1 },
      { x1: q0, x2: k.tEnd, y: -0.3, text: 'QT ~0.36-0.44 s', color: 'orange', side: 1 },
    ],
    vlines: [],
    hlines: [{ y: 0, text: '', color: 'grey' }],
    highlight: h ? { x1: h[0], x2: h[1], label: h[2], color: 'red', curve: 0 } : undefined,
    caption: 'P, QRS and T are the electrical story of one heartbeat',
  };
}

function ecgStemi(): WaveSpec {
  const q0 = 0.36;
  const o: BeatOpts = { stElev: 0.5 };
  const k = beatTimes(q0, o);
  const f = (t: number) => beatY(t, q0, o) + gauss(t, q0 + 0.012, 0.009, -0.12);
  return {
    preset: 'ecg-stemi',
    title: 'STEMI: ST elevation',
    xLabel: 'Time (s)',
    xRange: [0, 1.0],
    xTicks: [{ v: 0, label: '0' }, { v: 0.5, label: '0.5' }, { v: 1, label: '1.0' }],
    lanes: [ECG_LANE('Voltage')],
    curves: [{ color: 'blue', pts: sample(f, 0, 1.0, 320) }],
    landmarks: [
      { x: k.pPeak, y: 0.16, text: 'P', dx: 0, dy: -22, color: 'green', anchor: 'middle' },
      { x: k.r, y: 1.0, text: 'R', dx: -22, dy: 8, color: 'red', anchor: 'end' },
      { x: q0 + 0.012, y: -0.22, text: 'Pathological Q', dx: -16, dy: 22, color: 'purple', anchor: 'end' },
      { x: k.j, y: 0.5, text: 'J point', dx: 40, dy: -34, color: 'red', anchor: 'start' },
      { x: k.tPeak - 0.04, y: 0.64, text: 'ST elevation', dx: 70, dy: -26, color: 'red', anchor: 'start' },
    ],
    brackets: [],
    vlines: [],
    hlines: [{ y: 0, text: 'Isoelectric line', color: 'grey' }],
    highlight: { x1: k.j, x2: k.tPeak, label: 'ST segment lifted above baseline', color: 'red', curve: 0 },
    caption: 'Convex ST elevation means transmural ischaemia: act fast',
  };
}

function ecgAf(): WaveSpec {
  const rr = [0.28, 0.83, 1.17, 1.9, 2.3, 2.88];
  const f = (t: number) => {
    let y = 0.035 * Math.sin(2 * Math.PI * 7.3 * t) + 0.025 * Math.sin(2 * Math.PI * 11.7 * t + 1.1) + 0.02 * Math.sin(2 * Math.PI * 4.1 * t + 0.4);
    for (const r of rr) {
      y += gauss(t, r, 0.0095, 0.95) + gauss(t, r - 0.03, 0.007, -0.08) + gauss(t, r + 0.025, 0.009, -0.18) + gauss(t, r + 0.24, 0.04, 0.12);
    }
    return y;
  };
  return {
    preset: 'ecg-af',
    title: 'Atrial fibrillation',
    xLabel: 'Time (s)',
    xRange: [0, 3],
    xTicks: [{ v: 0, label: '0' }, { v: 1, label: '1' }, { v: 2, label: '2' }, { v: 3, label: '3 s' }],
    lanes: [ECG_LANE('Voltage')],
    curves: [{ color: 'blue', pts: sample(f, 0, 3, 480) }],
    landmarks: [
      { x: 1.55, y: 0.02, text: 'No P waves', dx: 0, dy: -150, color: 'red', anchor: 'middle', dot: false },
      { x: 2.05, y: 0.04, text: 'Fibrillatory baseline', dx: 10, dy: 60, color: 'purple', anchor: 'start', dot: false },
    ],
    brackets: [
      { x1: rr[0], x2: rr[1], y: 1.2, text: 'RR 0.55', color: 'green', side: -1 },
      { x1: rr[1], x2: rr[2], y: 1.2, text: 'RR 0.34', color: 'orange', side: -1 },
      { x1: rr[2], x2: rr[3], y: 1.2, text: 'RR 0.73', color: 'green', side: -1 },
    ],
    vlines: [],
    hlines: [],
    caption: 'Irregularly irregular RR intervals with no P waves',
  };
}

function ecgVt(): WaveSpec {
  const T = 0.33;
  const f = (t: number) => {
    const ph = ((t % T) + T) % T / T;
    return 0.95 * Math.sin(2 * Math.PI * ph) + 0.3 * Math.sin(4 * Math.PI * ph + 0.6);
  };
  return {
    preset: 'ecg-vt',
    title: 'Ventricular tachycardia',
    xLabel: 'Time (s)',
    xRange: [0, 2],
    xTicks: [{ v: 0, label: '0' }, { v: 1, label: '1' }, { v: 2, label: '2 s' }],
    lanes: [{ frac: 1, yRange: [-1.6, 1.8], yLabel: 'Voltage', yTicks: [{ v: 0, label: '0' }] }],
    curves: [{ color: 'blue', pts: sample(f, 0, 2, 400) }],
    landmarks: [
      { x: 0.33 * 0.25, y: f(0.33 * 0.25), text: 'Wide QRS (>0.12 s)', dx: 20, dy: -30, color: 'red', anchor: 'start' },
      { x: 0.33 * 2.25, y: f(0.33 * 2.25), text: 'Rate ~180/min', dx: 20, dy: -30, color: 'orange', anchor: 'start' },
      { x: 1.2, y: 1.45, text: 'No P waves, regular', dx: 0, dy: -4, color: 'purple', anchor: 'middle', dot: false },
    ],
    brackets: [{ x1: 0.33, x2: 0.66, y: -1.35, text: 'RR 0.33 s', color: 'green', side: -1 }],
    vlines: [],
    hlines: [],
    caption: 'Fast, regular, wide complexes: treat as unstable until proven otherwise',
  };
}

function ecgBlock1(): WaveSpec {
  const o: BeatOpts = { pr: 0.34 };
  const q = [0.5, 1.42];
  const f = (t: number) => q.reduce((a, q0) => a + beatY(t, q0, o), 0);
  const ks = q.map((q0) => beatTimes(q0, o));
  return {
    preset: 'ecg-heart-block-1',
    title: 'First-degree AV block',
    xLabel: 'Time (s)',
    xRange: [0, 2.0],
    xTicks: [{ v: 0, label: '0' }, { v: 1, label: '1' }, { v: 2, label: '2 s' }],
    lanes: [ECG_LANE('Voltage')],
    curves: [{ color: 'blue', pts: sample(f, 0, 2.0, 420) }],
    landmarks: [{ x: ks[0].pPeak, y: 0.16, text: 'P', dx: 0, dy: -22, color: 'green', anchor: 'middle' }, { x: ks[0].r, y: 1.0, text: 'R', dx: 22, dy: 6, color: 'red', anchor: 'start' }],
    brackets: [
      { x1: ks[0].pOnset, x2: q[0], y: -0.3, text: 'PR 0.34 s (>0.20)', color: 'red', side: 1 },
      { x1: ks[1].pOnset, x2: q[1], y: -0.3, text: 'PR 0.34 s', color: 'red', side: 1 },
    ],
    vlines: [],
    hlines: [],
    highlight: { x1: ks[0].pOnset, x2: q[0], label: 'Long PR interval, every P conducts', color: 'red', curve: 0 },
    caption: 'Every P is followed by a QRS, but the delay is long',
  };
}

// ───────── cardiac cycle (Wiggers) ─────────

function wiggers(): WaveSpec {
  const lv = knotFn([[0, 5], [0.06, 7], [0.10, 10], [0.17, 80], [0.28, 120], [0.38, 108], [0.46, 98], [0.52, 10], [0.56, 5], [0.8, 5]]);
  const ao = knotFn([[0, 82], [0.10, 80], [0.17, 80], [0.28, 120], [0.38, 110], [0.455, 100], [0.475, 96], [0.5, 100], [0.62, 90], [0.8, 82]]);
  const la = knotFn([[0, 7], [0.045, 11], [0.09, 6], [0.12, 9], [0.17, 4], [0.3, 7], [0.42, 12], [0.51, 15], [0.55, 6], [0.7, 6], [0.8, 7]]);
  const vol = knotFn([[0, 110], [0.07, 120], [0.10, 130], [0.17, 130], [0.46, 60], [0.52, 60], [0.62, 105], [0.8, 110]]);
  return {
    preset: 'cardiac-cycle-wiggers',
    title: 'Wiggers diagram',
    xLabel: 'Time (s)',
    xRange: [0, 0.8],
    xTicks: [{ v: 0, label: '0' }, { v: 0.4, label: '0.4' }, { v: 0.8, label: '0.8' }],
    lanes: [
      { frac: 0.64, yRange: [0, 135], yLabel: 'Pressure (mmHg)', yTicks: [{ v: 0, label: '0' }, { v: 120, label: '120' }] },
      { frac: 0.36, yRange: [40, 145], yLabel: 'LV vol (mL)', yTicks: [{ v: 60, label: '60' }, { v: 130, label: '130' }] },
    ],
    curves: [
      { name: 'Aorta', color: 'red', pts: sample(ao, 0, 0.8, 160), lane: 0 },
      { name: 'LV', color: 'blue', pts: sample(lv, 0, 0.8, 160), lane: 0 },
      { name: 'LA', color: 'green', pts: sample(la, 0, 0.8, 160), lane: 0 },
      { name: 'LV volume', color: 'purple', pts: sample(vol, 0, 0.8, 160), lane: 1 },
    ],
    landmarks: [
      { x: 0.475, y: 96, text: 'Dicrotic notch', dx: 14, dy: 36, color: 'red', anchor: 'start' },
      { x: 0.51, y: 15, text: 'v wave', dx: 16, dy: -18, color: 'green', anchor: 'start' },
      { x: 0.10, y: 130, text: 'EDV', dx: -12, dy: -10, color: 'purple', lane: 1, anchor: 'end' },
      { x: 0.46, y: 60, text: 'ESV', dx: 12, dy: 14, color: 'purple', lane: 1, anchor: 'start' },
    ],
    brackets: [],
    vlines: [
      { x: 0.1, text: 'MV closes (S1)', row: 0 },
      { x: 0.17, text: 'AV opens', row: 1 },
      { x: 0.46, text: 'AV closes (S2)', row: 0 },
      { x: 0.52, text: 'MV opens', row: 1 },
    ],
    hlines: [],
    caption: 'Fill, isovolumic squeeze, eject, isovolumic relax',
    legend: 'right',
  };
}

function pvLoop(): WaveSpec {
  const ctrl: Pt[] = [[120, 8], [121, 40], [120, 80], [112, 110], [98, 122], [78, 120], [60, 108], [50, 96], [49, 60], [50, 12], [58, 5], [80, 4], [104, 6]];
  return {
    preset: 'pv-loop',
    title: 'Pressure-volume loop',
    xLabel: 'LV volume (mL)',
    xRange: [35, 135],
    xTicks: [{ v: 50, label: '50' }, { v: 90, label: '90' }, { v: 130, label: '130' }],
    lanes: [{ frac: 1, yRange: [0, 140], yLabel: 'LV pressure (mmHg)', yTicks: [{ v: 0, label: '0' }, { v: 120, label: '120' }] }],
    curves: [{ color: 'blue', pts: smoothPath(ctrl, true), closed: true }],
    landmarks: [
      { x: 120, y: 8, text: '1 MV closes (EDV)', dx: -14, dy: -20, color: 'green', anchor: 'end' },
      { x: 120, y: 80, text: '2 AV opens', dx: 14, dy: 6, color: 'red', anchor: 'start' },
      { x: 50, y: 96, text: '3 AV closes (ESV)', dx: 16, dy: 26, color: 'red', anchor: 'start' },
      { x: 50, y: 12, text: '4 MV opens', dx: -14, dy: 8, color: 'green', anchor: 'end' },
      { x: 85, y: 62, text: 'Area = stroke work', dx: 0, dy: 0, color: 'purple', anchor: 'middle', dot: false },
    ],
    brackets: [{ x1: 50, x2: 120, y: 24, text: 'Stroke volume = EDV - ESV', color: 'orange', side: -1 }],
    vlines: [],
    hlines: [],
    caption: 'Counter-clockwise loop: one heartbeat of the left ventricle',
  };
}

// ───────── oxygen dissociation, Starling ─────────

function oxyHb(highlight?: string): WaveSpec {
  const sat = (p50: number) => (x: number) => 100 * hill(x, p50, 2.7);
  const base = sat(26.8);
  const curves: WaveCurve[] = [{ name: 'Normal (P50 26.8)', color: 'blue', pts: sample(base, 0.01, 100, 80) }];
  const showRight = !highlight || highlight === 'right';
  const showLeft = !highlight || highlight === 'left';
  const both = !highlight;
  if (showRight) curves.push({ name: 'Right shift', color: 'red', pts: sample(sat(38), 0.01, 100, 80) });
  if (showLeft && (both || highlight === 'left')) curves.push({ name: 'Left shift', color: 'green', pts: sample(sat(18), 0.01, 100, 80) });
  const notes: WaveLandmark[] = [
    { x: 26.8, y: 50, text: 'P50 = 26.8 mmHg', dx: 14, dy: 40, color: 'blue', anchor: 'start' },
    { x: 40, y: base(40), text: 'Venous (PvO2 40, ~75%)', dx: 14, dy: 38, color: 'purple', anchor: 'start' },
    { x: 100, y: base(100), text: 'Arterial (PaO2 100, ~97%)', dx: -12, dy: -18, color: 'purple', anchor: 'end' },
  ];
  if (showRight) notes.push({ x: 100, y: 22, text: 'Right shift: acid, CO2, heat, 2,3-DPG', dx: 0, dy: 0, color: 'red', anchor: 'end', dot: false });
  if (showLeft) notes.push({ x: 100, y: 10, text: 'Left shift: alkalosis, cold, HbF', dx: 0, dy: 0, color: 'green', anchor: 'end', dot: false });
  return {
    preset: 'oxy-hb-dissociation',
    title: 'Oxygen-haemoglobin dissociation',
    xLabel: 'PO2 (mmHg)',
    xRange: [0, 100],
    xTicks: [{ v: 0, label: '0' }, { v: 27, label: '27' }, { v: 60, label: '60' }, { v: 100, label: '100' }],
    lanes: [{ frac: 1, yRange: [0, 105], yLabel: 'O2 saturation (%)', yTicks: [{ v: 0, label: '0' }, { v: 50, label: '50' }, { v: 100, label: '100' }] }],
    curves,
    landmarks: notes,
    brackets: [],
    vlines: [{ x: 26.8, yTo: 50 }],
    hlines: [{ y: 50, text: '50%', color: 'grey' }],
    caption: highlight === 'right' ? 'Right shift: haemoglobin lets go of O2 more easily' : highlight === 'left' ? 'Left shift: haemoglobin holds on to O2' : 'Sigmoid curve: steep where tissues unload oxygen',
  };
}

function frankStarling(): WaveSpec {
  const normal = (x: number) => 100 * (1 - Math.exp(-x / 7)) * (1 - 0.0035 * Math.max(0, x - 18) ** 1.4 / 3);
  const failure = (x: number) => 55 * (1 - Math.exp(-x / 9)) * (1 - 0.0075 * Math.max(0, x - 14) ** 1.4 / 3);
  return {
    preset: 'frank-starling',
    title: 'Frank-Starling law',
    xLabel: 'Preload: LV end-diastolic volume',
    xRange: [0, 30],
    xTicks: [{ v: 0, label: 'low' }, { v: 30, label: 'high' }],
    lanes: [{ frac: 1, yRange: [0, 110], yLabel: 'Stroke volume', yTicks: [{ v: 0, label: '0' }] }],
    curves: [
      { name: 'Normal', color: 'blue', pts: sample(normal, 0, 30, 90) },
      { name: 'Heart failure', color: 'red', pts: sample(failure, 0, 30, 90) },
    ],
    landmarks: [
      { x: 8, y: normal(8), text: 'More stretch, more output', dx: 24, dy: 40, color: 'blue', anchor: 'start' },
      { x: 20, y: normal(20), text: 'Plateau', dx: -6, dy: -22, color: 'blue', anchor: 'middle' },
      { x: 24, y: failure(24), text: 'Flatter: less output for same preload', dx: -10, dy: 34, color: 'red', anchor: 'end' },
      { x: 28, y: normal(28), text: 'Overstretch', dx: -4, dy: -22, color: 'grey', anchor: 'end' },
    ],
    brackets: [],
    vlines: [],
    hlines: [],
    caption: 'The heart pumps out what comes back, up to a limit',
  };
}

// ───────── action potentials ─────────

function apVentricular(): WaveSpec {
  const f = knotFn([[0, -90], [20, -90], [22.5, -60], [25, 20], [28, 30], [38, 14], [60, 6], [150, 2], [230, -6], [270, -40], [300, -82], [320, -90], [400, -90]]);
  return {
    preset: 'action-potential-ventricular',
    title: 'Ventricular action potential',
    xLabel: 'Time (ms)',
    xRange: [0, 400],
    xTicks: [{ v: 0, label: '0' }, { v: 200, label: '200' }, { v: 400, label: '400' }],
    lanes: [{ frac: 1, yRange: [-100, 50], yLabel: 'Membrane (mV)', yTicks: [{ v: -90, label: '-90' }, { v: 0, label: '0' }, { v: 30, label: '+30' }] }],
    curves: [{ color: 'blue', pts: sample(f, 0, 400, 260) }],
    landmarks: [
      { x: 24, y: -20, text: '0 Na+ in', dx: -16, dy: 4, color: 'red', anchor: 'end' },
      { x: 34, y: 18, text: '1 K+ out', dx: 22, dy: -22, color: 'purple', anchor: 'start' },
      { x: 130, y: 3, text: '2 Ca2+ in = K+ out (plateau)', dx: 0, dy: -26, color: 'green', anchor: 'middle' },
      { x: 270, y: -40, text: '3 K+ out', dx: 18, dy: -8, color: 'orange', anchor: 'start' },
      { x: 355, y: -90, text: '4 Resting', dx: 0, dy: -24, color: 'grey', anchor: 'middle' },
    ],
    brackets: [],
    vlines: [],
    hlines: [{ y: -70, text: 'Threshold', color: 'grey' }],
    caption: 'Long plateau keeps the ventricle contracting',
  };
}

function apNerve(): WaveSpec {
  const f = knotFn([[0, -70], [1, -70], [1.25, -55], [1.5, -30], [1.8, 35], [2.0, 38], [2.5, 0], [3.0, -60], [3.5, -80], [4.3, -76], [5.5, -70], [8, -70]]);
  return {
    preset: 'action-potential-nerve',
    title: 'Nerve action potential',
    xLabel: 'Time (ms)',
    xRange: [0, 8],
    xTicks: [{ v: 0, label: '0' }, { v: 4, label: '4' }, { v: 8, label: '8' }],
    lanes: [{ frac: 1, yRange: [-95, 55], yLabel: 'Membrane (mV)', yTicks: [{ v: -70, label: '-70' }, { v: 0, label: '0' }, { v: 30, label: '+30' }] }],
    curves: [{ color: 'blue', pts: sample(f, 0, 8, 240) }],
    landmarks: [
      { x: 0.5, y: -70, text: 'Resting -70', dx: 0, dy: -24, color: 'grey', anchor: 'start' },
      { x: 1.25, y: -55, text: 'Threshold -55', dx: -14, dy: -6, color: 'red', anchor: 'end' },
      { x: 1.5, y: -30, text: 'Depolarisation: Na+ in', dx: -16, dy: -28, color: 'red', anchor: 'end' },
      { x: 2.0, y: 38, text: 'Peak', dx: 16, dy: -6, color: 'purple', anchor: 'start' },
      { x: 2.7, y: -20, text: 'Repolarisation: K+ out', dx: 24, dy: -14, color: 'orange', anchor: 'start' },
      { x: 3.5, y: -80, text: 'Hyperpolarisation', dx: 14, dy: 30, color: 'green', anchor: 'start' },
    ],
    brackets: [],
    vlines: [],
    hlines: [{ y: -55, text: '', color: 'grey' }],
    caption: 'All or nothing: once threshold is passed, the spike follows',
  };
}

// ───────── spirometry, OGTT, dose-response ─────────

function spirometry(): WaveSpec {
  const nFvc = 5.0, oFvc = 4.0;
  const norm = (t: number) => nFvc * (1 - Math.exp(-t / 0.6));
  const obs = (t: number) => oFvc * (1 - Math.exp(-t / 1.7));
  const nF1 = norm(1), oF1 = obs(1);
  return {
    preset: 'spirometry-normal-vs-obstructive',
    title: 'Spirometry: volume-time',
    xLabel: 'Time (s)',
    xRange: [0, 6],
    xTicks: [{ v: 0, label: '0' }, { v: 1, label: '1' }, { v: 3, label: '3' }, { v: 6, label: '6' }],
    lanes: [{ frac: 1, yRange: [0, 5.6], yLabel: 'Volume exhaled (L)', yTicks: [{ v: 0, label: '0' }, { v: 2, label: '2' }, { v: 4, label: '4' }] }],
    curves: [
      { name: 'Normal', color: 'blue', pts: sample(norm, 0, 6, 120) },
      { name: 'Obstructive', color: 'red', pts: sample(obs, 0, 6, 120) },
    ],
    landmarks: [
      { x: 1, y: nF1, text: `FEV1 ${nF1.toFixed(1)} L`, dx: 18, dy: -14, color: 'blue', anchor: 'start' },
      { x: 1, y: oF1, text: `FEV1 ${oF1.toFixed(1)} L`, dx: 20, dy: 34, color: 'red', anchor: 'start' },
      { x: 5.2, y: norm(5.2), text: `FVC ${nFvc.toFixed(1)} L, ratio ${Math.round((nF1 / nFvc) * 100)}%`, dx: -4, dy: -18, color: 'blue', anchor: 'end', dot: false },
      { x: 5.2, y: obs(5.2), text: `FVC ${oFvc.toFixed(1)} L, ratio ${Math.round((oF1 / oFvc) * 100)}% (<70%)`, dx: -4, dy: 30, color: 'red', anchor: 'end', dot: false },
    ],
    brackets: [],
    vlines: [{ x: 1, text: '1 s' }],
    hlines: [],
    caption: 'Obstruction slows the first second more than it cuts the total',
  };
}

function ogtt(): WaveSpec {
  const gN = knotFn([[0, 90], [30, 135], [60, 125], [90, 105], [120, 95], [180, 88]]);
  const gD = knotFn([[0, 135], [30, 210], [60, 260], [90, 270], [120, 245], [180, 190]]);
  const iN = knotFn([[0, 8], [30, 55], [60, 45], [90, 20], [120, 12], [180, 8]]);
  const iD = knotFn([[0, 14], [30, 25], [60, 45], [90, 65], [120, 60], [180, 35]]);
  return {
    preset: 'glucose-insulin-ogtt',
    title: 'Oral glucose tolerance test',
    xLabel: 'Minutes after 75 g glucose',
    xRange: [0, 180],
    xTicks: [{ v: 0, label: '0' }, { v: 60, label: '60' }, { v: 120, label: '120' }, { v: 180, label: '180' }],
    lanes: [
      { frac: 0.6, yRange: [60, 290], yLabel: 'Glucose (mg/dL)', yTicks: [{ v: 100, label: '100' }, { v: 200, label: '200' }] },
      { frac: 0.4, yRange: [0, 80], yLabel: 'Insulin', yTicks: [{ v: 0, label: '0' }, { v: 50, label: 'high' }] },
    ],
    curves: [
      { name: 'Normal', color: 'blue', pts: sample(gN, 0, 180, 90), lane: 0 },
      { name: 'Diabetic', color: 'red', pts: sample(gD, 0, 180, 90), lane: 0 },
      { color: 'blue', pts: sample(iN, 0, 180, 90), lane: 1 },
      { color: 'red', pts: sample(iD, 0, 180, 90), lane: 1 },
    ],
    landmarks: [
      { x: 120, y: gD(120), text: '2 h > 200 = diabetes', dx: 12, dy: -26, color: 'red', anchor: 'start' },
      { x: 120, y: gN(120), text: '2 h < 140 = normal', dx: 12, dy: -14, color: 'blue', anchor: 'start' },
      { x: 30, y: iN(30), text: 'Early insulin peak', dx: -6, dy: -24, color: 'blue', anchor: 'start', lane: 1 },
      { x: 90, y: iD(90), text: 'Delayed late peak', dx: 10, dy: -24, color: 'red', anchor: 'start', lane: 1 },
    ],
    brackets: [],
    vlines: [],
    hlines: [{ y: 200, text: '', color: 'red', lane: 0 }, { y: 140, text: '', color: 'grey', lane: 0 }],
    caption: 'In diabetes glucose climbs higher and stays up',
  };
}

function doseResponse(): WaveSpec {
  const a = (x: number) => 100 * hill(10 ** x, 1, 1);
  const b = (x: number) => 100 * hill(10 ** x, 10, 1);
  return {
    preset: 'dose-response',
    title: 'Dose-response curve',
    xLabel: 'Dose (log scale)',
    xRange: [-2, 3],
    xTicks: [{ v: -2, label: '0.01' }, { v: 0, label: '1' }, { v: 2, label: '100' }],
    lanes: [{ frac: 1, yRange: [0, 112], yLabel: 'Effect (% of max)', yTicks: [{ v: 0, label: '0' }, { v: 50, label: '50' }, { v: 100, label: '100' }] }],
    curves: [
      { name: 'Potent drug', color: 'blue', pts: sample(a, -2, 3, 100) },
      { name: 'Less potent', color: 'red', pts: sample(b, -2, 3, 100) },
    ],
    landmarks: [
      { x: 0, y: 50, text: 'EC50 = dose for 50% effect', dx: -14, dy: -26, color: 'blue', anchor: 'end' },
      { x: 1, y: 50, text: 'EC50 x10', dx: 16, dy: 24, color: 'red', anchor: 'start' },
      { x: 2.6, y: 100, text: 'Emax', dx: 0, dy: -16, color: 'grey', anchor: 'middle', dot: false },
    ],
    brackets: [],
    vlines: [{ x: 0, yTo: 50 }, { x: 1, yTo: 50 }],
    hlines: [{ y: 50, text: '', color: 'grey' }, { y: 100, text: '', color: 'grey' }],
    caption: 'Right shift means lower potency, same maximum effect',
  };
}

export function buildWaveform(preset: WaveformPreset, highlight?: string): WaveSpec {
  switch (preset) {
    case 'ecg-normal':
      return ecgNormal(highlight);
    case 'ecg-stemi':
      return ecgStemi();
    case 'ecg-af':
      return ecgAf();
    case 'ecg-vt':
      return ecgVt();
    case 'ecg-heart-block-1':
      return ecgBlock1();
    case 'cardiac-cycle-wiggers':
      return wiggers();
    case 'pv-loop':
      return pvLoop();
    case 'oxy-hb-dissociation':
      return oxyHb(highlight);
    case 'frank-starling':
      return frankStarling();
    case 'action-potential-ventricular':
      return apVentricular();
    case 'action-potential-nerve':
      return apNerve();
    case 'spirometry-normal-vs-obstructive':
      return spirometry();
    case 'glucose-insulin-ogtt':
      return ogtt();
    case 'dose-response':
      return doseResponse();
  }
}
