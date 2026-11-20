import { useEffect, useMemo, useRef } from 'react';
import { useFrame, useThree } from '@react-three/fiber';
import * as THREE from 'three';
import type { WallCollider } from '../three/Player';
import { HumanCharacter, makeControl } from './HumanCharacter';
import { DOCTOR_LOOK, type Look } from './rigs';

export type Collider = WallCollider & { /** height of the obstacle; undefined = full wall */ h?: number };

export interface Seat {
  x: number;
  z: number;
  yaw: number;
  height: number;
}

/** Shared, mutable player state: read by the world (door prompts, NPC
 *  head-turns) without React re-renders. */
export interface PlayerRuntime {
  pos: THREE.Vector3;
  yaw: number;
  speed: number;
  seated: boolean;
  /** False while a menu / transition owns the input. */
  inputEnabled: boolean;
  camYaw: number;
  camPitch: number;
  /** Pixels moved in the current / last pointer drag (click filter). */
  dragPx: number;
}

export function makeRuntime(x: number, z: number, yaw: number, seated = false): PlayerRuntime {
  return {
    pos: new THREE.Vector3(x, 0, z),
    yaw,
    speed: 0,
    seated,
    inputEnabled: true,
    camYaw: yaw + Math.PI,
    camPitch: 0.22,
    dragPx: 0,
  };
}

export interface CameraRig {
  distance: number;
  minDistance: number;
  maxDistance: number;
  pivotHeight: number;
  seatedPivotHeight?: number;
  shoulder: number;
  ceiling: number;
}

const WALK = 2.3;
const RUN = 5.0;
const RADIUS = 0.3;

export function isTypingTarget(t: EventTarget | null): boolean {
  const el = t as HTMLElement | null;
  return !!el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT' || el.isContentEditable);
}

function blocked(x: number, z: number, colliders: Collider[]): boolean {
  for (const c of colliders) {
    if (Math.abs(x - c.x) < c.w / 2 + RADIUS && Math.abs(z - c.z) < c.d / 2 + RADIUS) return true;
  }
  return false;
}

/** Earliest hit fraction (0..1) of the XZ segment p→q against the colliders
 *  taller than `y`, each expanded by `r`. 1 = clear. */
function segmentHit(px: number, pz: number, qx: number, qz: number, y: number, r: number, colliders: Collider[]): number {
  let best = 1;
  const dx = qx - px;
  const dz = qz - pz;
  for (const c of colliders) {
    if (c.h !== undefined && c.h < y) continue;
    const minX = c.x - c.w / 2 - r, maxX = c.x + c.w / 2 + r;
    const minZ = c.z - c.d / 2 - r, maxZ = c.z + c.d / 2 + r;
    if (px > minX && px < maxX && pz > minZ && pz < maxZ) continue; // pivot inside: ignore
    let t0 = 0, t1 = 1;
    if (Math.abs(dx) < 1e-9) {
      if (px < minX || px > maxX) continue;
    } else {
      let a = (minX - px) / dx, b = (maxX - px) / dx;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) continue;
    }
    if (Math.abs(dz) < 1e-9) {
      if (pz < minZ || pz > maxZ) continue;
    } else {
      let a = (minZ - pz) / dz, b = (maxZ - pz) / dz;
      if (a > b) [a, b] = [b, a];
      t0 = Math.max(t0, a); t1 = Math.min(t1, b);
      if (t0 > t1) continue;
    }
    if (t0 < best) best = t0;
  }
  return best;
}

function wrapAngle(a: number) {
  return Math.atan2(Math.sin(a), Math.cos(a));
}

export function ThirdPersonPlayer({
  runtime,
  colliders,
  rig,
  seat,
  look = DOCTOR_LOOK,
  lookAt,
}: {
  runtime: PlayerRuntime;
  colliders: Collider[];
  rig: CameraRig;
  seat?: Seat;
  look?: Look;
  /** Optional world point the avatar's head tracks while seated. */
  lookAt?: THREE.Vector3 | null;
}) {
  const { camera, gl } = useThree();
  const group = useRef<THREE.Group>(null);
  const control = useMemo(() => makeControl({ seatHeight: seat?.height }), [seat?.height]);
  const keys = useRef({ f: false, b: false, l: false, r: false, run: false, rotL: false, rotR: false });
  const camState = useRef({
    dist: rig.distance,
    want: rig.distance,
    effDist: rig.distance,
    pivot: new THREE.Vector3(runtime.pos.x, rig.pivotHeight, runtime.pos.z),
    lastDrag: -10,
    idle: 0,
    t: 0,
    init: false,
  });

  // ── keyboard ──
  useEffect(() => {
    const map = (e: KeyboardEvent): keyof typeof keys.current | null => {
      switch (e.code) {
        case 'KeyW': case 'ArrowUp': return 'f';
        case 'KeyS': case 'ArrowDown': return 'b';
        case 'KeyA': return 'l';
        case 'KeyD': return 'r';
        case 'ArrowLeft': return 'rotL';
        case 'ArrowRight': return 'rotR';
        case 'ShiftLeft': case 'ShiftRight': return 'run';
        default: return null;
      }
    };
    const down = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target)) return;
      const k = map(e);
      if (!k) return;
      keys.current[k] = true;
      if (k !== 'run') e.preventDefault();
    };
    const up = (e: KeyboardEvent) => {
      const k = map(e);
      if (k) keys.current[k] = false;
    };
    const blur = () => {
      const k = keys.current;
      k.f = k.b = k.l = k.r = k.run = k.rotL = k.rotR = false;
    };
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  // ── mouse drag orbit + wheel zoom ──
  useEffect(() => {
    const el = gl.domElement;
    let dragging = false;
    let lx = 0, ly = 0;
    const onDown = (e: PointerEvent) => {
      if (e.button !== 0 && e.button !== 2) return;
      dragging = true;
      runtime.dragPx = 0;
      lx = e.clientX; ly = e.clientY;
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const dx = e.clientX - lx, dy = e.clientY - ly;
      lx = e.clientX; ly = e.clientY;
      runtime.dragPx += Math.abs(dx) + Math.abs(dy);
      if (!runtime.inputEnabled) return;
      runtime.camYaw -= dx * 0.0055;
      runtime.camPitch = THREE.MathUtils.clamp(runtime.camPitch + dy * 0.004, -0.35, 1.1);
      camState.current.lastDrag = camState.current.t;
    };
    const onUp = () => { dragging = false; };
    const onWheel = (e: WheelEvent) => {
      const s = camState.current;
      s.want = THREE.MathUtils.clamp(s.want + Math.sign(e.deltaY) * 0.4, rig.minDistance, rig.maxDistance);
    };
    const noMenu = (e: Event) => e.preventDefault();
    el.addEventListener('pointerdown', onDown);
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
    el.addEventListener('wheel', onWheel, { passive: true });
    el.addEventListener('contextmenu', noMenu);
    return () => {
      el.removeEventListener('pointerdown', onDown);
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      el.removeEventListener('wheel', onWheel);
      el.removeEventListener('contextmenu', noMenu);
    };
  }, [gl, runtime, rig.minDistance, rig.maxDistance]);

  const tmp = useMemo(() => ({ move: new THREE.Vector3(), cam: new THREE.Vector3(), look: new THREE.Vector3() }), []);

  useFrame((_, rawDt) => {
    const dt = Math.min(rawDt, 0.05);
    const s = camState.current;
    s.t += dt;
    const k = keys.current;
    const enabled = runtime.inputEnabled;

    // Camera rotation from arrows.
    if (enabled && (k.rotL || k.rotR)) {
      runtime.camYaw += (k.rotL ? 1 : -1) * dt * 2.2;
      s.lastDrag = s.t;
    }

    // Input → desired direction (camera-relative).
    const fwdX = -Math.sin(runtime.camYaw), fwdZ = -Math.cos(runtime.camYaw);
    const rightX = Math.cos(runtime.camYaw), rightZ = -Math.sin(runtime.camYaw);
    let ix = 0, iz = 0;
    if (enabled) {
      if (k.f) { ix += fwdX; iz += fwdZ; }
      if (k.b) { ix -= fwdX; iz -= fwdZ; }
      if (k.r) { ix += rightX; iz += rightZ; }
      if (k.l) { ix -= rightX; iz -= rightZ; }
    }
    const hasInput = ix * ix + iz * iz > 1e-6;

    if (hasInput && runtime.seated) runtime.seated = false;

    let targetSpeed = 0;
    if (hasInput) {
      const len = Math.hypot(ix, iz);
      ix /= len; iz /= len;
      targetSpeed = k.run ? RUN : WALK;
      const wantYaw = Math.atan2(ix, iz);
      runtime.yaw += wrapAngle(wantYaw - runtime.yaw) * Math.min(1, dt * 10);
      s.idle = 0;
    } else {
      s.idle += dt;
    }
    runtime.speed += (targetSpeed - runtime.speed) * Math.min(1, dt * (targetSpeed > runtime.speed ? 6 : 9));
    if (runtime.speed < 0.02) runtime.speed = 0;

    if (!runtime.seated && runtime.speed > 0) {
      // Move along facing (smoothed) blended toward input dir.
      const mx = (hasInput ? ix : Math.sin(runtime.yaw)) * runtime.speed * dt;
      const mz = (hasInput ? iz : Math.cos(runtime.yaw)) * runtime.speed * dt;
      const nx = runtime.pos.x + mx;
      if (!blocked(nx, runtime.pos.z, colliders)) runtime.pos.x = nx;
      const nz = runtime.pos.z + mz;
      if (!blocked(runtime.pos.x, nz, colliders)) runtime.pos.z = nz;
    }

    // Auto-sit back into the chair.
    if (seat && !runtime.seated && !hasInput && runtime.speed === 0) {
      const d = Math.hypot(runtime.pos.x - seat.x, runtime.pos.z - seat.z);
      if (d < 0.6 && s.idle > 0.4) runtime.seated = true;
    }
    if (seat && runtime.seated) {
      runtime.pos.x += (seat.x - runtime.pos.x) * Math.min(1, dt * 8);
      runtime.pos.z += (seat.z - runtime.pos.z) * Math.min(1, dt * 8);
      runtime.yaw += wrapAngle(seat.yaw - runtime.yaw) * Math.min(1, dt * 6);
    }

    // Camera auto-follow behind the avatar while walking forward.
    if (hasInput && k.f && !k.b && s.t - s.lastDrag > 1.2) {
      const behind = runtime.yaw + Math.PI;
      runtime.camYaw += wrapAngle(behind - runtime.camYaw) * Math.min(1, dt * 1.1);
    }

    // Avatar.
    const g = group.current;
    if (g) {
      g.position.set(runtime.pos.x, 0, runtime.pos.z);
      g.rotation.y = runtime.yaw;
    }
    control.action = runtime.seated ? 'sit' : runtime.speed > 3.2 ? 'run' : runtime.speed > 0.15 ? 'walk' : 'idle';
    control.speed = runtime.speed;
    control.lookAt = runtime.seated ? lookAt ?? null : null;

    // ── camera ──
    s.dist += (s.want - s.dist) * Math.min(1, dt * 8);
    const pivotH = runtime.seated && rig.seatedPivotHeight ? rig.seatedPivotHeight : rig.pivotHeight;
    const shoulderX = Math.cos(runtime.camYaw) * rig.shoulder;
    const shoulderZ = -Math.sin(runtime.camYaw) * rig.shoulder;
    const pivotTarget = tmp.look.set(runtime.pos.x + shoulderX, pivotH, runtime.pos.z + shoulderZ);
    if (!s.init) s.pivot.copy(pivotTarget);
    s.pivot.lerp(pivotTarget, Math.min(1, dt * 12));

    const cp = Math.cos(runtime.camPitch), sp = Math.sin(runtime.camPitch);
    const ox = Math.sin(runtime.camYaw) * cp, oz = Math.cos(runtime.camYaw) * cp;
    const wantX = s.pivot.x + ox * s.dist;
    const wantZ = s.pivot.z + oz * s.dist;
    const camY = Math.min(rig.ceiling - 0.15, s.pivot.y + sp * s.dist);
    const hit = segmentHit(s.pivot.x, s.pivot.z, wantX, wantZ, camY, 0.22, colliders);
    const target = Math.max(0.35, s.dist * hit - 0.05);
    // Pull in instantly (never clip), ease back out.
    s.effDist = target < s.effDist ? target : s.effDist + (target - s.effDist) * Math.min(1, dt * 4);
    if (!s.init) { s.effDist = target; s.init = true; }
    const ed = s.effDist;
    tmp.cam.set(s.pivot.x + ox * ed, Math.max(0.3, Math.min(rig.ceiling - 0.15, s.pivot.y + sp * ed)), s.pivot.z + oz * ed);
    camera.position.copy(tmp.cam);
    camera.lookAt(s.pivot);
    if (g) g.visible = ed > 0.55;
  });

  return (
    <group ref={group} position={[runtime.pos.x, 0, runtime.pos.z]} rotation={[0, runtime.yaw, 0]}>
      <HumanCharacter look={look} control={control} />
    </group>
  );
}
