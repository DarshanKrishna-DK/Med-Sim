// Realistic rigged humans for the 3D world (corridor + clinic room).
//
// Two Ready Player Me style rigs (separate skin / hair / outfit materials)
// are recoloured per character so the cast reads as Indian patients, staff
// and families: a range of wheatish to deep brown skin, black or greying
// hair, kurta pajama, salwar kameez with dupatta, school uniforms, nurse
// whites. Animation clips come from Xbot.glb, retargeted per rig at load
// time (see retarget.ts). Files are local under public/assets/characters;
// sources and licences are in public/assets/CREDITS.md.

export type RigId = 'male' | 'female' | 'doctor' | 'saree' | 'dhoti' | 'child';

export const RIG_URL: Record<RigId, string> = {
  // Cleaned in Blender (scratch script build_male.py): no bow tie, flower or
  // tails; knee-length kurta / sherwani cloth; fitted short haircut mesh.
  male: '/assets/characters/male-kurta.glb',
  // Player doctor: white lab coat with a straight mid-thigh hem over a
  // light-blue shirt, clean-shaven, fitted short haircut.
  doctor: '/assets/characters/doctor.glb',
  female: '/assets/characters/rpm-female.glb',
  // Built in Blender (scratch build_saree.py / build_male.py + attire_male.py),
  // same skeletons as above so the retargeted clips play unchanged:
  // saree with pleats, border and pallu over a short-sleeved blouse, bindi, bangles.
  saree: '/assets/characters/female-saree.glb',
  // Elderly man: hip-length kurta over a loose white dhoti with front pleats.
  dhoti: '/assets/characters/male-dhoti.glb',
  // Boy: t-shirt with short sleeves and knee shorts (scaled by height).
  child: '/assets/characters/male-child.glb',
};

/** Source of the shared animation library. Xbot is never rendered. */
export const ANIM_URL = '/assets/characters/Xbot.glb';

export interface Garment {
  color: string;
  /** Keep the baked fabric texture (multiplied by `color`). */
  map: boolean;
  roughness?: number;
}

export interface Look {
  rig: RigId;
  /** Standing height in metres. */
  height: number;
  /** Multiply tint over the base skin texture. */
  skin: string;
  /** Hair colour (multiplies the strand texture of the Blender-built haircut). */
  hair: string;
  hairGrey?: boolean;
  top: Garment;
  bottom: Garment;
  shoes?: string;
  beard?: 'hide' | 'keep';
  glasses?: boolean;
  /** Saree border / zari colour (saree rig). */
  border?: string;
  /** Blouse colour (saree rig). */
  blouse?: string;
  /** Draped scarf over both shoulders (salwar kameez). */
  dupatta?: string;
  stethoscope?: boolean;
  /** Theatre attire: bouffant cap over the hair, surgical mask, gloves. */
  surgical?: { cap: string; mask: string; gloves?: string };
}

export function lookKey(l: Look): string {
  return JSON.stringify(l);
}

/** Wheatish to deep brown, as multiply tints over the light base skin. */
export const SKIN_TONES = ['#d9a383', '#c88f6c', '#b77b58', '#a56a49', '#8e5a3d', '#7a4a32'];
const HAIR_BLACK = '#3a2f2a';
const HAIR_DARK_BROWN = '#5a463a';
const HAIR_GREY = '#b9b4ad';

/** The player: Indian male doctor, white coat over navy trousers, stethoscope. */
export const DOCTOR_LOOK: Look = {
  rig: 'doctor',
  height: 1.78,
  skin: '#d8a382',
  hair: '#2a1f17',
  top: { color: '#f4f5f7', map: false, roughness: 0.8 },
  bottom: { color: '#1d2a44', map: false },
  shoes: '#2a221d',
  beard: 'hide',
  stethoscope: true,
};

/** The player when the profile says female: same white coat, navy trousers
 *  and stethoscope as the male doctor, on the female rig. */
export const FEMALE_DOCTOR_LOOK: Look = {
  rig: 'female',
  height: 1.63,
  skin: '#c88f6c',
  hair: HAIR_BLACK,
  top: { color: '#f4f5f7', map: false, roughness: 0.8 },
  bottom: { color: '#1d2a44', map: false },
  shoes: '#2a221d',
  stethoscope: true,
};

/** Swap a player look onto the body the profile asked for (keeps the outfit). */
export function playerLook(base: Look, gender: 'female' | 'male' | 'other' | undefined): Look {
  if (gender !== 'female') return base;
  const { rig, height, skin, hair } = FEMALE_DOCTOR_LOOK;
  return { ...base, rig, height, skin, hair, beard: undefined };
}

export const NURSE_LOOK: Look = {
  rig: 'female',
  height: 1.6,
  skin: '#b77b58',
  hair: HAIR_BLACK,
  top: { color: '#f6f7f9', map: false, roughness: 0.75 },
  bottom: { color: '#f2f3f5', map: false },
  shoes: '#f0f0f0',
};

export const WARD_ATTENDANT_LOOK: Look = {
  rig: 'male',
  height: 1.72,
  skin: '#8e5a3d',
  hair: HAIR_BLACK,
  top: { color: '#8fb8d8', map: false, roughness: 0.8 },
  bottom: { color: '#8fb8d8', map: false },
  beard: 'hide',
};

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const pick = <T,>(arr: T[], h: number) => arr[h % arr.length];

/** Extra avalanche so seeds that differ only in their last character still
 *  spread across the outfit choices. */
function mix(h: number): number {
  h = Math.imul(h ^ (h >>> 16), 0x7feb352d);
  h = Math.imul(h ^ (h >>> 15), 0x846ca68b);
  return (h ^ (h >>> 16)) >>> 0;
}

// Kameez / kurta palettes.
const KAMEEZ = ['#9c2a3a', '#c9932e', '#1f6f73', '#d98a6a', '#2a4a9a', '#3f7a43', '#a03a7a', '#6b3fa0', '#d4b24c'];
const SALWAR = ['#f2ead8', '#e9e2cf', '#2b2b38', '#7a1f2b', '#1e3b5c', '#d8c49a'];
const DUPATTA = ['#e7c35a', '#c0392b', '#f0e6d2', '#2e8b7a', '#d76f9a', '#f4a259', '#5b7fd1'];
const KURTA = ['#f3efe6', '#e8dcc0', '#9fb6cf', '#6d7f5a', '#7d2e3a', '#c7b08a', '#3f5a7a'];
const PAJAMA = ['#f2efe8', '#e6e0d2', '#3a3d46', '#c9bfae'];
const SAREE = ['#9c1f3a', '#1f6f73', '#c2571a', '#2a4a9a', '#3f7a43', '#7a1f6b', '#d4a017', '#b8325a', '#5b3f8c', '#0f6b5c'];
const SAREE_ELDER = ['#e9e2d0', '#7a6a8a', '#5a6e7a', '#8a6d5a', '#d8cfc0', '#4f6d5a'];
const ZARI = ['#d4a640', '#c9a227', '#e2c56a', '#b33a3a', '#2a4a9a', '#f0e6d2'];
const BLOUSE = ['#d4a640', '#7a1f2b', '#1e3b5c', '#2e8b7a', '#f0e6d2', '#3a2f5a'];
const TSHIRT = ['#e04a3a', '#2f7fd8', '#f2c230', '#3faa5a', '#f28c28', '#8a5ad8', '#f2f2ee', '#1fa3a3'];
const SHORTS = ['#24365e', '#6b5a3e', '#3a3d46', '#2f5a3a', '#7a7f88'];

/** Standing height by age (rough growth curve). */
export function heightForAge(age: number, gender: 'M' | 'F'): number {
  const adult = gender === 'F' ? 1.58 : 1.72;
  if (age >= 18) return age >= 75 ? adult - 0.04 : adult;
  if (age < 1) return 0.72;
  return Math.min(adult, 0.76 + (adult - 0.76) * (age / 17));
}

/** Deterministic Indian patient look from demographics + seed (case id). */
export function patientLook(age: number, gender: 'M' | 'F', seed = ''): Look {
  const h = hash(seed || `${age}${gender}`);
  const height = heightForAge(age, gender);
  const skin = SKIN_TONES[(h >>> 3) % SKIN_TONES.length];
  const elderly = age >= 62;
  const child = age < 14;
  const teen = age >= 14 && age < 18;

  if (gender === 'F') {
    if (child) {
      return {
        rig: 'female', height, skin, hair: HAIR_BLACK,
        top: { color: '#f5f5f2', map: false }, bottom: { color: '#24365e', map: false }, shoes: '#1c1c1c',
      };
    }
    const m = mix(h);
    const saree = age >= 30 ? m % 4 !== 0 : !teen && m % 4 === 0;
    if (saree) {
      const cloth = elderly ? pick(SAREE_ELDER, h >>> 9) : pick(SAREE, h >>> 9);
      return {
        rig: 'saree',
        height,
        skin,
        hair: elderly ? HAIR_GREY : (h >>> 7) % 4 === 0 ? HAIR_DARK_BROWN : HAIR_BLACK,
        hairGrey: elderly,
        top: { color: cloth, map: false, roughness: 0.72 },
        // leggings under the saree: same colour so nothing reads through
        bottom: { color: cloth, map: false, roughness: 0.8 },
        border: pick(ZARI, h >>> 13),
        blouse: pick(BLOUSE, h >>> 17),
        shoes: '#5a3a28',
        glasses: elderly && (h >>> 19) % 2 === 0,
      };
    }
    return {
      rig: 'female',
      height,
      skin,
      hair: elderly ? HAIR_GREY : (h >>> 7) % 4 === 0 ? HAIR_DARK_BROWN : HAIR_BLACK,
      hairGrey: elderly,
      top: { color: elderly ? pick(['#e9e2d0', '#8a6d5a', '#5a6e7a'], h >>> 9) : pick(KAMEEZ, h >>> 9), map: false, roughness: 0.82 },
      bottom: { color: pick(SALWAR, h >>> 13), map: false, roughness: 0.85 },
      shoes: '#5a3a28',
      dupatta: teen && (h >>> 17) % 2 === 0 ? undefined : pick(DUPATTA, h >>> 17),
      glasses: elderly && (h >>> 19) % 2 === 0,
    };
  }

  if (child) {
    return {
      rig: 'child', height, skin, hair: HAIR_BLACK,
      top: { color: pick(TSHIRT, h >>> 9), map: false, roughness: 0.8 },
      bottom: { color: pick(SHORTS, h >>> 13), map: false, roughness: 0.85 },
      shoes: '#1c1c1c', beard: 'hide',
    };
  }
  if (elderly && mix(h) % 3 !== 0) {
    return {
      rig: 'dhoti',
      height,
      skin,
      hair: HAIR_GREY,
      hairGrey: true,
      top: { color: pick(['#f4f1ea', '#efe6d2', '#e6ddc8', '#d9d4c8'], h >>> 9), map: false, roughness: 0.85 },
      bottom: { color: pick(['#f6f3ea', '#f0e9d6'], h >>> 13), map: false, roughness: 0.88 },
      shoes: '#4a3424',
      beard: (h >>> 15) % 3 === 0 ? 'hide' : 'keep',
      glasses: (h >>> 19) % 2 === 0,
    };
  }
  const shirtTrousers = !elderly && (h >>> 11) % 3 === 0;
  return {
    rig: 'male',
    height,
    skin,
    hair: elderly ? HAIR_GREY : HAIR_BLACK,
    hairGrey: elderly,
    top: elderly
      ? { color: '#f4f1ea', map: false, roughness: 0.85 }
      : shirtTrousers
        ? { color: pick(['#cfe0f2', '#f2f2ee', '#d9c9e6', '#e8d9b0'], h >>> 9), map: false, roughness: 0.75 }
        : { color: pick(KURTA, h >>> 9), map: false, roughness: 0.85 },
    bottom: elderly
      ? { color: '#efece4', map: false }
      : shirtTrousers
        ? { color: pick(['#2f3440', '#4a4237', '#22314a'], h >>> 13), map: false }
        : { color: pick(PAJAMA, h >>> 13), map: false },
    shoes: '#3a2a20',
    beard: teen ? 'hide' : (h >>> 15) % 3 === 0 ? 'hide' : 'keep',
    glasses: elderly && (h >>> 19) % 2 === 0,
  };
}
