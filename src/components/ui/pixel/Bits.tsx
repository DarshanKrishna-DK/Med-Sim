import { useEffect, useRef, useState } from 'react';
import { rng } from './draw';
import { prefersReducedMotion } from '../chrome';

/* Checkerboard dither strip between a paper band and a night band.
 * Squares thin out from the `from` side to the `to` side. */
const DITHER_SVG = (() => {
  const r = rng(42);
  const cols = 48;
  const rows = 4;
  const sq = 8;
  let rects = '';
  for (let y = 0; y < rows; y++) {
    const density = [0.85, 0.6, 0.35, 0.14][y];
    for (let x = 0; x < cols; x++) {
      const checker = (x + y) % 2 === 0;
      if (checker ? r() < density + 0.15 : r() < density - 0.25) {
        rects += `<rect x="${x * sq}" y="${y * sq}" width="${sq}" height="${sq}"/>`;
      }
    }
  }
  return { w: cols * sq, h: rows * sq, rects };
})();

const PAPER = '#f4f0e1';
const NIGHT = '#0b1f4b';

export function Dither({ from, to }: { from: 'paper' | 'night'; to: 'paper' | 'night' }) {
  const top = from === 'paper' ? PAPER : NIGHT;
  const bottom = to === 'paper' ? PAPER : NIGHT;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${DITHER_SVG.w}" height="${DITHER_SVG.h}" fill="${top}">${DITHER_SVG.rects}</svg>`;
  return (
    <div
      className="dither"
      aria-hidden="true"
      style={{
        backgroundColor: bottom,
        backgroundImage: `url("data:image/svg+xml,${encodeURIComponent(svg)}")`,
      }}
    />
  );
}

/** Number that counts up once when scrolled into view. */
export function CountUp({ value, suffix = '' }: { value: number; suffix?: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(() => (prefersReducedMotion() ? value : 0));

  useEffect(() => {
    if (prefersReducedMotion()) {
      setShown(value);
      return;
    }
    const el = ref.current;
    if (!el) return;
    let raf = 0;
    const io = new IntersectionObserver(
      (entries) => {
        if (!entries.some((e) => e.isIntersecting)) return;
        io.disconnect();
        const t0 = performance.now();
        const dur = 1100;
        const tick = (t: number) => {
          const p = Math.min(1, (t - t0) / dur);
          const eased = 1 - Math.pow(1 - p, 3);
          setShown(Math.round(value * eased));
          if (p < 1) raf = requestAnimationFrame(tick);
        };
        raf = requestAnimationFrame(tick);
      },
      { threshold: 0.4 },
    );
    io.observe(el);
    return () => {
      io.disconnect();
      cancelAnimationFrame(raf);
    };
  }, [value]);

  return (
    <span ref={ref} aria-label={`${value}${suffix}`}>
      <span aria-hidden="true">
        {shown.toLocaleString()}
        {suffix}
      </span>
    </span>
  );
}

/** Diamond ornament rule used under the hero tagline. */
export function OrnamentRule() {
  return (
    <div className="ornament" aria-hidden="true">
      <span className="ornament-line" />
      <svg width="18" height="18" viewBox="0 0 9 9" shapeRendering="crispEdges">
        <rect x="3" y="0" width="3" height="3" fill="currentColor" />
        <rect x="0" y="3" width="3" height="3" fill="currentColor" />
        <rect x="6" y="3" width="3" height="3" fill="currentColor" />
        <rect x="3" y="6" width="3" height="3" fill="currentColor" />
        <rect x="3" y="3" width="3" height="3" fill="var(--background)" />
      </svg>
      <span className="ornament-line" />
    </div>
  );
}

export function ArrowIcon({ size = 14 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 7 7" shapeRendering="crispEdges" aria-hidden="true">
      <rect x="0" y="3" width="5" height="1" fill="currentColor" />
      <rect x="3" y="1" width="1" height="1" fill="currentColor" />
      <rect x="4" y="2" width="1" height="1" fill="currentColor" />
      <rect x="5" y="3" width="1" height="1" fill="currentColor" />
      <rect x="4" y="4" width="1" height="1" fill="currentColor" />
      <rect x="3" y="5" width="1" height="1" fill="currentColor" />
    </svg>
  );
}
