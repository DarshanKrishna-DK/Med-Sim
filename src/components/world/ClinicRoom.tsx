import { useEffect, useMemo, useRef, useState } from 'react';
import { useFrame } from '@react-three/fiber';
import { Clone, Text, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import type { ActivePatient } from '../../game/types';
import { POLYCLINIC_BED_INDEX } from '../../game/store';
import { getExistingConversation } from '../../voice/conversationStore';
import { CLINIC_LABELS, type ClinicId } from '../../game/clinic';
import { FONT_BOLD, FONT_HEAVY, FONT_MED, canvasTex, makeArtTex, makeCeilingTex, makeFloorTex, makeOutdoorTex } from './Corridor';
import { HumanCharacter, makeControl } from './HumanCharacter';
import { doorForClinic, WINGS } from './corridorLayout';
import { hindiLabel, useSignFontsReady } from './hindi';
import { patientLook } from './rigs';
import { parentGenderForId } from '../../voice/patientPersona';
import type { Collider, PlayerRuntime, Seat } from './ThirdPersonPlayer';

// ───────── Consultation room (realistic) ─────────
//
//   z = −7  ┌──────────────────────────────┐ back wall: sink, cabinet, sign
//           │  [cab]      [desk]     [sink]│
//   window  │          doctor ▲            │  exam bed on the right wall
//   (x=−4)  │          patient ▼     [bed] │
//           │                              │
//   z = 0   └───────────────────┐ door ┌───┘ to the corridor
//                               └──────┘

export const ROOM = { minX: -4, maxX: 4, minZ: -7, maxZ: 0, h: 3 };
export const DOOR = { x: 2.7, halfW: 0.62 };
const DESK = { x: -1.2, z: -4.4, w: 1.7, d: 0.8, h: 0.76 };
export const DOCTOR_SEAT: Seat = { x: -1.2, z: -5.25, yaw: 0, height: 0.5 };
const PATIENT_SEAT = { x: -1.2, z: -3.4, yaw: Math.PI, height: 0.47 };
const BED = { x: 3.25, z: -4.3, w: 0.75, len: 1.95, h: 0.66 };
const PATIENT_PATH: Array<[number, number]> = [
  [DOOR.x, 1.5],
  [DOOR.x, -1.0],
  [-0.2, -2.6],
  [PATIENT_SEAT.x, PATIENT_SEAT.z],
];
export const EXIT_POINT = { x: DOOR.x, z: -0.7 };

const T = 0.3;
export const ROOM_COLLIDERS: Collider[] = [
  { x: 0, z: ROOM.minZ - T / 2, w: 8.6, d: T },
  { x: ROOM.minX - T / 2, z: -3.5, w: T, d: 7.6 },
  { x: ROOM.maxX + T / 2, z: -3.5, w: T, d: 7.6 },
  // front wall either side of the door
  { x: (ROOM.minX + DOOR.x - DOOR.halfW) / 2, z: T / 2, w: DOOR.x - DOOR.halfW - ROOM.minX, d: T },
  { x: (DOOR.x + DOOR.halfW + ROOM.maxX) / 2, z: T / 2, w: ROOM.maxX - DOOR.x - DOOR.halfW, d: T },
  // the doorway itself is closed for the doctor (leave with E)
  { x: DOOR.x, z: 0.35, w: DOOR.halfW * 2, d: 0.2 },
  { x: DESK.x, z: DESK.z, w: DESK.w, d: DESK.d, h: 0.8 },
  { x: PATIENT_SEAT.x, z: PATIENT_SEAT.z, w: 0.6, d: 0.6, h: 1.0 },
  { x: BED.x, z: BED.z, w: BED.w + 0.1, d: BED.len + 0.1, h: 0.9 },
  { x: 1.6, z: -6.7, w: 1.3, d: 0.6, h: 1.0 },
  { x: -3.3, z: -6.75, w: 1.0, d: 0.5 },
  { x: 3.6, z: -6.6, w: 0.6, d: 0.6, h: 1.4 },
];

// ───────── materials / helpers ─────────

function Box({ p, s, c, r = 0.7, m = 0, cast = false, rot }: { p: [number, number, number]; s: [number, number, number]; c: string; r?: number; m?: number; cast?: boolean; rot?: [number, number, number] }) {
  return (
    <mesh position={p} rotation={rot} castShadow={cast} receiveShadow>
      <boxGeometry args={s} />
      <meshStandardMaterial color={c} roughness={r} metalness={m} />
    </mesh>
  );
}

function Cyl({ p, r, h, c, rough = 0.4, metal = 0, rot }: { p: [number, number, number]; r: number; h: number; c: string; rough?: number; metal?: number; rot?: [number, number, number] }) {
  return (
    <mesh position={p} rotation={rot} castShadow>
      <cylinderGeometry args={[r, r, h, 16]} />
      <meshStandardMaterial color={c} roughness={rough} metalness={metal} />
    </mesh>
  );
}

// ───────── shell ─────────

function Shell({ wing }: { wing: string }) {
  const floor = useMemo(() => {
    const t = makeFloorTex();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(9 / 2.4, 9.5 / 2.4);
    return t;
  }, []);
  const ceil = useMemo(() => {
    const t = makeCeilingTex();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(8 / 0.6, 7 / 0.6);
    return t;
  }, []);
  const outdoor = useMemo(makeOutdoorTex, []);
  const wall = '#ebe7df';
  const wain = '#' + new THREE.Color(wing).lerp(new THREE.Color('#f4f2ec'), 0.7).getHexString();
  const W = { z0: -5.4, z1: -2.4, y0: 0.9, y1: 2.35 };
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -2.75]} receiveShadow>
        <planeGeometry args={[9, 9.5]} />
        <meshStandardMaterial map={floor} roughness={0.34} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, ROOM.h, -3.5]}>
        <planeGeometry args={[8, 7]} />
        <meshStandardMaterial map={ceil} roughness={0.95} />
      </mesh>
      {/* back + right walls */}
      <Box p={[0, ROOM.h / 2, ROOM.minZ - 0.1]} s={[8.4, ROOM.h, 0.2]} c={wall} r={0.9} />
      <Box p={[ROOM.maxX + 0.1, ROOM.h / 2, -3.5]} s={[0.2, ROOM.h, 7.4]} c={wall} r={0.9} />
      {/* left wall with a window opening */}
      <Box p={[ROOM.minX - 0.1, ROOM.h / 2, (ROOM.minZ + W.z0) / 2]} s={[0.2, ROOM.h, W.z0 - ROOM.minZ]} c={wall} r={0.9} />
      <Box p={[ROOM.minX - 0.1, ROOM.h / 2, (W.z1 + ROOM.maxZ) / 2]} s={[0.2, ROOM.h, ROOM.maxZ - W.z1]} c={wall} r={0.9} />
      <Box p={[ROOM.minX - 0.1, W.y0 / 2, (W.z0 + W.z1) / 2]} s={[0.2, W.y0, W.z1 - W.z0]} c={wall} r={0.9} />
      <Box p={[ROOM.minX - 0.1, (W.y1 + ROOM.h) / 2, (W.z0 + W.z1) / 2]} s={[0.2, ROOM.h - W.y1, W.z1 - W.z0]} c={wall} r={0.9} />
      <Box p={[ROOM.minX + 0.05, W.y0, (W.z0 + W.z1) / 2]} s={[0.22, 0.04, W.z1 - W.z0 + 0.1]} c="#f2f2ef" r={0.4} />
      {[W.z0, (W.z0 + W.z1) / 2, W.z1].map((z) => (
        <Box key={z} p={[ROOM.minX - 0.05, (W.y0 + W.y1) / 2, z]} s={[0.08, W.y1 - W.y0, 0.05]} c="#9aa3ab" m={0.7} r={0.3} />
      ))}
      <mesh position={[ROOM.minX - 0.06, (W.y0 + W.y1) / 2, (W.z0 + W.z1) / 2]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[W.z1 - W.z0, W.y1 - W.y0]} />
        <meshStandardMaterial color="#d9ecf5" transparent opacity={0.1} roughness={0.02} depthWrite={false} />
      </mesh>
      <mesh position={[ROOM.minX - 5, 1.6, -3.9]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[22, 11]} />
        <meshBasicMaterial map={outdoor} toneMapped={false} />
      </mesh>
      {/* blinds (half drawn) */}
      {Array.from({ length: 9 }, (_, i) => (
        <Box key={i} p={[ROOM.minX + 0.12, W.y1 - 0.05 - i * 0.07, (W.z0 + W.z1) / 2]} s={[0.04, 0.012, W.z1 - W.z0 - 0.1]} c="#f3f1ec" r={0.5} rot={[0, 0, 0.5]} />
      ))}
      {/* front wall with doorway */}
      <Box p={[(ROOM.minX + DOOR.x - DOOR.halfW) / 2, ROOM.h / 2, 0.1]} s={[DOOR.x - DOOR.halfW - ROOM.minX, ROOM.h, 0.2]} c={wall} r={0.9} />
      <Box p={[(DOOR.x + DOOR.halfW + ROOM.maxX) / 2, ROOM.h / 2, 0.1]} s={[ROOM.maxX - DOOR.x - DOOR.halfW, ROOM.h, 0.2]} c={wall} r={0.9} />
      <Box p={[DOOR.x, (2.2 + ROOM.h) / 2, 0.1]} s={[DOOR.halfW * 2, ROOM.h - 2.2, 0.2]} c={wall} r={0.9} />
      {/* corridor stub beyond the door */}
      <Box p={[DOOR.x, 1.5, 2.3]} s={[2.4, 3, 0.2]} c="#e8e5de" r={0.9} />
      <Box p={[DOOR.x - 1.2, 1.5, 1.2]} s={[0.2, 3, 2.2]} c="#e8e5de" r={0.9} />
      <Box p={[DOOR.x + 1.2, 1.5, 1.2]} s={[0.2, 3, 2.2]} c="#e8e5de" r={0.9} />
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[DOOR.x, 3, 1.2]}>
        <planeGeometry args={[2.4, 2.2]} />
        <meshStandardMaterial color="#efeeea" />
      </mesh>
      <pointLight position={[DOOR.x, 2.6, 1.2]} intensity={2.5} distance={4} decay={1.5} color="#fff3e2" />
      {/* wainscot + skirting + wing stripe */}
      <Box p={[0, 0.5, ROOM.minZ + 0.012]} s={[8, 1, 0.024]} c={wain} r={0.55} />
      <Box p={[ROOM.maxX - 0.012, 0.5, -3.5]} s={[0.024, 1, 7]} c={wain} r={0.55} />
      <Box p={[0, 1.02, ROOM.minZ + 0.014]} s={[8, 0.05, 0.028]} c={wing} r={0.5} />
      <Box p={[ROOM.maxX - 0.014, 1.02, -3.5]} s={[0.028, 0.05, 7]} c={wing} r={0.5} />
      <Box p={[ROOM.minX + 0.008, 0.06, -3.5]} s={[0.016, 0.12, 7]} c="#4a4f57" r={0.5} />
      <Box p={[0, 0.06, ROOM.minZ + 0.008]} s={[8, 0.12, 0.016]} c="#4a4f57" r={0.5} />
      {/* door frame */}
      <Box p={[DOOR.x - DOOR.halfW, 1.1, 0.0]} s={[0.07, 2.2, 0.26]} c="#cfd5dc" m={0.5} r={0.35} />
      <Box p={[DOOR.x + DOOR.halfW, 1.1, 0.0]} s={[0.07, 2.2, 0.26]} c="#cfd5dc" m={0.5} r={0.35} />
      <Box p={[DOOR.x, 2.2, 0.0]} s={[DOOR.halfW * 2 + 0.07, 0.07, 0.26]} c="#cfd5dc" m={0.5} r={0.35} />
    </>
  );
}

function DoorLeaf({ open }: { open: boolean }) {
  const pivot = useRef<THREE.Group>(null);
  const cur = useRef(0);
  useFrame((_, dt) => {
    cur.current += ((open ? 1 : 0) - cur.current) * Math.min(1, dt * 3);
    if (pivot.current) pivot.current.rotation.y = -cur.current * 1.5;
  });
  return (
    <group ref={pivot} position={[DOOR.x - DOOR.halfW + 0.04, 0, -0.08]}>
      <group position={[0.58, 1.06, 0]}>
        <Box p={[0, 0, 0]} s={[1.14, 2.1, 0.05]} c="#c9a77d" r={0.5} cast />
        <Box p={[0, -0.92, 0.002]} s={[1.1, 0.25, 0.056]} c="#b8bec6" m={0.85} r={0.32} />
        <Box p={[0.42, -0.04, -0.045]} s={[0.16, 0.028, 0.035]} c="#e3e7ea" m={1} r={0.18} />
        <Box p={[0.24, 0.4, 0]} s={[0.2, 0.75, 0.056]} c="#1c2733" m={0.2} r={0.08} />
      </group>
    </group>
  );
}

function CeilingLights() {
  const pos: Array<[number, number]> = [
    [-1.4, -4.6],
    [1.6, -4.6],
    [-1.4, -1.8],
    [1.6, -1.8],
  ];
  return (
    <>
      {pos.map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, ROOM.h - 0.012, z]}>
          <boxGeometry args={[1.2, 0.025, 0.6]} />
          <meshStandardMaterial color="#ffffff" emissive="#fff6ea" emissiveIntensity={2.6} toneMapped={false} />
        </mesh>
      ))}
      <pointLight position={[-1.3, 2.6, -4.2]} intensity={6} distance={8} decay={1.6} color="#fff3e2" />
      <pointLight position={[1.8, 2.6, -2.2]} intensity={5} distance={8} decay={1.6} color="#fff3e2" />
      <pointLight position={[3.1, 2.4, -4.4]} intensity={3} distance={5} decay={1.6} color="#ffffff" />
      <directionalLight
        position={[-6, 6, -2]}
        intensity={1.1}
        color="#fff1dc"
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-6}
        shadow-camera-right={6}
        shadow-camera-top={6}
        shadow-camera-bottom={-6}
        shadow-camera-near={0.5}
        shadow-camera-far={20}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />
      <hemisphereLight args={['#f4f6ff', '#b8ab96', 0.35]} />
    </>
  );
}

// ───────── furniture ─────────

function makeEmrTex(p: ActivePatient | null, clinic: string) {
  return canvasTex(640, 400, (g) => {
    g.fillStyle = '#f4f7fb';
    g.fillRect(0, 0, 640, 400);
    g.fillStyle = '#1d4f91';
    g.fillRect(0, 0, 640, 54);
    g.fillStyle = '#ffffff';
    g.font = '600 24px Inter, system-ui, sans-serif';
    g.fillText(`OPD · ${clinic}`, 20, 36);
    g.fillStyle = '#16233c';
    if (!p) {
      g.font = '500 26px Inter, system-ui, sans-serif';
      g.fillText('Waiting for the next patient', 20, 120);
      return;
    }
    const c = p.case;
    g.font = '700 32px Inter, system-ui, sans-serif';
    g.fillText(`${c.name}`, 20, 104);
    g.font = '500 22px Inter, system-ui, sans-serif';
    g.fillStyle = '#4a5a72';
    g.fillText(`${c.age} y · ${c.gender === 'F' ? 'Female' : 'Male'} · UHID ${c.id.toUpperCase()}`, 20, 138);
    g.fillStyle = '#16233c';
    g.font = '600 20px Inter, system-ui, sans-serif';
    g.fillText('Chief complaint', 20, 184);
    g.font = '400 20px Inter, system-ui, sans-serif';
    const words = c.chiefComplaint.split(' ');
    let line = '';
    let y = 214;
    for (const w of words) {
      if (g.measureText(line + w).width > 590) {
        g.fillText(line, 20, y);
        line = '';
        y += 28;
        if (y > 300) break;
      }
      line += w + ' ';
    }
    if (y <= 300) g.fillText(line, 20, y);
    const v = c.vitals;
    g.fillStyle = '#e6edf6';
    g.fillRect(0, 330, 640, 70);
    g.fillStyle = '#16233c';
    g.font = '600 20px Inter, system-ui, sans-serif';
    g.fillText(`HR ${v.hr}   BP ${v.bp}   SpO₂ ${v.spo2}%   T ${v.temp}°C   RR ${v.rr}`, 20, 372);
  });
}

function Desk({ patient, clinicLabel }: { patient: ActivePatient | null; clinicLabel: string }) {
  const tex = useMemo(() => makeEmrTex(patient, clinicLabel), [patient?.case.id, clinicLabel]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <group position={[DESK.x, 0, DESK.z]}>
      <Box p={[0, DESK.h - 0.02, 0]} s={[DESK.w, 0.04, DESK.d]} c="#d9c3a2" r={0.45} cast />
      <Box p={[-DESK.w / 2 + 0.22, DESK.h / 2 - 0.02, 0]} s={[0.42, DESK.h - 0.04, DESK.d - 0.04]} c="#eeeae2" r={0.5} cast />
      <Box p={[DESK.w / 2 - 0.03, DESK.h / 2 - 0.02, 0]} s={[0.04, DESK.h - 0.04, DESK.d - 0.04]} c="#eeeae2" r={0.5} />
      <Box p={[0.2, DESK.h / 2 + 0.05, DESK.d / 2 - 0.03]} s={[DESK.w - 0.5, DESK.h - 0.3, 0.02]} c="#eeeae2" r={0.5} />
      {[0.12, 0.3, 0.48].map((y) => (
        <Box key={y} p={[-DESK.w / 2 + 0.22, y, -DESK.d / 2 + 0.005]} s={[0.36, 0.14, 0.012]} c="#e3ddd2" r={0.5} />
      ))}
      {/* monitor faces the doctor (−z), set to the left so the patient stays in view */}
      <group position={[0.55, DESK.h, 0.1]} rotation={[0, Math.PI - 0.35, 0]}>
        <Box p={[0, 0.03, 0]} s={[0.22, 0.02, 0.16]} c="#2a2d31" r={0.4} />
        <Box p={[0, 0.16, 0.02]} s={[0.04, 0.24, 0.03]} c="#2a2d31" r={0.4} />
        <Box p={[0, 0.36, 0]} s={[0.58, 0.36, 0.03]} c="#121417" r={0.3} cast />
        <mesh position={[0, 0.36, 0.0155]}>
          <planeGeometry args={[0.54, 0.33]} />
          <meshBasicMaterial map={tex} toneMapped={false} />
        </mesh>
      </group>
      <Box p={[-0.3, DESK.h + 0.012, -0.15]} s={[0.42, 0.02, 0.14]} c="#2b2e33" r={0.5} />
      <Box p={[0.05, DESK.h + 0.01, -0.12]} s={[0.07, 0.015, 0.1]} c="#2b2e33" r={0.5} />
      {/* prescription pad, pen stand, BP machine */}
      <Box p={[0.35, DESK.h + 0.008, -0.1]} s={[0.15, 0.012, 0.21]} c="#fbfaf6" r={0.8} />
      <Cyl p={[0.6, DESK.h + 0.05, 0.25]} r={0.035} h={0.1} c="#2e3b52" rough={0.5} />
      <Box p={[0.45, DESK.h + 0.05, 0.22]} s={[0.24, 0.09, 0.16]} c="#e9edf1" r={0.4} />
      <Box p={[0.45, DESK.h + 0.096, 0.2]} s={[0.12, 0.004, 0.07]} c="#1d2b3b" r={0.3} />
      <Box p={[0.12, DESK.h + 0.025, 0.25]} s={[0.24, 0.03, 0.3]} c="#f4f1e8" r={0.8} />
    </group>
  );
}

function OfficeChair({ x, z, yaw }: { x: number; z: number; yaw: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, yaw, 0]}>
      {Array.from({ length: 5 }, (_, i) => (
        <group key={i} rotation={[0, (i / 5) * Math.PI * 2, 0]}>
          <Box p={[0.15, 0.06, 0]} s={[0.3, 0.03, 0.04]} c="#2a2d31" r={0.4} />
          <Cyl p={[0.29, 0.03, 0]} r={0.025} h={0.03} c="#1a1c1f" rot={[Math.PI / 2, 0, 0]} />
        </group>
      ))}
      <Cyl p={[0, 0.25, 0]} r={0.025} h={0.35} c="#9aa1a8" metal={0.9} rough={0.3} />
      <Box p={[0, 0.46, 0]} s={[0.5, 0.08, 0.48]} c="#2d3a4f" r={0.7} cast />
      <Box p={[0, 0.82, -0.25]} s={[0.46, 0.55, 0.07]} c="#2d3a4f" r={0.7} cast rot={[0.08, 0, 0]} />
    </group>
  );
}

function PatientChair({ x, z, yaw }: { x: number; z: number; yaw: number }) {
  return (
    <group position={[x, 0, z]} rotation={[0, yaw, 0]}>
      {[[-0.22, -0.2], [0.22, -0.2], [-0.22, 0.2], [0.22, 0.2]].map(([a, b]) => (
        <Cyl key={`${a}${b}`} p={[a, 0.22, b]} r={0.015} h={0.44} c="#aab2ba" metal={0.9} rough={0.3} />
      ))}
      <Box p={[0, 0.45, 0]} s={[0.5, 0.06, 0.48]} c="#2f5f8f" r={0.6} cast />
      <Box p={[0, 0.78, -0.23]} s={[0.5, 0.5, 0.05]} c="#2f5f8f" r={0.6} cast rot={[-0.08, 0, 0]} />
      {[-0.26, 0.26].map((a) => (
        <Box key={a} p={[a, 0.64, 0]} s={[0.04, 0.03, 0.42]} c="#aab2ba" m={0.9} r={0.3} />
      ))}
    </group>
  );
}

function ExamBed() {
  return (
    <group position={[BED.x, 0, BED.z]}>
      <Box p={[0, BED.h - 0.06, 0]} s={[BED.w, 0.1, BED.len]} c="#3a5f86" r={0.55} cast />
      <Box p={[0, BED.h + 0.0, 0.1]} s={[BED.w - 0.04, 0.012, BED.len - 0.3]} c="#f4f2ec" r={0.85} />
      <Box p={[0, BED.h + 0.12, -BED.len / 2 + 0.3]} s={[BED.w - 0.02, 0.1, 0.55]} c="#3a5f86" r={0.55} rot={[0.35, 0, 0]} />
      <Box p={[0, BED.h + 0.09, -BED.len / 2 + 0.22]} s={[0.45, 0.08, 0.3]} c="#ffffff" r={0.9} rot={[0.35, 0, 0]} />
      <Box p={[0, 0.3, 0]} s={[BED.w - 0.12, 0.5, BED.len - 0.3]} c="#e9ecef" r={0.4} />
      <Box p={[0, 0.08, BED.len / 2 + 0.12]} s={[0.4, 0.16, 0.24]} c="#cfd4d9" r={0.4} m={0.3} />
      {/* paper roll */}
      <Cyl p={[0, BED.h + 0.06, -BED.len / 2 + 0.02]} r={0.05} h={0.5} c="#fbfaf6" rough={0.9} rot={[0, 0, Math.PI / 2]} />
      {/* privacy curtain on a ceiling rail */}
      <Box p={[-BED.w / 2 - 0.35, ROOM.h - 0.05, 0]} s={[0.03, 0.03, BED.len + 0.6]} c="#c9ced4" m={0.8} r={0.3} />
      <mesh position={[-BED.w / 2 - 0.35, 1.6, BED.len / 2 - 0.1]} castShadow>
        <boxGeometry args={[0.04, 2.6, 0.8]} />
        <meshStandardMaterial color="#9cc7cf" roughness={0.9} />
      </mesh>
      {Array.from({ length: 6 }, (_, i) => (
        <mesh key={i} position={[-BED.w / 2 - 0.34 + (i % 2) * 0.03, 1.6, BED.len / 2 - 0.45 + i * 0.13]}>
          <cylinderGeometry args={[0.025, 0.025, 2.6, 8]} />
          <meshStandardMaterial color="#9cc7cf" roughness={0.9} />
        </mesh>
      ))}
    </group>
  );
}

function makeVitalsTex() {
  const c = document.createElement('canvas');
  c.width = 512;
  c.height = 300;
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  return { canvas: c, tex: t };
}

function VitalsMonitor({ patient }: { patient: ActivePatient | null }) {
  const { canvas, tex } = useMemo(makeVitalsTex, []);
  const st = useRef({ t: 0, acc: 0 });
  useFrame((_, dt) => {
    const s = st.current;
    s.t += dt;
    s.acc += dt;
    if (s.acc < 0.1) return;
    s.acc = 0;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#05080c';
    g.fillRect(0, 0, 512, 300);
    const v = patient?.case.vitals;
    const hr = v?.hr ?? 0;
    g.strokeStyle = '#3cff7a';
    g.lineWidth = 3;
    g.beginPath();
    for (let x = 0; x < 330; x += 2) {
      const ph = ((x / 330) * 4 + s.t * (hr / 60)) % 1;
      const y = 80 - (v ? (ph > 0.42 && ph < 0.46 ? 50 : ph > 0.46 && ph < 0.5 ? -18 : Math.sin(ph * 30) * 2) : 0);
      if (x === 0) g.moveTo(x + 14, y);
      else g.lineTo(x + 14, y);
    }
    g.stroke();
    g.strokeStyle = '#3cc8ff';
    g.beginPath();
    for (let x = 0; x < 330; x += 2) {
      const y = 190 - (v ? Math.sin((x / 40) + s.t * 1.6) * 16 : 0);
      if (x === 0) g.moveTo(x + 14, y);
      else g.lineTo(x + 14, y);
    }
    g.stroke();
    g.font = '700 44px Inter, system-ui, sans-serif';
    g.fillStyle = '#3cff7a';
    g.fillText(v ? String(hr) : '--', 370, 80);
    g.fillStyle = '#3cc8ff';
    g.fillText(v ? `${v.spo2}` : '--', 370, 190);
    g.font = '600 18px Inter, system-ui, sans-serif';
    g.fillStyle = '#9aa7b5';
    g.fillText('HR', 370, 36);
    g.fillText('SpO₂ %', 370, 146);
    g.fillStyle = '#ffd36b';
    g.font = '700 30px Inter, system-ui, sans-serif';
    g.fillText(v ? `NIBP ${v.bp}` : 'NIBP --/--', 14, 270);
    g.fillStyle = '#ff8fa3';
    g.fillText(v ? `${v.temp}°C` : '', 370, 270);
    tex.needsUpdate = true;
  });
  return (
    <group position={[ROOM.maxX - 0.08, 1.75, BED.z - 0.75]} rotation={[0, -Math.PI / 2, 0]}>
      <Box p={[0, 0, -0.04]} s={[0.56, 0.38, 0.08]} c="#d9dde2" r={0.4} cast />
      <mesh position={[0, 0.01, 0.002]}>
        <planeGeometry args={[0.48, 0.28]} />
        <meshBasicMaterial map={tex} toneMapped={false} />
      </mesh>
    </group>
  );
}

function SinkUnit() {
  return (
    <group position={[1.6, 0, ROOM.minZ + 0.3]}>
      <Box p={[0, 0.43, 0]} s={[1.3, 0.86, 0.6]} c="#f1efe9" r={0.45} cast />
      <Box p={[0, 0.88, 0]} s={[1.34, 0.04, 0.62]} c="#cfd3d6" r={0.25} />
      <Box p={[0, 0.87, 0.02]} s={[0.5, 0.03, 0.36]} c="#e9edf0" m={0.6} r={0.2} />
      <Cyl p={[0, 1.0, -0.2]} r={0.015} h={0.24} c="#dfe3e6" metal={1} rough={0.15} />
      <Box p={[0, 1.11, -0.13]} s={[0.03, 0.03, 0.15]} c="#dfe3e6" m={1} r={0.15} />
      <mesh position={[0, 1.65, -0.285]}>
        <planeGeometry args={[0.7, 0.8]} />
        <meshStandardMaterial color="#cdd6dc" metalness={1} roughness={0.05} />
      </mesh>
      <Box p={[0.6, 1.35, -0.26]} s={[0.12, 0.22, 0.09]} c="#f6f6f6" r={0.35} />
      <Box p={[-0.6, 1.4, -0.24]} s={[0.3, 0.38, 0.12]} c="#f3f4f5" r={0.35} />
      {[-0.42, -0.14, 0.14, 0.42].map((x) => (
        <Box key={x} p={[x, 0.45, 0.302]} s={[0.25, 0.7, 0.01]} c="#e6e2d8" r={0.45} />
      ))}
    </group>
  );
}

/** Colour-coded biomedical waste bins (yellow, red, blue, black). */
function WasteBins() {
  const cols = ['#e2b52b', '#c8302c', '#2b5fb4', '#26282b'];
  return (
    <group position={[3.0, 0, ROOM.minZ + 0.32]}>
      {cols.map((c, i) => (
        <group key={c} position={[i * 0.3 - 0.45, 0, 0]}>
          <Cyl p={[0, 0.25, 0]} r={0.12} h={0.5} c={c} rough={0.55} />
          <Cyl p={[0, 0.51, 0]} r={0.125} h={0.03} c={c} rough={0.45} />
        </group>
      ))}
    </group>
  );
}

function GlassCabinet() {
  return (
    <group position={[-3.3, 0, ROOM.minZ + 0.26]}>
      <Box p={[0, 1.0, 0]} s={[1.0, 2.0, 0.45]} c="#eeebe4" r={0.5} cast />
      <mesh position={[0, 1.35, 0.228]}>
        <planeGeometry args={[0.9, 1.15]} />
        <meshStandardMaterial color="#cfe3ee" transparent opacity={0.25} roughness={0.05} />
      </mesh>
      {[0.95, 1.35, 1.75].map((y) => (
        <group key={y}>
          <Box p={[0, y, 0]} s={[0.9, 0.02, 0.4]} c="#dcd8cf" r={0.5} />
          {Array.from({ length: 6 }, (_, i) => (
            <Box key={i} p={[-0.36 + i * 0.14, y + 0.07, 0.02]} s={[0.08, 0.12, 0.08]} c={['#f4f4f4', '#d9e8f5', '#f5e3c9', '#e3f1e0'][i % 4]} r={0.5} />
          ))}
        </group>
      ))}
    </group>
  );
}

function EyeChart() {
  const tex = useMemo(
    () =>
      canvasTex(256, 384, (g) => {
        g.fillStyle = '#fbfbf8';
        g.fillRect(0, 0, 256, 384);
        g.fillStyle = '#111';
        const rows = ['E', 'F P', 'T O Z', 'L P E D', 'P E C F D', 'E D F C Z P', 'F E L O P Z D'];
        rows.forEach((r, i) => {
          const size = 64 - i * 8;
          g.font = `700 ${size}px Inter, Arial, sans-serif`;
          const w = g.measureText(r).width;
          g.fillText(r, 128 - w / 2, 70 + i * 46);
        });
      }),
    [],
  );
  return (
    <mesh position={[-2.2, 1.7, ROOM.minZ + 0.012]}>
      <planeGeometry args={[0.42, 0.63]} />
      <meshStandardMaterial map={tex} roughness={0.8} />
    </mesh>
  );
}

function ClinicSign({ clinic, room, wing }: { clinic: string; room: string; wing: string }) {
  const hi = hindiLabel(clinic);
  const ready = useSignFontsReady();
  const tex = useMemo(
    () =>
      canvasTex(1024, 220, (g) => {
        g.fillStyle = '#15233c';
        g.fillRect(0, 0, 1024, 220);
        g.fillStyle = wing;
        g.fillRect(0, 0, 16, 220);
        g.fillStyle = '#ffffff';
        g.font = '800 64px Inter, system-ui, sans-serif';
        g.fillText(CLINIC_LABELS[clinic as ClinicId]?.toUpperCase() ?? clinic.toUpperCase(), 48, 92);
        g.font = '600 52px "Noto Sans Devanagari", "Nirmala UI", sans-serif';
        g.fillStyle = '#cdd7e6';
        if (hi) g.fillText(hi, 48, 170);
        g.font = '700 40px Inter, system-ui, sans-serif';
        g.fillStyle = '#a8e27c';
        const t = `OPD ${room}`;
        g.fillText(t, 1000 - g.measureText(t).width, 92);
      }),
    [clinic, room, wing, hi, ready],
  );
  return (
    <mesh position={[-0.6, 2.35, ROOM.minZ + 0.012]}>
      <planeGeometry args={[2.6, 0.56]} />
      <meshStandardMaterial map={tex} roughness={0.4} />
    </mesh>
  );
}

const PLANT_URL = '/assets/models/potted_plant_02/potted_plant_02_lod.glb';
const CLOCK_URL = '/assets/models/wall_clock/wall_clock_1k.gltf';

function Decor({ wingColor }: { wingColor: string }) {
  const plant = useGLTF(PLANT_URL).scene;
  const clock = useGLTF(CLOCK_URL).scene;
  const art = useMemo(() => makeArtTex(7), []);
  return (
    <>
      <Clone object={plant} position={[-3.55, 0, -0.5]} scale={1.25} />
      <Clone object={clock} position={[0.6, 2.45, -0.0 - 0.01]} rotation={[0, Math.PI, 0]} scale={1.2} />
      {/* framed art + anatomy poster */}
      <group position={[ROOM.maxX - 0.02, 1.7, -1.6]} rotation={[0, -Math.PI / 2, 0]}>
        <Box p={[0, 0, 0]} s={[0.7, 0.86, 0.03]} c="#2a2d31" r={0.4} />
        <mesh position={[0, 0, 0.017]}>
          <planeGeometry args={[0.6, 0.76]} />
          <meshStandardMaterial map={art} roughness={0.7} />
        </mesh>
      </group>
      {/* weighing scale */}
      <Box p={[-3.5, 0.03, -1.6]} s={[0.36, 0.06, 0.36]} c="#e9ecef" r={0.3} cast />
      <Box p={[-3.5, 0.065, -1.6]} s={[0.12, 0.004, 0.06]} c="#1d2b3b" r={0.3} />
      {/* hand sanitizer by the door */}
      <Box p={[DOOR.x - 0.95, 1.25, -0.04]} s={[0.12, 0.24, 0.09]} c="#f3f4f5" r={0.35} />
      <Box p={[DOOR.x - 0.95, 1.18, -0.09]} s={[0.04, 0.03, 0.02]} c={wingColor} r={0.35} />
      {/* IV stand by the bed */}
      <group position={[BED.x - 0.55, 0, BED.z - 1.0]}>
        <Cyl p={[0, 1.0, 0]} r={0.012} h={2.0} c="#d6dade" metal={0.95} rough={0.2} />
        <Cyl p={[0, 0.03, 0]} r={0.22} h={0.02} c="#c8cdd2" metal={0.9} rough={0.3} />
        <Box p={[0.1, 1.86, 0]} s={[0.1, 0.18, 0.04]} c="#e8f2f6" r={0.15} />
      </group>
    </>
  );
}

// ───────── patient ─────────

function lerpPath(path: Array<[number, number]>, t: number): { x: number; z: number; yaw: number } {
  const seg: number[] = [];
  let total = 0;
  for (let i = 0; i < path.length - 1; i++) {
    const d = Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
    seg.push(d);
    total += d;
  }
  let dist = THREE.MathUtils.clamp(t, 0, 1) * total;
  for (let i = 0; i < seg.length; i++) {
    if (dist <= seg[i] || i === seg.length - 1) {
      const u = seg[i] > 0 ? Math.min(1, dist / seg[i]) : 1;
      const [ax, az] = path[i];
      const [bx, bz] = path[i + 1];
      return { x: ax + (bx - ax) * u, z: az + (bz - az) * u, yaw: Math.atan2(bx - ax, bz - az) };
    }
    dist -= seg[i];
  }
  const l = path[path.length - 1];
  return { x: l[0], z: l[1], yaw: 0 };
}

function pathLength(path: Array<[number, number]>) {
  let d = 0;
  for (let i = 0; i < path.length - 1; i++) d += Math.hypot(path[i + 1][0] - path[i][0], path[i + 1][1] - path[i][1]);
  return d;
}

const WALK_SPEED = 1.15;

interface Actor {
  key: string;
  patient: ActivePatient;
  leaving: boolean;
  delay: number;
}

/** Keeps the outgoing patient walking out while the next one walks in. */
function PatientCast({ patient, runtime, onPhase }: { patient: ActivePatient | null; runtime: PlayerRuntime; onPhase: (p: string) => void }) {
  const [actors, setActors] = useState<Actor[]>(() => (patient ? [{ key: `${patient.case.id}-${patient.arrivedAt}`, patient, leaving: false, delay: 0 }] : []));
  const key = patient ? `${patient.case.id}-${patient.arrivedAt}` : '';
  useEffect(() => {
    setActors((prev) => {
      if (key && prev.some((a) => a.key === key && !a.leaving)) return prev;
      const busy = prev.some((a) => !a.leaving);
      const next = prev.map((a) => (a.key === key ? a : { ...a, leaving: true }));
      if (patient && key && !next.some((a) => a.key === key)) next.push({ key, patient, leaving: false, delay: busy ? 2.6 : 0 });
      return next;
    });
  }, [key, patient]);
  const gone = (k: string) => setActors((prev) => prev.filter((a) => a.key !== k));
  return (
    <>
      {actors.map((a) => (
        <PatientActor key={a.key} patient={a.patient} leaving={a.leaving} delay={a.delay} runtime={runtime} onPhase={a.leaving ? undefined : onPhase} onGone={() => gone(a.key)} />
      ))}
    </>
  );
}

/** One patient (plus a parent for children): waits `delay`, walks in through
 *  the door, sits facing the doctor with lip-sync, walks out when `leaving`. */
function PatientActor({
  patient,
  leaving,
  delay,
  runtime,
  onPhase,
  onGone,
}: {
  patient: ActivePatient;
  leaving: boolean;
  delay: number;
  runtime: PlayerRuntime;
  onPhase?: (p: string) => void;
  onGone: () => void;
}) {
  const st = useRef({ phase: 'wait' as 'wait' | 'in' | 'seated' | 'out' | 'gone', t: 0, wait: delay, yaw: Math.PI });
  const group = useRef<THREE.Group>(null);
  const parentGroup = useRef<THREE.Group>(null);
  const control = useMemo(() => makeControl({ seatHeight: PATIENT_SEAT.height }), []);
  const parentControl = useMemo(() => makeControl(), []);
  const doctorHead = useMemo(() => new THREE.Vector3(), []);
  const len = useMemo(() => pathLength(PATIENT_PATH), []);
  const reversed = useMemo(() => [...PATIENT_PATH].reverse() as Array<[number, number]>, []);
  const phaseRef = useRef(onPhase);
  phaseRef.current = onPhase;
  const goneRef = useRef(onGone);
  goneRef.current = onGone;

  useEffect(() => {
    const s = st.current;
    if (!leaving) return;
    if (s.phase === 'wait') {
      s.phase = 'gone';
      goneRef.current();
      return;
    }
    if (s.phase === 'in') {
      // turn around where we are: map progress onto the reversed path
      s.t = 1 - s.t;
    } else s.t = 0;
    s.phase = 'out';
    phaseRef.current?.('out');
  }, [leaving]);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const s = st.current;
    const g = group.current;
    if (!g) return;
    if (s.phase === 'gone') return;
    if (s.phase === 'wait') {
      g.visible = false;
      if (parentGroup.current) parentGroup.current.visible = false;
      s.wait -= dt;
      if (s.wait <= 0) {
        s.phase = 'in';
        s.t = 0;
        phaseRef.current?.('in');
      }
      return;
    }
    g.visible = true;
    if (parentGroup.current) parentGroup.current.visible = true;
    let x = PATIENT_SEAT.x, z = PATIENT_SEAT.z, yaw = PATIENT_SEAT.yaw;
    if (s.phase === 'in' || s.phase === 'out') {
      const speed = s.phase === 'out' ? WALK_SPEED * 1.25 : WALK_SPEED;
      s.t += (dt * speed) / len;
      const p = lerpPath(s.phase === 'in' ? PATIENT_PATH : reversed, s.t);
      x = p.x;
      z = p.z;
      yaw = p.yaw;
      control.action = 'walk';
      control.speed = speed;
      if (s.t >= 1) {
        if (s.phase === 'in') {
          s.phase = 'seated';
          phaseRef.current?.('seated');
        } else {
          s.phase = 'gone';
          phaseRef.current?.('gone');
          goneRef.current();
          return;
        }
      }
    } else {
      control.action = 'sit';
      control.speed = 0;
    }
    const wantYaw = s.phase === 'seated' ? PATIENT_SEAT.yaw : yaw;
    s.yaw += Math.atan2(Math.sin(wantYaw - s.yaw), Math.cos(wantYaw - s.yaw)) * Math.min(1, dt * 6);
    g.position.set(x, 0, z);
    g.rotation.y = s.yaw;
    doctorHead.set(runtime.pos.x, runtime.seated ? 1.2 : 1.65, runtime.pos.z);
    control.lookAt = s.phase === 'seated' ? doctorHead : null;
    const pg = parentGroup.current;
    if (pg) {
      if (s.phase === 'seated') {
        pg.position.set(PATIENT_SEAT.x + 0.75, 0, PATIENT_SEAT.z + 0.15);
        pg.rotation.y = Math.PI - 0.3;
        parentControl.action = 'idle';
        parentControl.speed = 0;
        parentControl.lookAt = doctorHead;
      } else {
        const back = lerpPath(s.phase === 'in' ? PATIENT_PATH : reversed, Math.max(0, s.t - 0.9 / len));
        pg.position.set(back.x + 0.35, 0, back.z + 0.2);
        pg.rotation.y = back.yaw;
        parentControl.action = 'walk';
        parentControl.speed = WALK_SPEED;
        parentControl.lookAt = null;
      }
    }
  });

  const mouth = useMemo(
    () => () => {
      const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
      return conv ? conv.getMouthAmplitude() : 0;
    },
    [],
  );
  const c = patient.case;
  const isChild = c.age < 14;
  // Child cases: the parent speaks for the child, so the parent's mouth moves.
  control.mouth = leaving ? undefined : isChild ? undefined : mouth;
  parentControl.mouth = !leaving && isChild ? mouth : undefined;
  const look = useMemo(() => patientLook(c.age, c.gender, c.id), [c]);
  const parentLook = useMemo(
    () => (isChild ? patientLook(36, parentGenderForId(c.id), `${c.id}-parent`) : null),
    [c, isChild],
  );
  return (
    <>
      <group ref={group} position={[PATIENT_PATH[0][0], 0, PATIENT_PATH[0][1]]} visible={false}>
        <HumanCharacter look={look} control={control} />
      </group>
      {parentLook && (
        <group ref={parentGroup} position={[PATIENT_PATH[0][0], 0, PATIENT_PATH[0][1] + 0.6]} visible={false}>
          <HumanCharacter look={parentLook} control={parentControl} />
        </group>
      )}
    </>
  );
}

// ───────── root ─────────

export function ClinicRoomWorld({
  patient,
  clinic,
  runtime,
  onPatientPhase,
}: {
  patient: ActivePatient | null;
  clinic: string;
  runtime: PlayerRuntime;
  onPatientPhase: (p: string) => void;
}) {
  const door = doorForClinic(clinic);
  const wing = door ? WINGS[door.dept.wing].color : '#3f7cc4';
  const label = CLINIC_LABELS[clinic as ClinicId] ?? 'Outpatient clinic';
  const [doorOpen, setDoorOpen] = useState(true);
  const phase = (p: string) => {
    setDoorOpen(p === 'in' || p === 'out');
    onPatientPhase(p);
  };
  return (
    <>
      <CeilingLights />
      <Shell wing={wing} />
      <DoorLeaf open={doorOpen} />
      <Desk patient={patient} clinicLabel={label} />
      <OfficeChair x={DOCTOR_SEAT.x} z={DOCTOR_SEAT.z - 0.08} yaw={0} />
      <PatientChair x={PATIENT_SEAT.x} z={PATIENT_SEAT.z} yaw={Math.PI} />
      <ExamBed />
      <VitalsMonitor patient={patient} />
      <SinkUnit />
      <WasteBins />
      <GlassCabinet />
      <EyeChart />
      <ClinicSign clinic={clinic} room={door?.room ?? '101'} wing={wing} />
      <Text font={FONT_MED} position={[DOOR.x, 2.45, -0.02]} rotation={[0, Math.PI, 0]} fontSize={0.09} color="#15233c" anchorX="center" letterSpacing={0.1}>
        EXIT TO CORRIDOR
      </Text>
      <Text font={FONT_HEAVY} position={[-3.98, 2.6, -1.1]} rotation={[0, Math.PI / 2, 0]} fontSize={0.12} color="#15233c" anchorX="center" letterSpacing={0.08}>
        {`OPD ${door?.room ?? ''}`}
      </Text>
      <Text font={FONT_BOLD} position={[ROOM.maxX - 0.02, 2.35, BED.z]} rotation={[0, -Math.PI / 2, 0]} fontSize={0.08} color="#15233c" anchorX="center" letterSpacing={0.1}>
        EXAMINATION
      </Text>
      <Decor wingColor={wing} />
      <PatientCast patient={patient} runtime={runtime} onPhase={phase} />
    </>
  );
}

useGLTF.preload(PLANT_URL);
useGLTF.preload(CLOCK_URL);
