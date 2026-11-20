import { memo, useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Clone, Text, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { FONT_BOLD, FONT_HEAVY, FONT_MED, canvasTex } from './Corridor';
import { DOORS } from './corridorLayout';
import { HumanCharacter, makeControl, type CharacterControl } from './HumanCharacter';
import { hindiLabel, useSignFontsReady } from './hindi';
import { DOCTOR_LOOK, NURSE_LOOK, type Look } from './rigs';
import type { Collider, PlayerRuntime } from './ThirdPersonPlayer';
import type { StationId, Vitals } from '../../ot/scenarios';
import type { AlarmLevel } from '../../ot/engine';

// ───────── Operation theatre ─────────
//
//   z = −8.5 ┌──[WHO poster]────[lap tower]──────[x-ray viewer]────────┐
//            │ workstation   anaesthetist   assistant   scrub nurse     │
//            │   + monitor    [head]══ OT TABLE ══[feet]   [warmer]     │
//   x = −5   │ drug cart   IV  (arm board)  chief surgeon  suction      │ x = +5
//            │                                           diathermy     │
//   z = 0    └─────────────────────────────────────────┐ doors ┌───────┘
//
// Patient lies along x, head toward the anaesthetist (−x). Their right side
// faces +z, where the chief surgeon stands. Nothing is animated surgically:
// the team holds static working poses under the OT lights.

export const OT = { minX: -5, maxX: 5, minZ: -8.5, maxZ: 0, h: 3.2 };
export const OT_DOOR = { x: 3.2, halfW: 0.8 };
// Spawn well inside the room and off the door axis: the third-person camera
// sits ~2.5 m behind the player, so a spawn near the doorway put the camera
// outside the room (the scene opened on a blank wall). From here the player
// faces the table (z -4.8) with the camera still inside the door wall (z 0).
export const OT_SPAWN = { x: 1.7, z: -3.0, yaw: Math.PI };
export const OT_EXIT = { x: OT_DOOR.x, z: -0.75 };

const TABLE = { x: 0, z: -4.8, len: 2.1, w: 0.58, h: 0.92 };
const HEAD_X = TABLE.x - 0.86;
const FIELD_X = TABLE.x + 0.18;

export interface OTStationSpec {
  id: StationId;
  x: number;
  z: number;
  /** Floating label height. */
  y: number;
  label: string;
}

export const OT_STATIONS: OTStationSpec[] = [
  { id: 'iv', x: -1.4, z: -3.55, y: 2.05, label: 'IV PUMP' },
  { id: 'patient', x: -0.62, z: -3.72, y: 1.35, label: 'PATIENT' },
  { id: 'drugs', x: -3.45, z: -3.6, y: 1.45, label: 'DRUG CART' },
  { id: 'oxygen', x: -2.6, z: -5.65, y: 1.95, label: 'VENTILATOR / O2' },
  { id: 'suction', x: 1.95, z: -3.65, y: 1.35, label: 'SUCTION' },
  { id: 'cautery', x: 2.95, z: -4.95, y: 1.45, label: 'DIATHERMY' },
  { id: 'warmer', x: 1.55, z: -6.55, y: 1.45, label: 'WARMER' },
];

/** Reach for a station (metres from its centre to the player). */
export const STATION_REACH = 1.45;

const ANAES = { x: -1.75, z: -5.35, yaw: 1.15 };
const CHIEF = { x: FIELD_X + 0.05, z: TABLE.z + 0.68, yaw: Math.PI };
const ASSIST = { x: FIELD_X - 0.05, z: TABLE.z - 0.7, yaw: 0 };
const SCRUB = { x: 1.6, z: -5.45, yaw: -0.95 };
const TOWER = { x: 0.7, z: -7.2 };

const T = 0.3;
export const OT_COLLIDERS: Collider[] = [
  { x: 0, z: OT.minZ - T / 2, w: 10.6, d: T },
  { x: OT.minX - T / 2, z: -4.25, w: T, d: 9.1 },
  { x: OT.maxX + T / 2, z: -4.25, w: T, d: 9.1 },
  { x: (OT.minX + OT_DOOR.x - OT_DOOR.halfW) / 2, z: T / 2, w: OT_DOOR.x - OT_DOOR.halfW - OT.minX, d: T },
  { x: (OT_DOOR.x + OT_DOOR.halfW + OT.maxX) / 2, z: T / 2, w: OT.maxX - OT_DOOR.x - OT_DOOR.halfW, d: T },
  { x: OT_DOOR.x, z: 0.35, w: OT_DOOR.halfW * 2, d: 0.2 },
  // table with the arm board, people, equipment
  { x: TABLE.x, z: TABLE.z, w: TABLE.len + 0.2, d: TABLE.w + 0.25, h: 1.1 },
  { x: HEAD_X + 0.22, z: TABLE.z + 0.62, w: 0.25, d: 0.75, h: 1.0 },
  { x: CHIEF.x, z: CHIEF.z + 0.05, w: 0.55, d: 0.45 },
  { x: ASSIST.x, z: ASSIST.z - 0.05, w: 0.55, d: 0.45 },
  { x: SCRUB.x, z: SCRUB.z, w: 0.5, d: 0.5 },
  { x: ANAES.x, z: ANAES.z, w: 0.5, d: 0.5 },
  { x: -2.6, z: -5.65, w: 0.8, d: 0.75 },
  { x: -3.45, z: -3.6, w: 0.65, d: 0.55, h: 1.05 },
  { x: -1.4, z: -3.55, w: 0.35, d: 0.35 },
  { x: 1.95, z: -3.65, w: 0.5, d: 0.45, h: 1.0 },
  { x: 2.95, z: -4.95, w: 0.65, d: 0.55, h: 1.1 },
  { x: 1.55, z: -6.55, w: 0.5, d: 0.5, h: 1.2 },
  { x: TOWER.x, z: TOWER.z, w: 0.7, d: 0.6 },
  { x: 1.75, z: -6.05 + 0.4, w: 0.9, d: 0.45, h: 0.95 },
];

// ───────── people ─────────

const GOWN = '#3f7f6e';
const MASK = '#9cc9d8';
const LATEX = '#e6d3ad';

export const SURGEON_LOOK: Look = {
  rig: 'doctor',
  height: 1.77,
  skin: '#b77b58',
  hair: '#2a1f17',
  top: { color: GOWN, map: false, roughness: 0.9 },
  bottom: { color: GOWN, map: false, roughness: 0.9 },
  shoes: '#e9ecee',
  beard: 'hide',
  glasses: true,
  surgical: { cap: '#2f5f8f', mask: MASK, gloves: LATEX },
};

export const ASSISTANT_LOOK: Look = {
  rig: 'female',
  height: 1.61,
  skin: '#a56a49',
  hair: '#3a2f2a',
  top: { color: GOWN, map: false, roughness: 0.9 },
  bottom: { color: GOWN, map: false, roughness: 0.9 },
  shoes: '#e9ecee',
  surgical: { cap: GOWN, mask: MASK, gloves: LATEX },
};

export const ANAESTHETIST_LOOK: Look = {
  rig: 'doctor',
  height: 1.72,
  skin: '#8e5a3d',
  hair: '#2a1f17',
  top: { color: '#3d6fa8', map: false, roughness: 0.88 },
  bottom: { color: '#3d6fa8', map: false, roughness: 0.88 },
  shoes: '#e9ecee',
  beard: 'hide',
  surgical: { cap: '#7c4f9a', mask: MASK, gloves: '#6f8fd8' },
};

export const SCRUB_NURSE_LOOK: Look = {
  ...NURSE_LOOK,
  top: { color: GOWN, map: false, roughness: 0.9 },
  bottom: { color: GOWN, map: false, roughness: 0.9 },
  surgical: { cap: GOWN, mask: MASK, gloves: LATEX },
};

/** The student, a junior in theatre scrubs. */
export const OT_PLAYER_LOOK: Look = {
  ...DOCTOR_LOOK,
  top: { color: '#5d93ad', map: false, roughness: 0.88 },
  bottom: { color: '#5d93ad', map: false, roughness: 0.88 },
  shoes: '#e9ecee',
  stethoscope: false,
  surgical: { cap: '#5d93ad', mask: MASK },
};

// ───────── helpers ─────────

function Box({ p, s, c, r = 0.7, m = 0, cast = false, rot, e, ei = 1 }: { p: [number, number, number]; s: [number, number, number]; c: string; r?: number; m?: number; cast?: boolean; rot?: [number, number, number]; e?: string; ei?: number }) {
  return (
    <mesh position={p} rotation={rot} castShadow={cast} receiveShadow>
      <boxGeometry args={s} />
      <meshStandardMaterial color={c} roughness={r} metalness={m} emissive={e ?? '#000000'} emissiveIntensity={e ? ei : 0} />
    </mesh>
  );
}

function Cyl({ p, r, h, c, rough = 0.5, metal = 0, rot, seg = 16, cast = false, opacity }: { p: [number, number, number]; r: number | [number, number]; h: number; c: string; rough?: number; metal?: number; rot?: [number, number, number]; seg?: number; cast?: boolean; opacity?: number }) {
  const [rt, rb] = Array.isArray(r) ? r : [r, r];
  return (
    <mesh position={p} rotation={rot} castShadow={cast}>
      <cylinderGeometry args={[rt, rb, h, seg]} />
      <meshStandardMaterial color={c} roughness={rough} metalness={metal} transparent={opacity !== undefined} opacity={opacity ?? 1} />
    </mesh>
  );
}

/** Steel pole on a five-wheel base. */
function PoleBase({ x, z, h }: { x: number; z: number; h: number }) {
  return (
    <group position={[x, 0, z]}>
      {[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2;
        return <Box key={i} p={[Math.sin(a) * 0.14, 0.05, Math.cos(a) * 0.14]} s={[0.03, 0.025, 0.28]} c="#c9ced4" m={0.7} r={0.3} rot={[0, a, 0]} />;
      })}
      <Cyl p={[0, h / 2, 0]} r={0.014} h={h} c="#d7dbe0" metal={0.85} rough={0.25} />
    </group>
  );
}

// ───────── shell ─────────

function makeTileTex() {
  return canvasTex(512, 512, (g) => {
    g.fillStyle = '#c4d9d0';
    g.fillRect(0, 0, 512, 512);
    g.strokeStyle = 'rgba(70,100,90,0.35)';
    g.lineWidth = 3;
    for (let k = 0; k <= 512; k += 64) {
      g.beginPath();
      g.moveTo(k, 0);
      g.lineTo(k, 512);
      g.moveTo(0, k);
      g.lineTo(512, k);
      g.stroke();
    }
    for (let i = 0; i < 900; i++) {
      g.fillStyle = i % 2 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.03)';
      g.fillRect((i * 97.13) % 512, (i * 53.71) % 512, 3, 3);
    }
  });
}

function makeFloorTex() {
  return canvasTex(512, 512, (g) => {
    g.fillStyle = '#7d958d';
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 3200; i++) {
      g.fillStyle = i % 3 ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.08)';
      g.fillRect((i * 97.13) % 512, (i * 53.71 + (i % 7) * 31) % 512, 2, 2);
    }
  });
}

function Shell() {
  const tiles = useMemo(() => {
    const t = makeTileTex();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(5, 1.6);
    return t;
  }, []);
  const floor = useMemo(() => {
    const t = makeFloorTex();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(5, 4);
    return t;
  }, []);
  useEffect(
    () => () => {
      tiles.dispose();
      floor.dispose();
    },
    [tiles, floor],
  );
  const H = OT.h;
  const W = OT.maxX - OT.minX;
  const D = OT.maxZ - OT.minZ;
  const cz = (OT.minZ + OT.maxZ) / 2;
  const wallMat = <meshStandardMaterial map={tiles} roughness={0.55} />;
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, cz]} receiveShadow>
        <planeGeometry args={[W + 0.4, D + 0.4]} />
        <meshStandardMaterial map={floor} roughness={0.35} metalness={0.05} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, H, cz]}>
        <planeGeometry args={[W, D]} />
        <meshStandardMaterial color="#e9eeec" roughness={0.9} />
      </mesh>
      {/* walls */}
      <mesh position={[0, H / 2, OT.minZ - 0.1]} receiveShadow>
        <boxGeometry args={[W + 0.4, H, 0.2]} />
        {wallMat}
      </mesh>
      <mesh position={[OT.minX - 0.1, H / 2, cz]} receiveShadow>
        <boxGeometry args={[0.2, H, D + 0.4]} />
        {wallMat}
      </mesh>
      <mesh position={[OT.maxX + 0.1, H / 2, cz]} receiveShadow>
        <boxGeometry args={[0.2, H, D + 0.4]} />
        {wallMat}
      </mesh>
      {/* front wall with the double doors */}
      <mesh position={[(OT.minX + OT_DOOR.x - OT_DOOR.halfW) / 2, H / 2, 0.1]}>
        <boxGeometry args={[OT_DOOR.x - OT_DOOR.halfW - OT.minX, H, 0.2]} />
        {wallMat}
      </mesh>
      <mesh position={[(OT_DOOR.x + OT_DOOR.halfW + OT.maxX) / 2, H / 2, 0.1]}>
        <boxGeometry args={[OT.maxX - OT_DOOR.x - OT_DOOR.halfW, H, 0.2]} />
        {wallMat}
      </mesh>
      <Box p={[OT_DOOR.x, (2.3 + H) / 2, 0.1]} s={[OT_DOOR.halfW * 2, H - 2.3, 0.2]} c="#c4d9d0" r={0.6} />
      {/* coved skirting (easy to clean) */}
      <Box p={[0, 0.07, OT.minZ + 0.01]} s={[W, 0.14, 0.02]} c="#5c7a70" r={0.4} />
      <Box p={[OT.minX + 0.01, 0.07, cz]} s={[0.02, 0.14, D]} c="#5c7a70" r={0.4} />
      <Box p={[OT.maxX - 0.01, 0.07, cz]} s={[0.02, 0.14, D]} c="#5c7a70" r={0.4} />
      {/* double swing doors, slightly ajar, with porthole windows */}
      {[-1, 1].map((sx) => (
        <group key={sx} position={[OT_DOOR.x + sx * OT_DOOR.halfW, 0, -0.04]} rotation={[0, sx * -0.35, 0]}>
          <Box p={[-sx * 0.4, 1.12, 0]} s={[0.78, 2.2, 0.05]} c="#8fb3a8" r={0.4} m={0.15} cast />
          <Box p={[-sx * 0.4, 0.2, -0.03]} s={[0.74, 0.32, 0.01]} c="#c7ccd1" m={0.8} r={0.3} />
          <mesh position={[-sx * 0.4, 1.5, -0.03]}>
            <circleGeometry args={[0.13, 20]} />
            <meshStandardMaterial color="#cfe6ff" emissive="#eaf3ff" emissiveIntensity={0.6} roughness={0.1} />
          </mesh>
        </group>
      ))}
      <Box p={[OT_DOOR.x, 1.5, 2.3]} s={[2.6, 3, 0.2]} c="#e8e5de" r={0.9} />
      <pointLight position={[OT_DOOR.x, 2.6, 1.2]} intensity={2} distance={4} decay={1.5} color="#fff3e2" />
    </>
  );
}

// ───────── lights ─────────

function OTLightHead({ p, tilt }: { p: [number, number, number]; tilt: [number, number, number] }) {
  return (
    <group position={p} rotation={tilt}>
      <mesh castShadow>
        <cylinderGeometry args={[0.36, 0.42, 0.12, 32]} />
        <meshStandardMaterial color="#e9edf0" roughness={0.35} metalness={0.3} />
      </mesh>
      <mesh position={[0, -0.062, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <circleGeometry args={[0.38, 32]} />
        <meshStandardMaterial color="#d8dde2" roughness={0.3} metalness={0.6} />
      </mesh>
      {Array.from({ length: 13 }, (_, i) => {
        const ring = i === 0 ? 0 : i < 7 ? 0.14 : 0.27;
        const a = i === 0 ? 0 : ((i < 7 ? i : i - 6) / 6) * Math.PI * 2 + (i < 7 ? 0 : 0.5);
        return (
          <mesh key={i} position={[Math.cos(a) * ring, -0.066, Math.sin(a) * ring]} rotation={[Math.PI / 2, 0, 0]}>
            <circleGeometry args={[0.045, 16]} />
            <meshStandardMaterial color="#ffffff" emissive="#fff8ec" emissiveIntensity={3} toneMapped={false} />
          </mesh>
        );
      })}
      <Cyl p={[0, 0.12, 0]} r={0.035} h={0.14} c="#cfd4d9" metal={0.6} rough={0.3} />
    </group>
  );
}

function Lights() {
  const target = useMemo(() => {
    const o = new THREE.Object3D();
    o.position.set(FIELD_X, TABLE.h, TABLE.z);
    return o;
  }, []);
  return (
    <>
      <hemisphereLight args={['#e8f2f0', '#3c4a46', 0.45]} />
      {/* laminar-flow ceiling panel over the table */}
      <mesh position={[0, OT.h - 0.01, TABLE.z]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[3, 2.6]} />
        <meshStandardMaterial color="#f5f8fa" emissive="#eef5ff" emissiveIntensity={0.55} />
      </mesh>
      {[
        [-3, -2],
        [3, -2],
        [-3, -7],
        [3, -7],
      ].map(([x, z]) => (
        <group key={`${x}${z}`}>
          <mesh position={[x, OT.h - 0.01, z]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[1.2, 0.6]} />
            <meshStandardMaterial color="#ffffff" emissive="#f3f7ff" emissiveIntensity={1.4} toneMapped={false} />
          </mesh>
          <pointLight position={[x, OT.h - 0.3, z]} intensity={4} distance={7} decay={1.4} color="#f2f6ff" />
        </group>
      ))}
      <pointLight position={[0, 2.7, TABLE.z]} intensity={3} distance={6} decay={1.4} color="#f6f9ff" />
      {/* the OT lights: a ceiling mount, two arms, two heads aimed at the field */}
      <Cyl p={[0.2, OT.h - 0.12, TABLE.z]} r={0.12} h={0.24} c="#dfe3e7" metal={0.5} rough={0.3} />
      <Cyl p={[0.2, OT.h - 0.5, TABLE.z]} r={0.04} h={0.6} c="#dfe3e7" metal={0.5} rough={0.3} />
      <Box p={[0.05, 2.62, TABLE.z + 0.15]} s={[0.55, 0.05, 0.06]} c="#dfe3e7" m={0.5} r={0.3} rot={[0, 0.5, 0]} />
      <Box p={[0.5, 2.55, TABLE.z - 0.2]} s={[0.55, 0.05, 0.06]} c="#dfe3e7" m={0.5} r={0.3} rot={[0, -0.6, 0]} />
      <OTLightHead p={[-0.15, 2.32, TABLE.z + 0.3]} tilt={[0.35, 0, -0.25]} />
      <OTLightHead p={[0.75, 2.26, TABLE.z - 0.4]} tilt={[-0.3, 0, 0.3]} />
      <primitive object={target} />
      <spotLight
        position={[0.2, 2.25, TABLE.z]}
        target={target}
        angle={0.42}
        penumbra={0.6}
        intensity={16}
        distance={4}
        decay={1.3}
        color="#fffaf0"
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-bias={-0.0004}
      />
    </>
  );
}

// ───────── table + patient ─────────

function TableAndPatient({ kind, spinal }: { kind: 'open' | 'lap' | 'lscs'; spinal: boolean }) {
  const drape = '#2f6f62';
  const top = TABLE.h;
  return (
    <group>
      {/* column table */}
      <Box p={[TABLE.x, 0.05, TABLE.z]} s={[0.9, 0.1, 0.5]} c="#c9ced4" m={0.6} r={0.3} cast />
      <Box p={[TABLE.x, 0.45, TABLE.z]} s={[0.32, 0.75, 0.28]} c="#d7dbe0" m={0.6} r={0.3} cast />
      <Box p={[TABLE.x, top - 0.08, TABLE.z]} s={[TABLE.len, 0.08, TABLE.w]} c="#2b3036" r={0.6} cast />
      {/* side rails */}
      {[-1, 1].map((s) => (
        <Box key={s} p={[TABLE.x, top - 0.1, TABLE.z + s * (TABLE.w / 2 + 0.01)]} s={[TABLE.len - 0.1, 0.03, 0.02]} c="#d7dbe0" m={0.8} r={0.25} />
      ))}
      {/* arm board (patient's right arm, the IV arm) */}
      <Box p={[HEAD_X + 0.22, top - 0.06, TABLE.z + 0.62]} s={[0.16, 0.05, 0.7]} c="#2b3036" r={0.6} />
      <mesh position={[HEAD_X + 0.22, top + 0.0, TABLE.z + 0.6]} rotation={[Math.PI / 2, 0, 0]} castShadow>
        <capsuleGeometry args={[0.045, 0.55, 4, 10]} />
        <meshStandardMaterial color="#9e6a4a" roughness={0.7} />
      </mesh>
      {/* cannula + tape at the wrist */}
      <Box p={[HEAD_X + 0.22, top + 0.05, TABLE.z + 0.78]} s={[0.07, 0.01, 0.06]} c="#f4f4f0" r={0.8} />
      {/* ID band */}
      <mesh position={[HEAD_X + 0.22, top + 0.0, TABLE.z + 0.86]} rotation={[0, 0, Math.PI / 2]}>
        <torusGeometry args={[0.05, 0.008, 6, 16]} />
        <meshStandardMaterial color="#f2c230" roughness={0.5} />
      </mesh>
      {/* body under the drape */}
      <mesh position={[TABLE.x + 0.1, top + 0.07, TABLE.z]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <capsuleGeometry args={[0.17, 1.3, 6, 16]} />
        <meshStandardMaterial color={drape} roughness={0.95} />
      </mesh>
      <Box p={[TABLE.x + 0.15, top + 0.0, TABLE.z]} s={[1.75, 0.04, TABLE.w + 0.38]} c={drape} r={0.95} cast />
      {[-1, 1].map((s) => (
        <Box key={s} p={[TABLE.x + 0.15, top - 0.28, TABLE.z + s * (TABLE.w / 2 + 0.2)]} s={[1.75, 0.56, 0.02]} c={drape} r={0.95} />
      ))}
      <Box p={[TABLE.x + 1.04, top - 0.28, TABLE.z]} s={[0.02, 0.56, TABLE.w + 0.4]} c={drape} r={0.95} />
      {/* operative field: prepped skin window */}
      <mesh position={[FIELD_X + (kind === 'lscs' ? 0.22 : 0), top + 0.245, TABLE.z + (kind === 'open' ? 0.05 : 0)]} rotation={[-Math.PI / 2, 0, 0]}>
        <planeGeometry args={[0.34, 0.26]} />
        <meshStandardMaterial color="#9a5a2c" roughness={0.6} />
      </mesh>
      {kind === 'lap' ? (
        <>
          {[
            [FIELD_X - 0.05, 0],
            [FIELD_X - 0.25, 0.1],
            [FIELD_X + 0.12, 0.09],
          ].map(([x, dz], i) => (
            <group key={i}>
              <Cyl p={[x, top + 0.33, TABLE.z + dz]} r={0.012} h={0.2} c="#2a2e33" metal={0.6} rough={0.3} rot={[0.3 * (i - 1), 0, 0.2]} />
              <Cyl p={[x, top + 0.26, TABLE.z + dz]} r={0.022} h={0.04} c="#5a6b78" />
            </group>
          ))}
        </>
      ) : (
        <>
          <Box p={[FIELD_X + (kind === 'lscs' ? 0.22 : 0), top + 0.25, TABLE.z + (kind === 'open' ? 0.05 : 0)]} s={kind === 'lscs' ? [0.02, 0.006, 0.2] : [0.16, 0.006, 0.02]} c="#6d1414" r={0.4} rot={[0, kind === 'open' ? 0.5 : 0, 0]} />
          {/* retractors */}
          {[-1, 1].map((s) => (
            <Box key={s} p={[FIELD_X + (kind === 'lscs' ? 0.22 : 0) + s * 0.05, top + 0.29, TABLE.z + s * 0.12]} s={[0.04, 0.012, 0.16]} c="#d7dbe0" m={0.9} r={0.2} rot={[0.4 * s, 0, 0]} />
          ))}
        </>
      )}
      {/* anaesthetic screen (ether screen) separating the head end */}
      <group position={[HEAD_X + 0.3, 0, TABLE.z]}>
        {[-1, 1].map((s) => (
          <Cyl key={s} p={[0, top + 0.35, s * (TABLE.w / 2 + 0.04)]} r={0.012} h={0.75} c="#d7dbe0" metal={0.8} rough={0.25} />
        ))}
        <Cyl p={[0, top + 0.72, 0]} r={0.012} h={TABLE.w + 0.1} c="#d7dbe0" metal={0.8} rough={0.25} rot={[Math.PI / 2, 0, 0]} />
        <Box p={[0.01, top + 0.48, 0]} s={[0.01, 0.48, TABLE.w + 0.05]} c={drape} r={0.95} />
      </group>
      {/* head, cap, airway */}
      <mesh position={[HEAD_X - 0.02, top + 0.11, TABLE.z]} castShadow>
        <sphereGeometry args={[0.1, 20, 16]} />
        <meshStandardMaterial color="#9e6a4a" roughness={0.65} />
      </mesh>
      <mesh position={[HEAD_X - 0.05, top + 0.14, TABLE.z]} rotation={[0, 0, Math.PI / 2 + 0.3]}>
        <sphereGeometry args={[0.108, 20, 12, 0, Math.PI * 2, 0, Math.PI / 2]} />
        <meshStandardMaterial color="#6f9fc8" roughness={0.9} side={THREE.DoubleSide} />
      </mesh>
      <Box p={[HEAD_X - 0.12, top + 0.03, TABLE.z]} s={[0.26, 0.06, 0.34]} c="#e8eef2" r={0.9} />
      {spinal ? (
        <mesh position={[HEAD_X + 0.02, top + 0.2, TABLE.z]} rotation={[0, 0, -0.3]}>
          <sphereGeometry args={[0.055, 14, 10, 0, Math.PI * 2, 0, Math.PI / 2]} />
          <meshStandardMaterial color="#9fd7b5" roughness={0.3} transparent opacity={0.7} />
        </mesh>
      ) : (
        <AirwayTube />
      )}
    </group>
  );
}

function AirwayTube() {
  const geo = useMemo(() => {
    const top = TABLE.h;
    const pts = [
      new THREE.Vector3(HEAD_X + 0.03, top + 0.15, TABLE.z),
      new THREE.Vector3(HEAD_X - 0.05, top + 0.32, TABLE.z - 0.05),
      new THREE.Vector3(HEAD_X - 0.4, top + 0.25, TABLE.z - 0.35),
      new THREE.Vector3(-2.2, 1.05, -5.45),
    ];
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 40, 0.016, 8, false);
  }, []);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <mesh geometry={geo} castShadow>
      <meshStandardMaterial color="#cfe0ea" roughness={0.3} transparent opacity={0.85} />
    </mesh>
  );
}

// ───────── multipara monitor (live canvas) ─────────

export interface MonitorView {
  v: Vitals;
  leadOff: boolean;
  alarm: AlarmLevel;
  fio2: number;
}

function ecgShape(p: number): number {
  // P wave, QRS spike, T wave over one beat (0..1).
  const g = (c: number, w: number, a: number) => a * Math.exp(-((p - c) * (p - c)) / (2 * w * w));
  return g(0.12, 0.025, 0.12) - g(0.27, 0.008, 0.12) + g(0.3, 0.01, 1) - g(0.33, 0.01, 0.25) + g(0.55, 0.05, 0.28);
}

function plethShape(p: number): number {
  const a = Math.exp(-((p - 0.25) ** 2) / 0.012);
  const b = 0.35 * Math.exp(-((p - 0.55) ** 2) / 0.008);
  return a + b;
}

function PatientMonitor({ getView, position, rotY = 0 }: { getView: () => MonitorView; position: [number, number, number]; rotY?: number }) {
  const W = 640;
  const H = 400;
  const { canvas, tex } = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = W;
    c.height = H;
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 4;
    return { canvas: c, tex: t };
  }, []);
  useEffect(() => () => tex.dispose(), [tex]);
  const acc = useRef(0);
  const beat = useRef({ ecg: 0, pl: 0 });
  const hist = useRef<{ ecg: number[]; pl: number[] }>({ ecg: [], pl: [] });
  const alarmMat = useRef<THREE.MeshStandardMaterial>(null);

  useFrame((state, dt) => {
    const view = getView();
    const v = view.v;
    // Keep the waveform buffers moving every frame (smooth sweep).
    const step = Math.min(dt, 0.1);
    const samples = Math.max(1, Math.round(step * 160));
    for (let i = 0; i < samples; i++) {
      beat.current.ecg = (beat.current.ecg + (v.hr / 60) * (step / samples)) % 1;
      beat.current.pl = (beat.current.pl + (v.hr / 60) * (step / samples)) % 1;
      hist.current.ecg.push(view.leadOff ? 0 : ecgShape(beat.current.ecg));
      hist.current.pl.push(plethShape((beat.current.pl + 0.85) % 1) * (v.spo2 < 90 ? 0.6 : 1));
    }
    const max = 420;
    if (hist.current.ecg.length > max) hist.current.ecg.splice(0, hist.current.ecg.length - max);
    if (hist.current.pl.length > max) hist.current.pl.splice(0, hist.current.pl.length - max);
    const blink = Math.floor(state.clock.elapsedTime * 2.5) % 2 === 0;
    if (alarmMat.current) {
      const col = view.alarm === 'crit' ? '#ff2a2a' : view.alarm === 'warn' ? '#ffb02e' : '#39d96b';
      alarmMat.current.color.set(col);
      alarmMat.current.emissive.set(col);
      alarmMat.current.emissiveIntensity = view.alarm === 'ok' ? 0.6 : blink ? 3 : 0.3;
    }
    acc.current += dt;
    if (acc.current < 1 / 15) return;
    acc.current = 0;
    const g = canvas.getContext('2d');
    if (!g) return;
    g.fillStyle = '#020604';
    g.fillRect(0, 0, W, H);
    const waveW = 420;
    const drawWave = (data: number[], y0: number, amp: number, color: string) => {
      g.strokeStyle = color;
      g.lineWidth = 3;
      g.beginPath();
      data.forEach((val, i) => {
        const x = 10 + (i / max) * waveW;
        const y = y0 - val * amp;
        if (i === 0) g.moveTo(x, y);
        else g.lineTo(x, y);
      });
      g.stroke();
    };
    g.font = '600 18px Inter, system-ui, sans-serif';
    g.fillStyle = '#39d96b';
    g.fillText('II', 12, 28);
    drawWave(hist.current.ecg, 120, 70, '#39d96b');
    if (view.leadOff && blink) {
      g.fillStyle = '#ff4040';
      g.font = '800 26px Inter, system-ui, sans-serif';
      g.fillText('ECG LEADS OFF?', 120, 80);
    }
    g.fillStyle = '#4fd6ff';
    g.font = '600 18px Inter, system-ui, sans-serif';
    g.fillText('Pleth', 12, 178);
    drawWave(hist.current.pl, 250, 55, '#4fd6ff');
    if (v.etco2 !== null) {
      g.fillStyle = '#ffd84a';
      g.fillText('CO2', 12, 290);
      const cap = hist.current.pl.map((_, i) => (Math.floor((i / max) * 6) % 2 === 0 ? 0.9 : 0.05));
      drawWave(cap, 360, 50, '#ffd84a');
    }
    // numerics column
    const nx = 450;
    const num = (label: string, value: string, unit: string, y: number, color: string, big = 56) => {
      g.fillStyle = color;
      g.font = '600 16px Inter, system-ui, sans-serif';
      g.fillText(label, nx, y - big + 8);
      g.font = `800 ${big}px Inter, system-ui, sans-serif`;
      g.fillText(value, nx, y);
      g.font = '600 15px Inter, system-ui, sans-serif';
      g.fillText(unit, nx + 150, y - big + 8);
    };
    const hrBad = !view.leadOff && (v.hr < 50 || v.hr > 120);
    num('HR', view.leadOff ? '---' : String(v.hr), 'bpm', 64, hrBad && blink ? '#ff4040' : '#39d96b');
    const bpBad = v.sbp < 90;
    num('NIBP', `${v.sbp}/${v.dbp}`, 'mmHg', 140, bpBad && blink ? '#ff4040' : '#ff6b6b', 40);
    g.font = '600 18px Inter, system-ui, sans-serif';
    g.fillStyle = '#ff9b9b';
    g.fillText(`(${Math.round((v.sbp + 2 * v.dbp) / 3)})`, nx + 130, 140);
    num('SpO2', String(v.spo2), '%', 222, v.spo2 < 92 && blink ? '#ff4040' : '#4fd6ff');
    num('EtCO2', v.etco2 === null ? '--' : String(v.etco2), 'mmHg', 300, '#ffd84a', 44);
    num('TEMP', v.temp.toFixed(1), 'C', 372, v.temp < 36 && blink ? '#ffb02e' : '#e8ecf0', 40);
    g.fillStyle = '#9aa4ad';
    g.font = '600 15px Inter, system-ui, sans-serif';
    g.fillText(`FiO2 ${view.fio2}%`, 12, 392);
    tex.needsUpdate = true;
  });

  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <Box p={[0, 0, -0.04]} s={[0.72, 0.5, 0.07]} c="#1d2127" r={0.4} m={0.3} cast />
      <mesh position={[0, 0, -0.004]}>
        <planeGeometry args={[0.66, 0.41]} />
        <meshStandardMaterial map={tex} emissiveMap={tex} emissive="#ffffff" emissiveIntensity={0.95} toneMapped={false} />
      </mesh>
      {/* alarm light bar */}
      <mesh position={[0, 0.27, -0.02]}>
        <boxGeometry args={[0.24, 0.035, 0.05]} />
        <meshStandardMaterial ref={alarmMat} color="#39d96b" emissive="#39d96b" emissiveIntensity={0.6} toneMapped={false} />
      </mesh>
    </group>
  );
}

// ───────── equipment ─────────

function AnaesthesiaWorkstation({ getView }: { getView: () => MonitorView }) {
  return (
    <group>
      <group position={[-2.6, 0, -5.65]} rotation={[0, Math.PI / 2, 0]}>
        <Box p={[0, 0.5, 0]} s={[0.75, 0.9, 0.62]} c="#e4e7ea" r={0.5} cast />
        <Box p={[0, 0.98, 0.04]} s={[0.78, 0.06, 0.66]} c="#cfd4d9" r={0.4} />
        <Box p={[0, 1.35, -0.18]} s={[0.7, 0.7, 0.25]} c="#e4e7ea" r={0.5} cast />
        {/* ventilator screen */}
        <mesh position={[0.12, 1.42, -0.05]}>
          <planeGeometry args={[0.36, 0.26]} />
          <meshStandardMaterial color="#0b2030" emissive="#1d6fa8" emissiveIntensity={0.5} />
        </mesh>
        {/* bellows */}
        <Cyl p={[-0.22, 1.2, 0.05]} r={0.08} h={0.26} c="#cfe6f5" opacity={0.45} rough={0.1} />
        {/* vaporisers */}
        <Box p={[-0.18, 1.08, -0.05]} s={[0.1, 0.16, 0.12]} c="#c9a227" r={0.4} />
        <Box p={[-0.05, 1.08, -0.05]} s={[0.1, 0.16, 0.12]} c="#7a3fa0" r={0.4} />
        {/* flowmeters: O2 white/green, air, N2O blue */}
        {[
          ['#ffffff', 0.18],
          ['#d9d9d9', 0.24],
          ['#2a5fa8', 0.3],
        ].map(([c, x]) => (
          <Cyl key={String(x)} p={[x as number, 1.15, 0.0]} r={0.012} h={0.2} c={c as string} opacity={0.8} />
        ))}
        {/* FiO2 knob */}
        <Cyl p={[0.24, 1.0, 0.33]} r={0.035} h={0.03} c="#2e9e5b" rot={[Math.PI / 2, 0, 0]} />
        {/* O2 cylinder (black body, white shoulder) */}
        <Cyl p={[0.42, 0.55, -0.2]} r={0.07} h={0.9} c="#1d1f22" rough={0.4} />
        <Cyl p={[0.42, 1.03, -0.2]} r={[0.03, 0.07]} h={0.08} c="#f2f2f2" rough={0.4} />
      </group>
      {/* monitor arm */}
      <Cyl p={[-2.2, 1.95, -6.1]} r={0.02} h={0.5} c="#cfd4d9" metal={0.6} rough={0.3} />
      <PatientMonitor getView={getView} position={[-2.05, 1.75, -6.0]} rotY={0.45} />
    </group>
  );
}

function DrugCart() {
  return (
    <group position={[-3.45, 0, -3.6]} rotation={[0, Math.PI / 2, 0]}>
      <Box p={[0, 0.48, 0]} s={[0.62, 0.86, 0.5]} c="#c0392b" r={0.5} cast />
      {[0.2, 0.42, 0.64, 0.84].map((y, i) => (
        <group key={y}>
          <Box p={[0, y, 0.255]} s={[0.56, 0.18, 0.01]} c={['#e74c3c', '#f1c40f', '#3498db', '#2ecc71'][i]} r={0.45} />
          <Box p={[0, y + 0.05, 0.265]} s={[0.2, 0.025, 0.02]} c="#e3e7ea" m={0.8} r={0.25} />
        </group>
      ))}
      <Box p={[0, 0.93, 0]} s={[0.66, 0.04, 0.54]} c="#e8ebee" r={0.4} />
      {/* syringe tray with labelled syringes and ampoules */}
      <Box p={[0, 0.97, 0.04]} s={[0.46, 0.04, 0.3]} c="#f4f6f8" r={0.4} />
      {Array.from({ length: 7 }, (_, i) => (
        <group key={i}>
          <Cyl p={[-0.18 + i * 0.06, 1.0, 0.04]} r={0.009} h={0.16} c="#f4f9ff" rot={[Math.PI / 2, 0, 0]} opacity={0.85} />
          <Box p={[-0.18 + i * 0.06, 1.0, 0.0]} s={[0.022, 0.012, 0.04]} c={['#7a3fa0', '#f1c40f', '#2ecc71', '#e67e22', '#3498db', '#e74c3c', '#95a5a6'][i]} r={0.5} />
        </group>
      ))}
      {[0, 1, 2, 3].map((i) => (
        <Cyl key={i} p={[-0.2 + i * 0.05, 0.99, -0.17]} r={0.01} h={0.06} c="#e9d9a6" opacity={0.8} />
      ))}
      <Box p={[0.26, 1.0, -0.17]} s={[0.12, 0.1, 0.1]} c="#f1c40f" r={0.5} />
    </group>
  );
}

function IVStand({ running }: { running: () => boolean }) {
  const drip = useRef<THREE.Mesh>(null);
  useFrame((st) => {
    if (!drip.current) return;
    const on = running();
    drip.current.visible = on;
    if (on) drip.current.position.y = 1.68 - ((st.clock.elapsedTime * 1.4) % 1) * 0.06;
  });
  const x = -1.4;
  const z = -3.55;
  return (
    <group>
      <PoleBase x={x} z={z} h={2.0} />
      <Box p={[x, 1.98, z]} s={[0.36, 0.02, 0.02]} c="#d7dbe0" m={0.8} r={0.25} />
      {/* fluid bags */}
      {[-0.13, 0.13].map((dx, i) => (
        <group key={dx}>
          <Box p={[x + dx, 1.84, z]} s={[0.1, 0.2, 0.03]} c={i === 0 ? '#e9f4ff' : '#f6ecd8'} r={0.2} />
          <Cyl p={[x + dx, 1.7, z]} r={0.012} h={0.06} c="#e9f4ff" opacity={0.7} />
        </group>
      ))}
      <mesh ref={drip} position={[x - 0.13, 1.68, z]}>
        <sphereGeometry args={[0.006, 6, 6]} />
        <meshStandardMaterial color="#cfe6ff" />
      </mesh>
      {/* infusion pump */}
      <group position={[x, 1.12, z + 0.06]}>
        <Box p={[0, 0, 0]} s={[0.2, 0.24, 0.12]} c="#eef0f2" r={0.4} cast />
        <mesh position={[0, 0.05, 0.061]}>
          <planeGeometry args={[0.14, 0.07]} />
          <meshStandardMaterial color="#0a1a10" emissive="#39d96b" emissiveIntensity={0.7} />
        </mesh>
        <Box p={[0, -0.07, 0.062]} s={[0.14, 0.04, 0.005]} c="#2a5fa8" r={0.4} />
      </group>
      {/* line to the cannula */}
      <Cyl p={[x + 0.2, 1.05, z - 0.08]} r={0.004} h={1.2} c="#e9f4ff" rot={[0.35, 0, -0.75]} opacity={0.8} />
    </group>
  );
}

function SuctionUnit({ level, on }: { level: () => number; on: () => boolean }) {
  const fluid = useRef<THREE.Mesh>(null);
  const led = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => {
    const l = THREE.MathUtils.clamp(level(), 0.05, 0.95);
    if (fluid.current) {
      fluid.current.scale.y = l;
      fluid.current.position.y = 0.6 + (0.34 * l) / 2;
    }
    if (led.current) led.current.emissiveIntensity = on() ? 2.5 : 0.1;
  });
  return (
    <group position={[1.95, 0, -3.65]}>
      <Box p={[0, 0.3, 0]} s={[0.42, 0.5, 0.36]} c="#e4e7ea" r={0.5} cast />
      {[0, 1, 2, 3].map((i) => (
        <Cyl key={i} p={[i < 2 ? -0.16 : 0.16, 0.04, i % 2 ? -0.13 : 0.13]} r={0.035} h={0.04} c="#2a2e33" rot={[0, 0, Math.PI / 2]} />
      ))}
      {/* canister */}
      <Cyl p={[-0.08, 0.77, 0]} r={0.09} h={0.36} c="#e9f4ff" opacity={0.35} rough={0.1} />
      <mesh ref={fluid} position={[-0.08, 0.62, 0]}>
        <cylinderGeometry args={[0.083, 0.083, 0.34, 16]} />
        <meshStandardMaterial color="#8e1b1b" roughness={0.3} />
      </mesh>
      <Cyl p={[-0.08, 0.97, 0]} r={0.095} h={0.03} c="#2a5fa8" />
      {/* vacuum gauge + switch */}
      <Cyl p={[0.12, 0.62, 0.18]} r={0.06} h={0.02} c="#f4f6f8" rot={[Math.PI / 2, 0, 0]} />
      <Box p={[0.12, 0.42, 0.185]} s={[0.05, 0.03, 0.01]} c="#2a2e33" />
      <mesh position={[0.12, 0.48, 0.19]}>
        <sphereGeometry args={[0.012, 8, 8]} />
        <meshStandardMaterial ref={led} color="#39d96b" emissive="#39d96b" emissiveIntensity={0.1} toneMapped={false} />
      </mesh>
      {/* tubing toward the field */}
      <Cyl p={[-0.6, 1.0, -0.5]} r={0.008} h={1.4} c="#e9f4ff" rot={[0.7, 0, 1.0]} opacity={0.8} />
    </group>
  );
}

function DiathermyUnit({ on, padOk }: { on: () => boolean; padOk: () => boolean }) {
  const screen = useRef<THREE.MeshStandardMaterial>(null);
  const warn = useRef<THREE.MeshStandardMaterial>(null);
  useFrame((st) => {
    if (screen.current) screen.current.emissiveIntensity = on() ? 0.9 : 0.05;
    if (warn.current) warn.current.emissiveIntensity = !padOk() && Math.floor(st.clock.elapsedTime * 3) % 2 === 0 ? 3 : 0.05;
  });
  return (
    <group position={[2.95, 0, -4.95]} rotation={[0, -Math.PI / 2, 0]}>
      {/* trolley */}
      <Box p={[0, 0.45, 0]} s={[0.6, 0.04, 0.5]} c="#c9ced4" m={0.6} r={0.3} />
      <Box p={[0, 0.08, 0]} s={[0.6, 0.04, 0.5]} c="#c9ced4" m={0.6} r={0.3} />
      {[-1, 1].flatMap((sx) => [-1, 1].map((sz) => <Cyl key={`${sx}${sz}`} p={[sx * 0.27, 0.27, sz * 0.22]} r={0.012} h={0.4} c="#d7dbe0" metal={0.8} rough={0.25} />))}
      {/* generator */}
      <Box p={[0, 0.66, 0]} s={[0.5, 0.38, 0.42]} c="#eef0f2" r={0.4} cast />
      <mesh position={[-0.08, 0.72, 0.212]}>
        <planeGeometry args={[0.22, 0.12]} />
        <meshStandardMaterial ref={screen} color="#0a1424" emissive="#4fd6ff" emissiveIntensity={0.9} />
      </mesh>
      <Box p={[0.15, 0.73, 0.214]} s={[0.05, 0.05, 0.01]} c="#f1c40f" />
      <Box p={[0.15, 0.64, 0.214]} s={[0.05, 0.05, 0.01]} c="#3498db" />
      <mesh position={[-0.17, 0.56, 0.214]}>
        <boxGeometry args={[0.05, 0.03, 0.01]} />
        <meshStandardMaterial ref={warn} color="#ff3030" emissive="#ff3030" emissiveIntensity={0.05} toneMapped={false} />
      </mesh>
      {/* foot pedal + cable */}
      <Box p={[0.1, 0.03, 0.45]} s={[0.22, 0.05, 0.16]} c="#2a5fa8" r={0.5} />
    </group>
  );
}

function ForcedAirWarmer({ on }: { on: () => boolean }) {
  const led = useRef<THREE.MeshStandardMaterial>(null);
  useFrame(() => {
    if (led.current) led.current.emissiveIntensity = on() ? 2.5 : 0.08;
  });
  const geo = useMemo(() => {
    const pts = [new THREE.Vector3(1.55, 0.95, -6.45), new THREE.Vector3(1.4, 1.2, -6.0), new THREE.Vector3(1.0, 1.0, -5.4), new THREE.Vector3(0.95, TABLE.h + 0.08, -5.15)];
    return new THREE.TubeGeometry(new THREE.CatmullRomCurve3(pts), 30, 0.045, 10, false);
  }, []);
  useEffect(() => () => geo.dispose(), [geo]);
  return (
    <group>
      <PoleBase x={1.55} z={-6.55} h={1.1} />
      <group position={[1.55, 0.88, -6.55]}>
        <Box p={[0, 0, 0]} s={[0.36, 0.3, 0.28]} c="#eef0f2" r={0.4} cast />
        <mesh position={[0, 0.05, 0.141]}>
          <planeGeometry args={[0.16, 0.07]} />
          <meshStandardMaterial ref={led} color="#ff8a3d" emissive="#ff8a3d" emissiveIntensity={0.08} toneMapped={false} />
        </mesh>
      </group>
      <mesh geometry={geo} castShadow>
        <meshStandardMaterial color="#e9eef2" roughness={0.6} />
      </mesh>
    </group>
  );
}

function LapTower({ active }: { active: boolean }) {
  return (
    <group position={[TOWER.x, 0, TOWER.z]}>
      <Box p={[0, 0.7, 0]} s={[0.62, 1.3, 0.52]} c="#d9dce0" r={0.4} cast />
      {[0.35, 0.6, 0.85, 1.1].map((y) => (
        <Box key={y} p={[0, y, 0.265]} s={[0.56, 0.18, 0.01]} c="#2a2e33" r={0.4} />
      ))}
      <Box p={[0, 1.75, 0]} s={[0.06, 0.6, 0.06]} c="#cfd4d9" m={0.6} r={0.3} />
      <group position={[0, 2.0, 0.08]}>
        <Box p={[0, 0, 0]} s={[0.7, 0.42, 0.05]} c="#15171b" r={0.4} />
        <mesh position={[0, 0, 0.027]}>
          <planeGeometry args={[0.64, 0.37]} />
          <meshStandardMaterial color={active ? '#5a1e1e' : '#05070a'} emissive={active ? '#c0503c' : '#000000'} emissiveIntensity={active ? 0.45 : 0} />
        </mesh>
      </group>
    </group>
  );
}

function MayoTrolley() {
  return (
    <group position={[1.75, 0, -5.65]}>
      <Box p={[0, 0.92, 0]} s={[0.85, 0.03, 0.42]} c="#2f6f62" r={0.95} />
      <Cyl p={[0.35, 0.46, 0]} r={0.02} h={0.9} c="#d7dbe0" metal={0.8} rough={0.25} />
      {Array.from({ length: 8 }, (_, i) => (
        <Box key={i} p={[-0.32 + i * 0.08, 0.945, (i % 2) * 0.06 - 0.03]} s={[0.012, 0.008, 0.16]} c="#e3e7ea" m={0.95} r={0.15} rot={[0, (i % 3) * 0.1, 0]} />
      ))}
    </group>
  );
}

// ───────── signage ─────────

function makeChecklistPoster() {
  return canvasTex(512, 720, (g) => {
    g.fillStyle = '#fbf8f1';
    g.fillRect(0, 0, 512, 720);
    g.fillStyle = '#2f6f62';
    g.fillRect(0, 0, 512, 96);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.font = '800 34px Inter, system-ui, sans-serif';
    g.fillText('SURGICAL SAFETY', 256, 46);
    g.fillText('CHECKLIST', 256, 84);
    g.textAlign = 'left';
    const blocks: Array<[string, string[]]> = [
      ['SIGN IN', ['Identity, site, procedure, consent', 'Site marked', 'Allergy', 'Airway / aspiration risk', 'Blood loss > 500 mL']],
      ['TIME OUT', ['Team introduced', 'Patient, procedure, incision', 'Antibiotic in last 60 min']],
      ['SIGN OUT', ['Counts correct', 'Specimen labelled', 'Concerns for recovery']],
    ];
    let y = 140;
    for (const [h, rows] of blocks) {
      g.fillStyle = '#2f6f62';
      g.font = '800 28px Inter, system-ui, sans-serif';
      g.fillText(h, 30, y);
      y += 36;
      g.fillStyle = '#2a2d31';
      g.font = '500 22px Inter, system-ui, sans-serif';
      for (const r of rows) {
        g.strokeStyle = '#2a2d31';
        g.lineWidth = 2;
        g.strokeRect(34, y - 18, 18, 18);
        g.fillText(r, 64, y);
        y += 32;
      }
      y += 18;
    }
    g.fillStyle = '#8a8f96';
    g.font = '500 18px Inter, system-ui, sans-serif';
    g.fillText('World Health Organization', 30, 700);
  });
}

function RoomSign() {
  const ready = useSignFontsReady();
  const room = DOORS.find((d) => d.dept.id === 'operation-theatre')?.room ?? '';
  const tex = useMemo(() => {
    const hi = hindiLabel('operation-theatre');
    return canvasTex(768, 150, (g) => {
      g.fillStyle = '#15233c';
      g.fillRect(0, 0, 768, 150);
      g.fillStyle = '#2f9c8a';
      g.fillRect(0, 0, 768, 8);
      g.textAlign = 'center';
      g.fillStyle = '#ffffff';
      g.font = '800 46px Inter, system-ui, sans-serif';
      g.fillText(`OPERATION THEATRE ${room}`, 384, 68, 740);
      if (hi) {
        g.font = '600 36px "Noto Sans Devanagari", "Nirmala UI", sans-serif';
        g.fillStyle = '#cdd7e6';
        g.fillText(hi, 384, 124, 740);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready, room]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <mesh position={[-1.5, 2.85, OT.minZ + 0.02]}>
      <planeGeometry args={[1.7, 0.33]} />
      <meshStandardMaterial map={tex} roughness={0.45} />
    </mesh>
  );
}

const CLOCK_URL = '/assets/models/wall_clock/wall_clock_1k.gltf';

function Decor() {
  const clock = useGLTF(CLOCK_URL).scene;
  const poster = useMemo(makeChecklistPoster, []);
  useEffect(() => () => poster.dispose(), [poster]);
  return (
    <>
      <RoomSign />
      <Clone object={clock} position={[1.4, 2.55, OT.minZ + 0.02]} scale={1.1} />
      <group position={[-3.6, 1.6, OT.minZ + 0.02]}>
        <Box p={[0, 0, 0]} s={[0.74, 1.04, 0.02]} c="#2a2d31" r={0.4} />
        <mesh position={[0, 0, 0.012]}>
          <planeGeometry args={[0.68, 0.97]} />
          <meshStandardMaterial map={poster} roughness={0.75} />
        </mesh>
      </group>
      {/* x-ray viewer on the right wall */}
      <group position={[OT.maxX - 0.03, 1.6, -6.6]} rotation={[0, -Math.PI / 2, 0]}>
        <Box p={[0, 0, 0]} s={[1.1, 0.7, 0.05]} c="#c9ced4" m={0.5} r={0.35} />
        <mesh position={[0, 0, 0.03]}>
          <planeGeometry args={[1.0, 0.6]} />
          <meshStandardMaterial color="#f4f8ff" emissive="#eaf3ff" emissiveIntensity={1.1} toneMapped={false} />
        </mesh>
      </group>
      {/* gas outlets panel by the workstation */}
      <group position={[OT.minX + 0.03, 1.3, -6.6]} rotation={[0, Math.PI / 2, 0]}>
        <Box p={[0, 0, 0]} s={[0.6, 0.22, 0.04]} c="#eef0f2" r={0.4} />
        {['#ffffff', '#2a5fa8', '#2a2e33', '#f1c40f'].map((c, i) => (
          <Cyl key={c} p={[-0.21 + i * 0.14, 0, 0.03]} r={0.03} h={0.03} c={c} rot={[Math.PI / 2, 0, 0]} />
        ))}
      </group>
      <Text font={FONT_MED} position={[OT_DOOR.x, 2.55, -0.02]} rotation={[0, Math.PI, 0]} fontSize={0.09} color="#15233c" anchorX="center" letterSpacing={0.1}>
        EXIT TO CORRIDOR
      </Text>
      <Text font={FONT_HEAVY} position={[OT_DOOR.x, 2.75, 0.22]} fontSize={0.1} color="#c0392b" anchorX="center" letterSpacing={0.1}>
        OPERATION IN PROGRESS
      </Text>
    </>
  );
}

// ───────── station markers ─────────

function StationMarkers({ near }: { near: StationId | null }) {
  return (
    <>
      {OT_STATIONS.map((s) => {
        const on = near === s.id;
        return (
          <group key={s.id} position={[s.x, 0, s.z]}>
            <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.012, 0]}>
              <ringGeometry args={[0.42, on ? 0.5 : 0.46, 40]} />
              <meshBasicMaterial color={on ? '#a8e27c' : '#d8f0c8'} transparent opacity={on ? 0.95 : 0.28} toneMapped={false} />
            </mesh>
            {on && (
              <Text font={FONT_BOLD} position={[0, s.y + 0.18, 0]} fontSize={0.1} color="#a8e27c" anchorX="center" outlineWidth={0.006} outlineColor="#0b1f4b" letterSpacing={0.08}>
                {`${s.label}  ·  E`}
              </Text>
            )}
          </group>
        );
      })}
    </>
  );
}

// ───────── team ─────────

function TeamMember({ look, x, z, yaw, pose, lookAt }: { look: Look; x: number; z: number; yaw: number; pose?: 'surgeon'; lookAt?: THREE.Vector3 }) {
  const control = useMemo<CharacterControl>(() => makeControl({ action: 'idle', pose, lookAt: lookAt ?? null }), [pose, lookAt]);
  return (
    <group position={[x, 0, z]} rotation={[0, yaw, 0]}>
      <HumanCharacter look={look} control={control} />
    </group>
  );
}

// ───────── root ─────────

export interface OTWorldProps {
  runtime: PlayerRuntime;
  kind: 'open' | 'lap' | 'lscs';
  spinal: boolean;
  near: StationId | null;
  getView: () => MonitorView;
  getEquipment: () => { ivRunning: boolean; suctionOn: boolean; suctionLevel: number; cauteryOn: boolean; padOk: boolean; warmerOn: boolean };
}

function OTWorldImpl({ kind, spinal, near, getView, getEquipment }: OTWorldProps) {
  const monitorPoint = useMemo(() => new THREE.Vector3(-2.05, 1.75, -6.0), []);
  return (
    <>
      <Lights />
      <Shell />
      <TableAndPatient kind={kind} spinal={spinal} />
      <AnaesthesiaWorkstation getView={getView} />
      <DrugCart />
      <IVStand running={() => getEquipment().ivRunning} />
      <SuctionUnit level={() => getEquipment().suctionLevel} on={() => getEquipment().suctionOn} />
      <DiathermyUnit on={() => getEquipment().cauteryOn} padOk={() => getEquipment().padOk} />
      <ForcedAirWarmer on={() => getEquipment().warmerOn} />
      <LapTower active={kind === 'lap'} />
      <MayoTrolley />
      <Decor />
      <StationMarkers near={near} />
      <TeamMember look={SURGEON_LOOK} x={CHIEF.x} z={CHIEF.z} yaw={CHIEF.yaw} pose="surgeon" />
      <TeamMember look={ASSISTANT_LOOK} x={ASSIST.x} z={ASSIST.z} yaw={ASSIST.yaw} pose="surgeon" />
      <TeamMember look={SCRUB_NURSE_LOOK} x={SCRUB.x} z={SCRUB.z} yaw={SCRUB.yaw} />
      <TeamMember look={ANAESTHETIST_LOOK} x={ANAES.x} z={ANAES.z} yaw={ANAES.yaw} lookAt={monitorPoint} />
    </>
  );
}

export const OTWorld = memo(OTWorldImpl);

useGLTF.preload(CLOCK_URL);
