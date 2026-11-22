import type { RoomRole } from '../../room/types';

/* Pixel portraits of everyone who can be in a BAND agent room. Same hand as
 * Nurse Asha's mascot: 14x14 grid, crispEdges, flat palette. One silhouette per
 * role so they read without colour: cap, cross badge, goggles, beard and apron,
 * glasses and grey hair, gold tie. */

type Palette = Record<string, string>;

const K = '#1d2433';

const ART: Record<RoomRole, { px: string[]; pal: Palette }> = {
  nurse: {
    pal: { k: K, c: '#f7f6ef', r: '#e8505b', h: '#241712', s: '#b9784f', e: K, m: '#6e2a22', u: '#a8d8f2', w: '#f7f6ef' },
    px: [
      '....kkkkkk....',
      '...kccrrcck...',
      '...kcrrrrck...',
      '..kkccrrcckk..',
      '..khhhhhhhhk..',
      '.khhsssssshhk.',
      '.khssessesshk.',
      '.khssessesshk.',
      '..kssssssssk..',
      '..kkssmmsskk..',
      '...kkssssk....',
      '..kuuwsswuuk..',
      '.kuuuuwwuuuuk.',
      '.kuuuuuuuuuuk.',
    ],
  },
  pharmacist: {
    pal: { k: K, h: '#3a1d12', s: '#c98d62', e: K, m: '#7a3226', g: '#4f9a4a', w: '#f7f6ef', c: '#a8e27c' },
    px: [
      '....kkkkkk....',
      '..kkhhhhhhkk..',
      '.khhhhhhhhhhk.',
      '.khhhsssshhhk.',
      '.khhsssssshhk.',
      '.khsssssssshk.',
      '.khsessssesk..',
      '.khsssssssshk.',
      '.khhsssssshhk.',
      '.khhksmmskhhk.',
      '.khkkssssskhk.',
      '..kwwgsssgwwk.',
      '.kwwwwggwcwwk.',
      '.kwwwwggcccwk.',
    ],
  },
  lab: {
    pal: { k: K, h: '#15110f', s: '#8f5a3a', e: K, m: '#54231b', l: '#8fe3ff', f: '#5b4a99', w: '#f7f6ef', p: '#c9a7ff' },
    px: [
      '....kkkkkk....',
      '...khhhhhhk...',
      '..khhhhhhhhk..',
      '..khhsssshhk..',
      '..khsssssshk..',
      '..kffffffffk..',
      '..kfllkkllfk..',
      '..kfllkkllfk..',
      '..kkffsssffk..',
      '...kssmmssk...',
      '....kssssk....',
      '..kwwpsspwwk..',
      '.kwwwwppwwwwk.',
      '.kwwwwppwpwwk.',
    ],
  },
  radiology: {
    pal: { k: K, h: '#2a1a14', s: '#b57a50', e: K, m: '#6b2a20', a: '#d06a2c', A: '#ffa36b', b: '#33201a' },
    px: [
      '...kkkkkkkk...',
      '..khhhhhhhhk..',
      '..khhhhhhhhk..',
      '..khsssssshk..',
      '..kssssssssk..',
      '..ksessssesk..',
      '..kssssssssk..',
      '..kbssssssbk..',
      '..kbbbbbbbbk..',
      '..kkbbmmbbkk..',
      '...kkbbbbkk...',
      '..kaAkbbkAak..',
      '.kaaaAAAAaaak.',
      '.kaaaaaaaaaak.',
    ],
  },
  examiner: {
    pal: { k: K, h: '#c9ced8', s: '#c9936b', e: K, m: '#7a3226', g: '#f7f6ef', u: '#7b2f4f', w: '#f7f6ef', t: '#f59bc0' },
    px: [
      '....kkkkkk....',
      '...khhhhhhk...',
      '..khhssssshk..',
      '..khsssssshk..',
      '..khsssssshk..',
      '..kkkkkkkkkk..',
      '..kkgekkgekk..',
      '..kkkkskkkkk..',
      '..kssssssssk..',
      '...kssmmssk...',
      '....kssssk....',
      '..kuuwssvuuk..',
      '.kuuuuwtuuuuk.',
      '.kuuuuttuuuuk.',
    ],
  },
  faculty: {
    pal: { k: K, h: '#4a4f5c', s: '#d09a70', e: K, m: '#7a3226', u: '#23355f', w: '#f7f6ef', g: '#ffd76a' },
    px: [
      '....kkkkkk....',
      '..kkhhhhhhkk..',
      '..khhhhhhhhk..',
      '..khsssssshk..',
      '..kssssssssk..',
      '..ksessssesk..',
      '..kssssssssk..',
      '..kssssssssk..',
      '..kkssmmsskk..',
      '...kssmmssk...',
      '....kssssk....',
      '..kuuwggwuuk..',
      '.kuuuuggwuuuk.',
      '.kuuuuggwuuuk.',
    ],
  },
  // Dr Iyer: silver hair in a bun, chalk-green coat.
  teacher: {
    pal: { k: K, h: '#c9ccd6', s: '#a86f48', e: K, m: '#8a2f2a', u: '#2f6b5a', w: '#f7f6ef', y: '#ffd76a' },
    px: [
      '.....khhk.....',
      '....khhhhk....',
      '..kkhhhhhhkk..',
      '.khhhhhhhhhhk.',
      '.khhsssssshhk.',
      '.khsssssssshk.',
      '.khssessesshk.',
      '.khsssssssshk.',
      '.khssmmmmsshk.',
      '..khssssssk...',
      '....kssssk....',
      '..kuuwsswuuk..',
      '.kuuuuyyuuuuk.',
      '.kuuuuyyuuuuk.',
    ],
  },
  // Priya: side plait, marigold sari border.
  reception: {
    pal: { k: K, h: '#1c120f', s: '#b9784f', e: K, m: '#8c2f3a', r: '#c2185b', u: '#7a3f9d', y: '#ffb347' },
    px: [
      '....kkkkkk....',
      '..kkhhhhhhkk..',
      '..khhhhhhhhk..',
      '.khhhssrshhk..',
      '.khhsssssshk..',
      '.khsessesshk..',
      '.khssssssshk..',
      '.khhsssssshk..',
      '.khhksmmskkk..',
      '.khhkkssskk...',
      '.khhkkssk.....',
      '.kyhuusssuyk..',
      '.kyyuuuuuyyuk.',
      '.kuyyyuuyyuuk.',
    ],
  },
  // Sister Leela: theatre cap and mask.
  theatre: {
    pal: { k: K, c: '#3f8f9a', C: '#5fb3bd', s: '#a86f48', e: K, w: '#dff1f2', u: '#2f7480' },
    px: [
      '....kkkkkk....',
      '..kkccCCcckk..',
      '.kccCccccCcck.',
      '.kcccccccccck.',
      '.kccccccccck..',
      '..kssssssssk..',
      '..ksessssesk..',
      '..kwwwwwwwwk..',
      '..kwwwwwwwwk..',
      '...kwwwwwwk...',
      '....kssssk....',
      '..kuuwsswuuk..',
      '.kuuuuwwuuuuk.',
      '.kuuuuuuuuuuk.',
    ],
  },
};

const RECTS = Object.fromEntries(
  (Object.keys(ART) as RoomRole[]).map((role) => [
    role,
    ART[role].px.flatMap((row, y) =>
      Array.from(row).map((ch, x) =>
        ART[role].pal[ch] ? <rect key={`${x}-${y}`} x={x} y={y} width={1} height={1} fill={ART[role].pal[ch]} /> : null,
      ),
    ),
  ]),
) as Record<RoomRole, Array<JSX.Element | null>>;

/** Decorative: the name always sits next to it. */
export function RoomAvatar({ role, size = 28 }: { role: RoomRole; size?: number }) {
  return (
    <svg className={`ar-avatar ar-role--${role}`} width={size} height={size} viewBox="0 0 14 14" shapeRendering="crispEdges" aria-hidden="true">
      {RECTS[role] ?? RECTS.faculty}
    </svg>
  );
}
