// Whiteboard layout: turns a lesson step into a flat list of marker
// strokes and handwritten text with draw timing. The same shapes feed the
// animated SVG player (Whiteboard.tsx) and the 3D board texture
// (boardTexture.ts), so both surfaces always show the same drawing.

import type {
  CompareVisual,
  CycleVisual,
  FlowVisual,
  GraphVisual,
  LabelledVisual,
  LessonStep,
  LessonVisual,
  TimelineVisual,
  WaveformVisual,
} from './lesson';
import { buildWaveform, type WaveColor } from './waveforms.ts';

export const BOARD_W = 1280;
export const BOARD_H = 720;
/** Diagram area (right of the bullet column). */
export const DIAGRAM = { x: 420, y: 118, w: 830, h: 560 };

export const INK = {
  blue: '#1f4fbf',
  red: '#c0392b',
  green: '#23804a',
  black: '#1f2328',
  purple: '#6b3fa0',
  orange: '#c96a12',
  grey: '#5b6470',
};

export const HAND_FONT = '"Kalam", "Segoe Print", "Comic Sans MS", cursive';

export type Shape =
  | { t: 'path'; d: string; stroke: string; w: number; fill?: string; len: number; diagram: boolean; delay: number; dur: number }
  | {
      t: 'text';
      x: number;
      y: number;
      text: string;
      size: number;
      color: string;
      anchor: 'start' | 'middle' | 'end';
      bold?: boolean;
      rotate?: number;
      diagram: boolean;
      delay: number;
      dur: number;
    };

type PathIn = { d: string; stroke: string; w?: number; fill?: string; len: number };
type TextIn = { x: number; y: number; text: string; size: number; color: string; anchor?: 'start' | 'middle' | 'end'; bold?: boolean; rotate?: number };

/** Collects shapes in drawing order and hands out start times. */
class Pen {
  shapes: Shape[] = [];
  cursor = 0;
  diagram = false;
  path(p: PathIn, overlap = 0.55) {
    const dur = Math.min(1.15, Math.max(0.3, p.len / 760));
    this.shapes.push({ t: 'path', d: p.d, stroke: p.stroke, w: p.w ?? 3.5, fill: p.fill, len: p.len, diagram: this.diagram, delay: this.cursor, dur });
    this.cursor += dur * overlap;
  }
  text(tx: TextIn, overlap = 0.6) {
    const dur = Math.min(0.95, Math.max(0.28, tx.text.length * 0.032));
    this.shapes.push({ t: 'text', anchor: 'start', ...tx, diagram: this.diagram, delay: this.cursor, dur });
    this.cursor += dur * overlap;
  }
  /** Multi-line text block; returns the y after the last line. */
  lines(lines: string[], x: number, y: number, size: number, color: string, anchor: 'start' | 'middle' | 'end' = 'start', bold = false, lh = size * 1.22) {
    lines.forEach((l, i) => this.text({ x, y: y + i * lh, text: l, size, color, anchor, bold }));
    return y + lines.length * lh;
  }
  pause(s: number) {
    this.cursor += s;
  }
}

// ───────── geometry helpers ─────────

const f = (n: number) => Math.round(n * 10) / 10;

/** Average glyph width for the handwriting font, as a fraction of size. */
const CHAR_W = 0.5;

export function wrap(text: string, maxChars: number): string[] {
  const words = text.split(/\s+/).filter(Boolean);
  const out: string[] = [];
  let cur = '';
  for (const w of words) {
    if (!cur) cur = w;
    else if ((cur + ' ' + w).length <= maxChars) cur += ' ' + w;
    else {
      out.push(cur);
      cur = w;
    }
  }
  if (cur) out.push(cur);
  return out.length ? out : [''];
}

const charsFor = (width: number, size: number) => Math.max(6, Math.floor(width / (size * CHAR_W)));

function roundRect(x: number, y: number, w: number, h: number, r: number): PathIn & { stroke: string } {
  r = Math.min(r, w / 2, h / 2);
  const d =
    `M${f(x + r)} ${f(y)}H${f(x + w - r)}Q${f(x + w)} ${f(y)} ${f(x + w)} ${f(y + r)}V${f(y + h - r)}` +
    `Q${f(x + w)} ${f(y + h)} ${f(x + w - r)} ${f(y + h)}H${f(x + r)}Q${f(x)} ${f(y + h)} ${f(x)} ${f(y + h - r)}` +
    `V${f(y + r)}Q${f(x)} ${f(y)} ${f(x + r)} ${f(y)}Z`;
  return { d, len: 2 * (w + h), stroke: INK.blue };
}

function ellipse(cx: number, cy: number, rx: number, ry: number): { d: string; len: number } {
  const d = `M${f(cx - rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx + rx)} ${f(cy)}A${f(rx)} ${f(ry)} 0 1 0 ${f(cx - rx)} ${f(cy)}`;
  return { d, len: Math.PI * (3 * (rx + ry) - Math.sqrt((3 * rx + ry) * (rx + 3 * ry))) };
}

function arrowHead(tx: number, ty: number, angle: number, size = 16): string {
  const a1 = angle + Math.PI - 0.45;
  const a2 = angle + Math.PI + 0.45;
  return `M${f(tx + Math.cos(a1) * size)} ${f(ty + Math.sin(a1) * size)}L${f(tx)} ${f(ty)}L${f(tx + Math.cos(a2) * size)} ${f(ty + Math.sin(a2) * size)}`;
}

/** Hand-drawn arrow: a slightly bowed stroke plus a head. */
function arrow(x1: number, y1: number, x2: number, y2: number, bow = 0.06): { d: string; len: number; mid: [number, number]; normal: [number, number] } {
  const dx = x2 - x1, dy = y2 - y1;
  const len = Math.hypot(dx, dy) || 1;
  const nx = -dy / len, ny = dx / len;
  const cx = (x1 + x2) / 2 + nx * len * bow;
  const cy = (y1 + y2) / 2 + ny * len * bow;
  const ang = Math.atan2(y2 - cy, x2 - cx);
  return {
    d: `M${f(x1)} ${f(y1)}Q${f(cx)} ${f(cy)} ${f(x2)} ${f(y2)}` + arrowHead(x2, y2, ang),
    len: len + 34,
    mid: [(x1 + 2 * cx + x2) / 4, (y1 + 2 * cy + y2) / 4],
    normal: [nx, ny],
  };
}

/** Point where the ray from a box centre toward (tx,ty) leaves the box. */
function boxExit(cx: number, cy: number, hw: number, hh: number, tx: number, ty: number, pad = 8): [number, number] {
  const dx = tx - cx, dy = ty - cy;
  const t = Math.min(Math.abs(dx) > 1e-6 ? (hw + pad) / Math.abs(dx) : Infinity, Math.abs(dy) > 1e-6 ? (hh + pad) / Math.abs(dy) : Infinity);
  return [cx + dx * t, cy + dy * t];
}

interface Box {
  cx: number;
  cy: number;
  hw: number;
  hh: number;
}

function labelBox(pen: Pen, label: string, cx: number, cy: number, width: number, size: number, color: string): Box {
  const lines = wrap(label, charsFor(width - 24, size)).slice(0, 3);
  const lh = size * 1.18;
  const h = Math.max(size * 2.3, lines.length * lh + 26);
  const w = Math.min(width, Math.max(...lines.map((l) => l.length)) * size * CHAR_W + 40);
  const rr = roundRect(cx - w / 2, cy - h / 2, w, h, 14);
  pen.path({ ...rr, stroke: color, w: 3.5 }, 0.45);
  pen.lines(lines, cx, cy - ((lines.length - 1) * lh) / 2 + size * 0.36, size, INK.black, 'middle', false, lh);
  return { cx, cy, hw: w / 2, hh: h / 2 };
}

// ───────── visual kinds ─────────

function drawFlow(pen: Pen, v: FlowVisual, W: number, H: number) {
  const n = v.nodes.length;
  const twoRows = n >= 5;
  const cols = twoRows ? Math.ceil(n / 2) : n;
  const gap = 64;
  const bw = Math.min(230, (W - (cols - 1) * gap) / cols);
  const size = bw < 170 ? 21 : 24;
  const pos = new Map<string, Box>();
  const totalW = cols * bw + (cols - 1) * gap;
  const x0 = (W - totalW) / 2 + bw / 2;
  v.nodes.forEach((node, i) => {
    const row = twoRows && i >= cols ? 1 : 0;
    const col = row === 0 ? i : cols - 1 - (i - cols);
    const cx = x0 + col * (bw + gap);
    const cy = twoRows ? (row === 0 ? H * 0.27 : H * 0.73) : H * 0.48;
    pos.set(node.id, labelBox(pen, node.label, cx, cy, bw, size, INK.blue));
    pen.pause(0.05);
    const out = v.edges.filter((e) => e.from === node.id && e.to !== node.id && pos.has(e.to));
    const inc = v.edges.filter((e) => e.to === node.id && pos.has(e.from) && e.from !== node.id);
    for (const e of [...inc, ...out]) drawEdge(pen, pos.get(e.from)!, pos.get(e.to)!, e.label);
  });
}

function drawEdge(pen: Pen, a: Box, b: Box, label?: string) {
  const [x1, y1] = boxExit(a.cx, a.cy, a.hw, a.hh, b.cx, b.cy);
  const [x2, y2] = boxExit(b.cx, b.cy, b.hw, b.hh, a.cx, a.cy, 10);
  const ar = arrow(x1, y1, x2, y2, 0.05);
  pen.path({ d: ar.d, len: ar.len, stroke: INK.black, w: 3 }, 0.7);
  if (label) {
    const horizontal = Math.abs(x2 - x1) > Math.abs(y2 - y1);
    const lx = ar.mid[0] + (horizontal ? 0 : 14);
    const ly = ar.mid[1] + (horizontal ? -16 : 6);
    const lines = wrap(label, horizontal ? Math.max(8, Math.floor(Math.abs(x2 - x1) / 10)) : 14).slice(0, 2);
    pen.lines(horizontal ? lines.slice(-1) : lines, lx, horizontal ? ly : ly, 19, INK.red, horizontal ? 'middle' : 'start');
  }
}

function drawCycle(pen: Pen, v: CycleVisual, W: number, H: number) {
  const n = v.nodes.length;
  const cx = W / 2, cy = H / 2 + 6;
  const rx = W * 0.35, ry = H * 0.37;
  const ang = (i: number) => -Math.PI / 2 + (2 * Math.PI * i) / n;
  const boxW = n >= 5 ? 180 : 200;
  const boxes = v.nodes.map((node, i) => {
    const b = labelBox(pen, node.label, cx + Math.cos(ang(i)) * rx, cy + Math.sin(ang(i)) * ry, boxW, 22, INK.blue);
    pen.pause(0.05);
    return b;
  });
  v.nodes.forEach((_, i) => {
    const a = boxes[i], b = boxes[(i + 1) % n];
    // Walk along the ellipse from a to b, leaving both boxes.
    const a0 = ang(i), a1 = ang(i + 1);
    const pts: Array<[number, number]> = [];
    for (let k = 0; k <= 40; k++) {
      const t = a0 + ((a1 - a0) * k) / 40;
      const px = cx + Math.cos(t) * rx * 1.02, py = cy + Math.sin(t) * ry * 1.02;
      const inA = Math.abs(px - a.cx) < a.hw + 8 && Math.abs(py - a.cy) < a.hh + 8;
      const inB = Math.abs(px - b.cx) < b.hw + 10 && Math.abs(py - b.cy) < b.hh + 10;
      if (!inA && !inB) pts.push([px, py]);
    }
    if (pts.length < 2) return;
    let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
    let len = 0;
    for (let k = 1; k < pts.length; k++) {
      d += `L${f(pts[k][0])} ${f(pts[k][1])}`;
      len += Math.hypot(pts[k][0] - pts[k - 1][0], pts[k][1] - pts[k - 1][1]);
    }
    const [ex, ey] = pts[pts.length - 1];
    const [px, py] = pts[pts.length - 2];
    d += arrowHead(ex, ey, Math.atan2(ey - py, ex - px));
    pen.path({ d, len: len + 34, stroke: INK.green, w: 3.2 }, 0.6);
  });
  if (v.center) {
    const e = ellipse(cx, cy, 92, 56);
    pen.path({ ...e, stroke: INK.orange, w: 3 });
    const lines = wrap(v.center, 12).slice(0, 2);
    pen.lines(lines, cx, cy - ((lines.length - 1) * 26) / 2 + 8, 23, INK.orange, 'middle', true, 26);
  }
}

function drawCompare(pen: Pen, v: CompareVisual, W: number, H: number) {
  const colW = W * 0.44;
  const cols: Array<[number, { title: string; items: string[] }, string]> = [
    [W * 0.25, v.left, INK.blue],
    [W * 0.75, v.right, INK.red],
  ];
  pen.path({ d: `M${f(W / 2)} 96 Q${f(W / 2 + 6)} ${f(H / 2)} ${f(W / 2)} ${f(H - 20)}`, len: H - 116, stroke: INK.grey, w: 2.5 });
  const vs = ellipse(W / 2, 46, 30, 26);
  pen.path({ ...vs, stroke: INK.grey, w: 2.5 });
  pen.text({ x: W / 2, y: 55, text: 'vs', size: 26, color: INK.grey, anchor: 'middle', bold: true });
  for (const [x, col, color] of cols) {
    const title = wrap(col.title, charsFor(colW, 34))[0];
    pen.text({ x, y: 58, text: title, size: 34, color, anchor: 'middle', bold: true });
    const tw = Math.min(colW, title.length * 34 * CHAR_W + 20);
    pen.path({ d: `M${f(x - tw / 2)} 74 Q${f(x)} 80 ${f(x + tw / 2)} 72`, len: tw, stroke: color, w: 3 });
    let y = 132;
    for (const item of col.items) {
      const lines = wrap(item, charsFor(colW - 40, 26)).slice(0, 3);
      pen.path({ d: `M${f(x - colW / 2 + 6)} ${f(y - 9)}L${f(x - colW / 2 + 22)} ${f(y - 9)}`, len: 16, stroke: color, w: 4 }, 0.3);
      y = pen.lines(lines, x - colW / 2 + 34, y, 26, INK.black, 'start', false, 32) + 22;
    }
  }
}

function pointOnEllipse(cx: number, cy: number, rx: number, ry: number, tx: number, ty: number): [number, number] {
  const a = Math.atan2((ty - cy) / ry, (tx - cx) / rx);
  return [cx + Math.cos(a) * rx, cy + Math.sin(a) * ry];
}

function drawLabelled(pen: Pen, v: LabelledVisual, W: number, H: number) {
  const cx = W / 2, cy = H / 2;
  const rx = 150, ry = 96;
  const e = ellipse(cx, cy, rx, ry);
  pen.path({ ...e, stroke: INK.purple, w: 4, fill: 'rgba(107,63,160,0.06)' });
  const cl = wrap(v.center, 12).slice(0, 3);
  pen.lines(cl, cx, cy - ((cl.length - 1) * 34) / 2 + 11, 30, INK.purple, 'middle', true, 34);
  const n = v.labels.length;
  const left = Math.ceil(n / 2);
  v.labels.forEach((lab, i) => {
    const isLeft = i < left;
    const k = isLeft ? i : i - left;
    const count = isLeft ? left : n - left;
    const y = count === 1 ? cy : 70 + (k * (H - 140)) / (count - 1);
    const tx = isLeft ? W * 0.25 : W * 0.75;
    const lines = wrap(lab.label, 16).slice(0, 2);
    const anchor = isLeft ? 'end' : 'start';
    const yEnd = pen.lines(lines, tx, y + 8, 25, INK.black, anchor, true, 28);
    if (lab.note) pen.lines(wrap(lab.note, 20).slice(0, 2), tx, yEnd + 2, 19, INK.green, anchor, false, 22);
    const sx = isLeft ? tx + 12 : tx - 12;
    const [ex, ey] = pointOnEllipse(cx, cy, rx, ry, sx, y);
    pen.path({ d: `M${f(sx)} ${f(y)}L${f(ex)} ${f(ey)}`, len: Math.hypot(ex - sx, ey - y), stroke: INK.grey, w: 2.5 }, 0.6);
    pen.path({ ...ellipse(ex, ey, 5, 5), stroke: INK.red, w: 3, fill: INK.red }, 0.3);
  });
}

function drawTimeline(pen: Pen, v: TimelineVisual, W: number, H: number) {
  const y = H * 0.42;
  pen.path({ d: `M24 ${f(y)} L${f(W - 24)} ${f(y)}` + arrowHead(W - 24, y, 0, 20), len: W, stroke: INK.black, w: 3.5 });
  const n = v.events.length;
  const x0 = 80, x1 = W - 90;
  const span = n > 1 ? (x1 - x0) / (n - 1) : 0;
  v.events.forEach((ev, i) => {
    const x = n > 1 ? x0 + i * span : W / 2;
    pen.path({ d: `M${f(x)} ${f(y - 16)}L${f(x)} ${f(y + 16)}`, len: 32, stroke: INK.blue, w: 4 }, 0.3);
    pen.path({ ...ellipse(x, y, 7, 7), stroke: INK.blue, w: 3, fill: INK.blue }, 0.3);
    pen.text({ x, y: y - 32, text: ev.t, size: 24, color: INK.red, anchor: 'middle', bold: true });
    const lines = wrap(ev.label, charsFor(Math.min(220, span || 300) - 10, 22)).slice(0, 3);
    pen.lines(lines, x, y + 52, 22, INK.black, 'middle', false, 27);
  });
}

function fmt(n: number): string {
  const a = Math.abs(n);
  if (a >= 1000) return String(Math.round(n));
  if (a >= 10) return String(Math.round(n * 10) / 10);
  return String(Math.round(n * 100) / 100);
}

function drawGraph(pen: Pen, v: GraphVisual, W: number, H: number) {
  const L = 92, R = W - 30, T = 40, B = H - 84;
  const all = v.series.flatMap((s) => s.points);
  let xMin = Math.min(...all.map((p) => p[0])), xMax = Math.max(...all.map((p) => p[0]));
  let yMin = Math.min(...all.map((p) => p[1])), yMax = Math.max(...all.map((p) => p[1]));
  if (xMax - xMin < 1e-9) { xMin -= 1; xMax += 1; }
  if (yMax - yMin < 1e-9) { yMin -= 1; yMax += 1; }
  if (yMin >= 0 && yMin < 0.35 * yMax) yMin = 0;
  const pad = (yMax - yMin) * 0.08;
  yMax += pad;
  if (yMin !== 0) yMin -= pad;
  const X = (x: number) => L + ((x - xMin) / (xMax - xMin)) * (R - L);
  const Y = (y: number) => B - ((y - yMin) / (yMax - yMin)) * (B - T);
  pen.path({ d: `M${L} ${B} L${R + 10} ${B}` + arrowHead(R + 10, B, 0, 16), len: R - L + 30, stroke: INK.black, w: 3.5 }, 0.4);
  pen.path({ d: `M${L} ${B} L${L} ${T - 10}` + arrowHead(L, T - 10, -Math.PI / 2, 16), len: B - T + 30, stroke: INK.black, w: 3.5 });
  pen.text({ x: (L + R) / 2, y: H - 22, text: v.xLabel || 'x', size: 24, color: INK.grey, anchor: 'middle' });
  pen.text({ x: 26, y: (T + B) / 2, text: v.yLabel || 'y', size: 24, color: INK.grey, anchor: 'middle', rotate: -90 });
  pen.text({ x: L, y: B + 30, text: fmt(xMin), size: 19, color: INK.grey, anchor: 'middle' }, 0.3);
  pen.text({ x: R, y: B + 30, text: fmt(xMax), size: 19, color: INK.grey, anchor: 'middle' }, 0.3);
  pen.text({ x: L - 10, y: T + 6, text: fmt(yMax), size: 19, color: INK.grey, anchor: 'end' }, 0.3);
  pen.text({ x: L - 10, y: B + 6, text: fmt(yMin), size: 19, color: INK.grey, anchor: 'end' }, 0.3);
  const colors = [INK.blue, INK.red];
  v.series.forEach((s, si) => {
    const pts = s.points.map(([x, y]) => [X(x), Y(y)] as [number, number]);
    // Catmull-Rom → cubic Bézier for a smooth marker line.
    let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
    let len = 0;
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[Math.max(0, i - 1)], p1 = pts[i], p2 = pts[i + 1], p3 = pts[Math.min(pts.length - 1, i + 2)];
      const c1 = [p1[0] + (p2[0] - p0[0]) / 6, p1[1] + (p2[1] - p0[1]) / 6];
      const c2 = [p2[0] - (p3[0] - p1[0]) / 6, p2[1] - (p3[1] - p1[1]) / 6];
      d += `C${f(c1[0])} ${f(c1[1])} ${f(c2[0])} ${f(c2[1])} ${f(p2[0])} ${f(p2[1])}`;
      len += Math.hypot(p2[0] - p1[0], p2[1] - p1[1]);
    }
    pen.path({ d, len: len * 1.6, stroke: colors[si % 2], w: 4.5 }, 0.8);
    if (s.name) {
      const lx = R - 190, ly = T + 8 + si * 34;
      pen.path({ d: `M${lx} ${ly - 7} L${lx + 34} ${ly - 7}`, len: 34, stroke: colors[si % 2], w: 4.5 }, 0.3);
      pen.text({ x: lx + 44, y: ly, text: s.name, size: 22, color: colors[si % 2], bold: true });
    }
  });
}

const WAVE_INK: Record<WaveColor, string> = {
  blue: INK.blue, red: INK.red, green: INK.green, purple: INK.purple, orange: INK.orange, black: INK.black, grey: INK.grey,
};

function dashed(x1: number, y1: number, x2: number, y2: number, on = 9, off = 8): { d: string; len: number } {
  const len = Math.hypot(x2 - x1, y2 - y1) || 1;
  const ux = (x2 - x1) / len, uy = (y2 - y1) / len;
  let d = '';
  for (let t = 0; t < len; t += on + off) {
    const e = Math.min(len, t + on);
    d += `M${f(x1 + ux * t)} ${f(y1 + uy * t)}L${f(x1 + ux * e)} ${f(y1 + uy * e)}`;
  }
  return { d, len };
}

function drawWaveform(pen: Pen, v: WaveformVisual, W: number, H: number) {
  const spec = buildWaveform(v.preset, v.highlight);
  const L = 100, R = W - 36, T = 62, B = H - 92;
  const gap = 30;
  const totalFrac = spec.lanes.reduce((a, l) => a + l.frac, 0);
  const usable = B - T - gap * (spec.lanes.length - 1);
  let acc = T;
  const lanes = spec.lanes.map((l) => {
    const h = (usable * l.frac) / totalFrac;
    const g = { top: acc, bot: acc + h, l };
    acc += h + gap;
    return g;
  });
  const [x0, x1] = spec.xRange;
  const X = (x: number) => L + ((x - x0) / (x1 - x0)) * (R - L);
  const Y = (lane: number | undefined, y: number) => {
    const g = lanes[Math.min(lane ?? 0, lanes.length - 1)];
    const [a, b] = g.l.yRange;
    return g.bot - ((y - a) / (b - a)) * (g.bot - g.top);
  };
  const clampX = (x: number) => Math.max(24, Math.min(W - 24, x));
  const clampY = (y: number) => Math.max(18, Math.min(H - 6, y));

  if (!spec.vlines.some((x) => x.text)) pen.text({ x: R, y: 26, text: spec.title, size: 26, color: INK.grey, anchor: 'end', bold: true }, 0.4);
  // axes
  lanes.forEach((g, i) => {
    const last = i === lanes.length - 1;
    pen.path({ d: `M${L} ${f(g.bot)}L${R + 8} ${f(g.bot)}` + arrowHead(R + 8, g.bot, 0, 14), len: R - L + 22, stroke: INK.black, w: 3 }, 0.3);
    pen.path({ d: `M${L} ${f(g.bot)}L${L} ${f(g.top - 6)}` + arrowHead(L, g.top - 6, -Math.PI / 2, 14), len: g.bot - g.top + 20, stroke: INK.black, w: 3 }, 0.3);
    for (const t of g.l.yTicks) {
      const y = Y(i, t.v);
      pen.text({ x: L - 10, y: y + 6, text: t.label, size: 18, color: INK.grey, anchor: 'end' }, 0.15);
    }
    pen.text({ x: 30, y: (g.top + g.bot) / 2, text: g.l.yLabel, size: lanes.length > 1 ? 19 : 23, color: INK.grey, anchor: 'middle', rotate: -90 }, 0.3);
    if (last) {
      for (const t of spec.xTicks) pen.text({ x: X(t.v), y: g.bot + 28, text: t.label, size: 19, color: INK.grey, anchor: 'middle' }, 0.15);
      pen.text({ x: (L + R) / 2, y: g.bot + 58, text: spec.xLabel, size: 23, color: INK.grey, anchor: 'middle' }, 0.3);
    }
  });

  // reference lines
  for (const h of spec.hlines) {
    const y = Y(h.lane, h.y);
    const dl = dashed(L, y, R, y);
    pen.path({ d: dl.d, len: dl.len, stroke: WAVE_INK[h.color ?? 'grey'], w: 2 }, 0.2);
    if (h.text) pen.text({ x: R - 4, y: y - 8, text: h.text, size: 18, color: WAVE_INK[h.color ?? 'grey'], anchor: 'end' }, 0.2);
  }
  for (const vl of spec.vlines) {
    const top = vl.lane !== undefined ? lanes[vl.lane].top : lanes[0].top;
    const bot = vl.lane !== undefined ? lanes[vl.lane].bot : lanes[lanes.length - 1].bot;
    const yEnd = vl.yTo !== undefined ? Y(vl.lane, vl.yTo) : top;
    const dl = dashed(X(vl.x), bot, X(vl.x), vl.yTo !== undefined ? yEnd : top - 4);
    pen.path({ d: dl.d, len: dl.len, stroke: INK.grey, w: 2 }, 0.2);
    if (vl.text) pen.text({ x: clampX(X(vl.x)), y: T - 12 - (vl.row ?? 0) * 24, text: vl.text, size: 18, color: INK.grey, anchor: 'middle' }, 0.2);
  }

  // curves
  spec.curves.forEach((c) => {
    const pts = c.pts.map(([x, y]) => [X(x), Y(c.lane, y)] as [number, number]);
    let d = `M${f(pts[0][0])} ${f(pts[0][1])}`;
    let len = 0;
    for (let i = 1; i < pts.length; i++) {
      d += `L${f(pts[i][0])} ${f(pts[i][1])}`;
      len += Math.hypot(pts[i][0] - pts[i - 1][0], pts[i][1] - pts[i - 1][1]);
    }
    if (c.closed) d += 'Z';
    pen.path({ d, len, stroke: WAVE_INK[c.color], w: 4.5 }, 0.8);
  });
  // legend for named curves
  let li = 0;
  for (const c of spec.curves) {
    if (!c.name || (c.lane ?? 0) !== 0) continue;
    const lx = spec.legend === 'right' ? R - 190 : L + 22, ly = lanes[0].top + 14 + li * 30;
    pen.path({ d: `M${lx} ${ly - 7}L${lx + 34} ${ly - 7}`, len: 34, stroke: WAVE_INK[c.color], w: 4.5 }, 0.3);
    pen.text({ x: lx + 44, y: ly, text: c.name, size: 21, color: WAVE_INK[c.color], bold: true }, 0.3);
    li++;
  }
  // highlighted segment
  if (spec.highlight) {
    const hl = spec.highlight;
    const c = spec.curves[hl.curve ?? 0];
    const seg = c.pts.filter(([x]) => x >= hl.x1 && x <= hl.x2).map(([x, y]) => [X(x), Y(c.lane, y)] as [number, number]);
    if (seg.length > 1) {
      let d = `M${f(seg[0][0])} ${f(seg[0][1])}`;
      let len = 0;
      for (let i = 1; i < seg.length; i++) {
        d += `L${f(seg[i][0])} ${f(seg[i][1])}`;
        len += Math.hypot(seg[i][0] - seg[i - 1][0], seg[i][1] - seg[i - 1][1]);
      }
      pen.path({ d, len, stroke: WAVE_INK[hl.color], w: 8 }, 0.5);
    }
    pen.text({ x: clampX((X(hl.x1) + X(hl.x2)) / 2), y: T - 14, text: hl.label, size: 22, color: WAVE_INK[hl.color], anchor: 'middle', bold: true }, 0.4);
  }
  // brackets
  for (const b of spec.brackets) {
    const y = Y(b.lane, b.y), xa = X(b.x1), xb = X(b.x2);
    const col = WAVE_INK[b.color];
    pen.path({ d: `M${f(xa)} ${f(y)}L${f(xb)} ${f(y)}M${f(xa)} ${f(y - 8)}L${f(xa)} ${f(y + 8)}M${f(xb)} ${f(y - 8)}L${f(xb)} ${f(y + 8)}`, len: xb - xa + 32, stroke: col, w: 3 }, 0.4);
    pen.text({ x: clampX((xa + xb) / 2), y: clampY(y + (b.side === 1 ? 28 : -12)), text: b.text, size: 19, color: col, anchor: 'middle', bold: true }, 0.3);
  }
  // landmarks
  for (const m of spec.landmarks) {
    const px = X(m.x), py = Y(m.lane, m.y);
    const col = WAVE_INK[m.color ?? 'black'];
    if (m.dot !== false) pen.path({ ...ellipse(px, py, 5, 5), stroke: col, w: 3, fill: col }, 0.2);
    pen.text({ x: clampX(px + m.dx), y: clampY(py + m.dy), text: m.text, size: m.text.length <= 3 ? 26 : 20, color: col, anchor: m.anchor ?? 'start', bold: true }, 0.25);
  }
  if (v.caption || spec.caption) pen.text({ x: (L + R) / 2, y: H - 8, text: v.caption || spec.caption, size: 21, color: INK.black, anchor: 'middle' }, 0.3);
}

function drawVisual(pen: Pen, v: LessonVisual) {
  const { w: W, h: H } = DIAGRAM;
  switch (v.kind) {
    case 'flow':
      return v.nodes.length ? drawFlow(pen, v, W, H) : undefined;
    case 'cycle':
      return v.nodes.length ? drawCycle(pen, v, W, H) : undefined;
    case 'compare':
      return drawCompare(pen, v, W, H);
    case 'labelled':
      return drawLabelled(pen, v, W, H);
    case 'timeline':
      return v.events.length ? drawTimeline(pen, v, W, H) : undefined;
    case 'graph':
      return v.series.length && v.series[0].points.length > 1 ? drawGraph(pen, v, W, H) : undefined;
    case 'waveform':
      return drawWaveform(pen, v, W, H);
    default:
      return undefined;
  }
}

export interface StepDrawing {
  shapes: Shape[];
  /** Seconds until the last stroke is finished. */
  total: number;
}

/** Heading + bullet column, then the diagram. */
export function buildStepDrawing(step: LessonStep, index: number): StepDrawing {
  const pen = new Pen();
  const heading = `${index + 1}. ${step.heading}`;
  const hSize = heading.length > 34 ? 38 : 46;
  pen.text({ x: 48, y: 74, text: heading, size: hSize, color: INK.blue, bold: true }, 0.9);
  const hw = Math.min(BOARD_W - 96, heading.length * hSize * CHAR_W + 10);
  pen.path({ d: `M46 96 Q${f(48 + hw / 2)} 104 ${f(48 + hw)} 94`, len: hw, stroke: INK.red, w: 3.5 }, 0.8);
  let y = 172;
  for (const p of step.points.slice(0, 3)) {
    const lines = wrap(p, charsFor(320, 28)).slice(0, 3);
    pen.path({ ...ellipse(62, y - 9, 6, 6), stroke: INK.red, w: 3, fill: INK.red }, 0.3);
    y = pen.lines(lines, 82, y, 28, INK.black, 'start', false, 35) + 26;
  }
  if (step.points.length) {
    pen.path({ d: `M${DIAGRAM.x - 14} 130 Q${DIAGRAM.x - 8} 400 ${DIAGRAM.x - 14} 660`, len: 530, stroke: '#c9ced6', w: 2 }, 0.3);
  }
  pen.pause(0.15);
  pen.diagram = true;
  drawVisual(pen, step.visual);
  const last = pen.shapes.reduce((m, s) => Math.max(m, s.delay + s.dur), 0);
  return { shapes: pen.shapes, total: last };
}
