import { useMemo } from 'react';
import '../../styles/reception.css';

/* Priya at Reception: a pixel-art front-desk receptionist, drawn like Nurse
 * Asha (SVG rects, crispEdges, 24x22 grid). Hair bun, bindi, headset and a
 * navy blazer over a saree border. Talking swaps the mouth; CSS does motion. */

const PAL: Record<string, string> = {
  k: '#1d2433', // outline
  h: '#1f1410', // hair
  H: '#3a2620', // hair shine
  s: '#c08458', // skin
  S: '#9b5f3d', // skin shade
  b: '#d98b72', // blush
  j: '#2c3e70', // blazer
  J: '#1f2d55', // blazer shade
  w: '#f7f6ef', // blouse
  g: '#e0a83c', // saree border
  m: '#4a5468', // headset
  n: '#a8e27c', // name tag
};

const BASE = [
  '.....kkkkkk.....',
  '....khhhhhhk....',
  '...khhHHhhhhk...',
  '..khhhhhhhhhhk..',
  '.khhhhhhhhhhhhk.',
  '.khhhsssssshhhk.',
  'mkhsssssssssshk.',
  'mkhsssssssssshk.',
  'mkhsssssssssshk.',
  'mkhsssssssssshk.',
  '.khsbssssssbshk.',
  '..khsssssssshk..',
  '...kkSssssSkk...',
  '....kwSSSSwk....',
  '..kkjwwwwwwjkk..',
  '.kjjjjgwwgjjjjk.',
  '.kjjjjjggjjjnnk.',
  '.kJjjjjjjjjjjJk.',
  '.kJjjjjjjjjjjJk.',
  '.kkkkkkkkkkkkkk.',
];

const OX = 4;
const OY = 2;

export function PriyaSprite({ talking = false, busy = false, size = 84 }: { talking?: boolean; busy?: boolean; size?: number }) {
  const base = useMemo(
    () =>
      BASE.flatMap((row, y) =>
        Array.from(row).map((ch, x) =>
          PAL[ch] ? <rect key={`${x}-${y}`} x={OX + x} y={OY + y} width={1} height={1} fill={PAL[ch]} /> : null,
        ),
      ),
    [],
  );
  return (
    <svg
      width={size}
      height={Math.round((size * 22) / 24)}
      viewBox="0 0 24 22"
      shapeRendering="crispEdges"
      className={`priya ${talking ? 'priya--talking' : ''} ${busy ? 'priya--busy' : ''}`}
      role="img"
      aria-label={`Priya at Reception${talking ? ', speaking' : busy ? ', working' : ''}`}
    >
      <g className="priya-figure">
        {base}
        {/* hair bun + bindi */}
        <rect x={OX + 6} y={OY - 2} width={4} height={2} fill={PAL.h} />
        <rect x={OX + 7} y={OY + 6} width={2} height={1} fill="#d6334a" />
        {/* headset mic boom */}
        <rect x={OX + 0} y={OY + 10} width={1} height={1} fill={PAL.m} />
        <rect x={OX + 1} y={OY + 11} width={3} height={1} fill={PAL.m} />
        {/* eyes (blink via CSS) */}
        <g className="priya-eyes">
          <rect x={OX + 5} y={OY + 8} width={1} height={2} fill={PAL.k} />
          <rect x={OX + 10} y={OY + 8} width={1} height={2} fill={PAL.k} />
        </g>
        {/* mouth */}
        <g className="priya-mouth-rest">
          <rect x={OX + 6} y={OY + 10} width={1} height={1} fill="#6e2a22" />
          <rect x={OX + 7} y={OY + 11} width={2} height={1} fill="#6e2a22" />
          <rect x={OX + 9} y={OY + 10} width={1} height={1} fill="#6e2a22" />
        </g>
        <g className="priya-mouth-open">
          <rect x={OX + 7} y={OY + 10} width={2} height={1} fill="#6e2a22" />
          <rect x={OX + 7} y={OY + 11} width={2} height={1} fill="#e07a7a" />
        </g>
      </g>
      {busy && (
        <g>
          <rect className="priya-dot" x={18} y={2} width={1} height={1} fill="#f0c24a" />
          <rect className="priya-dot priya-dot--2" x={20} y={2} width={1} height={1} fill="#f0c24a" />
          <rect className="priya-dot priya-dot--3" x={22} y={2} width={1} height={1} fill="#f0c24a" />
        </g>
      )}
    </svg>
  );
}
