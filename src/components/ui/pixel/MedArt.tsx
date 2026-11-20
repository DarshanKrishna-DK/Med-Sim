/* Pixel-art medical illustrations for empty states: a medicine tray (nurse
 * feed), a clipboard (debrief) and a stethoscope (history). Each is a set
 * of sprite layers drawn as crisp SVG rects; the small idle motions live
 * in app.css (.medart-*) and rest under prefers-reduced-motion. */

const PAL: Record<string, string> = {
  k: '#1d2433', // outline
  w: '#f7f6ef', // white
  g: '#d5dbe7', // steel, light
  G: '#9aa6bd', // steel, mid
  d: '#66728c', // steel, dark
  r: '#e8505b', // red
  R: '#b8323d', // red, shade
  y: '#f0c24a', // yellow
  Y: '#c9971f', // yellow, shade
  b: '#9fe1f0', // saline
  B: '#56b6d1', // saline, shade
  p: '#f3ecd6', // paper
  P: '#d6caa6', // paper, shade
  l: '#9fb0cf', // ruled line
  x: '#1c61a1', // ink
  n: '#2b4c8a', // navy (binding, tubing)
  c: '#7fc456', // tick
  o: '#b07a45', // board
  O: '#83552c', // board, shade
};

type Layer = { s: readonly string[]; x: number; y: number; cls?: string };

// ── medicine tray ────────────────────────────────────────────────────

const IV_BAG = [
  '....kkkk....',
  '....k..k....',
  '.kkkkkkkkkk.',
  'kwwwwwwwwwwk',
  'kwwwwwwwwwwk',
  'kwbbbbbbbbwk',
  'kwbwwwwwwbwk',
  'kwbwwrrwwbwk',
  'kwbwrrrrwbwk',
  'kwbwwrrwwbwk',
  'kwbwwwwwwbwk',
  'kwbbbbbbbbwk',
  'kwBBBBBBBBwk',
  '.kwBBBBBBwk.',
  '..kkwBBwkk..',
  '....kwwk....',
  '....kwwk....',
  '....kwwk....',
  '....kbBk....',
  '.....kk.....',
];

const IV_RAIL = ['kkkkkkkkkkkkkk', 'GGGGGGGGGGGGGG'];

const TUBE = ['d', 'd', 'd', 'd'];

const RX_PAD = [
  '.kkkkkkkkkkkk.',
  'knnnnnnnnnnnnk',
  'knnnnnnnnnnnnk',
  'kpppppppppppPk',
  'kpxxxpppppppPk',
  'kpxppxppppppPk',
  'kpxxxpppppppPk',
  'kpxpxppxppppPk',
  'kpxppxxpppppPk',
  'kpxppxxpppppPk',
  'kpxpxppxppppPk',
  'kpppppppppppPk',
  'kplllllllllpPk',
  'kpppppppppppPk',
  'kpllllllppppPk',
  'kpppppppppppPk',
  'kppppxpxxpxpPk',
  'kpppppxppxppPk',
  'kPPPPPPPPPPPPk',
  '.kkkkkkkkkkkk.',
];

const TRAY_BACK = [
  '.kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk.',
  'kggggggggggggggggggggggggggggggggggggggk',
  'kGddddddddddddddddddddddddddddddddddddGk',
  'kGddddddddddddddddddddddddddddddddddddGk',
];

const TRAY_FRONT = [
  'kgwwggggggggggggggggggggggggggggggggwggk',
  '.kGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGGk.',
  '..kkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkkk..',
];

const SYRINGE = [
  'kk...kkkkkkkkkkkkk.........',
  'kgkkkkdbBbBbBbBbBkkk.......',
  'kgGGGkdbbbbbbbbbbkggggggggg',
  'kgkkkkdBBBBBBBBBBkkk.......',
  'kk...kkkkkkkkkkkkk.........',
];

const NEEDLE_GLINT = ['w'];

const TABLET_W = ['.kkk.', 'kwwwk', 'kgggk', '.kkk.'];
const TABLET_Y = ['.kkk.', 'kyyyk', 'kYYYk', '.kkk.'];
const CAPSULE = ['.kkkkkk.', 'krrrwwwk', 'kRRRgggk', '.kkkkkk.'];
const DROP = ['B'];

const TRAY_LAYERS: Layer[] = [
  { s: IV_BAG, x: 1, y: 1 },
  { s: IV_RAIL, x: 0, y: 0 },
  { s: DROP, x: 6, y: 16, cls: 'medart-drip' },
  { s: TUBE, x: 6, y: 21 },
  { s: RX_PAD, x: 25, y: 2 },
  { s: TRAY_BACK, x: 2, y: 25 },
  { s: SYRINGE, x: 4, y: 24 },
  { s: NEEDLE_GLINT, x: 30, y: 26, cls: 'medart-glint' },
  { s: TABLET_W, x: 32, y: 25 },
  { s: TABLET_Y, x: 36, y: 25 },
  { s: CAPSULE, x: 32, y: 22, cls: 'medart-wobble' },
  { s: TRAY_FRONT, x: 2, y: 29 },
];

// ── clipboard ────────────────────────────────────────────────────────

const BOARD = [
  '.kkkkkkkkkkkkkkkkkk.',
  'kooooooooooooooooOOk',
  'kooooooooooooooooOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'koppppppppppppppPOOk',
  'kooooooooooooooooOOk',
  'kOOOOOOOOOOOOOOOOOOk',
  '.kkkkkkkkkkkkkkkkkk.',
];

const CLIP = ['..kkkk..', '.kg..gk.', 'kkgkkgkk', 'kggggggk', 'kGGGGGGk', 'kkkkkkkk'];

const TITLE = ['xxxxxxx..xxx'];
const TICK = ['...c', 'c.c.', '.c..'];
const RULE = ['lllllllll'];
const BOX = ['kkk', 'k.k', 'kkk'];

const CLIPBOARD_LAYERS: Layer[] = [
  { s: BOARD, x: 0, y: 3 },
  { s: CLIP, x: 6, y: 0 },
  { s: TITLE, x: 3, y: 8 },
  { s: TICK, x: 3, y: 10 },
  { s: RULE, x: 8, y: 11 },
  { s: TICK, x: 3, y: 13 },
  { s: RULE, x: 8, y: 14 },
  { s: TICK, x: 3, y: 16 },
  { s: RULE, x: 8, y: 17 },
  { s: BOX, x: 3, y: 20 },
  { s: TICK, x: 3, y: 19, cls: 'medart-tick' },
  { s: RULE, x: 8, y: 21 },
];

// ── stethoscope ──────────────────────────────────────────────────────

const STETHOSCOPE = [
  '.kk.........kk..........',
  'kwwk.......kwwk.........',
  '.kGk.......kGk..........',
  '..kGk.....kGk...........',
  '..kGk.....kGk...........',
  '...kGk...kGk............',
  '...kGk...kGk............',
  '....knnknnk.............',
  '.....knnnk..............',
  '.....knnk...............',
  '.....knnk.....kkkkk.....',
  '.....knnk....kgggggk....',
  '.....knnk...kgwwwwwGk...',
  '.....knnk...kgwwwwwGk...',
  '.....knnk...kgwwwwwGk...',
  '.....knnk...kgwwwwwGk...',
  '.....knnk...kgwwwwwGk...',
  '.....knnk....kGGGGGk....',
  '.....knnk.....kkGkk.....',
  '.....knnk......knk......',
  '.....knnnk....knnk......',
  '......knnnkkkknnk.......',
  '.......knnnnnnnk........',
  '........kkkkkkk.........',
];

const HEART = ['.r.r.', 'rrrrr', 'rrrrr', '.rrr.', '..r..'];

const STETHOSCOPE_LAYERS: Layer[] = [
  { s: STETHOSCOPE, x: 0, y: 2 },
  { s: HEART, x: 19, y: 0, cls: 'medart-beat' },
];

// ── render ───────────────────────────────────────────────────────────

function Sprite({ layer }: { layer: Layer }) {
  const rects = layer.s.flatMap((row, y) =>
    Array.from(row).map((ch, x) =>
      PAL[ch] ? <rect key={`${x}-${y}`} x={layer.x + x} y={layer.y + y} width={1} height={1} fill={PAL[ch]} /> : null,
    ),
  );
  return layer.cls ? <g className={layer.cls}>{rects}</g> : <>{rects}</>;
}

function PixelScene({ layers, w, h, label, className }: { layers: Layer[]; w: number; h: number; label: string; className: string }) {
  return (
    <svg
      viewBox={`0 0 ${w} ${h}`}
      width="100%"
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
      className={`medart ${className}`}
    >
      {layers.map((l, i) => (
        <Sprite key={i} layer={l} />
      ))}
    </svg>
  );
}

export function MedicineTrayArt() {
  return (
    <PixelScene
      layers={TRAY_LAYERS}
      w={43}
      h={32}
      label="A drip bag, a prescription pad and a tray with a syringe, tablets and a capsule"
      className="medart--tray"
    />
  );
}

export function ClipboardArt() {
  return <PixelScene layers={CLIPBOARD_LAYERS} w={20} h={27} label="A clipboard with a ticked checklist" className="medart--clipboard" />;
}

export function StethoscopeArt() {
  return <PixelScene layers={STETHOSCOPE_LAYERS} w={24} h={26} label="A stethoscope beside a beating heart" className="medart--stethoscope" />;
}
