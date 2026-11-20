import type { ClinicId } from '../../../game/clinic';

/* 10-wide pixel glyphs, one per organ system. 'a' = main tone,
 * 'b' = highlight. Rendered as crisp SVG rects. */
const GLYPHS = {
  heart: ['.aa...aa..', 'abba.aaaa.', 'abaaaaaaa.', 'aaaaaaaaa.', '.aaaaaaa..', '..aaaaa...', '...aaa....', '....a.....'],
  brain: ['..aaaaaa..', '.aabaabaa.', 'aabaaaabaa', 'aaabaabaaa', 'abaaaabaaa', '.aaabaaaa.', '..aaa.aa..', '......aa..'],
  lungs: ['....aa....', '....aa....', '.aa.aa.aa.', 'aaa.aa.aaa', 'aaab..baaa', 'aaab..baaa', 'aaaa..aaaa', '.aa....aa.'],
  drop: ['....a.....', '...aaa....', '...aaa....', '..aaaaa...', '.aabaaaa..', '.abaaaaa..', '.aaaaaaa..', '..aaaaa...'],
  kidney: ['.aaaaa....', 'aabaaaa...', 'abaaaaaa..', 'aaaa..bb..', 'aaaa..bb..', 'abaaaaaa..', 'aabaaaa...', '.aaaaa....'],
  bone: ['aa......aa', 'aab....baa', '.aaaaaaaa.', '.abbbbbba.', 'aab....baa', 'aa......aa'],
  eye: ['...aaaa...', '.aa....aa.', 'a...bb...a', 'a..bbbb..a', 'a...bb...a', '.aa....aa.', '...aaaa...'],
  ear: ['..aaaaa...', '.aa...aa..', 'aa..aa.a..', 'a..a..aa..', 'a..a.aa...', 'aa...a....', '.aa..a....', '..aaa.....'],
  virus: ['....a.....', '.a.aaa.a..', '..aaaaa...', 'aaabaabaaa', '..aaaaa...', '.a.aaa.a..', '....a.....'],
  stomach: ['...aa.....', '...aa.....', '..aaaaa...', '.aabaaaa..', '.abaaaaaa.', '.aaaaaaaa.', '..aaaaaaa.', '......aa..'],
  bottle: ['...aa.....', '..abba....', '..aaaa....', '.aabaaa...', '.abaaaa...', '.aaaaaa...', '.aaaaaa...', '.aaaaaa...'],
  hand: ['..a.a.a...', '..a.a.a.a.', '..aaaaaaa.', '.aaaaaaaa.', 'aaaaaaaaa.', '.aaaaaaa..', '..aaaaa...', '..aaaaa...'],
  flask: ['...aaa....', '...a.a....', '...a.a....', '..a...a...', '.a.bbb.a..', 'a.bbbbb.a.', 'abbbbbbba.', '.aaaaaaa..'],
  scope: ['a.....a...', 'a.....a...', 'a.....a...', '.a...a....', '..aaa.....', '...a......', '...a...aa.', '...a..a..a', '....aaa.aa'],
  scalpel: ['........aa', '.......aba', '......aba.', '.....aba..', '....aaa...', '...aa.....', '..aa......', '.aa.......'],
  cross: ['...aaa....', '...aba....', 'aaaabaaaa.', 'abbbbbbba.', 'aaaabaaaa.', '...aba....', '...aaa....'],
  tooth: ['.aaa..aaa.', 'aabaaaabaa', 'abaaaaaaaa', 'aaaaaaaaaa', '.aaaaaaaa.', '.aaa..aaa.', '.aa....aa.', '.a......a.'],
} as const;

export type GlyphName = keyof typeof GLYPHS;

export const CLINIC_GLYPH: Record<ClinicId, GlyphName> = {
  'all-specialties': 'cross',
  'internal-medicine': 'scope',
  cardiology: 'heart',
  neurology: 'brain',
  neurosurgery: 'brain',
  dermatology: 'hand',
  endocrinology: 'flask',
  gastroenterology: 'stomach',
  pulmonology: 'lungs',
  nephrology: 'kidney',
  rheumatology: 'bone',
  hematology: 'drop',
  oncology: 'drop',
  'infectious-disease': 'virus',
  'allergy-immunology': 'virus',
  psychiatry: 'brain',
  obgyn: 'bottle',
  urology: 'kidney',
  ophthalmology: 'eye',
  ent: 'ear',
  orthopedics: 'bone',
  pmr: 'bone',
  pediatrics: 'bottle',
  'general-surgery': 'scalpel',
  'cardiothoracic-vascular-surgery': 'heart',
  geriatrics: 'scope',
  'palliative-care': 'hand',
  neonatology: 'bottle',
  'sports-medicine': 'bone',
  'plastic-surgery': 'scalpel',
  dentistry: 'tooth',
  'emergency-medicine': 'cross',
  anesthesiology: 'lungs',
  'communication-skills': 'hand',
};

export function PixelGlyph({
  name,
  size = 60,
  main = 'currentColor',
  hi = 'var(--text)',
}: {
  name: GlyphName;
  size?: number;
  main?: string;
  hi?: string;
}) {
  const rows = GLYPHS[name];
  const w = 10;
  const h = rows.length;
  return (
    <svg
      width={size}
      height={(size * h) / w}
      viewBox={`0 0 ${w} ${h}`}
      shapeRendering="crispEdges"
      aria-hidden="true"
      className="px-glyph"
    >
      {rows.flatMap((row, y) =>
        Array.from(row).map((ch, x) =>
          ch === '.' ? null : <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={ch === 'b' ? hi : main} />,
        ),
      )}
    </svg>
  );
}

/* 12×12 attending portrait for the dialogue box. */
const ATTENDING = [
  '...hhhhhh...',
  '..hhhhhhhh..',
  '..hssssssh..',
  '..sseesees..',
  '..ssssssss..',
  '...ssmmss...',
  '....ssss....',
  '..wwwccwww..',
  '.wwwwccwwww.',
  '.wwtwccwtww.',
  '.wwwttttwww.',
  '.wwwwccwwww.',
];

export function AttendingPortrait({ size = 72 }: { size?: number }) {
  const pal: Record<string, string> = {
    h: '#7a7f8c',
    s: '#d9a07a',
    e: '#1d2433',
    m: '#a5594a',
    w: '#f3f1e2',
    c: '#1c61a1',
    t: '#2a2f3a',
  };
  return (
    <svg width={size} height={size} viewBox="0 0 12 12" shapeRendering="crispEdges" aria-hidden="true" className="px-portrait">
      <rect x={0} y={0} width={12} height={12} fill="#173571" />
      {ATTENDING.flatMap((row, y) =>
        Array.from(row).map((ch, x) => (pal[ch] ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={pal[ch]} /> : null)),
      )}
    </svg>
  );
}
