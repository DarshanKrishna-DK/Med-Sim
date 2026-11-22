import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import { Clone, MeshReflectorMaterial, Text, createInstances, useGLTF } from '@react-three/drei';
import * as THREE from 'three';
import {
  BASE_COLLIDERS,
  CEILING_H,
  CORRIDOR_HALF_W,
  DEPARTMENTS,
  DOORS,
  DOOR_SPACING,
  END_Z,
  LOBBY_CEILING_H,
  LOBBY_FRONT_Z,
  LOBBY_HALF_W,
  WINGS,
  wingRange,
  wingStartZ,
  type DoorSpec,
  type WingId,
} from './corridorLayout';
import type { Collider, PlayerRuntime } from './ThirdPersonPlayer';
import { HumanCharacter, makeControl } from './HumanCharacter';
import { hindiLabel, useSignFontsReady } from './hindi';
import { NURSE_LOOK, WARD_ATTENDANT_LOOK, patientLook, type Look } from './rigs';

export const FONT_BOLD = '/assets/fonts/inter-700.woff';
export const FONT_MED = '/assets/fonts/inter-500.woff';
export const FONT_HEAVY = '/assets/fonts/inter-800.woff';

const M = {
  wall: '#c9d0d8',
  wallLobby: '#e2dfd8',
  skirting: '#4a4f57',
  rail: '#b9c3cc',
  railWood: '#a77b52',
  leaf: '#c9a77d',
  leafSoon: '#8c929a',
  frame: '#cfd5dc',
  steel: '#b8bec6',
  navy: '#15233c',
};

// ───────────────────────── procedural textures ─────────────────────────

export function canvasTex(w: number, h: number, draw: (c: CanvasRenderingContext2D) => void, srgb = true) {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  draw(c.getContext('2d')!);
  const t = new THREE.CanvasTexture(c);
  if (srgb) t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

export function makeCeilingTex() {
  return canvasTex(256, 256, (g) => {
    g.fillStyle = '#b6bdc6';
    g.fillRect(0, 0, 256, 256);
    for (let i = 0; i < 2400; i++) {
      const v = 158 + Math.random() * 30;
      g.fillStyle = `rgba(${v - 4},${v},${v + 8},0.55)`;
      g.fillRect(Math.random() * 256, Math.random() * 256, 1.5, 1.5);
    }
    g.fillStyle = '#868e98';
    g.fillRect(0, 0, 256, 5);
    g.fillRect(0, 0, 5, 256);
  });
}

export function makeOutdoorTex() {
  return canvasTex(1024, 512, (g) => {
    const sky = g.createLinearGradient(0, 0, 0, 340);
    sky.addColorStop(0, '#7fb2e6');
    sky.addColorStop(0.7, '#cfe3f3');
    sky.addColorStop(1, '#eef3f2');
    g.fillStyle = sky;
    g.fillRect(0, 0, 1024, 512);
    // soft clouds
    for (let i = 0; i < 14; i++) {
      const x = Math.random() * 1024, y = 40 + Math.random() * 160, r = 40 + Math.random() * 80;
      const cg = g.createRadialGradient(x, y, 0, x, y, r);
      cg.addColorStop(0, 'rgba(255,255,255,0.55)');
      cg.addColorStop(1, 'rgba(255,255,255,0)');
      g.fillStyle = cg;
      g.fillRect(x - r, y - r, r * 2, r * 2);
    }
    // distant buildings
    for (let i = 0; i < 22; i++) {
      const w = 40 + Math.random() * 70, h = 60 + Math.random() * 170, x = i * 48 - 20;
      const shade = 180 + Math.random() * 40;
      g.fillStyle = `rgb(${shade - 20},${shade - 8},${shade + 6})`;
      g.fillRect(x, 340 - h, w, h);
      g.fillStyle = 'rgba(255,255,255,0.25)';
      for (let yy = 340 - h + 8; yy < 330; yy += 14) for (let xx = x + 6; xx < x + w - 8; xx += 12) g.fillRect(xx, yy, 6, 7);
    }
    // tree line + lawn (many small leaf clumps, lit from above)
    g.fillStyle = '#8aa26f';
    g.fillRect(0, 380, 1024, 132);
    for (let i = 0; i < 1400; i++) {
      const x = Math.random() * 1024, y = 300 + Math.random() * 95, r = 4 + Math.random() * 9;
      const lit = (395 - y) / 95;
      g.fillStyle = `rgb(${50 + lit * 50 + Math.random() * 15},${80 + lit * 60 + Math.random() * 20},${45 + lit * 25})`;
      g.beginPath();
      g.arc(x, y, r, 0, Math.PI * 2);
      g.fill();
    }
    // atmospheric softening
    const src = g.canvas;
    const copy = document.createElement('canvas');
    copy.width = src.width;
    copy.height = src.height;
    copy.getContext('2d')!.drawImage(src, 0, 0);
    g.filter = 'blur(2.5px)';
    g.drawImage(copy, 0, 0);
    g.filter = 'none';
  });
}

export function makeArtTex(seed: number) {
  const palettes = [
    ['#2f5d8a', '#8fb7d6', '#e9dcc4', '#d88b5a'],
    ['#3d7a6a', '#a9cdb8', '#f1e7d0', '#c9a24a'],
    ['#6b4f7a', '#c6b3d4', '#f3ece0', '#d7836f'],
    ['#24496b', '#e3c79a', '#f6f1e7', '#7aa5b8'],
  ];
  const p = palettes[seed % palettes.length];
  return canvasTex(256, 320, (g) => {
    g.fillStyle = p[2];
    g.fillRect(0, 0, 256, 320);
    let s = seed * 9301 + 49297;
    const rnd = () => ((s = (s * 9301 + 49297) % 233280) / 233280);
    for (let i = 0; i < 7; i++) {
      g.fillStyle = p[i % 4];
      g.globalAlpha = 0.55 + rnd() * 0.4;
      g.beginPath();
      g.arc(rnd() * 256, rnd() * 320, 30 + rnd() * 90, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.fillStyle = p[0];
    g.fillRect(0, 250 + rnd() * 30, 256, 6);
  });
}

/** Bilingual header above a door (English + Hindi), drawn on a canvas so
 *  Devanagari is shaped by the browser. */
function DoorHeader({ door }: { door: DoorSpec }) {
  const ready = useSignFontsReady();
  const tex = useMemo(() => {
    const hi = hindiLabel(door.dept.id);
    return canvasTex(768, 160, (g) => {
      g.fillStyle = '#15233c';
      g.fillRect(0, 0, 768, 160);
      g.fillStyle = WINGS[door.dept.wing].color;
      g.fillRect(0, 0, 768, 14);
      g.textAlign = 'center';
      g.fillStyle = '#ffffff';
      const en = door.dept.label.toUpperCase();
      g.font = '800 ' + (en.length > 24 ? 40 : en.length > 16 ? 50 : 58) + 'px Inter, system-ui, sans-serif';
      g.fillText(en, 384, hi ? 78 : 106, 744);
      if (hi) {
        g.font = '700 44px "Noto Sans Devanagari", "Nirmala UI", sans-serif';
        g.fillStyle = '#e6edf8';
        g.fillText(hi, 384, 140, 744);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [door, ready]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <mesh position={[0, 2.54, 0.036]}>
      <planeGeometry args={[1.93, 0.4]} />
      <meshStandardMaterial color="#000000" emissive="#ffffff" emissiveMap={tex} emissiveIntensity={0.85} roughness={0.6} toneMapped={false} />
    </mesh>
  );
}

// ───────────────────────── instanced door parts ─────────────────────────

const [RecessI, Recess] = createInstances();
const [JambI, Jamb] = createInstances();
const [HeadI, Head] = createInstances();
const [LeafI, Leaf] = createInstances();
const [KickI, Kick] = createInstances();
const [LeverI, Lever] = createInstances();
const [GlassLitI, GlassLit] = createInstances();
const [GlassDarkI, GlassDark] = createInstances();
const [HeaderI, Header] = createInstances();
const [PlateI, Plate] = createInstances();
const [LedI, Led] = createInstances();
const [DispenserI, Dispenser] = createInstances();
const [RailI, Rail] = createInstances();
const [BracketI, Bracket] = createInstances();
const [PanelI, Panel] = createInstances();
const [WainI, Wain] = createInstances();
const [StripeI, Stripe] = createInstances();
const [WashI, Wash] = createInstances();
const [GlowI, Glow] = createInstances();
const [HeadStripI, HeadStrip] = createInstances();

export interface DoorFx {
  open: number;
  openTarget: number;
  shake: number;
}

function Door({
  door,
  fx,
  onClick,
}: {
  door: DoorSpec;
  fx: DoorFx;
  onClick: (d: DoorSpec) => void;
}) {
  const pivot = useRef<THREE.Group>(null);
  const textGroup = useRef<THREE.Group>(null);
  const { camera } = useThree();
  const built = !!door.dept.clinic || !!door.dept.special;
  const wing = WINGS[door.dept.wing].color;
  const wp = useMemo(() => new THREE.Vector3(door.x, 1.5, door.z), [door]);

  useFrame((_, dt) => {
    fx.open += (fx.openTarget - fx.open) * Math.min(1, dt * 5);
    let r = fx.open * 1.35;
    if (fx.shake > 0) {
      fx.shake = Math.max(0, fx.shake - dt);
      r += Math.sin(fx.shake * 70) * 0.02 * Math.min(1, fx.shake * 2.5);
    }
    if (pivot.current) pivot.current.rotation.y = r;
    if (textGroup.current) textGroup.current.visible = camera.position.distanceToSquared(wp) < 34 * 34;
  });

  return (
    <group position={[door.x, 0, door.z]} rotation={[0, door.rotY, 0]}>
      <Recess position={[0, 1.07, 0.012]} color={built ? '#3b3229' : '#15181d'} />
      <Jamb position={[-0.62, 1.1, 0.05]} color={built ? pale(wing, 0.35) : M.frame} />
      <Jamb position={[0.62, 1.1, 0.05]} color={built ? pale(wing, 0.35) : M.frame} />
      <Glow position={[-0.62, 1.1, 0.108]} color={wing} />
      <Glow position={[0.62, 1.1, 0.108]} color={wing} />
      <HeadStrip position={[0, 2.745, 0.042]} color={wing} />
      {built && <Wash position={[0, 0.012, 0.95]} rotation={[-Math.PI / 2, 0, 0]} color={WASH_COLOR} />}
      <Head position={[0, 2.215, 0.05]} />
      <group ref={pivot} position={[-0.55, 0, 0.055]}>
        <Leaf position={[0.55, 1.055, 0]} color={built ? M.leaf : M.leafSoon} />
        <Kick position={[0.55, 0.14, 0.002]} />
        <Lever position={[0.98, 1.02, 0.045]} />
        <Lever position={[0.98, 1.02, -0.045]} />
        {built ? <GlassLit position={[0.78, 1.45, 0]} /> : <GlassDark position={[0.78, 1.45, 0]} />}
      </group>
      <Header position={[0, 2.54, 0.02]} color="#15233c" />
      <Plate position={[1.07, 1.57, 0.012]} />
      <Led position={[1.31, 1.75, 0.024]} color={built ? '#5dff7a' : '#ffb02e'} />
      <Dispenser position={[-0.95, 1.25, 0.05]} />
      <group ref={textGroup}>
        <DoorHeader door={door} />
        <Text font={FONT_HEAVY} position={[0.82, 1.67, 0.024]} fontSize={0.16} anchorX="left" anchorY="middle" color="#ffffff">
          {door.room}
        </Text>
        <Text
          font={FONT_MED}
          position={[0.82, 1.47, 0.024]}
          fontSize={0.058}
          anchorX="left"
          anchorY="middle"
          color={built ? '#9fe3b0' : '#ffc46b'}
          letterSpacing={0.04}
        >
          {built ? (door.dept.special === 'operation-theatre' ? 'THEATRE OPEN' : door.dept.special ? 'READING ROOM' : 'CLINIC OPEN') : 'COMING SOON'}
        </Text>
      </group>
      {/* click target */}
      <mesh
        position={[0, 1.1, 0.2]}
        onClick={(e) => {
          e.stopPropagation();
          onClick(door);
        }}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        <boxGeometry args={[1.3, 2.2, 0.3]} />
        <meshBasicMaterial visible={false} />
      </mesh>
    </group>
  );
}

const WASH_COLOR = '#ffdca8';
const washTex = canvasTex(128, 128, (g) => {
  const gr = g.createLinearGradient(0, 0, 0, 128);
  gr.addColorStop(0, 'rgba(255,255,255,1)');
  gr.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = gr;
  g.fillRect(0, 0, 128, 128);
  g.globalCompositeOperation = 'destination-out';
  const gx = g.createLinearGradient(0, 0, 128, 0);
  gx.addColorStop(0, 'rgba(0,0,0,1)');
  gx.addColorStop(0.3, 'rgba(0,0,0,0)');
  gx.addColorStop(0.7, 'rgba(0,0,0,0)');
  gx.addColorStop(1, 'rgba(0,0,0,1)');
  g.fillStyle = gx;
  g.fillRect(0, 0, 128, 128);
});

function DoorInstances({ children }: { children: React.ReactNode }) {
  return (
    <RecessI frustumCulled={false} limit={40} receiveShadow>
      <boxGeometry args={[1.18, 2.14, 0.02]} />
      <meshStandardMaterial roughness={0.9} />
      <JambI frustumCulled={false} limit={80} castShadow receiveShadow>
        <boxGeometry args={[0.08, 2.2, 0.1]} />
        <meshStandardMaterial color="#ffffff" metalness={0.3} roughness={0.35} />
        <HeadI frustumCulled={false} limit={40} castShadow>
          <boxGeometry args={[1.32, 0.07, 0.1]} />
          <meshStandardMaterial color={M.frame} metalness={0.5} roughness={0.35} />
          <LeafI frustumCulled={false} limit={40} castShadow receiveShadow>
            <boxGeometry args={[1.1, 2.11, 0.05]} />
            <meshStandardMaterial color="#ffffff" roughness={0.5} metalness={0} />
            <KickI frustumCulled={false} limit={40}>
              <boxGeometry args={[1.06, 0.26, 0.056]} />
              <meshStandardMaterial color={M.steel} metalness={0.85} roughness={0.32} />
              <LeverI frustumCulled={false} limit={80}>
                <boxGeometry args={[0.16, 0.028, 0.035]} />
                <meshStandardMaterial color="#e3e7ea" metalness={1} roughness={0.18} />
                <GlassLitI frustumCulled={false} limit={40}>
                  <boxGeometry args={[0.2, 0.75, 0.056]} />
                  <meshStandardMaterial color="#fff1d6" emissive="#ffd9a0" emissiveIntensity={0.9} roughness={0.1} />
                  <GlassDarkI frustumCulled={false} limit={40}>
                    <boxGeometry args={[0.2, 0.75, 0.056]} />
                    <meshStandardMaterial color="#1c2733" roughness={0.08} metalness={0.2} />
                    <HeaderI frustumCulled={false} limit={40}>
                      <boxGeometry args={[1.95, 0.42, 0.03]} />
                      <meshStandardMaterial roughness={0.45} />
                      <PlateI frustumCulled={false} limit={40}>
                        <boxGeometry args={[0.62, 0.42, 0.02]} />
                        <meshStandardMaterial color={M.navy} roughness={0.4} />
                        <LedI frustumCulled={false} limit={40}>
                          <boxGeometry args={[0.035, 0.035, 0.01]} />
                          <meshBasicMaterial toneMapped={false} />
                          <DispenserI frustumCulled={false} limit={40} castShadow>
                            <boxGeometry args={[0.12, 0.24, 0.09]} />
                            <meshStandardMaterial color="#f3f4f5" roughness={0.35} />
                            <WashI frustumCulled={false} limit={40} renderOrder={2}>
                              <planeGeometry args={[1.9, 1.5]} />
                              <meshBasicMaterial map={washTex} transparent blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} opacity={0.85} />
                              <GlowI frustumCulled={false} limit={80}>
                                <boxGeometry args={[0.03, 2.2, 0.03]} />
                                <meshBasicMaterial toneMapped={false} />
                                <HeadStripI frustumCulled={false} limit={40}>
                                  <boxGeometry args={[1.95, 0.05, 0.03]} />
                                  <meshBasicMaterial toneMapped={false} />
                                  {children}
                                </HeadStripI>
                              </GlowI>
                            </WashI>
                          </DispenserI>
                        </LedI>
                      </PlateI>
                    </HeaderI>
                  </GlassDarkI>
                </GlassLitI>
              </LeverI>
            </KickI>
          </LeafI>
        </HeadI>
      </JambI>
    </RecessI>
  );
}

// ───────────────────────── wall dressing ─────────────────────────

/** Gaps between doors along one wall (handrail / wainscot runs). */
function wallRuns(): Array<{ z0: number; z1: number }> {
  const zs = Array.from(new Set(DOORS.map((d) => d.z))).sort((a, b) => b - a);
  const runs: Array<{ z0: number; z1: number }> = [];
  let start = -0.15;
  for (const z of zs) {
    runs.push({ z0: start, z1: z + 0.7 });
    start = z - 0.7;
  }
  runs.push({ z0: start, z1: END_Z + 0.1 });
  return runs;
}

function wingAt(z: number): WingId {
  if (z > wingStartZ('surgical')) return 'medicine';
  if (z > wingStartZ('diagnostics')) return 'surgical';
  return 'diagnostics';
}

function pale(hex: string, k: number) {
  return '#' + new THREE.Color(hex).lerp(new THREE.Color('#e4e8ee'), k).getHexString();
}

function WallDressing() {
  const runs = useMemo(wallRuns, []);
  const items = useMemo(() => {
    const rails: JSX.Element[] = [];
    const brackets: JSX.Element[] = [];
    const wains: JSX.Element[] = [];
    const stripes: JSX.Element[] = [];
    let k = 0;
    for (const side of [-1, 1]) {
      const wx = side * CORRIDOR_HALF_W;
      for (const r of runs) {
        const len = r.z0 - r.z1;
        if (len < 0.2) continue;
        const zc = (r.z0 + r.z1) / 2;
        const color = WINGS[wingAt(zc)].color;
        rails.push(<Rail key={`r${k}`} position={[wx - side * 0.075, 0.92, zc]} scale={[1, 1, len]} />);
        wains.push(<Wain key={`w${k}`} position={[wx - side * 0.011, 0.5, zc]} scale={[1, 1, len]} color={pale(color, 0.78)} />);
        stripes.push(<Stripe key={`s${k}`} position={[wx - side * 0.012, 1.36, zc]} scale={[1, 1, len]} color={color} />);
        const nb = Math.max(2, Math.round(len / 1.2) + 1);
        for (let i = 0; i < nb; i++) {
          const z = r.z0 - 0.15 - (i * (len - 0.3)) / (nb - 1);
          brackets.push(<Bracket key={`b${k}-${i}`} position={[wx - side * 0.04, 0.88, z]} />);
        }
        k++;
      }
    }
    return { rails, brackets, wains, stripes };
  }, [runs]);

  return (
    <>
      <RailI frustumCulled={false} limit={80} castShadow>
        <boxGeometry args={[0.05, 0.07, 1]} />
        <meshStandardMaterial color={M.railWood} roughness={0.42} />
        {items.rails}
      </RailI>
      <BracketI frustumCulled={false} limit={200}>
        <boxGeometry args={[0.07, 0.05, 0.03]} />
        <meshStandardMaterial color="#d7dbe0" metalness={0.9} roughness={0.25} />
        {items.brackets}
      </BracketI>
      <WainI frustumCulled={false} limit={80} receiveShadow>
        <boxGeometry args={[0.022, 1.0, 1]} />
        <meshStandardMaterial roughness={0.55} />
        {items.wains}
      </WainI>
      <StripeI frustumCulled={false} limit={80}>
        <boxGeometry args={[0.024, 0.11, 1]} />
        <meshBasicMaterial toneMapped={false} />
        {items.stripes}
      </StripeI>
    </>
  );
}

// ───────────────────────── shell (floor, walls, ceiling, lights) ─────────────────────────

const FLOOR_MIN_Z = END_Z - 0.2;
const FLOOR_MAX_Z = LOBBY_FRONT_Z + 0.2;

/** Polished speckled vinyl / terrazzo, 0.6 m tiles (one texture = 2.4 m). */
export function makeFloorTex() {
  return canvasTex(1024, 1024, (g) => {
    g.fillStyle = '#d8d9d5';
    g.fillRect(0, 0, 1024, 1024);
    // slight per-tile tone variation
    for (let ty = 0; ty < 4; ty++)
      for (let tx = 0; tx < 4; tx++) {
        const v = Math.random() * 10 - 5;
        g.fillStyle = `rgba(${128 + v * 8},${128 + v * 8},${128 + v * 7},0.05)`;
        g.fillRect(tx * 256, ty * 256, 256, 256);
      }
    const chips = ['#9aa0a6', '#7d8288', '#b9b6ae', '#eeeeea', '#a59c8e', '#6f7b86', '#c9c4b8'];
    for (let i = 0; i < 26000; i++) {
      g.fillStyle = chips[(Math.random() * chips.length) | 0];
      g.globalAlpha = 0.35 + Math.random() * 0.5;
      const r = Math.random() < 0.92 ? 0.6 + Math.random() * 1.3 : 2 + Math.random() * 2.5;
      g.beginPath();
      g.arc(Math.random() * 1024, Math.random() * 1024, r, 0, Math.PI * 2);
      g.fill();
    }
    g.globalAlpha = 1;
    g.fillStyle = 'rgba(70,74,78,0.55)';
    for (let i = 0; i <= 4; i++) {
      g.fillRect(i * 256 - 1, 0, 2, 1024);
      g.fillRect(0, i * 256 - 1, 1024, 2);
    }
  });
}

function Floor({ reflections }: { reflections: boolean }) {
  const w = LOBBY_HALF_W * 2 + 0.4;
  const d = FLOOR_MAX_Z - FLOOR_MIN_Z;
  const map = useMemo(() => {
    const t = makeFloorTex();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    t.repeat.set(w / 2.4, d / 2.4);
    return t;
  }, [w, d]);
  return (
    <mesh rotation={[-Math.PI / 2, 0, 0]} position={[0, 0, (FLOOR_MIN_Z + FLOOR_MAX_Z) / 2]} receiveShadow>
      <planeGeometry args={[w, d]} />
      {reflections ? (
        <MeshReflectorMaterial
          map={map}
          roughness={0.32}
          color="#ffffff"
          blur={[500, 180]}
          resolution={256}
          mixBlur={1}
          mixStrength={0.55}
          mixContrast={1}
          mirror={0.3}
          depthScale={0}
          metalness={0}
        />
      ) : (
        <meshStandardMaterial map={map} roughness={0.32} color="#ffffff" />
      )}
    </mesh>
  );
}

function Box({
  p,
  s,
  color,
  rough = 0.85,
  metal = 0,
  cast = false,
}: {
  p: [number, number, number];
  s: [number, number, number];
  color: string;
  rough?: number;
  metal?: number;
  cast?: boolean;
}) {
  return (
    <mesh position={p} castShadow={cast} receiveShadow>
      <boxGeometry args={s} />
      <meshStandardMaterial color={color} roughness={rough} metalness={metal} />
    </mesh>
  );
}

const WIN = { halfW: 1.65, y0: 0.45, y1: 2.75 };

function Shell() {
  const ceilTex = useMemo(() => {
    const t = makeCeilingTex();
    t.wrapS = t.wrapT = THREE.RepeatWrapping;
    return t;
  }, []);
  const corrCeil = useMemo(() => {
    const t = ceilTex.clone();
    t.repeat.set((CORRIDOR_HALF_W * 2) / 0.6, -END_Z / 0.6);
    t.needsUpdate = true;
    return t;
  }, [ceilTex]);
  const lobbyCeil = useMemo(() => {
    const t = ceilTex.clone();
    t.repeat.set((LOBBY_HALF_W * 2) / 0.6, LOBBY_FRONT_Z / 0.6);
    t.needsUpdate = true;
    return t;
  }, [ceilTex]);
  const outdoor = useMemo(makeOutdoorTex, []);
  const L = -END_Z;

  return (
    <>
      {/* corridor side walls */}
      <Box p={[-CORRIDOR_HALF_W - 0.1, CEILING_H / 2, END_Z / 2]} s={[0.2, CEILING_H, L]} color={M.wall} />
      <Box p={[CORRIDOR_HALF_W + 0.1, CEILING_H / 2, END_Z / 2]} s={[0.2, CEILING_H, L]} color={M.wall} />
      {/* skirting */}
      <Box p={[-CORRIDOR_HALF_W + 0.008, 0.06, END_Z / 2]} s={[0.016, 0.12, L]} color={M.skirting} rough={0.5} />
      <Box p={[CORRIDOR_HALF_W - 0.008, 0.06, END_Z / 2]} s={[0.016, 0.12, L]} color={M.skirting} rough={0.5} />
      {/* wing-coloured floor guide lines along both walls */}
      {(['medicine', 'surgical', 'diagnostics'] as WingId[]).map((w) => {
        const z0 = w === 'medicine' ? -0.15 : wingStartZ(w);
        const z1 = w === 'diagnostics' ? END_Z : w === 'medicine' ? wingStartZ('surgical') : wingStartZ('diagnostics');
        return [-1, 1].map((side) => (
          <mesh key={w + side} position={[side * (CORRIDOR_HALF_W - 0.22), 0.006, (z0 + z1) / 2]} rotation={[-Math.PI / 2, 0, 0]}>
            <planeGeometry args={[0.07, z0 - z1]} />
            <meshBasicMaterial color={WINGS[w].color} toneMapped={false} />
          </mesh>
        ));
      })}
      {/* corridor ceiling */}
      <mesh position={[0, CEILING_H, END_Z / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[CORRIDOR_HALF_W * 2, L]} />
        <meshStandardMaterial map={corrCeil} roughness={1} color="#e4e8ed" />
      </mesh>

      {/* end wall with a full-width window */}
      <group position={[0, 0, END_Z]}>
        <Box p={[-(CORRIDOR_HALF_W + WIN.halfW) / 2, CEILING_H / 2, -0.1]} s={[CORRIDOR_HALF_W - WIN.halfW, CEILING_H, 0.2]} color={M.wall} />
        <Box p={[(CORRIDOR_HALF_W + WIN.halfW) / 2, CEILING_H / 2, -0.1]} s={[CORRIDOR_HALF_W - WIN.halfW, CEILING_H, 0.2]} color={M.wall} />
        <Box p={[0, WIN.y0 / 2, -0.1]} s={[WIN.halfW * 2, WIN.y0, 0.2]} color={M.wall} />
        <Box p={[0, (WIN.y1 + CEILING_H) / 2, -0.1]} s={[WIN.halfW * 2, CEILING_H - WIN.y1, 0.2]} color={M.wall} />
        {/* sill + mullions */}
        <Box p={[0, WIN.y0 + 0.02, 0.04]} s={[WIN.halfW * 2 + 0.1, 0.04, 0.22]} color="#f0f0ee" rough={0.4} />
        {[-WIN.halfW, -WIN.halfW / 3, WIN.halfW / 3, WIN.halfW].map((x, i) => (
          <Box key={i} p={[x, (WIN.y0 + WIN.y1) / 2, -0.05]} s={[0.06, WIN.y1 - WIN.y0, 0.08]} color="#9aa3ab" metal={0.7} rough={0.3} />
        ))}
        <Box p={[0, 1.65, -0.05]} s={[WIN.halfW * 2, 0.05, 0.08]} color="#9aa3ab" metal={0.7} rough={0.3} />
        <mesh position={[0, (WIN.y0 + WIN.y1) / 2, -0.08]}>
          <planeGeometry args={[WIN.halfW * 2, WIN.y1 - WIN.y0]} />
          <meshStandardMaterial color="#d9ecf5" transparent opacity={0.12} roughness={0.02} metalness={0.1} depthWrite={false} />
        </mesh>
        <mesh position={[0, 1.4, -6]}>
          <planeGeometry args={[26, 13]} />
          <meshBasicMaterial map={outdoor} toneMapped={false} color="#ffffff" />
        </mesh>
      </group>

      {/* lobby */}
      <Box p={[-(LOBBY_HALF_W + CORRIDOR_HALF_W) / 2, LOBBY_CEILING_H / 2, -0.1]} s={[LOBBY_HALF_W - CORRIDOR_HALF_W, LOBBY_CEILING_H, 0.2]} color={M.wallLobby} />
      <Box p={[(LOBBY_HALF_W + CORRIDOR_HALF_W) / 2, LOBBY_CEILING_H / 2, -0.1]} s={[LOBBY_HALF_W - CORRIDOR_HALF_W, LOBBY_CEILING_H, 0.2]} color={M.wallLobby} />
      <Box p={[0, (CEILING_H + LOBBY_CEILING_H) / 2, -0.1]} s={[CORRIDOR_HALF_W * 2 + 0.4, LOBBY_CEILING_H - CEILING_H, 0.2]} color={M.wallLobby} />
      <Box p={[-LOBBY_HALF_W - 0.1, LOBBY_CEILING_H / 2, LOBBY_FRONT_Z / 2]} s={[0.2, LOBBY_CEILING_H, LOBBY_FRONT_Z]} color={M.wallLobby} />
      <Box p={[LOBBY_HALF_W + 0.1, LOBBY_CEILING_H / 2, LOBBY_FRONT_Z / 2]} s={[0.2, LOBBY_CEILING_H, LOBBY_FRONT_Z]} color={M.wallLobby} />
      {/* lobby wood accent wall panels (lower) */}
      <Box p={[-LOBBY_HALF_W + 0.015, 0.6, LOBBY_FRONT_Z / 2]} s={[0.03, 1.2, LOBBY_FRONT_Z]} color="#b48a5e" rough={0.5} />
      <Box p={[LOBBY_HALF_W - 0.015, 0.6, LOBBY_FRONT_Z / 2]} s={[0.03, 1.2, LOBBY_FRONT_Z]} color="#b48a5e" rough={0.5} />
      {/* entrance: glazed front wall */}
      <group position={[0, 0, LOBBY_FRONT_Z]}>
        <Box p={[0, LOBBY_CEILING_H - 0.3, 0.1]} s={[LOBBY_HALF_W * 2, 0.6, 0.2]} color={M.wallLobby} />
        {Array.from({ length: 8 }, (_, i) => -LOBBY_HALF_W + (i * LOBBY_HALF_W * 2) / 7).map((x, i) => (
          <Box key={i} p={[x, (LOBBY_CEILING_H - 0.6) / 2, 0.05]} s={[0.08, LOBBY_CEILING_H - 0.6, 0.12]} color="#8e979f" metal={0.7} rough={0.3} />
        ))}
        <Box p={[0, 2.4, 0.05]} s={[LOBBY_HALF_W * 2, 0.06, 0.1]} color="#8e979f" metal={0.7} rough={0.3} />
        <mesh position={[0, (LOBBY_CEILING_H - 0.6) / 2, 0.06]}>
          <planeGeometry args={[LOBBY_HALF_W * 2, LOBBY_CEILING_H - 0.6]} />
          <meshStandardMaterial color="#d9ecf5" transparent opacity={0.1} roughness={0.02} depthWrite={false} />
        </mesh>
        <mesh position={[0, 3, 9]} rotation={[0, Math.PI, 0]}>
          <planeGeometry args={[60, 22]} />
          <meshBasicMaterial map={outdoor} toneMapped={false} />
        </mesh>
      </group>
      <mesh position={[0, LOBBY_CEILING_H, LOBBY_FRONT_Z / 2]} rotation={[Math.PI / 2, 0, 0]}>
        <planeGeometry args={[LOBBY_HALF_W * 2, LOBBY_FRONT_Z]} />
        <meshStandardMaterial map={lobbyCeil} roughness={1} color="#ffffff" />
      </mesh>
    </>
  );
}

/** Light-panel anchors: one per door pair along the corridor + a lobby grid. */
const PANEL_POS: Array<[number, number, number]> = (() => {
  const out: Array<[number, number, number]> = [];
  for (let z = -1.4; z > END_Z + 0.8; z -= DOOR_SPACING / 2) out.push([0, CEILING_H - 0.012, z]);
  for (const x of [-4.2, 0, 4.2]) for (const z of [2.2, 5.6, 9]) out.push([x, LOBBY_CEILING_H - 0.012, z]);
  return out;
})();

function CeilingPanels() {
  return (
    <PanelI frustumCulled={false} limit={PANEL_POS.length}>
      <boxGeometry args={[1.2, 0.025, 0.6]} />
      <meshStandardMaterial color="#ffffff" emissive="#fff6ea" emissiveIntensity={1.3} toneMapped={false} />
      {PANEL_POS.map((p, i) => (
        <Panel key={i} position={p} />
      ))}
    </PanelI>
  );
}

/** A small pool of point lights hopped to the light panels nearest the
 *  player: real falloff where it matters, constant shader cost. */
function LightPool({ runtime, count = 4 }: { runtime: PlayerRuntime; count?: number }) {
  const refs = useRef<Array<THREE.PointLight | null>>([]);
  const anchors = useMemo(() => PANEL_POS.map((p) => new THREE.Vector3(p[0], p[1] > 3.5 ? p[1] - 1.1 : 2.1, p[2])), []);
  useFrame(() => {
    const pos = runtime.pos;
    const sorted = anchors
      .map((a, i) => ({ i, d: (a.x - pos.x) ** 2 + (a.z - pos.z) ** 2 }))
      .sort((a, b) => a.d - b.d)
      .slice(0, count);
    sorted.forEach((s, k) => {
      const l = refs.current[k];
      if (l) l.position.copy(anchors[s.i]);
    });
  });
  return (
    <>
      {Array.from({ length: count }, (_, i) => (
        <pointLight key={i} ref={(l) => (refs.current[i] = l)} intensity={4.5} distance={9} decay={2} color="#fff3e2" />
      ))}
    </>
  );
}

/** Shadow-casting key light that follows the player (tight frustum). */
function FollowSun({ runtime }: { runtime: PlayerRuntime }) {
  const light = useRef<THREE.DirectionalLight>(null);
  const { scene } = useThree();
  useEffect(() => {
    if (light.current) scene.add(light.current.target);
  }, [scene]);
  useFrame(() => {
    const l = light.current;
    if (!l) return;
    const p = runtime.pos;
    l.position.set(p.x + 1.5, 6, p.z + 2.5);
    l.target.position.set(p.x, 0, p.z);
    l.target.updateMatrixWorld();
  });
  return (
    <directionalLight
      ref={light}
      intensity={0.6}
      color="#fff4e6"
      castShadow
      shadow-mapSize-width={1024}
      shadow-mapSize-height={1024}
      shadow-camera-left={-7}
      shadow-camera-right={7}
      shadow-camera-top={7}
      shadow-camera-bottom={-7}
      shadow-camera-near={0.5}
      shadow-camera-far={16}
      shadow-bias={-0.0004}
      shadow-normalBias={0.03}
    />
  );
}

// ───────────────────────── signage ─────────────────────────

function HangingSign({ z, lines }: { z: number; lines: Array<{ text: string; color: string }> }) {
  const big = lines.length === 1;
  const lh = big ? 0.26 : 0.2;
  const h = 0.16 + lines.length * lh;
  const drop = 0.1;
  const y = CEILING_H - drop - h / 2;
  const face = (rot: number) => (
    <group rotation={[0, rot, 0]}>
      {lines.map((l, i) => (
        <group key={i} position={[0, h / 2 - 0.08 - lh / 2 - i * lh, 0.031]}>
          <mesh position={[-1.58, 0, 0]}>
            <planeGeometry args={[0.1, lh * 0.8]} />
            <meshBasicMaterial color={l.color} toneMapped={false} />
          </mesh>
          <Text font={FONT_HEAVY} position={[-1.46, 0, 0]} fontSize={big ? 0.14 : 0.125} anchorX="left" anchorY="middle" color="#ffffff" letterSpacing={0.02}>
            {l.text}
          </Text>
        </group>
      ))}
    </group>
  );
  return (
    <group position={[0, y, z]}>
      {[-1.4, 1.4].map((x) => (
        <mesh key={x} position={[x, h / 2 + drop / 2, 0]}>
          <cylinderGeometry args={[0.008, 0.008, drop]} />
          <meshStandardMaterial color="#9aa1a8" metalness={0.9} roughness={0.3} />
        </mesh>
      ))}
      <mesh castShadow>
        <boxGeometry args={[3.4, h, 0.05]} />
        <meshStandardMaterial color={M.navy} emissive="#1d3257" emissiveIntensity={0.9} roughness={0.5} />
      </mesh>
      {face(0)}
      {face(Math.PI)}
    </group>
  );
}

function wingLines(): Array<{ text: string; color: string }> {
  return (Object.keys(WINGS) as WingId[]).map((w) => ({
    text: `${WINGS[w].label}  ${wingRange(w)}`,
    color: WINGS[w].color,
  }));
}

function Directory({ position, rotY }: { position: [number, number, number]; rotY: number }) {
  const cols = (Object.keys(WINGS) as WingId[]).map((w) => ({
    w,
    text: DOORS.filter((d) => d.dept.wing === w)
      .map((d) => `${d.room}  ${d.dept.label}${d.dept.clinic || d.dept.special ? '' : '  · soon'}`)
      .join('\n'),
  }));
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <Box p={[0, 1.2, 0]} s={[2.5, 2.4, 0.12]} color={M.navy} rough={0.35} cast />
      <Box p={[0, 0.03, 0]} s={[2.7, 0.06, 0.5]} color="#30363e" metal={0.6} rough={0.35} />
      <Text font={FONT_HEAVY} position={[-1.12, 2.22, 0.065]} fontSize={0.13} anchorX="left" anchorY="middle" color="#ffffff" letterSpacing={0.06}>
        FLOOR DIRECTORY · LEVEL 1
      </Text>
      <mesh position={[0, 2.08, 0.065]}>
        <planeGeometry args={[2.25, 0.008]} />
        <meshBasicMaterial color="#a8e27c" toneMapped={false} />
      </mesh>
      {cols.map((c, i) => (
        <group key={c.w} position={[-1.12 + i * 0.78, 1.96, 0.065]}>
          <mesh position={[0.035, 0, 0]}>
            <planeGeometry args={[0.07, 0.07]} />
            <meshBasicMaterial color={WINGS[c.w].color} toneMapped={false} />
          </mesh>
          <Text font={FONT_BOLD} position={[0.1, 0, 0]} fontSize={0.05} maxWidth={0.62} anchorX="left" anchorY="middle" color="#ffffff">
            {WINGS[c.w].label.toUpperCase()}
          </Text>
          <Text font={FONT_MED} position={[0, -0.1, 0]} fontSize={0.04} lineHeight={1.45} anchorX="left" anchorY="top" color="#cdd7e6">
            {c.text}
          </Text>
        </group>
      ))}
      <Text font={FONT_MED} position={[-1.12, 0.32, 0.065]} fontSize={0.05} anchorX="left" anchorY="middle" color="#a8e27c" letterSpacing={0.06}>
        YOU ARE HERE · MAIN LOBBY
      </Text>
    </group>
  );
}

// ───────────────────────── props ─────────────────────────

const MODELS = {
  plant: '/assets/models/potted_plant_02/potted_plant_02_lod.glb',
  wheelchair: '/assets/models/wheelchair_01/wheelchair_01_lod.glb',
  extinguisher: '/assets/models/korean_fire_extinguisher_01/korean_fire_extinguisher_01_lod.glb',
  clock: '/assets/models/wall_clock/wall_clock_1k.gltf',
  chair: '/assets/models/plastic_monobloc_chair_01/plastic_monobloc_chair_01_1k.gltf',
};

function useShadowed(url: string, cast = true) {
  const g = useGLTF(url);
  useMemo(() => {
    g.scene.traverse((o) => {
      const m = o as THREE.Mesh;
      if (m.isMesh) {
        m.castShadow = cast;
        m.receiveShadow = true;
      }
    });
  }, [g.scene, cast]);
  return g.scene;
}

function Bench({ position, rotY = 0, seats = 3 }: { position: [number, number, number]; rotY?: number; seats?: number }) {
  const w = seats * 0.62;
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      {Array.from({ length: seats }, (_, i) => {
        const x = -w / 2 + 0.31 + i * 0.62;
        return (
          <group key={i} position={[x, 0, 0]}>
            <mesh position={[0, 0.45, 0]} castShadow receiveShadow>
              <boxGeometry args={[0.56, 0.07, 0.5]} />
              <meshStandardMaterial color="#2f5f8f" roughness={0.6} />
            </mesh>
            <mesh position={[0, 0.78, -0.24]} rotation={[-0.12, 0, 0]} castShadow>
              <boxGeometry args={[0.56, 0.48, 0.06]} />
              <meshStandardMaterial color="#2f5f8f" roughness={0.6} />
            </mesh>
          </group>
        );
      })}
      <mesh position={[0, 0.39, 0]} castShadow>
        <boxGeometry args={[w, 0.04, 0.08]} />
        <meshStandardMaterial color="#aab2ba" metalness={0.9} roughness={0.3} />
      </mesh>
      {[-w / 2 + 0.08, w / 2 - 0.08].map((x) => (
        <group key={x} position={[x, 0, 0]}>
          <mesh position={[0, 0.2, 0]} castShadow>
            <boxGeometry args={[0.05, 0.4, 0.05]} />
            <meshStandardMaterial color="#aab2ba" metalness={0.9} roughness={0.3} />
          </mesh>
          <mesh position={[0, 0.02, 0]}>
            <boxGeometry args={[0.07, 0.04, 0.5]} />
            <meshStandardMaterial color="#aab2ba" metalness={0.9} roughness={0.3} />
          </mesh>
        </group>
      ))}
    </group>
  );
}

function IVStand({ position }: { position: [number, number, number] }) {
  return (
    <group position={position}>
      {Array.from({ length: 5 }, (_, i) => (
        <group key={i} rotation={[0, (i / 5) * Math.PI * 2, 0]}>
          <mesh position={[0.16, 0.05, 0]} rotation={[0, 0, 0.12]}>
            <boxGeometry args={[0.32, 0.02, 0.025]} />
            <meshStandardMaterial color="#c8cdd2" metalness={0.9} roughness={0.25} />
          </mesh>
          <mesh position={[0.31, 0.03, 0]}>
            <sphereGeometry args={[0.028, 10, 8]} />
            <meshStandardMaterial color="#2b2f35" roughness={0.6} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, 1.05, 0]} castShadow>
        <cylinderGeometry args={[0.012, 0.014, 2.0, 10]} />
        <meshStandardMaterial color="#d6dade" metalness={0.95} roughness={0.2} />
      </mesh>
      <mesh position={[0, 2.03, 0]} rotation={[0, 0, Math.PI / 2]}>
        <cylinderGeometry args={[0.008, 0.008, 0.36, 8]} />
        <meshStandardMaterial color="#d6dade" metalness={0.95} roughness={0.2} />
      </mesh>
      <mesh position={[0.14, 1.86, 0]} castShadow>
        <boxGeometry args={[0.12, 0.2, 0.04]} />
        <meshStandardMaterial color="#e8f2f6" transparent opacity={0.75} roughness={0.15} />
      </mesh>
      <mesh position={[0.14, 1.3, 0]}>
        <cylinderGeometry args={[0.002, 0.002, 0.95, 4]} />
        <meshStandardMaterial color="#e8eef2" />
      </mesh>
    </group>
  );
}

function SupplyCart({ position, rotY = 0, color = '#3f7cc4' }: { position: [number, number, number]; rotY?: number; color?: string }) {
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <mesh position={[0, 0.55, 0]} castShadow receiveShadow>
        <boxGeometry args={[0.75, 0.85, 0.5]} />
        <meshStandardMaterial color="#e9ecef" roughness={0.4} />
      </mesh>
      {[0.3, 0.52, 0.74].map((y) => (
        <mesh key={y} position={[0, y, 0.252]}>
          <boxGeometry args={[0.68, 0.17, 0.01]} />
          <meshStandardMaterial color={color} roughness={0.45} />
        </mesh>
      ))}
      <mesh position={[0, 1.0, 0]} castShadow>
        <boxGeometry args={[0.8, 0.04, 0.55]} />
        <meshStandardMaterial color="#cfd4d9" roughness={0.3} metalness={0.4} />
      </mesh>
      <mesh position={[0.43, 0.9, 0]} rotation={[Math.PI / 2, 0, 0]}>
        <cylinderGeometry args={[0.012, 0.012, 0.45, 8]} />
        <meshStandardMaterial color="#d6dade" metalness={0.95} roughness={0.2} />
      </mesh>
      {[[-0.3, -0.2], [0.3, -0.2], [-0.3, 0.2], [0.3, 0.2]].map(([x, z]) => (
        <mesh key={`${x}${z}`} position={[x, 0.05, z]} rotation={[0, 0, Math.PI / 2]}>
          <cylinderGeometry args={[0.05, 0.05, 0.03, 12]} />
          <meshStandardMaterial color="#25282d" roughness={0.7} />
        </mesh>
      ))}
    </group>
  );
}

function WallArt({ position, rotY, seed }: { position: [number, number, number]; rotY: number; seed: number }) {
  const tex = useMemo(() => makeArtTex(seed), [seed]);
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <mesh castShadow>
        <boxGeometry args={[0.66, 0.82, 0.03]} />
        <meshStandardMaterial color="#2a2d31" roughness={0.4} />
      </mesh>
      <mesh position={[0, 0, 0.016]}>
        <planeGeometry args={[0.56, 0.72]} />
        <meshStandardMaterial map={tex} roughness={0.7} />
      </mesh>
    </group>
  );
}

function ReceptionDesk({ position, rotY }: { position: [number, number, number]; rotY: number }) {
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <Box p={[0, 0.55, 0]} s={[3.2, 1.1, 0.7]} color="#f2efe9" rough={0.35} cast />
      <Box p={[0, 1.13, 0.08]} s={[3.3, 0.05, 0.9]} color="#b48a5e" rough={0.4} cast />
      <Box p={[0, 0.45, 0.352]} s={[3.0, 0.5, 0.01]} color="#3f7cc4" rough={0.4} />
      <Box p={[0, 0.78, -0.2]} s={[3.1, 0.04, 0.4]} color="#d9d4ca" rough={0.5} />
      {/* monitors */}
      {[-0.8, 0.6].map((x) => (
        <group key={x} position={[x, 1.16, -0.15]}>
          <Box p={[0, 0.22, 0]} s={[0.5, 0.32, 0.03]} color="#15181c" rough={0.3} cast />
          <Box p={[0, 0.06, 0.05]} s={[0.05, 0.12, 0.05]} color="#2a2d31" rough={0.4} />
        </group>
      ))}
    </group>
  );
}

function Planter({ position, scale = 1.3 }: { position: [number, number, number]; scale?: number }) {
  const plant = useShadowed(MODELS.plant, false);
  return <Clone object={plant} position={position} scale={scale} />;
}

function Props() {
  const wheelchair = useShadowed(MODELS.wheelchair);
  const ext = useShadowed(MODELS.extinguisher);
  const clock = useShadowed(MODELS.clock);
  const chair = useShadowed(MODELS.chair);

  return (
    <>
      {/* ── lobby ── */}
      <ReceptionDesk position={[-4.6, 0, 4.6]} rotY={Math.PI / 2} />
      <Text font={FONT_HEAVY} position={[-LOBBY_HALF_W + 0.02, 3.1, 4.6]} rotation={[0, Math.PI / 2, 0]} fontSize={0.42} anchorX="center" anchorY="middle" color="#15233c" letterSpacing={0.04}>
        MEDSIM GENERAL HOSPITAL
      </Text>
      <Text font={FONT_MED} position={[-LOBBY_HALF_W + 0.02, 2.62, 4.6]} rotation={[0, Math.PI / 2, 0]} fontSize={0.16} anchorX="center" anchorY="middle" color="#3f7cc4" letterSpacing={0.18}>
        OUTPATIENT CLINICS · RECEPTION
      </Text>
      <Directory position={[3.1, 0, 1.6]} rotY={-0.5} />
      <Bench position={[5.0, 0, 5.0]} rotY={-Math.PI / 2} seats={4} />
      <Bench position={[5.0, 0, 8.2]} rotY={-Math.PI / 2} seats={4} />
      <Bench position={[3.0, 0, 6.6]} rotY={Math.PI / 2} seats={4} />
      <Planter position={[6.3, 0, 0.7]} />
      <Planter position={[-6.3, 0, 0.7]} />
      <Planter position={[6.3, 0, 10.2]} />
      <Planter position={[-6.3, 0, 10.2]} />
      <Clone object={wheelchair} position={[-5.8, 0, 8.6]} rotation={[0, 2.2, 0]} />
      <Clone object={wheelchair} position={[-5.1, 0, 9.3]} rotation={[0, 2.5, 0]} />
      <Clone object={clock} position={[0, 3.55, 0.01]} scale={1.4} />
      {[0, 1, 2].map((i) => (
        <Clone key={i} object={chair} position={[-3.1, 0, 6.8 + i * 0.7]} rotation={[0, -Math.PI / 2, 0]} />
      ))}

      {/* ── corridor ── */}
      <HangingSign z={-0.9} lines={wingLines()} />
      <HangingSign z={wingStartZ('surgical') + 0.4} lines={[{ text: `${WINGS.surgical.label}  ${wingRange('surgical')}`, color: WINGS.surgical.color }]} />
      <HangingSign z={wingStartZ('diagnostics') + 0.4} lines={[{ text: `${WINGS.diagnostics.label}  ${wingRange('diagnostics')}`, color: WINGS.diagnostics.color }]} />

      <Bench position={[-CORRIDOR_HALF_W + 0.32, 0, -5.0]} rotY={Math.PI / 2} />
      <Bench position={[CORRIDOR_HALF_W - 0.32, 0, -12.2]} rotY={-Math.PI / 2} />
      <Bench position={[-CORRIDOR_HALF_W + 0.32, 0, -19.4]} rotY={Math.PI / 2} />
      <Bench position={[CORRIDOR_HALF_W - 0.32, 0, -33.8]} rotY={-Math.PI / 2} />
      <Bench position={[-CORRIDOR_HALF_W + 0.32, 0, -41.0]} rotY={Math.PI / 2} />
      <Bench position={[CORRIDOR_HALF_W - 0.32, 0, -55.4]} rotY={-Math.PI / 2} />
      <Planter position={[CORRIDOR_HALF_W - 0.35, 0, -5.0]} scale={1.15} />
      <Planter position={[CORRIDOR_HALF_W - 0.35, 0, -48.2]} scale={1.15} />
      <Planter position={[-CORRIDOR_HALF_W + 0.4, 0, END_Z + 0.5]} scale={1.3} />
      <Planter position={[CORRIDOR_HALF_W - 0.4, 0, END_Z + 0.5]} scale={1.3} />
      <Clone object={wheelchair} position={[CORRIDOR_HALF_W - 0.45, 0, -26.5]} rotation={[0, -2.0, 0]} />
      <IVStand position={[-CORRIDOR_HALF_W + 0.3, 0, -12.3]} />
      <IVStand position={[CORRIDOR_HALF_W - 0.3, 0, -41.2]} />
      <SupplyCart position={[CORRIDOR_HALF_W - 0.35, 0, -19.3]} rotY={-Math.PI / 2} />
      <SupplyCart position={[-CORRIDOR_HALF_W + 0.35, 0, -48.3]} rotY={Math.PI / 2} color="#2f9c8a" />
      {[-8.6, -30.2, -51.8].map((z, i) => (
        <group key={z} position={[i % 2 ? CORRIDOR_HALF_W - 0.08 : -CORRIDOR_HALF_W + 0.08, 0, z]} rotation={[0, i % 2 ? -Math.PI / 2 : Math.PI / 2, 0]}>
          <Clone object={ext} position={[0, 0.0, 0.08]} />
          <mesh position={[0, 1.75, 0]}>
            <boxGeometry args={[0.3, 0.2, 0.02]} />
            <meshStandardMaterial color="#c8302c" roughness={0.5} />
          </mesh>
        </group>
      ))}
      <WallArt position={[-CORRIDOR_HALF_W + 0.02, 1.7, -15.8]} rotY={Math.PI / 2} seed={1} />
      <WallArt position={[CORRIDOR_HALF_W - 0.02, 1.7, -23.0]} rotY={-Math.PI / 2} seed={2} />
      <WallArt position={[-CORRIDOR_HALF_W + 0.02, 1.7, -37.4]} rotY={Math.PI / 2} seed={3} />
      <WallArt position={[CORRIDOR_HALF_W - 0.02, 1.7, -44.6]} rotY={-Math.PI / 2} seed={4} />
      <WallArt position={[-LOBBY_HALF_W + 0.02, 1.9, 8.6]} rotY={Math.PI / 2} seed={5} />
      <Clone object={clock} position={[0, 2.62, END_Z + 0.02]} />
    </>
  );
}

/** Obstacles from the props (keeps the doctor out of benches, desk, carts). */
export const PROP_COLLIDERS: Collider[] = [
  { x: -4.6, z: 4.6, w: 0.9, d: 3.4, h: 1.2 },
  { x: 3.15, z: 1.6, w: 2.2, d: 1.2, h: 2.4 },
  { x: 5.0, z: 5.0, w: 0.6, d: 2.6, h: 1.0 },
  { x: 5.0, z: 8.2, w: 0.6, d: 2.6, h: 1.0 },
  { x: 3.0, z: 6.6, w: 0.6, d: 2.6, h: 1.0 },
  { x: -CORRIDOR_HALF_W + 0.32, z: -5.0, w: 0.55, d: 1.9, h: 1.0 },
  { x: CORRIDOR_HALF_W - 0.32, z: -12.2, w: 0.55, d: 1.9, h: 1.0 },
  { x: -CORRIDOR_HALF_W + 0.32, z: -19.4, w: 0.55, d: 1.9, h: 1.0 },
  { x: CORRIDOR_HALF_W - 0.32, z: -33.8, w: 0.55, d: 1.9, h: 1.0 },
  { x: -CORRIDOR_HALF_W + 0.32, z: -41.0, w: 0.55, d: 1.9, h: 1.0 },
  { x: CORRIDOR_HALF_W - 0.32, z: -55.4, w: 0.55, d: 1.9, h: 1.0 },
  { x: CORRIDOR_HALF_W - 0.35, z: -19.3, w: 0.55, d: 0.8, h: 1.0 },
  { x: -CORRIDOR_HALF_W + 0.35, z: -48.3, w: 0.55, d: 0.8, h: 1.0 },
  { x: CORRIDOR_HALF_W - 0.45, z: -26.5, w: 0.8, d: 0.8, h: 1.0 },
  { x: -5.4, z: 8.9, w: 1.6, d: 1.6, h: 1.0 },
  { x: -3.1, z: 6.8, w: 0.6, d: 2.2, h: 0.9 },
];

export const CORRIDOR_COLLIDERS: Collider[] = [...BASE_COLLIDERS, ...PROP_COLLIDERS];

// ───────────────────────── NPCs ─────────────────────────

function PatrolNpc({ look, a, b, speed = 1.25, runtime }: { look: Look; a: [number, number]; b: [number, number]; speed?: number; runtime: PlayerRuntime }) {
  const g = useRef<THREE.Group>(null);
  const control = useMemo(() => makeControl({ action: 'walk', speed }), [speed]);
  const st = useRef({ t: 0, dir: 1, pause: 0, yaw: 0 });
  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.1);
    const s = st.current;
    const len = Math.hypot(b[0] - a[0], b[1] - a[1]);
    // yield to the player
    const gp = g.current?.position;
    const near = gp ? Math.hypot(gp.x - runtime.pos.x, gp.z - runtime.pos.z) < 1.1 : false;
    if (s.pause > 0 || near) {
      s.pause = Math.max(0, s.pause - dt);
      control.action = 'idle';
      control.speed = 0;
    } else {
      control.action = 'walk';
      control.speed = speed;
      s.t += (s.dir * speed * dt) / len;
      if (s.t >= 1 || s.t <= 0) {
        s.t = THREE.MathUtils.clamp(s.t, 0, 1);
        s.dir *= -1;
        s.pause = 1.5;
      }
    }
    const x = a[0] + (b[0] - a[0]) * s.t;
    const z = a[1] + (b[1] - a[1]) * s.t;
    const wantYaw = Math.atan2((b[0] - a[0]) * s.dir, (b[1] - a[1]) * s.dir);
    s.yaw += Math.atan2(Math.sin(wantYaw - s.yaw), Math.cos(wantYaw - s.yaw)) * Math.min(1, dt * 4);
    if (g.current) {
      g.current.position.set(x, 0, z);
      g.current.rotation.y = s.yaw;
    }
    control.lookAt = near ? new THREE.Vector3(runtime.pos.x, 1.6, runtime.pos.z) : null;
  });
  return (
    <group ref={g}>
      <HumanCharacter look={look} control={control} />
    </group>
  );
}

function StaticNpc({ look, position, rotY, sit, runtime, seatHeight }: { look: Look; position: [number, number, number]; rotY: number; sit?: boolean; runtime: PlayerRuntime; seatHeight?: number }) {
  const control = useMemo(() => makeControl({ action: sit ? 'sit' : 'idle', seatHeight }), [sit, seatHeight]);
  const head = useMemo(() => new THREE.Vector3(), []);
  useFrame(() => {
    const d = Math.hypot(position[0] - runtime.pos.x, position[2] - runtime.pos.z);
    if (d < 5) {
      head.set(runtime.pos.x, 1.6, runtime.pos.z);
      control.lookAt = head;
    } else control.lookAt = null;
  });
  return (
    <group position={position} rotation={[0, rotY, 0]}>
      <HumanCharacter look={look} control={control} />
    </group>
  );
}

function Npcs({ runtime }: { runtime: PlayerRuntime }) {
  const elder = useMemo(() => patientLook(70, 'M', 'lobby-elder-2'), []);
  const mother = useMemo(() => patientLook(38, 'F', 'lobby-family-1'), []);
  const visitor = useMemo(() => patientLook(29, 'F', 'corridor-visitor-3'), []);
  const kid = useMemo(() => patientLook(8, 'M', 'lobby-family-kid'), []);
  const grandma = useMemo(() => patientLook(66, 'F', 'lobby-grandma-1'), []);
  return (
    <>
      <StaticNpc look={NURSE_LOOK} position={[-5.25, 0, 4.4]} rotY={Math.PI / 2} runtime={runtime} />
      <StaticNpc look={elder} position={[5.06, 0, 4.1]} rotY={-Math.PI / 2} sit seatHeight={0.48} runtime={runtime} />
      <StaticNpc look={mother} position={[5.06, 0, 5.3]} rotY={-Math.PI / 2} sit seatHeight={0.48} runtime={runtime} />
      <StaticNpc look={kid} position={[5.06, 0, 5.93]} rotY={-Math.PI / 2} sit seatHeight={0.48} runtime={runtime} />
      <StaticNpc look={grandma} position={[2.94, 0, 6.29]} rotY={Math.PI / 2} sit seatHeight={0.48} runtime={runtime} />
      <StaticNpc look={visitor} position={[-CORRIDOR_HALF_W + 0.36, 0, -19.1]} rotY={Math.PI / 2} sit seatHeight={0.48} runtime={runtime} />
      <PatrolNpc look={WARD_ATTENDANT_LOOK} a={[0.9, -3]} b={[0.9, -29]} runtime={runtime} />
    </>
  );
}

// ───────────────────────── world root ─────────────────────────

export function CorridorWorld({
  runtime,
  doorFx,
  onDoorClick,
  reflections = true,
}: {
  runtime: PlayerRuntime;
  doorFx: DoorFx[];
  onDoorClick: (d: DoorSpec) => void;
  reflections?: boolean;
}) {
  return (
    <>
      <hemisphereLight args={['#e6ecff', '#9c9486', 0.3]} />
      <FollowSun runtime={runtime} />
      <LightPool runtime={runtime} />
      {/* daylight spilling from the end window + the entrance */}
      <pointLight position={[0, 2.2, END_Z + 1.2]} intensity={14} distance={16} decay={1.5} color="#eaf3ff" />
      <pointLight position={[0, 3.2, LOBBY_FRONT_Z - 1]} intensity={12} distance={12} decay={1.5} color="#eef5ff" />

      <Floor reflections={reflections} />
      <Shell />
      <WallDressing />
      <CeilingPanels />
      <DoorInstances>
        {DOORS.map((d, i) => (
          <Door key={d.dept.id} door={d} fx={doorFx[i]} onClick={onDoorClick} />
        ))}
      </DoorInstances>
      <Props />
      <Npcs runtime={runtime} />
    </>
  );
}

export const DEPARTMENT_COUNT = DEPARTMENTS.length;

Object.values(MODELS).forEach((u) => useGLTF.preload(u));
