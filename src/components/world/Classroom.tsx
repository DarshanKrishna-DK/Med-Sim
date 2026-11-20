import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Clone, Text, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import { FONT_BOLD, FONT_HEAVY, FONT_MED, canvasTex, makeCeilingTex, makeOutdoorTex } from './Corridor';
import { HumanCharacter, makeControl } from './HumanCharacter';
import { hindiLabel, useSignFontsReady } from './hindi';
import { patientLook, type Look } from './rigs';
import type { Collider, PlayerRuntime } from './ThirdPersonPlayer';
import { paintBoard, loadHandFont } from '../teach/boardTexture';
import type { Lesson } from '../teach/lesson';

// ───────── Lecture hall (Teacher Portal) ─────────
//
//   z = −9  ┌──────────[ WHITEBOARD ]──────────┐ front wall
//           │ teacher ▲             [lectern]  │
//   windows │  [desk+bench]   aisle  [desk+bench]│ posters (x = +6)
//   (x=−6)  │  [desk+bench]          [desk+bench]│
//           │  [desk+bench]          [desk+bench]│
//   z = 0   └──────────────────────────┐ door ┌─┘ to the corridor
//                                      └──────┘

export const CLASS = { minX: -6, maxX: 6, minZ: -9, maxZ: 0, h: 3.4 };
export const CLASS_DOOR = { x: 4.7, halfW: 0.62 };
export const CLASS_SPAWN = { x: 4.7, z: -1.1, yaw: Math.PI };
export const CLASS_EXIT = { x: CLASS_DOOR.x, z: -0.7 };
export const TEACHER_SPOT = { x: -2.75, z: -7.75, yaw: 0.42 };
const BOARD = { w: 4.1, h: 2.31, y: 1.86, z: CLASS.minZ + 0.07 };
const LECTERN = { x: 3.0, z: -7.5 };
const DESK_ROWS = [-5.3, -3.8, -2.3];
const DESK_COLS = [-2.75, 2.75];
const DESK = { w: 2.4, d: 0.5, h: 0.74 };
const BENCH_OFF = 0.52;

const T = 0.3;
export const CLASS_COLLIDERS: Collider[] = [
  { x: 0, z: CLASS.minZ - T / 2, w: 12.6, d: T },
  { x: CLASS.minX - T / 2, z: -4.5, w: T, d: 9.6 },
  { x: CLASS.maxX + T / 2, z: -4.5, w: T, d: 9.6 },
  { x: (CLASS.minX + CLASS_DOOR.x - CLASS_DOOR.halfW) / 2, z: T / 2, w: CLASS_DOOR.x - CLASS_DOOR.halfW - CLASS.minX, d: T },
  { x: (CLASS_DOOR.x + CLASS_DOOR.halfW + CLASS.maxX) / 2, z: T / 2, w: CLASS.maxX - CLASS_DOOR.x - CLASS_DOOR.halfW, d: T },
  { x: CLASS_DOOR.x, z: 0.35, w: CLASS_DOOR.halfW * 2, d: 0.2 },
  ...DESK_ROWS.flatMap((z) =>
    DESK_COLS.flatMap((x): Collider[] => [
      { x, z, w: DESK.w, d: DESK.d, h: 0.8 },
      { x, z: z + BENCH_OFF, w: DESK.w, d: 0.34, h: 0.5 },
    ]),
  ),
  { x: LECTERN.x, z: LECTERN.z, w: 0.75, d: 0.6, h: 1.2 },
  { x: TEACHER_SPOT.x, z: TEACHER_SPOT.z, w: 0.6, d: 0.6, h: 1.8 },
  { x: -4.9, z: -8.55, w: 1.3, d: 0.6, h: 0.8 },
  { x: 5.55, z: -8.6, w: 0.6, d: 0.6, h: 1.2 },
];

/** Professor Meera Iyer: maroon silk saree under a white lab coat, gold
 *  border pallu over the shoulders, reading glasses, stethoscope. */
export const TEACHER_LOOK: Look = {
  rig: 'female',
  height: 1.62,
  skin: '#b77b58',
  hair: '#2b2220',
  top: { color: '#f4f5f7', map: false, roughness: 0.78 },
  bottom: { color: '#7a1630', map: false, roughness: 0.55 },
  shoes: '#3a2418',
  dupatta: '#b8862b',
  glasses: true,
  stethoscope: true,
};

// ───────── helpers ─────────

function Box({ p, s, c, r = 0.7, m = 0, cast = false, rot }: { p: [number, number, number]; s: [number, number, number]; c: string; r?: number; m?: number; cast?: boolean; rot?: [number, number, number] }) {
  return (
    <mesh position={p} rotation={rot} castShadow={cast} receiveShadow>
      <boxGeometry args={s} />
      <meshStandardMaterial color={c} roughness={r} metalness={m} />
    </mesh>
  );
}

/** Warm wood-laminate floor (lecture halls, not hospital vinyl). */
function makeWoodTex() {
  return canvasTex(512, 512, (g) => {
    const planks = 8;
    for (let i = 0; i < planks; i++) {
      const base = ['#9a7350', '#a27a55', '#93704e', '#a98159'][i % 4];
      g.fillStyle = base;
      g.fillRect(0, (i * 512) / planks, 512, 512 / planks);
      g.globalAlpha = 0.18;
      for (let k = 0; k < 26; k++) {
        g.strokeStyle = k % 2 ? '#6e4e33' : '#c39a70';
        g.lineWidth = 1 + (k % 3);
        g.beginPath();
        const y = (i * 512) / planks + ((k * 7.3) % (512 / planks));
        g.moveTo(0, y);
        g.bezierCurveTo(170, y + 3, 340, y - 3, 512, y + 1);
        g.stroke();
      }
      g.globalAlpha = 1;
      g.fillStyle = '#5c412b';
      g.fillRect(0, (i * 512) / planks, 512, 2);
      g.fillRect(((i * 197) % 512), (i * 512) / planks, 2, 512 / planks);
    }
  });
}

function makePosterTex(kind: 'heart' | 'ecg' | 'neuron' | 'hygiene') {
  return canvasTex(512, 720, (g) => {
    g.fillStyle = '#fbf8f1';
    g.fillRect(0, 0, 512, 720);
    const accent = { heart: '#b3263a', ecg: '#1f4fbf', neuron: '#6b3fa0', hygiene: '#23804a' }[kind];
    g.fillStyle = accent;
    g.fillRect(0, 0, 512, 92);
    g.fillStyle = '#ffffff';
    g.textAlign = 'center';
    g.font = '800 46px Inter, system-ui, sans-serif';
    const title = { heart: 'THE HEART', ecg: 'READING AN ECG', neuron: 'THE NEURON', hygiene: '5 MOMENTS' }[kind];
    g.fillText(title, 256, 64);
    g.strokeStyle = accent;
    g.fillStyle = accent;
    g.lineWidth = 6;
    g.lineCap = 'round';
    if (kind === 'heart') {
      g.beginPath();
      g.moveTo(256, 560);
      g.bezierCurveTo(60, 420, 70, 200, 190, 190);
      g.bezierCurveTo(240, 186, 256, 230, 256, 250);
      g.bezierCurveTo(256, 230, 272, 186, 322, 190);
      g.bezierCurveTo(442, 200, 452, 420, 256, 560);
      g.globalAlpha = 0.18;
      g.fill();
      g.globalAlpha = 1;
      g.stroke();
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(256, 250);
      g.lineTo(256, 520);
      g.stroke();
      g.beginPath();
      g.moveTo(130, 360);
      g.lineTo(382, 360);
      g.stroke();
      g.fillStyle = '#333';
      g.font = '600 26px Inter, system-ui, sans-serif';
      ['RA', 'LA', 'RV', 'LV'].forEach((t, i) => g.fillText(t, i % 2 ? 330 : 182, i < 2 ? 320 : 440));
    } else if (kind === 'ecg') {
      g.strokeStyle = '#f2b8b8';
      g.lineWidth = 1;
      for (let x = 20; x < 500; x += 20) { g.beginPath(); g.moveTo(x, 150); g.lineTo(x, 560); g.stroke(); }
      for (let y = 150; y < 570; y += 20) { g.beginPath(); g.moveTo(20, y); g.lineTo(492, y); g.stroke(); }
      g.strokeStyle = accent;
      g.lineWidth = 5;
      g.beginPath();
      const base = 360;
      let x = 24;
      g.moveTo(x, base);
      for (let beat = 0; beat < 2; beat++) {
        const pts: Array<[number, number]> = [[20, 0], [14, -26], [14, 0], [12, 0], [6, 16], [8, -150], [8, 40], [8, 0], [30, 0], [22, -44], [22, 0], [52, 0]];
        for (const [dx, dy] of pts) { x += dx; g.lineTo(x, base + dy); }
      }
      g.stroke();
      g.fillStyle = '#333';
      g.font = '600 28px Inter, system-ui, sans-serif';
      g.fillText('P   QRS   T', 256, 620);
    } else if (kind === 'neuron') {
      g.beginPath();
      g.arc(170, 300, 60, 0, Math.PI * 2);
      g.globalAlpha = 0.2;
      g.fill();
      g.globalAlpha = 1;
      g.stroke();
      for (let i = 0; i < 7; i++) {
        const a = (i / 7) * Math.PI * 2 + 0.4;
        g.beginPath();
        g.moveTo(170 + Math.cos(a) * 60, 300 + Math.sin(a) * 60);
        g.quadraticCurveTo(170 + Math.cos(a) * 110, 300 + Math.sin(a) * 90, 170 + Math.cos(a + 0.3) * 140, 300 + Math.sin(a + 0.3) * 120);
        g.stroke();
      }
      g.beginPath();
      g.moveTo(230, 300);
      g.bezierCurveTo(320, 320, 360, 420, 420, 560);
      g.stroke();
      for (let i = 0; i < 4; i++) {
        g.strokeRect(275 + i * 36, 320 + i * 58, 26, 14);
      }
    } else {
      g.fillStyle = '#333';
      g.textAlign = 'left';
      g.font = '600 30px Inter, system-ui, sans-serif';
      ['Before touching a patient', 'Before a clean procedure', 'After body fluid risk', 'After touching a patient', 'After the surroundings'].forEach((t, i) => {
        g.fillStyle = accent;
        g.beginPath();
        g.arc(56, 170 + i * 100, 24, 0, Math.PI * 2);
        g.fill();
        g.fillStyle = '#fff';
        g.textAlign = 'center';
        g.fillText(String(i + 1), 56, 181 + i * 100);
        g.fillStyle = '#333';
        g.textAlign = 'left';
        g.fillText(t, 96, 181 + i * 100, 400);
      });
    }
    g.fillStyle = '#8a8f96';
    g.textAlign = 'center';
    g.font = '500 22px Inter, system-ui, sans-serif';
    g.fillText('MedSim Medical College', 256, 690);
  });
}

// ───────── shell ─────────

function Shell() {
  const wood = useMemo(() => {
    const t = makeWoodTex();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(12 / 2.2, 9.6 / 2.2);
    return t;
  }, []);
  const ceil = useMemo(() => {
    const t = makeCeilingTex();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(12 / 0.6, 9 / 0.6);
    return t;
  }, []);
  const outdoor = useMemo(makeOutdoorTex, []);
  const wall = '#ece6da';
  const accent = '#2f5d8a';
  const H = CLASS.h;
  const WIN = { y0: 0.95, y1: 2.6, zs: [-7.2, -4.6, -2.0], half: 0.95 };
  // left wall split around three windows
  const leftSegs: Array<[number, number]> = [];
  let z = CLASS.minZ;
  for (const wz of WIN.zs) {
    leftSegs.push([z, wz - WIN.half]);
    z = wz + WIN.half;
  }
  leftSegs.push([z, CLASS.maxZ]);
  return (
    <>
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, -4.5]} receiveShadow>
        <planeGeometry args={[12.4, 9.6]} />
        <meshStandardMaterial map={wood} roughness={0.42} />
      </mesh>
      {/* teaching area: grey vinyl strip in front of the board */}
      <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0.004, -8.0]} receiveShadow>
        <planeGeometry args={[12, 2]} />
        <meshStandardMaterial color="#8d949c" roughness={0.5} />
      </mesh>
      <mesh rotation={[Math.PI / 2, 0, 0]} position={[0, H, -4.5]}>
        <planeGeometry args={[12, 9]} />
        <meshStandardMaterial map={ceil} roughness={0.95} />
      </mesh>
      {/* front + right walls */}
      <Box p={[0, H / 2, CLASS.minZ - 0.1]} s={[12.4, H, 0.2]} c={wall} r={0.9} />
      <Box p={[CLASS.maxX + 0.1, H / 2, -4.5]} s={[0.2, H, 9.4]} c={wall} r={0.9} />
      {/* left wall with windows */}
      {leftSegs.map(([a, b]) => (
        <Box key={a} p={[CLASS.minX - 0.1, H / 2, (a + b) / 2]} s={[0.2, H, b - a]} c={wall} r={0.9} />
      ))}
      {WIN.zs.map((wz) => (
        <group key={wz}>
          <Box p={[CLASS.minX - 0.1, WIN.y0 / 2, wz]} s={[0.2, WIN.y0, WIN.half * 2]} c={wall} r={0.9} />
          <Box p={[CLASS.minX - 0.1, (WIN.y1 + H) / 2, wz]} s={[0.2, H - WIN.y1, WIN.half * 2]} c={wall} r={0.9} />
          <Box p={[CLASS.minX + 0.06, WIN.y0, wz]} s={[0.22, 0.04, WIN.half * 2 + 0.1]} c="#f2f2ef" r={0.4} />
          <Box p={[CLASS.minX - 0.05, (WIN.y0 + WIN.y1) / 2, wz]} s={[0.06, WIN.y1 - WIN.y0, 0.05]} c="#9aa3ab" m={0.7} r={0.3} />
          <mesh position={[CLASS.minX - 0.06, (WIN.y0 + WIN.y1) / 2, wz]} rotation={[0, Math.PI / 2, 0]}>
            <planeGeometry args={[WIN.half * 2, WIN.y1 - WIN.y0]} />
            <meshStandardMaterial color="#d9ecf5" transparent opacity={0.1} roughness={0.02} depthWrite={false} />
          </mesh>
        </group>
      ))}
      <mesh position={[CLASS.minX - 6, 1.8, -4.5]} rotation={[0, Math.PI / 2, 0]}>
        <planeGeometry args={[30, 12]} />
        <meshBasicMaterial map={outdoor} toneMapped={false} />
      </mesh>
      {/* back wall with the door */}
      <Box p={[(CLASS.minX + CLASS_DOOR.x - CLASS_DOOR.halfW) / 2, H / 2, 0.1]} s={[CLASS_DOOR.x - CLASS_DOOR.halfW - CLASS.minX, H, 0.2]} c={wall} r={0.9} />
      <Box p={[(CLASS_DOOR.x + CLASS_DOOR.halfW + CLASS.maxX) / 2, H / 2, 0.1]} s={[CLASS.maxX - CLASS_DOOR.x - CLASS_DOOR.halfW, H, 0.2]} c={wall} r={0.9} />
      <Box p={[CLASS_DOOR.x, (2.2 + H) / 2, 0.1]} s={[CLASS_DOOR.halfW * 2, H - 2.2, 0.2]} c={wall} r={0.9} />
      <Box p={[CLASS_DOOR.x - CLASS_DOOR.halfW, 1.1, 0]} s={[0.07, 2.2, 0.26]} c="#cfd5dc" m={0.5} r={0.35} />
      <Box p={[CLASS_DOOR.x + CLASS_DOOR.halfW, 1.1, 0]} s={[0.07, 2.2, 0.26]} c="#cfd5dc" m={0.5} r={0.35} />
      <Box p={[CLASS_DOOR.x, 2.2, 0]} s={[CLASS_DOOR.halfW * 2 + 0.07, 0.07, 0.26]} c="#cfd5dc" m={0.5} r={0.35} />
      {/* door leaf, ajar */}
      <group position={[CLASS_DOOR.x - CLASS_DOOR.halfW + 0.04, 0, -0.08]} rotation={[0, -0.35, 0]}>
        <Box p={[0.58, 1.06, 0]} s={[1.14, 2.1, 0.05]} c="#8a6a4a" r={0.5} cast />
        <Box p={[1.0, 1.02, -0.045]} s={[0.16, 0.028, 0.035]} c="#e3e7ea" m={1} r={0.18} />
      </group>
      {/* corridor glimpse beyond the door */}
      <Box p={[CLASS_DOOR.x, 1.5, 2.3]} s={[2.4, 3, 0.2]} c="#e8e5de" r={0.9} />
      <Box p={[CLASS_DOOR.x - 1.2, 1.5, 1.2]} s={[0.2, 3, 2.2]} c="#e8e5de" r={0.9} />
      <Box p={[CLASS_DOOR.x + 1.2, 1.5, 1.2]} s={[0.2, 3, 2.2]} c="#e8e5de" r={0.9} />
      <pointLight position={[CLASS_DOOR.x, 2.6, 1.2]} intensity={2.5} distance={4} decay={1.5} color="#fff3e2" />
      {/* skirting + accent dado rail */}
      <Box p={[0, 0.06, CLASS.minZ + 0.008]} s={[12, 0.12, 0.016]} c="#4a4f57" r={0.5} />
      <Box p={[CLASS.maxX - 0.008, 0.06, -4.5]} s={[0.016, 0.12, 9]} c="#4a4f57" r={0.5} />
      <Box p={[CLASS.minX + 0.008, 0.06, -4.5]} s={[0.016, 0.12, 9]} c="#4a4f57" r={0.5} />
      <Box p={[CLASS.maxX - 0.014, 1.0, -4.5]} s={[0.028, 0.06, 9]} c={accent} r={0.5} />
      <Box p={[CLASS.maxX - 0.01, 0.5, -4.5]} s={[0.02, 1.0, 9]} c="#d9d2c3" r={0.6} />
    </>
  );
}

function Lights({ boardLit }: { boardLit: boolean }) {
  const spot = useRef<THREE.SpotLight>(null);
  const target = useMemo(() => {
    const o = new THREE.Object3D();
    o.position.set(0, BOARD.y, BOARD.z);
    return o;
  }, []);
  useEffect(() => {
    if (spot.current) spot.current.target = target;
  }, [target]);
  const panels: Array<[number, number]> = [];
  for (const x of [-3.2, 0, 3.2]) for (const z of [-7.0, -4.5, -2.0]) panels.push([x, z]);
  return (
    <>
      {panels.map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, CLASS.h - 0.012, z]}>
          <boxGeometry args={[1.2, 0.025, 0.6]} />
          <meshStandardMaterial color="#ffffff" emissive="#fff6ea" emissiveIntensity={2.4} toneMapped={false} />
        </mesh>
      ))}
      <pointLight position={[-3, 3.0, -5.5]} intensity={6} distance={9} decay={1.6} color="#fff3e2" />
      <pointLight position={[3, 3.0, -5.5]} intensity={6} distance={9} decay={1.6} color="#fff3e2" />
      <pointLight position={[0, 3.0, -2.0]} intensity={5} distance={9} decay={1.6} color="#fff3e2" />
      <primitive object={target} />
      <spotLight ref={spot} position={[0, 3.2, -5.6]} angle={0.62} penumbra={0.7} intensity={boardLit ? 8 : 6} distance={7} decay={1.4} color="#fffaf0" />
      <directionalLight
        position={[-9, 6, -3]}
        intensity={1.2}
        color="#fff1dc"
        castShadow
        shadow-mapSize-width={1024}
        shadow-mapSize-height={1024}
        shadow-camera-left={-8}
        shadow-camera-right={8}
        shadow-camera-top={8}
        shadow-camera-bottom={-8}
        shadow-camera-near={0.5}
        shadow-camera-far={25}
        shadow-bias={-0.0004}
        shadow-normalBias={0.03}
      />
      <hemisphereLight args={['#f4f6ff', '#b8ab96', 0.4]} />
    </>
  );
}

// ───────── whiteboard ─────────

function Whiteboard3D({ lesson, step, loadingTopic }: { lesson: Lesson | null; step: number | 'quiz'; loadingTopic?: string }) {
  const canvas = useMemo(() => {
    const c = document.createElement('canvas');
    c.width = 2048;
    c.height = 1152;
    return c;
  }, []);
  const tex = useMemo(() => {
    const t = new THREE.CanvasTexture(canvas);
    t.colorSpace = THREE.SRGBColorSpace;
    t.anisotropy = 8;
    return t;
  }, [canvas]);
  useEffect(() => () => tex.dispose(), [tex]);
  useEffect(() => {
    let alive = true;
    const draw = () => {
      if (!alive) return;
      paintBoard(canvas, lesson, step, { loadingTopic });
      tex.needsUpdate = true;
    };
    draw();
    void loadHandFont().then(draw);
    return () => {
      alive = false;
    };
  }, [canvas, tex, lesson, step, loadingTopic]);
  const frame = '#b9c0c8';
  return (
    <group position={[0, BOARD.y, BOARD.z]}>
      <mesh position={[0, 0, -0.02]} receiveShadow>
        <boxGeometry args={[BOARD.w + 0.12, BOARD.h + 0.12, 0.04]} />
        <meshStandardMaterial color={frame} metalness={0.8} roughness={0.32} />
      </mesh>
      <mesh position={[0, 0, 0.002]}>
        <planeGeometry args={[BOARD.w, BOARD.h]} />
        <meshStandardMaterial map={tex} emissiveMap={tex} emissive="#ffffff" emissiveIntensity={0.05} roughness={0.32} metalness={0} />
      </mesh>
      {/* marker tray + markers + duster */}
      <mesh position={[0, -BOARD.h / 2 - 0.07, 0.06]} castShadow>
        <boxGeometry args={[BOARD.w * 0.8, 0.03, 0.12]} />
        <meshStandardMaterial color={frame} metalness={0.8} roughness={0.32} />
      </mesh>
      {['#1f4fbf', '#c0392b', '#23804a', '#1f2328'].map((c, i) => (
        <mesh key={c} position={[-0.9 + i * 0.16, -BOARD.h / 2 - 0.042, 0.07]} rotation={[0, 0, Math.PI / 2]} castShadow>
          <cylinderGeometry args={[0.012, 0.012, 0.13, 10]} />
          <meshStandardMaterial color={c} roughness={0.4} />
        </mesh>
      ))}
      <Box p={[0.7, -BOARD.h / 2 - 0.03, 0.07]} s={[0.14, 0.05, 0.06]} c="#2a2d31" r={0.8} cast />
      {/* projector screen casing above the board */}
      <mesh position={[0, BOARD.h / 2 + 0.22, 0.12]} rotation={[0, 0, Math.PI / 2]} castShadow>
        <cylinderGeometry args={[0.06, 0.06, BOARD.w + 0.3, 16]} />
        <meshStandardMaterial color="#e9ebee" roughness={0.4} metalness={0.2} />
      </mesh>
    </group>
  );
}

function Projector() {
  return (
    <group position={[0, CLASS.h, -4.4]}>
      <mesh position={[0, -0.18, 0]}>
        <cylinderGeometry args={[0.02, 0.02, 0.36, 8]} />
        <meshStandardMaterial color="#9aa3ab" metalness={0.8} roughness={0.3} />
      </mesh>
      <Box p={[0, -0.42, 0]} s={[0.42, 0.14, 0.36]} c="#eef0f2" r={0.35} cast />
      <mesh position={[0.1, -0.42, -0.19]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.045, 0.05, 0.04, 20]} />
        <meshStandardMaterial color="#1c2733" roughness={0.1} metalness={0.4} />
      </mesh>
      <mesh position={[-0.13, -0.36, -0.181]}>
        <circleGeometry args={[0.008, 8]} />
        <meshStandardMaterial color="#5cff8a" emissive="#5cff8a" emissiveIntensity={4} toneMapped={false} />
      </mesh>
    </group>
  );
}

// ───────── furniture ─────────

function DeskBench({ x, z }: { x: number; z: number }) {
  const top = '#b98d5f';
  const metal = '#3b4048';
  return (
    <group position={[x, 0, z]}>
      <Box p={[0, DESK.h, 0]} s={[DESK.w, 0.04, DESK.d]} c={top} r={0.45} cast />
      <Box p={[0, DESK.h - 0.2, -DESK.d / 2 + 0.02]} s={[DESK.w - 0.06, 0.36, 0.02]} c="#8f6a45" r={0.55} cast />
      <Box p={[0, DESK.h - 0.12, 0.02]} s={[DESK.w - 0.1, 0.02, DESK.d - 0.1]} c="#8f6a45" r={0.6} />
      {[-1, 1].map((s) => (
        <group key={s}>
          <Box p={[s * (DESK.w / 2 - 0.06), DESK.h / 2, 0]} s={[0.04, DESK.h, DESK.d - 0.04]} c={metal} m={0.6} r={0.4} cast />
          <Box p={[s * (DESK.w / 2 - 0.06), 0.2, BENCH_OFF / 2]} s={[0.04, 0.04, BENCH_OFF + 0.2]} c={metal} m={0.6} r={0.4} />
          <Box p={[s * (DESK.w / 2 - 0.06), 0.22, BENCH_OFF]} s={[0.04, 0.44, 0.3]} c={metal} m={0.6} r={0.4} cast />
        </group>
      ))}
      <Box p={[0, 0.45, BENCH_OFF]} s={[DESK.w, 0.04, 0.32]} c={top} r={0.45} cast />
      {/* notebooks + pens */}
      <Box p={[-0.55, DESK.h + 0.03, 0.04]} s={[0.24, 0.015, 0.32]} c="#f5f3ee" r={0.8} rot={[0, 0.12, 0]} />
      <Box p={[0.62, DESK.h + 0.03, 0.02]} s={[0.22, 0.02, 0.3]} c="#3d6fb0" r={0.7} rot={[0, -0.2, 0]} />
      <mesh position={[-0.4, DESK.h + 0.03, 0.1]} rotation={[0, 0.6, Math.PI / 2]}>
        <cylinderGeometry args={[0.005, 0.005, 0.14, 6]} />
        <meshStandardMaterial color="#1f4fbf" />
      </mesh>
    </group>
  );
}

function Lectern() {
  return (
    <group position={[LECTERN.x, 0, LECTERN.z]} rotation={[0, -0.25, 0]}>
      <Box p={[0, 0.55, 0]} s={[0.6, 1.1, 0.45]} c="#7a5a3c" r={0.5} cast />
      <Box p={[0, 1.13, 0.02]} s={[0.7, 0.05, 0.55]} c="#8f6a45" r={0.45} cast rot={[-0.18, 0, 0]} />
      <Box p={[0, 0.55, 0.229]} s={[0.4, 0.5, 0.01]} c="#1d2f55" r={0.6} />
      {/* laptop */}
      <group position={[0, 1.17, 0.02]} rotation={[-0.18, Math.PI, 0]}>
        <Box p={[0, 0.006, 0]} s={[0.34, 0.012, 0.24]} c="#c8ccd2" m={0.7} r={0.3} />
        <group position={[0, 0.012, 0.12]} rotation={[-1.85, 0, 0]}>
          <Box p={[0, 0, -0.12]} s={[0.34, 0.008, 0.24]} c="#c8ccd2" m={0.7} r={0.3} />
          <mesh position={[0, -0.006, -0.12]} rotation={[Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.31, 0.2]} />
            <meshStandardMaterial color="#9fd3ff" emissive="#6fb3ff" emissiveIntensity={0.9} />
          </mesh>
        </group>
      </group>
      <mesh position={[0.22, 1.25, 0.1]} rotation={[0.4, 0, 0]}>
        <cylinderGeometry args={[0.006, 0.006, 0.2, 6]} />
        <meshStandardMaterial color="#222" />
      </mesh>
    </group>
  );
}

function Poster({ kind, position, rotY }: { kind: 'heart' | 'ecg' | 'neuron' | 'hygiene'; position: [number, number, number]; rotY: number }) {
  const tex = useMemo(() => makePosterTex(kind), [kind]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <Box p={[0, 0, 0]} s={[0.78, 1.08, 0.02]} c="#2a2d31" r={0.4} />
      <mesh position={[0, 0, 0.012]}>
        <planeGeometry args={[0.72, 1.01]} />
        <meshStandardMaterial map={tex} roughness={0.75} />
      </mesh>
    </group>
  );
}

function HallSign() {
  const ready = useSignFontsReady();
  const tex = useMemo(() => {
    const hi = hindiLabel('lecture-hall');
    return canvasTex(768, 150, (g) => {
      g.fillStyle = '#15233c';
      g.fillRect(0, 0, 768, 150);
      g.fillStyle = '#7fd8ff';
      g.fillRect(0, 0, 768, 8);
      g.textAlign = 'center';
      g.fillStyle = '#ffffff';
      g.font = '800 50px Inter, system-ui, sans-serif';
      g.fillText('LECTURE HALL 1', 384, 70, 740);
      if (hi) {
        g.font = '600 38px "Noto Sans Devanagari", "Nirmala UI", sans-serif';
        g.fillStyle = '#cdd7e6';
        g.fillText(`${hi} 1`, 384, 126, 740);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <mesh position={[-4.3, 2.75, CLASS.minZ + 0.012]}>
      <planeGeometry args={[1.9, 0.37]} />
      <meshStandardMaterial map={tex} roughness={0.45} />
    </mesh>
  );
}

const PLANT_URL = '/assets/models/potted_plant_02/potted_plant_02_lod.glb';
const CLOCK_URL = '/assets/models/wall_clock/wall_clock_1k.gltf';

function Decor() {
  const plant = useGLTF(PLANT_URL).scene;
  const clock = useGLTF(CLOCK_URL).scene;
  return (
    <>
      <Clone object={plant} position={[5.55, 0, -8.6]} scale={1.3} />
      <Clone object={plant} position={[-5.55, 0, -0.5]} scale={1.2} />
      <Clone object={clock} position={[0, 2.95, -0.01]} rotation={[0, Math.PI, 0]} scale={1.2} />
      <HallSign />
      <Poster kind="heart" position={[CLASS.maxX - 0.02, 1.75, -6.9]} rotY={-Math.PI / 2} />
      <Poster kind="ecg" position={[CLASS.maxX - 0.02, 1.75, -4.9]} rotY={-Math.PI / 2} />
      <Poster kind="neuron" position={[CLASS.maxX - 0.02, 1.75, -2.9]} rotY={-Math.PI / 2} />
      <Poster kind="hygiene" position={[-3.3, 1.6, -0.02]} rotY={Math.PI} />
      {/* teacher's side table with books + a skeleton-model stand */}
      <group position={[-4.9, 0, -8.55]}>
        <Box p={[0, 0.74, 0]} s={[1.2, 0.04, 0.55]} c="#8f6a45" r={0.45} cast />
        {[-0.55, 0.55].map((x) => (
          <Box key={x} p={[x, 0.37, 0]} s={[0.04, 0.74, 0.5]} c="#3b4048" m={0.6} r={0.4} />
        ))}
        {['#9c2a3a', '#1f4fbf', '#23804a', '#c9932e'].map((c, i) => (
          <Box key={c} p={[-0.35 + i * 0.07, 0.86, -0.08]} s={[0.06, 0.2 + (i % 2) * 0.04, 0.26]} c={c} r={0.7} cast />
        ))}
        {/* model heart on a stand */}
        <mesh position={[0.3, 0.84, 0.02]}>
          <cylinderGeometry args={[0.07, 0.09, 0.16, 16]} />
          <meshStandardMaterial color="#3b4048" roughness={0.4} />
        </mesh>
        <mesh position={[0.3, 0.99, 0.02]} scale={[1, 1.2, 0.9]} castShadow>
          <sphereGeometry args={[0.09, 20, 16]} />
          <meshStandardMaterial color="#b3263a" roughness={0.45} />
        </mesh>
      </group>
      <Text font={FONT_MED} position={[CLASS_DOOR.x, 2.45, -0.02]} rotation={[0, Math.PI, 0]} fontSize={0.09} color="#15233c" anchorX="center" letterSpacing={0.1}>
        EXIT TO CORRIDOR
      </Text>
      <Text font={FONT_HEAVY} position={[3.6, 2.85, CLASS.minZ + 0.012]} fontSize={0.13} color="#15233c" anchorX="center" letterSpacing={0.06}>
        MEDSIM MEDICAL COLLEGE
      </Text>
      <Text font={FONT_BOLD} position={[3.6, 2.66, CLASS.minZ + 0.012]} fontSize={0.075} color="#2f5d8a" anchorX="center" letterSpacing={0.12}>
        DEPARTMENT OF MEDICINE · TEACHER PORTAL
      </Text>
    </>
  );
}

// ───────── people ─────────

const STUDENTS: Array<{ x: number; z: number; age: number; g: 'M' | 'F'; seed: string; coat: boolean }> = [
  { x: -3.35, z: DESK_ROWS[0] + BENCH_OFF, age: 21, g: 'F', seed: 'mbbs-student-1', coat: true },
  { x: 2.15, z: DESK_ROWS[0] + BENCH_OFF, age: 22, g: 'M', seed: 'mbbs-student-2', coat: true },
  { x: -2.15, z: DESK_ROWS[1] + BENCH_OFF, age: 20, g: 'M', seed: 'mbbs-student-3', coat: false },
  { x: 3.35, z: DESK_ROWS[2] + BENCH_OFF, age: 21, g: 'F', seed: 'mbbs-student-4', coat: false },
];

function Student({ x, z, look, runtime }: { x: number; z: number; look: Look; runtime: PlayerRuntime }) {
  const control = useMemo(() => makeControl({ action: 'sit', seatHeight: 0.47 }), []);
  const target = useMemo(() => new THREE.Vector3(TEACHER_SPOT.x, 1.55, TEACHER_SPOT.z), []);
  useFrame(() => {
    // Glance at the doctor when they walk right past, otherwise the teacher.
    const d = Math.hypot(x - runtime.pos.x, z - runtime.pos.z);
    if (d < 1.4) target.set(runtime.pos.x, 1.6, runtime.pos.z);
    else target.set(TEACHER_SPOT.x, 1.55, TEACHER_SPOT.z);
    control.lookAt = target;
  });
  return (
    <group position={[x, 0, z]} rotation={[0, Math.PI, 0]}>
      <HumanCharacter look={look} control={control} />
    </group>
  );
}

function Teacher({ runtime, mouth }: { runtime: PlayerRuntime; mouth: () => number }) {
  const control = useMemo(() => makeControl({ action: 'idle' }), []);
  const head = useMemo(() => new THREE.Vector3(), []);
  const g = useRef<THREE.Group>(null);
  const st = useRef({ yaw: TEACHER_SPOT.yaw });
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    head.set(runtime.pos.x, runtime.seated ? 1.2 : 1.62, runtime.pos.z);
    control.lookAt = head;
    // Turn the body gently toward the doctor (clamped so she stays by the board).
    const want = THREE.MathUtils.clamp(Math.atan2(runtime.pos.x - TEACHER_SPOT.x, runtime.pos.z - TEACHER_SPOT.z), -0.2, 1.1);
    st.current.yaw += (want - st.current.yaw) * Math.min(1, dt * 1.5);
    if (g.current) g.current.rotation.y = st.current.yaw;
  });
  control.mouth = mouth;
  return (
    <group ref={g} position={[TEACHER_SPOT.x, 0, TEACHER_SPOT.z]} rotation={[0, TEACHER_SPOT.yaw, 0]}>
      <HumanCharacter look={TEACHER_LOOK} control={control} />
    </group>
  );
}

// ───────── root ─────────

export function ClassroomWorld({
  runtime,
  lesson,
  step,
  loadingTopic,
  mouth,
}: {
  runtime: PlayerRuntime;
  lesson: Lesson | null;
  step: number | 'quiz';
  loadingTopic?: string;
  mouth: () => number;
}) {
  const students = useMemo(
    () =>
      STUDENTS.map((s) => {
        const base = patientLook(s.age, s.g, s.seed);
        const look: Look = s.coat ? { ...base, top: { color: '#f3f4f6', map: false, roughness: 0.8 }, dupatta: undefined } : base;
        return { ...s, look };
      }),
    [],
  );
  return (
    <>
      <Lights boardLit={!!lesson} />
      <Shell />
      <Whiteboard3D lesson={lesson} step={step} loadingTopic={loadingTopic} />
      <Projector />
      {DESK_ROWS.map((z) => DESK_COLS.map((x) => <DeskBench key={`${x}${z}`} x={x} z={z} />))}
      <Lectern />
      <Decor />
      <Teacher runtime={runtime} mouth={mouth} />
      {students.map((s) => (
        <Student key={s.seed} x={s.x} z={s.z} look={s.look} runtime={runtime} />
      ))}
    </>
  );
}

useGLTF.preload(PLANT_URL);
useGLTF.preload(CLOCK_URL);
