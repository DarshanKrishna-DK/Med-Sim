import { useEffect, useRef } from 'react';

// Pixel-art examiner (64x64 canvas, scaled up with pixelated rendering) with
// a mouth and a row of lip-sync bars driven by the live voice amplitude
// (Conversation.getMouthAmplitude(), or the Murf read-out in typed mode).

const W = 64;
const H = 64;
const BARS = 9;

const C = {
  wall: '#112a60',
  wallLine: '#173571',
  frame: '#d9a520',
  frameIn: '#f3f1e2',
  skin: '#c68a5e',
  skinShade: '#a8704a',
  skinLight: '#d89c70',
  hair: '#c9ccd3',
  hairShade: '#9aa0ab',
  glasses: '#141a28',
  lens: '#8fb3c9',
  eye: '#1b1b1b',
  mouth: '#4a1717',
  teeth: '#efe9da',
  coat: '#e8e6da',
  coatShade: '#c4c1b3',
  shirt: '#9fb8d8',
  tie: '#7a1f2b',
  tieShade: '#5a1520',
  desk: '#6b4423',
  deskTop: '#8a5a30',
  deskEdge: '#4a2e17',
  paper: '#f3f1e2',
  paperLine: '#a7b6d6',
  plate: '#061431',
  plateText: '#a8e27c',
};

type Px = (x: number, y: number, w: number, h: number, c: string) => void;

function drawStatic(px: Px) {
  // Wall with panel lines, a framed certificate and a wall clock.
  px(0, 0, W, H, C.wall);
  for (let y = 6; y < 52; y += 8) px(0, y, W, 1, C.wallLine);
  px(3, 4, 12, 9, C.frame);
  px(4, 5, 10, 7, C.frameIn);
  px(6, 7, 6, 1, C.paperLine);
  px(6, 9, 4, 1, C.paperLine);
  px(50, 4, 9, 9, C.frameIn);
  px(51, 5, 7, 7, C.wallLine);
  px(54, 6, 1, 3, C.frameIn);
  px(54, 8, 3, 1, C.frameIn);

  // White coat, shoulders and lapels.
  px(14, 42, 36, 22, C.coat);
  px(11, 46, 42, 18, C.coat);
  px(11, 46, 3, 18, C.coatShade);
  px(50, 46, 3, 18, C.coatShade);
  // Shirt V, tie, lapel shading.
  px(27, 40, 10, 4, C.shirt);
  px(28, 44, 8, 3, C.shirt);
  px(29, 47, 6, 3, C.shirt);
  px(30, 50, 4, 2, C.shirt);
  px(31, 41, 2, 13, C.tie);
  px(31, 41, 2, 2, C.tieShade);
  px(24, 42, 3, 10, C.coatShade);
  px(37, 42, 3, 10, C.coatShade);
  // Pen in the breast pocket.
  px(42, 48, 5, 1, C.coatShade);
  px(44, 45, 1, 3, C.tie);

  // Neck.
  px(28, 36, 8, 5, C.skinShade);

  // Desk, papers and a name plate.
  px(0, 54, W, 10, C.desk);
  px(0, 54, W, 2, C.deskTop);
  px(0, 63, W, 1, C.deskEdge);
  px(3, 52, 12, 4, C.paper);
  px(4, 53, 9, 1, C.paperLine);
  px(46, 51, 14, 5, C.paper);
  px(47, 52, 11, 1, C.paperLine);
  px(47, 54, 8, 1, C.paperLine);
  px(23, 56, 18, 5, C.plate);
  px(25, 58, 14, 1, C.plateText);
}

function drawHead(px: Px, blink: boolean, mouth: number, nod: number) {
  const y0 = 12 + nod;
  // Ears.
  px(20, y0 + 9, 2, 6, C.skinShade);
  px(42, y0 + 9, 2, 6, C.skinShade);
  // Face.
  px(22, y0 + 2, 20, 20, C.skin);
  px(23, y0 + 1, 18, 1, C.skin);
  px(24, y0 + 22, 16, 1, C.skin);
  px(26, y0 + 23, 12, 1, C.skinShade);
  px(22, y0 + 14, 1, 8, C.skinShade);
  px(41, y0 + 14, 1, 8, C.skinShade);
  // Shine on the bald crown.
  px(28, y0 + 2, 5, 1, C.skinLight);
  // Grey hair at the sides and a thin fringe at the back.
  px(21, y0 + 3, 3, 9, C.hair);
  px(40, y0 + 3, 3, 9, C.hair);
  px(21, y0 + 9, 2, 3, C.hairShade);
  px(41, y0 + 9, 2, 3, C.hairShade);
  px(24, y0 + 1, 3, 1, C.hair);
  px(37, y0 + 1, 3, 1, C.hair);
  // Bushy grey eyebrows.
  px(25, y0 + 7, 5, 1, C.hair);
  px(34, y0 + 7, 5, 1, C.hair);
  px(25, y0 + 8, 1, 1, C.hairShade);
  px(38, y0 + 8, 1, 1, C.hairShade);
  // Spectacles.
  px(24, y0 + 9, 7, 5, C.glasses);
  px(33, y0 + 9, 7, 5, C.glasses);
  px(25, y0 + 10, 5, 3, C.lens);
  px(34, y0 + 10, 5, 3, C.lens);
  px(31, y0 + 10, 2, 1, C.glasses);
  px(22, y0 + 10, 2, 1, C.glasses);
  px(40, y0 + 10, 2, 1, C.glasses);
  if (blink) {
    px(26, y0 + 11, 3, 1, C.skinShade);
    px(35, y0 + 11, 3, 1, C.skinShade);
  } else {
    px(27, y0 + 11, 2, 2, C.eye);
    px(36, y0 + 11, 2, 2, C.eye);
  }
  // Nose.
  px(31, y0 + 13, 2, 4, C.skinShade);
  px(30, y0 + 16, 4, 1, C.skinShade);
  // Grey moustache.
  px(27, y0 + 18, 10, 2, C.hair);
  px(26, y0 + 19, 1, 1, C.hairShade);
  px(37, y0 + 19, 1, 1, C.hairShade);
  // Mouth: closed, small, open.
  if (mouth < 0.06) {
    px(29, y0 + 20, 6, 1, C.mouth);
  } else if (mouth < 0.3) {
    px(29, y0 + 20, 6, 2, C.mouth);
    px(30, y0 + 20, 4, 1, C.teeth);
  } else {
    px(28, y0 + 20, 8, 3, C.mouth);
    px(29, y0 + 20, 6, 1, C.teeth);
  }
}

export function ExaminerPortrait({
  mouth,
  speaking,
  label,
}: {
  /** 0..1 mouth opening, read every frame. */
  mouth: () => number;
  /** True while the examiner is mid-sentence (used for the caption state only). */
  speaking: boolean;
  label: string;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const barsRef = useRef<HTMLDivElement>(null);
  const mouthRef = useRef(mouth);
  mouthRef.current = mouth;

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx) return;
    const px: Px = (x, y, w, h, c) => {
      ctx.fillStyle = c;
      ctx.fillRect(x, y, w, h);
    };
    const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    let raf = 0;
    let smooth = 0;
    let nextBlink = performance.now() + 2500;
    let blinkUntil = 0;
    const bars = barsRef.current ? (Array.from(barsRef.current.children) as HTMLElement[]) : [];
    const frame = (now: number) => {
      const amp = Math.max(0, Math.min(1, mouthRef.current() || 0));
      smooth += (amp - smooth) * 0.45;
      if (now > nextBlink) {
        blinkUntil = now + 140;
        nextBlink = now + 2800 + Math.random() * 3200;
      }
      const nod = !reduce && smooth > 0.35 && Math.sin(now / 260) > 0.6 ? 1 : 0;
      drawStatic(px);
      drawHead(px, !reduce && now < blinkUntil, smooth, nod);
      const t = now / 1000;
      bars.forEach((b, i) => {
        const shape = 0.55 + 0.45 * Math.sin(t * (7 + i * 1.7) + i * 1.3);
        const centre = 1 - Math.abs(i - (BARS - 1) / 2) / BARS;
        const h = 0.08 + Math.min(0.92, smooth * 1.6 * shape * (0.5 + centre));
        b.style.transform = `scaleY(${h.toFixed(3)})`;
      });
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <figure className={`viva-portrait${speaking ? ' is-speaking' : ''}`}>
      <canvas ref={canvasRef} width={W} height={H} className="viva-portrait-canvas" role="img" aria-label={label} />
      <div ref={barsRef} className="viva-lipsync" aria-hidden="true">
        {Array.from({ length: BARS }, (_, i) => (
          <span key={i} />
        ))}
      </div>
    </figure>
  );
}
