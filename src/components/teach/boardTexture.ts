// Draws a lesson step (fully drawn) onto a 2D canvas for the classroom's
// 3D whiteboard texture. Uses the same shapes as the animated SVG player.

import { BOARD_H, BOARD_W, DIAGRAM, HAND_FONT, INK, buildStepDrawing, wrap } from './layout';
import type { Lesson } from './lesson';

let fontPromise: Promise<void> | null = null;

/** Loads the handwriting font (Kalam, Google Fonts) once. Resolves even if
 *  offline: the board falls back to a system script font. */
export function loadHandFont(): Promise<void> {
  if (fontPromise) return fontPromise;
  fontPromise = (async () => {
    try {
      if (!document.querySelector('link[data-medsim-hand]')) {
        const link = document.createElement('link');
        link.rel = 'stylesheet';
        link.href = 'https://fonts.googleapis.com/css2?family=Kalam:wght@400;700&display=swap';
        link.dataset.medsimHand = '1';
        document.head.appendChild(link);
        await new Promise<void>((res) => {
          link.onload = () => res();
          link.onerror = () => res();
          window.setTimeout(res, 2500);
        });
      }
      await Promise.race([
        Promise.all([document.fonts.load('400 28px Kalam'), document.fonts.load('700 28px Kalam')]),
        new Promise((r) => window.setTimeout(r, 2500)),
      ]);
    } catch {
      /* system fallback */
    }
  })();
  return fontPromise;
}

function fillText(g: CanvasRenderingContext2D, text: string, x: number, y: number, size: number, color: string, anchor: CanvasTextAlign, bold = false) {
  g.font = `${bold ? 700 : 400} ${size}px ${HAND_FONT}`;
  g.fillStyle = color;
  g.textAlign = anchor;
  g.fillText(text, x, y);
}

function drawBoardBase(g: CanvasRenderingContext2D, w: number, h: number) {
  g.fillStyle = '#fbfcfd';
  g.fillRect(0, 0, w, h);
  // faint ghosting of old marker, the way real boards look
  g.globalAlpha = 0.05;
  g.strokeStyle = '#6a7a8c';
  g.lineWidth = 18;
  for (let i = 0; i < 5; i++) {
    g.beginPath();
    const y = 120 + i * 130;
    g.moveTo(80 + i * 37, y);
    g.bezierCurveTo(400, y - 40, 800, y + 50, 1180 - i * 20, y + 8);
    g.stroke();
  }
  g.globalAlpha = 1;
}

/** Paint `lesson` step `step` (or the welcome / quiz board) onto `canvas`.
 *  Canvas is BOARD_W x BOARD_H scaled by `scale`. */
export function paintBoard(canvas: HTMLCanvasElement, lesson: Lesson | null, step: number | 'quiz', opts: { loadingTopic?: string } = {}) {
  const scale = canvas.width / BOARD_W;
  const g = canvas.getContext('2d');
  if (!g) return;
  g.setTransform(scale, 0, 0, scale, 0, 0);
  g.lineCap = 'round';
  g.lineJoin = 'round';
  drawBoardBase(g, BOARD_W, BOARD_H);

  if (!lesson) {
    if (opts.loadingTopic) {
      fillText(g, 'Today: ' + opts.loadingTopic, BOARD_W / 2, 300, 64, INK.blue, 'center', true);
      fillText(g, 'preparing the board...', BOARD_W / 2, 390, 38, INK.grey, 'center');
      return;
    }
    fillText(g, 'Teacher Portal', BOARD_W / 2, 200, 78, INK.blue, 'center', true);
    g.strokeStyle = INK.red;
    g.lineWidth = 4;
    g.beginPath();
    g.moveTo(400, 228);
    g.quadraticCurveTo(640, 244, 880, 224);
    g.stroke();
    fillText(g, 'Say "teach me" + any topic', BOARD_W / 2, 330, 44, INK.black, 'center');
    fillText(g, 'Cardiac cycle  ·  ECG basics  ·  Acid-base balance', BOARD_W / 2, 420, 34, INK.green, 'center');
    fillText(g, 'Diabetes management  ·  Asthma vs COPD', BOARD_W / 2, 470, 34, INK.green, 'center');
    fillText(g, 'Ask questions any time. There is a quiz at the end!', BOARD_W / 2, 590, 30, INK.grey, 'center');
    return;
  }

  if (step === 'quiz') {
    fillText(g, 'Quick quiz', 48, 80, 52, INK.red, 'left', true);
    wrap(lesson.quiz.question, 40).slice(0, 3).forEach((l, i) => fillText(g, l, 48, 170 + i * 58, 48, INK.black, 'left', true));
    lesson.quiz.options.forEach((o, i) => {
      const y = 380 + i * 86;
      g.strokeStyle = INK.blue;
      g.lineWidth = 3;
      g.beginPath();
      g.arc(78, y - 12, 22, 0, Math.PI * 2);
      g.stroke();
      fillText(g, 'ABCD'[i], 78, y - 1, 28, INK.blue, 'center', true);
      fillText(g, wrap(o, 44)[0], 120, y, 42, INK.black, 'left');
    });
    return;
  }

  const s = lesson.steps[step];
  if (!s) return;
  fillText(g, lesson.title, BOARD_W - 40, 40, 24, INK.grey, 'right');
  const { shapes } = buildStepDrawing(s, step);
  for (const sh of shapes) {
    g.save();
    if (sh.diagram) g.translate(DIAGRAM.x, DIAGRAM.y);
    if (sh.t === 'path') {
      const p = new Path2D(sh.d);
      if (sh.fill) {
        g.fillStyle = sh.fill;
        g.fill(p);
      }
      g.strokeStyle = sh.stroke;
      g.lineWidth = sh.w;
      g.stroke(p);
    } else {
      if (sh.rotate) {
        g.translate(sh.x, sh.y);
        g.rotate((sh.rotate * Math.PI) / 180);
        fillText(g, sh.text, 0, 0, sh.size, sh.color, sh.anchor === 'middle' ? 'center' : sh.anchor === 'end' ? 'right' : 'left', sh.bold);
      } else {
        fillText(g, sh.text, sh.x, sh.y, sh.size, sh.color, sh.anchor === 'middle' ? 'center' : sh.anchor === 'end' ? 'right' : 'left', sh.bold);
      }
    }
    g.restore();
  }
}
