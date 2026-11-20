import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useFrame } from '@react-three/fiber';
import { Clone, Text, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { FONT_BOLD, FONT_HEAVY, FONT_MED, canvasTex, makeCeilingTex } from './Corridor';
import { DOORS } from './corridorLayout';
import { HumanCharacter, makeControl } from './HumanCharacter';
import { hindiLabel, useSignFontsReady } from './hindi';
import type { Look } from './rigs';
import type { Collider, PlayerRuntime } from './ThirdPersonPlayer';
import type { RadCase } from '../../data/radiology';
import { MODALITY_LABEL, RAD_CASES } from '../../data/radiology';

// ───────── Radiology reading room (reporting room) ─────────
//
//   z = −6  ┌─[lightbox]──[ monitors on the reporting desk ]──[shelf]─┐
//           │              Dr. Rao (seated)   empty chair             │
//   x = −4  │                                                printer │ x = +4
//           │  film jackets                        poster            │
//   z = 0   └──────────────────────────────────────┐ door ┌──────────┘
//                                                  └──────┘ to the corridor
//
// Dim on purpose: radiologists read with the room lights low so the
// monitors and the light box carry the scene.

export const RAD = { minX: -4, maxX: 4, minZ: -6, maxZ: 0, h: 3.0 };
export const RAD_DOOR = { x: 2.7, halfW: 0.62 };
export const RAD_SPAWN = { x: 2.7, z: -1.1, yaw: Math.PI };
export const RAD_EXIT = { x: RAD_DOOR.x, z: -0.7 };

const DESK = { x: -0.4, z: -5.25, w: 3.0, d: 0.85, h: 0.74 };
const CONSULTANT_SEAT = { x: -1.05, z: -4.35 };
const STUDENT_CHAIR = { x: 0.35, z: -4.3 };
const LIGHTBOX = { x: RAD.minX + 0.03, y: 1.6, z: -3.2, w: 2.2, h: 0.95 };
const SHELF = { x: 3.35, z: -5.55 };
const PRINTER = { x: 3.45, z: -3.2 };

const T = 0.3;
export const RAD_COLLIDERS: Collider[] = [
  { x: 0, z: RAD.minZ - T / 2, w: 8.6, d: T },
  { x: RAD.minX - T / 2, z: -3, w: T, d: 6.6 },
  { x: RAD.maxX + T / 2, z: -3, w: T, d: 6.6 },
  { x: (RAD.minX + RAD_DOOR.x - RAD_DOOR.halfW) / 2, z: T / 2, w: RAD_DOOR.x - RAD_DOOR.halfW - RAD.minX, d: T },
  { x: (RAD_DOOR.x + RAD_DOOR.halfW + RAD.maxX) / 2, z: T / 2, w: RAD.maxX - RAD_DOOR.x - RAD_DOOR.halfW, d: T },
  { x: RAD_DOOR.x, z: 0.35, w: RAD_DOOR.halfW * 2, d: 0.2 },
  { x: DESK.x, z: DESK.z, w: DESK.w, d: DESK.d, h: 0.8 },
  { x: CONSULTANT_SEAT.x, z: CONSULTANT_SEAT.z, w: 0.62, d: 0.62, h: 1.4 },
  { x: STUDENT_CHAIR.x, z: STUDENT_CHAIR.z, w: 0.55, d: 0.55, h: 0.9 },
  { x: SHELF.x, z: SHELF.z, w: 1.1, d: 0.45, h: 1.9 },
  { x: PRINTER.x, z: PRINTER.z, w: 0.7, d: 0.6, h: 1.0 },
  { x: -3.55, z: -0.7, w: 0.6, d: 0.6, h: 1.0 },
];

/** Dr. Vikram Rao: greying hair, glasses, white lab coat over a pale shirt
 *  and charcoal formal trousers, polished brown shoes. */
export const RADIOLOGIST_LOOK: Look = {
  rig: 'doctor',
  height: 1.74,
  skin: '#b07656',
  hair: '#5c5650',
  hairGrey: true,
  top: { color: '#f2f3f5', map: false, roughness: 0.82 },
  bottom: { color: '#33363d', map: false, roughness: 0.6 },
  shoes: '#4a2c1c',
  beard: 'hide',
  glasses: true,
};

function Box({ p, s, c, r = 0.7, m = 0, cast = false, rot, e, ei = 1 }: { p: [number, number, number]; s: [number, number, number]; c: string; r?: number; m?: number; cast?: boolean; rot?: [number, number, number]; e?: string; ei?: number }) {
  return (
    <mesh position={p} rotation={rot} castShadow={cast} receiveShadow>
      <boxGeometry args={s} />
      <meshStandardMaterial color={c} roughness={r} metalness={m} emissive={e ?? '#000000'} emissiveIntensity={e ? ei : 0} />
    </mesh>
  );
}

// ───────── film texture ─────────

/** Loads the film image into a texture (no Suspense: the room renders at once). */
function useFilmTexture(url: string | null): { tex: THREE.Texture | null; aspect: number } {
  const [state, setState] = useState<{ tex: THREE.Texture | null; aspect: number }>({ tex: null, aspect: 1 });
  useEffect(() => {
    if (!url) return;
    let alive = true;
    let loaded: THREE.Texture | null = null;
    new THREE.TextureLoader().load(
      url,
      (t) => {
        loaded = t;
        if (!alive) {
          t.dispose();
          return;
        }
        t.colorSpace = THREE.SRGBColorSpace;
        t.anisotropy = 8;
        const img = t.image as { width?: number; height?: number } | undefined;
        setState({ tex: t, aspect: img && img.width && img.height ? img.width / img.height : 1 });
      },
      undefined,
      () => alive && setState({ tex: null, aspect: 1 }),
    );
    return () => {
      alive = false;
      loaded?.dispose();
    };
  }, [url]);
  return state;
}

/** The film fitted (letterboxed) inside a w x h screen area. */
function FittedFilm({ tex, aspect, w, h, glow = 0.85 }: { tex: THREE.Texture | null; aspect: number; w: number; h: number; glow?: number }) {
  const fw = aspect > w / h ? w : h * aspect;
  const fh = aspect > w / h ? w / aspect : h;
  if (!tex) return null;
  return (
    <mesh position={[0, 0, 0.002]}>
      <planeGeometry args={[fw, fh]} />
      <meshStandardMaterial map={tex} emissiveMap={tex} emissive="#ffffff" emissiveIntensity={glow} roughness={0.4} toneMapped={false} />
    </mesh>
  );
}

// ───────── shell + lights ─────────

function makeVinylTex() {
  return canvasTex(512, 512, (g) => {
    g.fillStyle = '#4b5059';
    g.fillRect(0, 0, 512, 512);
    for (let i = 0; i < 2600; i++) {
      const x = (i * 97.13) % 512;
      const y = (i * 53.71 + (i % 7) * 31) % 512;
      g.fillStyle = i % 3 ? 'rgba(255,255,255,0.05)' : 'rgba(0,0,0,0.12)';
      g.fillRect(x, y, 2, 2);
    }
    g.strokeStyle = 'rgba(0,0,0,0.25)';
    g.lineWidth = 2;
    for (let k = 0; k <= 512; k += 128) {
      g.beginPath();
      g.moveTo(k, 0);
      g.lineTo(k, 512);
      g.moveTo(0, k);
      g.lineTo(512, k);
      g.stroke();
    }
  });
}

function Shell() {
  const floor = useMemo(() => {
    const t = makeVinylTex();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(8 / 1.2, 6 / 1.2);
    return t;
  }, []);
  const ceil = useMemo(() => {
    const t = makeCeilingTex();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(8 / 0.6, 6 / 0.6);
    return t;
  }, []);
  useEffect(
    () => () => {
      floor.dispose();
      ceil.dispose();
    },
    [floor, ceil],
  );
  const wall = '#5d6774';
  const H = RAD.h;
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -3]} receiveShadow>
        <planeGeometry args={[8.4, 6.4]} />
        <meshStandardMaterial map={floor} roughness={0.55} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, H, -3]}>
        <planeGeometry args={[8, 6]} />
        <meshStandardMaterial map={ceil} roughness={0.95} color="#9aa0a8" />
      </mesh>
      <Box p={[0, H / 2, RAD.minZ - 0.1]} s={[8.4, H, 0.2]} c={wall} r={0.92} />
      <Box p={[RAD.minX - 0.1, H / 2, -3]} s={[0.2, H, 6.4]} c={wall} r={0.92} />
      <Box p={[RAD.maxX + 0.1, H / 2, -3]} s={[0.2, H, 6.4]} c={wall} r={0.92} />
      {/* back wall with the door */}
      <Box p={[(RAD.minX + RAD_DOOR.x - RAD_DOOR.halfW) / 2, H / 2, 0.1]} s={[RAD_DOOR.x - RAD_DOOR.halfW - RAD.minX, H, 0.2]} c={wall} r={0.92} />
      <Box p={[(RAD_DOOR.x + RAD_DOOR.halfW + RAD.maxX) / 2, H / 2, 0.1]} s={[RAD.maxX - RAD_DOOR.x - RAD_DOOR.halfW, H, 0.2]} c={wall} r={0.92} />
      <Box p={[RAD_DOOR.x, (2.2 + H) / 2, 0.1]} s={[RAD_DOOR.halfW * 2, H - 2.2, 0.2]} c={wall} r={0.92} />
      {[-1, 1].map((sx) => (
        <Box key={sx} p={[RAD_DOOR.x + sx * RAD_DOOR.halfW, 1.1, 0]} s={[0.07, 2.2, 0.26]} c="#9aa3ab" m={0.5} r={0.35} />
      ))}
      <Box p={[RAD_DOOR.x, 2.2, 0]} s={[RAD_DOOR.halfW * 2 + 0.07, 0.07, 0.26]} c="#9aa3ab" m={0.5} r={0.35} />
      {/* lead-lined door, ajar, with the radiation trefoil plate */}
      <group position={[RAD_DOOR.x - RAD_DOOR.halfW + 0.04, 0, -0.08]} rotation={[0, -0.3, 0]}>
        <Box p={[0.58, 1.06, 0]} s={[1.14, 2.1, 0.06]} c="#6f7b86" r={0.45} m={0.2} cast />
        <Box p={[1.0, 1.02, -0.05]} s={[0.16, 0.028, 0.035]} c="#e3e7ea" m={1} r={0.18} />
        <Box p={[0.58, 1.55, -0.035]} s={[0.26, 0.26, 0.01]} c="#f2c230" r={0.5} />
      </group>
      {/* corridor glimpse */}
      <Box p={[RAD_DOOR.x, 1.5, 2.3]} s={[2.4, 3, 0.2]} c="#e8e5de" r={0.9} />
      <Box p={[RAD_DOOR.x - 1.2, 1.5, 1.2]} s={[0.2, 3, 2.2]} c="#e8e5de" r={0.9} />
      <Box p={[RAD_DOOR.x + 1.2, 1.5, 1.2]} s={[0.2, 3, 2.2]} c="#e8e5de" r={0.9} />
      <pointLight position={[RAD_DOOR.x, 2.6, 1.2]} intensity={2.2} distance={4} decay={1.5} color="#fff3e2" />
      {/* skirting + acoustic panels on the front wall */}
      <Box p={[0, 0.06, RAD.minZ + 0.008]} s={[8, 0.12, 0.016]} c="#2c3036" r={0.5} />
      <Box p={[RAD.minX + 0.008, 0.06, -3]} s={[0.016, 0.12, 6]} c="#2c3036" r={0.5} />
      <Box p={[RAD.maxX - 0.008, 0.06, -3]} s={[0.016, 0.12, 6]} c="#2c3036" r={0.5} />
      {[-2.6, -1.3, 0, 1.3].map((x) => (
        <Box key={x} p={[x, 2.05, RAD.minZ + 0.03]} s={[1.15, 0.9, 0.05]} c="#3c4652" r={1} />
      ))}
    </>
  );
}

function Lights() {
  return (
    <>
      {/* dimmed recessed downlights */}
      {[
        [-2, -3.8],
        [2, -3.8],
        [-2, -1.4],
        [2, -1.4],
      ].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, RAD.h - 0.01, z]} rotation={[Math.PI / 2, 0, 0]}>
          <circleGeometry args={[0.11, 20]} />
          <meshStandardMaterial color="#fff2dc" emissive="#ffe6c4" emissiveIntensity={1.6} toneMapped={false} />
        </mesh>
      ))}
      <pointLight position={[-2, 2.8, -1.6]} intensity={1.6} distance={6} decay={1.6} color="#ffe2bd" />
      <pointLight position={[2, 2.8, -1.6]} intensity={1.6} distance={6} decay={1.6} color="#ffe2bd" />
      <pointLight position={[0.2, 2.7, -3.6]} intensity={1.2} distance={5} decay={1.6} color="#ffe2bd" castShadow shadow-mapSize-width={512} shadow-mapSize-height={512} shadow-bias={-0.0005} />
      {/* cool monitor spill onto the desk and the consultant */}
      <pointLight position={[-0.4, 1.2, -5.0]} intensity={2.2} distance={3.2} decay={1.5} color="#bcd6ff" />
      {/* light box wash */}
      <pointLight position={[RAD.minX + 0.6, 1.6, LIGHTBOX.z]} intensity={2.6} distance={3.6} decay={1.5} color="#eaf3ff" />
      <hemisphereLight args={['#aab8cc', '#2a2622', 0.18]} />
    </>
  );
}

// ───────── furniture ─────────

function Monitor({ position, rotY = 0, w, h, children }: { position: [number, number, number]; rotY?: number; w: number; h: number; children?: ReactNode }) {
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      {/* stand */}
      <Box p={[0, -h / 2 - 0.13, -0.06]} s={[0.05, 0.28, 0.04]} c="#22252a" m={0.6} r={0.35} />
      <Box p={[0, -h / 2 - 0.27, -0.02]} s={[0.26, 0.015, 0.2]} c="#22252a" m={0.6} r={0.35} />
      {/* bezel */}
      <Box p={[0, 0, -0.025]} s={[w + 0.04, h + 0.04, 0.035]} c="#15171b" r={0.4} m={0.3} cast />
      <mesh position={[0, 0, -0.006]}>
        <planeGeometry args={[w, h]} />
        <meshStandardMaterial color="#05070a" roughness={0.2} />
      </mesh>
      <group position={[0, 0, -0.004]}>{children}</group>
    </group>
  );
}

function makeWorklistTex(currentId: string) {
  return canvasTex(512, 820, (g) => {
    g.fillStyle = '#0c1424';
    g.fillRect(0, 0, 512, 820);
    g.fillStyle = '#1f3d6b';
    g.fillRect(0, 0, 512, 64);
    g.fillStyle = '#ffffff';
    g.font = '700 30px Inter, system-ui, sans-serif';
    g.fillText('PACS · WORKLIST', 20, 43);
    g.font = '500 21px Inter, system-ui, sans-serif';
    RAD_CASES.slice(0, 19).forEach((c, i) => {
      const y = 100 + i * 37;
      const on = c.id === currentId;
      if (on) {
        g.fillStyle = '#2f6fd1';
        g.fillRect(8, y - 25, 496, 34);
      }
      g.fillStyle = on ? '#ffffff' : i % 2 ? '#9fb4d6' : '#c9d6ea';
      g.fillText(`${String(i + 1).padStart(2, '0')}  ${MODALITY_LABEL[c.modality]}`, 20, y);
      g.fillText(`${c.patient.age}${c.patient.sex}`, 420, y);
    });
  });
}

function ReportingDesk({ film }: { film: RadCase | null }) {
  const { tex, aspect } = useFilmTexture(film?.image ?? null);
  const worklist = useMemo(() => makeWorklistTex(film?.id ?? ''), [film?.id]);
  useEffect(() => () => worklist.dispose(), [worklist]);
  const top = '#6b5a48';
  return (
    <group>
      <group position={[DESK.x, 0, DESK.z]}>
        <Box p={[0, DESK.h, 0]} s={[DESK.w, 0.045, DESK.d]} c={top} r={0.5} cast />
        {[-1, 1].map((s) => (
          <Box key={s} p={[s * (DESK.w / 2 - 0.05), DESK.h / 2, 0]} s={[0.05, DESK.h, DESK.d - 0.06]} c="#2c3036" m={0.5} r={0.4} cast />
        ))}
        <Box p={[0, DESK.h - 0.3, -DESK.d / 2 + 0.03]} s={[DESK.w - 0.1, 0.5, 0.02]} c="#2c3036" r={0.6} />
        {/* keyboard, mouse, dictation mic, mug, report pad */}
        <Box p={[-0.6, DESK.h + 0.03, 0.18]} s={[0.44, 0.02, 0.15]} c="#1b1d21" r={0.5} />
        <Box p={[-0.25, DESK.h + 0.03, 0.2]} s={[0.06, 0.025, 0.1]} c="#1b1d21" r={0.4} />
        <group position={[0.15, DESK.h + 0.02, 0.15]} rotation={[0, -0.3, 0]}>
          <Box p={[0, 0.01, 0]} s={[0.06, 0.02, 0.18]} c="#30343a" r={0.4} m={0.4} />
          <Box p={[0, 0.03, -0.04]} s={[0.035, 0.02, 0.05]} c="#c0392b" r={0.4} e="#c0392b" ei={0.6} />
        </group>
        <mesh position={[0.6, DESK.h + 0.07, 0.12]} castShadow>
          <cylinderGeometry args={[0.04, 0.035, 0.1, 16]} />
          <meshStandardMaterial color="#f1ece2" roughness={0.4} />
        </mesh>
        <Box p={[0.95, DESK.h + 0.03, 0.08]} s={[0.22, 0.012, 0.3]} c="#f5f3ee" r={0.85} rot={[0, 0.15, 0]} />
      </group>
      {/* main diagnostic monitor with the current film */}
      <Monitor position={[DESK.x - 0.6, DESK.h + 0.62, DESK.z - 0.12]} w={0.92} h={0.6}>
        <FittedFilm tex={tex} aspect={aspect} w={0.9} h={0.58} />
      </Monitor>
      {/* second diagnostic monitor, angled in */}
      <Monitor position={[DESK.x + 0.45, DESK.h + 0.62, DESK.z - 0.02]} rotY={-0.32} w={0.92} h={0.6}>
        <FittedFilm tex={tex} aspect={aspect} w={0.9} h={0.58} glow={0.55} />
      </Monitor>
      {/* portrait worklist monitor */}
      <Monitor position={[DESK.x - 1.35, DESK.h + 0.56, DESK.z + 0.04]} rotY={0.42} w={0.36} h={0.58}>
        <mesh position={[0, 0, 0.002]}>
          <planeGeometry args={[0.35, 0.56]} />
          <meshStandardMaterial map={worklist} emissiveMap={worklist} emissive="#ffffff" emissiveIntensity={0.7} toneMapped={false} />
        </mesh>
      </Monitor>
      {/* the light box on the side wall */}
      <LightBox film={film} tex={tex} aspect={aspect} />
    </group>
  );
}

function LightBox({ film, tex, aspect }: { film: RadCase | null; tex: THREE.Texture | null; aspect: number }) {
  const panelW = LIGHTBOX.w / 2;
  const isFilm = !!film && film.modality !== 'ecg' && film.modality !== 'us';
  return (
    <group position={[LIGHTBOX.x, LIGHTBOX.y, LIGHTBOX.z]} rotation={[0, Math.PI / 2, 0]}>
      <Box p={[0, 0, 0.02]} s={[LIGHTBOX.w + 0.1, LIGHTBOX.h + 0.1, 0.06]} c="#c9ced4" m={0.5} r={0.35} />
      {[-0.5, 0.5].map((k) => (
        <mesh key={k} position={[k * panelW, 0, 0.052]}>
          <planeGeometry args={[panelW - 0.04, LIGHTBOX.h - 0.04]} />
          <meshStandardMaterial color="#f4f8ff" emissive="#eaf3ff" emissiveIntensity={isFilm && k < 0 ? 0.35 : 1.5} toneMapped={false} />
        </mesh>
      ))}
      {isFilm && (
        <group position={[-0.5 * panelW, 0, 0.056]}>
          <FittedFilm tex={tex} aspect={aspect} w={panelW - 0.08} h={LIGHTBOX.h - 0.08} glow={1.1} />
        </group>
      )}
      {/* clips on the top rail */}
      {[-0.8, -0.3, 0.3, 0.8].map((x) => (
        <Box key={x} p={[x, LIGHTBOX.h / 2 - 0.02, 0.06]} s={[0.05, 0.03, 0.02]} c="#8a9097" m={0.7} r={0.3} />
      ))}
    </group>
  );
}

function OfficeChair({ x, z, rotY }: { x: number; z: number; rotY: number }) {
  const fabric = '#1d2633';
  return (
    <group position={[x, 0, z]} rotation={[0, rotY, 0]}>
      <Box p={[0, 0.47, 0]} s={[0.5, 0.07, 0.48]} c={fabric} r={0.9} cast />
      {/* seat faces +z; backrest behind (-z) */}
      <Box p={[0, 0.82, -0.24]} s={[0.46, 0.6, 0.06]} c={fabric} r={0.9} cast rot={[0.08, 0, 0]} />
      <mesh position={[0, 0.25, 0]}>
        <cylinderGeometry args={[0.025, 0.025, 0.4, 10]} />
        <meshStandardMaterial color="#9aa3ab" metalness={0.8} roughness={0.3} />
      </mesh>
      {[0, 1, 2, 3, 4].map((i) => {
        const a = (i / 5) * Math.PI * 2;
        return <Box key={i} p={[Math.sin(a) * 0.17, 0.05, Math.cos(a) * 0.17]} s={[0.04, 0.03, 0.34]} c="#22252a" m={0.5} r={0.4} rot={[0, a, 0]} />;
      })}
      {[-1, 1].map((s) => (
        <Box key={s} p={[s * 0.27, 0.64, 0.02]} s={[0.05, 0.04, 0.32]} c="#22252a" r={0.5} />
      ))}
    </group>
  );
}

function makePosterTex() {
  return canvasTex(512, 720, (g) => {
    g.fillStyle = '#fbf8f1';
    g.fillRect(0, 0, 512, 720);
    g.fillStyle = '#d08a2c';
    g.fillRect(0, 0, 512, 92);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.font = '800 44px Inter, system-ui, sans-serif';
    g.fillText('READ IT IN ORDER', 256, 62);
    g.textAlign = 'left';
    const rows: Array<[string, string]> = [
      ['A', 'Airway'],
      ['B', 'Breathing'],
      ['C', 'Circulation'],
      ['D', 'Diaphragm, bones'],
      ['E', 'Everything else'],
    ];
    rows.forEach(([k, v], i) => {
      const y = 170 + i * 96;
      g.fillStyle = '#15233c';
      g.beginPath();
      g.arc(70, y - 12, 34, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = '#ffffff';
      g.font = '800 40px Inter, system-ui, sans-serif';
      g.textAlign = 'center';
      g.fillText(k, 70, y + 2);
      g.textAlign = 'left';
      g.fillStyle = '#2a2d31';
      g.font = '600 34px Inter, system-ui, sans-serif';
      g.fillText(v, 124, y);
    });
    g.fillStyle = '#8a8f96';
    g.textAlign = 'center';
    g.font = '500 22px Inter, system-ui, sans-serif';
    g.fillText('Department of Radiodiagnosis', 256, 690);
  });
}

function RoomSign() {
  const ready = useSignFontsReady();
  const room = DOORS.find((d) => d.dept.id === 'radiology')?.room ?? '';
  const tex = useMemo(() => {
    const hi = hindiLabel('radiology');
    return canvasTex(768, 150, (g) => {
      g.fillStyle = '#15233c';
      g.fillRect(0, 0, 768, 150);
      g.fillStyle = '#d08a2c';
      g.fillRect(0, 0, 768, 8);
      g.textAlign = 'center';
      g.fillStyle = '#ffffff';
      g.font = '800 46px Inter, system-ui, sans-serif';
      g.fillText(`REPORTING ROOM ${room}`, 384, 68, 740);
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
    <mesh position={[2.9, 2.72, RAD.minZ + 0.06]}>
      <planeGeometry args={[1.7, 0.33]} />
      <meshStandardMaterial map={tex} roughness={0.45} />
    </mesh>
  );
}

const PLANT_URL = '/assets/models/potted_plant_02/potted_plant_02_lod.glb';
const CLOCK_URL = '/assets/models/wall_clock/wall_clock_1k.gltf';

function Decor() {
  const plant = useGLTF(PLANT_URL).scene;
  const clock = useGLTF(CLOCK_URL).scene;
  const poster = useMemo(makePosterTex, []);
  useEffect(() => () => poster.dispose(), [poster]);
  const jackets = ['#c9b48a', '#b9a06f', '#d8c7a0', '#a88f5f', '#cdbb92'];
  return (
    <>
      <Clone object={plant} position={[-3.55, 0, -0.7]} scale={1.15} />
      <Clone object={clock} position={[-1.2, 2.6, -0.02]} rotation={[0, Math.PI, 0]} scale={1.1} />
      <RoomSign />
      {/* poster on the right wall */}
      <group position={[RAD.maxX - 0.02, 1.6, -1.6]} rotation={[0, -Math.PI / 2, 0]}>
        <Box p={[0, 0, 0]} s={[0.74, 1.04, 0.02]} c="#2a2d31" r={0.4} />
        <mesh position={[0, 0, 0.012]}>
          <planeGeometry args={[0.68, 0.97]} />
          <meshStandardMaterial map={poster} roughness={0.75} />
        </mesh>
      </group>
      {/* shelf of film jackets */}
      <group position={[SHELF.x, 0, SHELF.z]}>
        <Box p={[0, 0.95, 0]} s={[1.1, 1.9, 0.42]} c="#3a3f47" r={0.6} m={0.2} cast />
        {[0.45, 0.95, 1.45].map((y) => (
          <group key={y}>
            <Box p={[0, y - 0.2, 0.05]} s={[1.0, 0.02, 0.36]} c="#2c3036" r={0.5} />
            {jackets.map((c, i) => (
              <Box key={c} p={[-0.38 + i * 0.17 + (y % 0.3) * 0.1, y, 0.08]} s={[0.035 + (i % 2) * 0.02, 0.36, 0.33]} c={c} r={0.85} />
            ))}
          </group>
        ))}
      </group>
      {/* film printer / CD burner on a cabinet */}
      <group position={[PRINTER.x, 0, PRINTER.z]}>
        <Box p={[0, 0.4, 0]} s={[0.66, 0.8, 0.56]} c="#d9dce0" r={0.6} cast />
        <Box p={[0, 0.92, 0]} s={[0.58, 0.24, 0.48]} c="#eceef1" r={0.45} cast />
        <Box p={[-0.17, 1.0, 0.245]} s={[0.12, 0.05, 0.01]} c="#5cff8a" e="#5cff8a" ei={2} />
      </group>
      <Text font={FONT_MED} position={[RAD_DOOR.x, 2.45, -0.02]} rotation={[0, Math.PI, 0]} fontSize={0.09} color="#e6ebf2" anchorX="center" letterSpacing={0.1}>
        EXIT TO CORRIDOR
      </Text>
      <Text font={FONT_HEAVY} position={[-1.3, 2.86, RAD.minZ + 0.06]} fontSize={0.11} color="#e6ebf2" anchorX="center" letterSpacing={0.08}>
        DEPARTMENT OF RADIODIAGNOSIS
      </Text>
      <Text font={FONT_BOLD} position={[-1.3, 2.71, RAD.minZ + 0.06]} fontSize={0.06} color="#d08a2c" anchorX="center" letterSpacing={0.14}>
        QUIET PLEASE · REPORTING IN PROGRESS
      </Text>
    </>
  );
}

// ───────── consultant ─────────

function Consultant({ runtime, mouth }: { runtime: PlayerRuntime; mouth: () => number }) {
  const control = useMemo(() => makeControl({ action: 'sit', seatHeight: 0.5 }), []);
  const head = useMemo(() => new THREE.Vector3(), []);
  const screen = useMemo(() => new THREE.Vector3(DESK.x - 0.6, DESK.h + 0.62, DESK.z - 0.12), []);
  const g = useRef<THREE.Group>(null);
  const st = useRef({ yaw: Math.PI, talkUntil: 0 });
  useFrame((state, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const near = Math.hypot(runtime.pos.x - CONSULTANT_SEAT.x, runtime.pos.z - CONSULTANT_SEAT.z) < 3.4;
    const talking = mouth() > 0.04;
    if (talking) st.current.talkUntil = state.clock.elapsedTime + 1.5;
    const engaged = near || state.clock.elapsedTime < st.current.talkUntil;
    if (engaged) {
      head.set(runtime.pos.x, runtime.seated ? 1.2 : 1.62, runtime.pos.z);
      control.lookAt = head;
    } else {
      control.lookAt = screen;
    }
    // Swivel the chair a little toward the doctor while talking with them.
    let toward = Math.atan2(runtime.pos.x - CONSULTANT_SEAT.x, runtime.pos.z - CONSULTANT_SEAT.z);
    if (toward < 0) toward += Math.PI * 2;
    const want = engaged ? THREE.MathUtils.clamp(toward, Math.PI * 0.55, Math.PI * 1.45) : Math.PI;
    let diff = want - st.current.yaw;
    diff = Math.atan2(Math.sin(diff), Math.cos(diff));
    st.current.yaw += diff * Math.min(1, dt * 1.2);
    if (g.current) g.current.rotation.y = st.current.yaw;
  });
  control.mouth = mouth;
  return (
    <group ref={g} position={[CONSULTANT_SEAT.x, 0, CONSULTANT_SEAT.z]} rotation={[0, Math.PI, 0]}>
      <OfficeChair x={0} z={-0.05} rotY={0} />
      <HumanCharacter look={RADIOLOGIST_LOOK} control={control} />
    </group>
  );
}

// ───────── root ─────────

export function RadiologyWorld({ runtime, film, mouth }: { runtime: PlayerRuntime; film: RadCase | null; mouth: () => number }) {
  return (
    <>
      <Lights />
      <Shell />
      <ReportingDesk film={film} />
      <OfficeChair x={STUDENT_CHAIR.x} z={STUDENT_CHAIR.z} rotY={Math.PI - 0.35} />
      <Decor />
      <Consultant runtime={runtime} mouth={mouth} />
    </>
  );
}

useGLTF.preload(PLANT_URL);
useGLTF.preload(CLOCK_URL);
