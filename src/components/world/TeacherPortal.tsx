import { useEffect, useMemo, useRef } from 'react';
import { useFrame } from '@react-three/fiber';
import { Sparkles } from '@react-three/drei';
import * as THREE from 'three';
import { canvasTex } from './Corridor';
import { LOBBY_FRONT_Z } from './corridorLayout';
import { hindiLabel, useSignFontsReady } from './hindi';
import type { Collider, PlayerRuntime } from './ThirdPersonPlayer';

// ───────── Teacher Portal: glowing doorway in the lobby ─────────
//
// Freestanding against the entrance glass, directly behind the lobby spawn
// point (the doctor spawns facing the corridor, so it is "behind" them).
// Walk up + E (or click it) to enter the lecture hall.

export const PORTAL = {
  x: 0,
  z: LOBBY_FRONT_Z - 0.45,
  halfW: 1.05,
  h: 2.75,
  /** Where the doctor stands / reappears, facing back into the lobby. */
  standX: 0,
  standZ: LOBBY_FRONT_Z - 1.55,
  exitYaw: Math.PI,
};

export const PORTAL_COLLIDERS: Collider[] = [{ x: PORTAL.x, z: PORTAL.z, w: PORTAL.halfW * 2 + 0.7, d: 0.62 }];

const USE_RADIUS = 2.1;

/** True when the doctor is close to the portal and roughly facing it. */
export function nearPortal(runtime: PlayerRuntime): boolean {
  const dx = PORTAL.x - runtime.pos.x, dz = PORTAL.z - runtime.pos.z;
  const dist = Math.hypot(dx, dz);
  if (dist > USE_RADIUS) return false;
  const facing = (dx * Math.sin(runtime.yaw) + dz * Math.cos(runtime.yaw)) / Math.max(dist, 1e-3);
  return dist < 1.35 || facing > 0.1;
}

const VERT = /* glsl */ `
varying vec2 vUv;
void main() {
  vUv = uv;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
}`;

const FRAG = /* glsl */ `
uniform float uTime;
uniform float uHover;
varying vec2 vUv;
float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
float noise(vec2 p) {
  vec2 i = floor(p), f = fract(p);
  vec2 u = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
}
void main() {
  vec2 p = (vUv - 0.5) * vec2(0.76, 1.0);
  float r = length(p);
  float a = atan(p.y, p.x);
  float swirl = noise(vec2(a * 2.2 + uTime * 0.35 - r * 7.0, r * 5.0 - uTime * 0.6));
  float rings = 0.5 + 0.5 * sin(r * 26.0 - uTime * 2.2 + swirl * 3.0);
  vec3 deep = vec3(0.05, 0.08, 0.32);
  vec3 teal = vec3(0.22, 0.85, 0.95);
  vec3 violet = vec3(0.55, 0.38, 1.0);
  vec3 col = mix(deep, mix(violet, teal, swirl), smoothstep(0.62, 0.05, r) * (0.55 + 0.45 * rings));
  col += vec3(0.85, 0.95, 1.0) * smoothstep(0.16, 0.0, r) * (0.7 + 0.3 * sin(uTime * 1.7));
  // bright rim toward the frame
  float edge = max(abs(vUv.x - 0.5) * 2.0, abs(vUv.y - 0.5) * 2.0);
  col += teal * smoothstep(0.82, 1.0, edge) * 0.9;
  col *= 1.0 + 0.25 * uHover;
  gl_FragColor = vec4(col, 0.93);
}`;

function PortalSign() {
  const ready = useSignFontsReady();
  const tex = useMemo(() => {
    const hi = hindiLabel('teacher-portal');
    return canvasTex(1024, 220, (g) => {
      const grad = g.createLinearGradient(0, 0, 1024, 0);
      grad.addColorStop(0, '#15233c');
      grad.addColorStop(0.5, '#1d2f55');
      grad.addColorStop(1, '#15233c');
      g.fillStyle = grad;
      g.fillRect(0, 0, 1024, 220);
      g.fillStyle = '#7fd8ff';
      g.fillRect(0, 0, 1024, 8);
      g.fillRect(0, 212, 1024, 8);
      g.textAlign = 'center';
      g.fillStyle = '#ffffff';
      g.font = '800 74px Inter, system-ui, sans-serif';
      g.fillText('TEACHER PORTAL', 512, 100, 980);
      if (hi) {
        g.font = '600 50px "Noto Sans Devanagari", "Nirmala UI", sans-serif';
        g.fillStyle = '#bfe7ff';
        g.fillText(hi, 512, 168, 980);
      }
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <mesh position={[0, PORTAL.h + 0.62, 0.02]}>
      <planeGeometry args={[2.7, 0.58]} />
      <meshStandardMaterial map={tex} emissiveMap={tex} emissive="#ffffff" emissiveIntensity={0.22} roughness={0.5} />
    </mesh>
  );
}

function SubSign() {
  const tex = useMemo(
    () =>
      canvasTex(1024, 96, (g) => {
        g.fillStyle = '#0f1a2e';
        g.fillRect(0, 0, 1024, 96);
        g.textAlign = 'center';
        g.fillStyle = '#a8e27c';
        g.font = '600 40px Inter, system-ui, sans-serif';
        g.fillText('LECTURE HALL  ·  LEARN WITH DR. MEERA IYER', 512, 62, 990);
      }),
    [],
  );
  useEffect(() => () => tex.dispose(), [tex]);
  return (
    <mesh position={[0, PORTAL.h + 0.24, 0.185]}>
      <planeGeometry args={[2.3, 0.2]} />
      <meshStandardMaterial map={tex} emissiveMap={tex} emissive="#ffffff" emissiveIntensity={0.25} roughness={0.5} />
    </mesh>
  );
}

/** The portal itself. `active` brightens it while the doctor is in range. */
export function TeacherPortal({ active, onClick }: { active: boolean; onClick: () => void }) {
  const mat = useMemo(
    () =>
      new THREE.ShaderMaterial({
        vertexShader: VERT,
        fragmentShader: FRAG,
        uniforms: { uTime: { value: 0 }, uHover: { value: 0 } },
        transparent: true,
        depthWrite: false,
        toneMapped: false,
      }),
    [],
  );
  useEffect(() => () => mat.dispose(), [mat]);
  const light = useRef<THREE.PointLight>(null);
  const ring = useRef<THREE.MeshStandardMaterial>(null);
  useFrame((st, dt) => {
    const t = st.clock.elapsedTime;
    mat.uniforms.uTime.value = t;
    const want = active ? 1 : 0;
    mat.uniforms.uHover.value += (want - mat.uniforms.uHover.value) * Math.min(1, dt * 5);
    const h = mat.uniforms.uHover.value;
    if (light.current) light.current.intensity = 5 + 3 * h + Math.sin(t * 2.1) * 0.6;
    if (ring.current) ring.current.emissiveIntensity = 1.6 + 1.6 * h + Math.sin(t * 3) * 0.4;
  });

  const { halfW, h } = PORTAL;
  const frame = '#1b2440';
  const glow = '#7fd8ff';
  return (
    <group position={[PORTAL.x, 0, PORTAL.z]} rotation={[0, Math.PI, 0]}>
      {/* plinth + frame (local +z faces the lobby) */}
      <mesh position={[0, 0.04, 0]} receiveShadow castShadow>
        <boxGeometry args={[halfW * 2 + 0.7, 0.08, 0.6]} />
        <meshStandardMaterial color="#2a3550" roughness={0.35} metalness={0.5} />
      </mesh>
      {[-1, 1].map((s) => (
        <group key={s}>
          <mesh position={[s * (halfW + 0.16), h / 2 + 0.08, 0]} castShadow receiveShadow>
            <boxGeometry args={[0.3, h + 0.16, 0.36]} />
            <meshStandardMaterial color={frame} roughness={0.3} metalness={0.65} />
          </mesh>
          <mesh position={[s * (halfW + 0.005), h / 2 + 0.08, 0.1]}>
            <boxGeometry args={[0.03, h, 0.03]} />
            <meshStandardMaterial color={glow} emissive={glow} emissiveIntensity={3} toneMapped={false} />
          </mesh>
        </group>
      ))}
      <mesh position={[0, h + 0.24, 0]} castShadow>
        <boxGeometry args={[halfW * 2 + 0.62, 0.32, 0.36]} />
        <meshStandardMaterial color={frame} roughness={0.3} metalness={0.65} />
      </mesh>
      <mesh position={[0, h + 0.075, 0.1]}>
        <boxGeometry args={[halfW * 2, 0.03, 0.03]} />
        <meshStandardMaterial color={glow} emissive={glow} emissiveIntensity={3} toneMapped={false} />
      </mesh>
      <SubSign />
      <PortalSign />

      {/* swirling portal surface */}
      <mesh
        position={[0, h / 2 + 0.08, 0.02]}
        material={mat}
        onClick={(e) => {
          e.stopPropagation();
          onClick();
        }}
        onPointerOver={() => (document.body.style.cursor = 'pointer')}
        onPointerOut={() => (document.body.style.cursor = '')}
      >
        <planeGeometry args={[halfW * 2, h]} />
      </mesh>

      {/* glowing floor ring where you step up */}
      <mesh position={[0, 0.012, 0.95]} rotation={[-Math.PI / 2, 0, 0]}>
        <ringGeometry args={[0.52, 0.66, 48]} />
        <meshStandardMaterial ref={ring} color={glow} emissive={glow} emissiveIntensity={2} toneMapped={false} transparent opacity={0.85} />
      </mesh>
      <Sparkles count={36} scale={[halfW * 2, h, 0.6]} position={[0, h / 2 + 0.1, 0.35]} size={2.6} speed={0.35} color="#cdeeff" opacity={0.8} />
      <pointLight ref={light} position={[0, 1.7, 0.9]} color="#86b8ff" intensity={6} distance={6} decay={1.6} />
    </group>
  );
}
