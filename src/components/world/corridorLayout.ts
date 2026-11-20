import type { ClinicId } from '../../game/clinic';
import { CLINIC_LABELS } from '../../game/clinic';
import type { WallCollider } from '../three/Player';

// ───────── Hospital ground floor ─────────
//
//                 z = END_Z  ┌──────────┐  window wall (daylight)
//                            │ DIAG 3xx │
//                            │──────────│  hanging wing sign
//                            │ SURG 2xx │
//                            │──────────│  hanging wing sign
//                            │ MED  1xx │   doors alternate L / R
//      z = 0  ┌──────────────┘          └──────────────┐
//             │                LOBBY                    │  reception, directory
//      z = 11 └──────────── entrance glass ─────────────┘

export const CORRIDOR_HALF_W = 2.1;
export const CEILING_H = 3.0;
export const LOBBY_HALF_W = 7;
export const LOBBY_FRONT_Z = 11;
export const LOBBY_CEILING_H = 4.2;
export const DOOR_SPACING = 3.6;
export const FIRST_DOOR_Z = -3.2;
export const PAIRS = 18;
export const END_Z = FIRST_DOOR_Z - (PAIRS - 1) * DOOR_SPACING - 2.8; // ≈ −67
export const SPAWN = { x: 0, z: 7.2, yaw: Math.PI };

export type WingId = 'medicine' | 'surgical' | 'diagnostics';

export const WINGS: Record<WingId, { label: string; color: string; series: number }> = {
  medicine: { label: 'Medicine Wing', color: '#3f7cc4', series: 100 },
  surgical: { label: 'Surgical, Women & Children', color: '#2f9c8a', series: 200 },
  diagnostics: { label: 'Diagnostics & Critical Care', color: '#d08a2c', series: 300 },
};

export interface Department {
  id: string;
  label: string;
  wing: WingId;
  /** Built specialties map to a clinic room with cases. */
  clinic: ClinicId | null;
  /** Open non-clinic room behind this door (its own screen, no patients). */
  special?: SpecialRoom;
}

export type SpecialRoom = 'radiology';

/** True when the door leads somewhere (a clinic or a special room). */
export const isDoorOpen = (d: Department): boolean => !!d.clinic || !!d.special;

const built = (id: ClinicId, wing: WingId): Department => ({
  id,
  label: CLINIC_LABELS[id],
  wing,
  clinic: id,
});
const soon = (id: string, label: string, wing: WingId): Department => ({ id, label, wing, clinic: null });

export const DEPARTMENTS: Department[] = [
  built('internal-medicine', 'medicine'),
  built('cardiology', 'medicine'),
  built('pulmonology', 'medicine'),
  built('gastroenterology', 'medicine'),
  built('endocrinology', 'medicine'),
  built('nephrology', 'medicine'),
  built('rheumatology', 'medicine'),
  built('hematology', 'medicine'),
  built('oncology', 'medicine'),
  built('infectious-disease', 'medicine'),
  built('allergy-immunology', 'medicine'),
  built('dermatology', 'medicine'),
  built('neurology', 'medicine'),
  built('psychiatry', 'medicine'),
  built('geriatrics', 'medicine'),
  built('palliative-care', 'medicine'),

  built('pediatrics', 'surgical'),
  built('neonatology', 'surgical'),
  built('obgyn', 'surgical'),
  built('general-surgery', 'surgical'),
  built('cardiothoracic-vascular-surgery', 'surgical'),
  built('neurosurgery', 'surgical'),
  built('orthopedics', 'surgical'),
  built('sports-medicine', 'surgical'),
  built('pmr', 'surgical'),
  built('urology', 'surgical'),
  built('ent', 'surgical'),
  built('ophthalmology', 'surgical'),
  built('plastic-surgery', 'surgical'),
  built('dentistry', 'surgical'),

  built('emergency-medicine', 'diagnostics'),
  soon('intensive-care', 'Intensive Care', 'diagnostics'),
  built('anesthesiology', 'diagnostics'),
  { id: 'radiology', label: 'Radiology', wing: 'diagnostics', clinic: null, special: 'radiology' },
  soon('nuclear-medicine', 'Nuclear Medicine', 'diagnostics'),
  soon('pathology-lab', 'Pathology & Lab', 'diagnostics'),
];

export interface DoorSpec {
  index: number;
  dept: Department;
  room: string;
  side: 'L' | 'R';
  /** Door centre on the wall face. */
  x: number;
  z: number;
  /** Rotation so the door's local +Z points into the corridor. */
  rotY: number;
  /** Where the player stands when using the door / returning from it. */
  standX: number;
  standZ: number;
  /** Player yaw when returning out of the room (facing across). */
  exitYaw: number;
}

export const DOORS: DoorSpec[] = (() => {
  const counters: Record<WingId, number> = { medicine: 0, surgical: 0, diagnostics: 0 };
  return DEPARTMENTS.map((dept, i) => {
    const pair = Math.floor(i / 2);
    const side: 'L' | 'R' = i % 2 === 0 ? 'L' : 'R';
    const x = side === 'L' ? -CORRIDOR_HALF_W : CORRIDOR_HALF_W;
    const z = FIRST_DOOR_Z - pair * DOOR_SPACING;
    counters[dept.wing] += 1;
    const room = String(WINGS[dept.wing].series + counters[dept.wing]);
    return {
      index: i,
      dept,
      room,
      side,
      x,
      z,
      rotY: side === 'L' ? Math.PI / 2 : -Math.PI / 2,
      standX: side === 'L' ? x + 0.9 : x - 0.9,
      standZ: z,
      exitYaw: side === 'L' ? Math.PI / 2 : -Math.PI / 2,
    };
  });
})();

export function doorForClinic(clinic: string | null | undefined): DoorSpec | undefined {
  if (!clinic) return undefined;
  return DOORS.find((d) => d.dept.clinic === clinic);
}

/** z where a wing starts (first door pair of that wing). */
export function wingStartZ(wing: WingId): number {
  const first = DOORS.find((d) => d.dept.wing === wing)!;
  return first.z + DOOR_SPACING / 2;
}

export function wingRange(wing: WingId): string {
  const rooms = DOORS.filter((d) => d.dept.wing === wing).map((d) => d.room);
  return `${rooms[0]}-${rooms[rooms.length - 1]}`;
}

const T = 0.3; // wall thickness for colliders

export const BASE_COLLIDERS: WallCollider[] = [
  // corridor side walls
  { x: -CORRIDOR_HALF_W - T / 2, z: END_Z / 2, w: T, d: -END_Z },
  { x: CORRIDOR_HALF_W + T / 2, z: END_Z / 2, w: T, d: -END_Z },
  // corridor end wall
  { x: 0, z: END_Z - T / 2, w: CORRIDOR_HALF_W * 2 + 2 * T, d: T },
  // lobby back wall (either side of the corridor mouth)
  { x: -(LOBBY_HALF_W + CORRIDOR_HALF_W) / 2, z: -T / 2, w: LOBBY_HALF_W - CORRIDOR_HALF_W, d: T },
  { x: (LOBBY_HALF_W + CORRIDOR_HALF_W) / 2, z: -T / 2, w: LOBBY_HALF_W - CORRIDOR_HALF_W, d: T },
  // lobby side + front walls
  { x: -LOBBY_HALF_W - T / 2, z: LOBBY_FRONT_Z / 2, w: T, d: LOBBY_FRONT_Z },
  { x: LOBBY_HALF_W + T / 2, z: LOBBY_FRONT_Z / 2, w: T, d: LOBBY_FRONT_Z },
  { x: 0, z: LOBBY_FRONT_Z + T / 2, w: LOBBY_HALF_W * 2, d: T },
];
