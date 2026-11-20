import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { PerformanceMonitor, useProgress } from '@react-three/drei';
import { store } from '../../game/store';
import { ensureAudioContext } from '../../voice/conversationStore';
import { CorridorWorld, CORRIDOR_COLLIDERS, type DoorFx } from './Corridor';
import { DOORS, SPAWN, WINGS, doorForClinic, wingStartZ, type DoorSpec } from './corridorLayout';
import { ThirdPersonPlayer, isTypingTarget, makeRuntime, type PlayerRuntime } from './ThirdPersonPlayer';
import { PostFX, WorldEnvironment, type FxQuality } from './WorldFX';
import { ControlsCard, Fade, MenuButton, PauseMenu, PromptPill, Toast, UI, labelStyle, panel } from './worldUi';
import { PORTAL, PORTAL_COLLIDERS, TeacherPortal, nearPortal } from './TeacherPortal';
import { LangToggle } from '../ui/LangToggle';

const WORLD_COLLIDERS = [...CORRIDOR_COLLIDERS, ...PORTAL_COLLIDERS];

/** Tracks whether the doctor stands at the Teacher Portal. */
function PortalProbe({ runtime, onChange }: { runtime: PlayerRuntime; onChange: (near: boolean) => void }) {
  const cur = useRef(false);
  useFrame(() => {
    const n = nearPortal(runtime);
    if (n !== cur.current) {
      cur.current = n;
      onChange(n);
    }
  });
  return null;
}

const CAMERA_RIG = { distance: 3.3, minDistance: 1.4, maxDistance: 6, pivotHeight: 1.58, shoulder: 0.42, ceiling: 3.0 };
const USE_RADIUS = 1.7;

function pickQuality(): FxQuality | null {
  try {
    const q = new URLSearchParams(window.location.search).get('fx');
    if (q === 'low' || q === 'high') return q;
  } catch {
    /* ignore */
  }
  return null;
}

/** Finds the door the doctor is standing at and facing. */
function DoorProbe({ runtime, onChange }: { runtime: PlayerRuntime; onChange: (d: DoorSpec | null) => void }) {
  const current = useRef<DoorSpec | null>(null);
  useFrame(() => {
    let best: DoorSpec | null = null;
    let bestD = USE_RADIUS;
    const fx = Math.sin(runtime.yaw), fz = Math.cos(runtime.yaw);
    for (const d of DOORS) {
      const dx = d.x - runtime.pos.x, dz = d.z - runtime.pos.z;
      const dist = Math.hypot(dx, dz);
      if (dist > bestD) continue;
      const facing = (dx * fx + dz * fz) / Math.max(dist, 1e-3);
      if (dist > 1.05 && facing < 0.15) continue;
      best = d;
      bestD = dist;
    }
    if (best !== current.current) {
      current.current = best;
      onChange(best);
    }
  });
  return null;
}

function LocationChip({ runtime }: { runtime: PlayerRuntime }) {
  const [label, setLabel] = useState('Main lobby');
  useEffect(() => {
    const t = window.setInterval(() => {
      const z = runtime.pos.z;
      const next =
        z > 0 ? 'Main lobby' : z > wingStartZ('surgical') ? WINGS.medicine.label : z > wingStartZ('diagnostics') ? WINGS.surgical.label : WINGS.diagnostics.label;
      setLabel((p) => (p === next ? p : next));
    }, 250);
    return () => window.clearInterval(t);
  }, [runtime]);
  return (
    <div style={{ ...panel, position: 'absolute', top: 16, left: 16, padding: '8px 12px', pointerEvents: 'none' }}>
      <div style={{ ...labelStyle, color: UI.primary, fontSize: 11 }}>MedSim General · Level 1</div>
      <div style={{ fontFamily: UI.heading, fontSize: 28, lineHeight: 1, marginTop: 2 }}>{label}</div>
    </div>
  );
}

function LoadingOverlay() {
  const { active, progress } = useProgress();
  const [show, setShow] = useState(true);
  useEffect(() => {
    if (!active && progress >= 100) {
      const t = window.setTimeout(() => setShow(false), 250);
      return () => window.clearTimeout(t);
    }
    setShow(true);
  }, [active, progress]);
  if (!show) return null;
  return (
    <div style={{ position: 'absolute', inset: 0, display: 'grid', placeItems: 'center', background: UI.bg, zIndex: 50 }}>
      <div style={{ ...panel, padding: '18px 22px', minWidth: 300 }}>
        <div style={{ ...labelStyle, color: UI.primary }}>Entering the hospital</div>
        <div style={{ fontFamily: UI.heading, fontSize: 34, lineHeight: 1, margin: '6px 0 12px' }}>{Math.round(progress)}%</div>
        <div style={{ height: 8, background: UI.bg, border: `2px solid ${UI.line}` }}>
          <div style={{ height: '100%', width: `${progress}%`, background: UI.primary }} />
        </div>
      </div>
    </div>
  );
}

export function CorridorScreen() {
  const forced = useMemo(pickQuality, []);
  const [quality, setQuality] = useState<FxQuality>(forced ?? 'high');
  const [dpr, setDpr] = useState(1);
  const runtime = useMemo(() => {
    if (store.getState().corridorReturnPortal) return makeRuntime(PORTAL.standX, PORTAL.standZ, PORTAL.exitYaw);
    const door = doorForClinic(store.getState().corridorReturnClinic);
    if (door) return makeRuntime(door.standX, door.standZ, 0);
    return makeRuntime(SPAWN.x, SPAWN.z, SPAWN.yaw);
  }, []);
  useEffect(() => {
    if (import.meta.env.DEV) (window as unknown as { __medsimPlayer?: PlayerRuntime }).__medsimPlayer = runtime;
  }, [runtime]);
  const doorFx = useMemo<DoorFx[]>(() => DOORS.map(() => ({ open: 0, openTarget: 0, shake: 0 })), []);
  const [active, setActive] = useState<DoorSpec | null>(null);
  const [atPortal, setAtPortal] = useState(false);
  const [toast, setToast] = useState<{ title: string; body: string; id: number } | null>(null);
  const [fade, setFade] = useState(1);
  const [menu, setMenu] = useState(false);
  const busy = useRef(false);

  // Fade in from black on arrival.
  useEffect(() => {
    const t = window.setTimeout(() => setFade(0), 80);
    return () => window.clearTimeout(t);
  }, []);

  useEffect(() => {
    runtime.inputEnabled = !menu && !busy.current;
  }, [menu, runtime]);

  useEffect(() => {
    if (!toast) return;
    const t = window.setTimeout(() => setToast(null), 3200);
    return () => window.clearTimeout(t);
  }, [toast]);

  const useDoor = useCallback(
    (door: DoorSpec) => {
      if (busy.current) return;
      const fx = doorFx[door.index];
      const clinic = door.dept.clinic;
      if (!clinic) {
        fx.shake = 0.55;
        setToast({
          title: door.dept.label,
          body: `Room ${door.room} is not open in this build yet. Try a lit door with a green light.`,
          id: Date.now(),
        });
        return;
      }
      // Warm the AudioContext inside this gesture so voice can start in the room.
      try {
        ensureAudioContext();
      } catch {
        /* no Web Audio, the voice panel will surface it */
      }
      busy.current = true;
      runtime.inputEnabled = false;
      fx.openTarget = 1;
      setFade(1);
      window.setTimeout(() => store.enterClinic(clinic), 650);
    },
    [doorFx, runtime],
  );

  const usePortal = useCallback(() => {
    if (busy.current) return;
    // Warm the AudioContext inside this gesture for the teacher's voice.
    try {
      ensureAudioContext();
    } catch {
      /* no Web Audio, the classroom panel will surface it */
    }
    busy.current = true;
    runtime.inputEnabled = false;
    setFade(1);
    window.setTimeout(() => store.enterClassroom(), 650);
  }, [runtime]);

  const onPortalClick = useCallback(() => {
    if (runtime.dragPx > 6 || menu) return;
    // Clicking from across the lobby does nothing; walk up first.
    if (Math.hypot(PORTAL.x - runtime.pos.x, PORTAL.z - runtime.pos.z) > 3.4) return;
    usePortal();
  }, [runtime, menu, usePortal]);

  const onDoorClick = useCallback(
    (door: DoorSpec) => {
      if (runtime.dragPx > 6 || menu) return;
      const d = Math.hypot(door.x - runtime.pos.x, door.z - runtime.pos.z);
      if (d > 3.2) {
        setToast({ title: door.dept.label, body: 'Walk up to the door, then press E or click it.', id: Date.now() });
        return;
      }
      useDoor(door);
    },
    [runtime, useDoor, menu],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.repeat) return;
      if (e.code === 'Escape') {
        if (busy.current) return;
        setMenu((m) => !m);
        return;
      }
      if (e.code === 'KeyE' && !menu && active) {
        e.preventDefault();
        useDoor(active);
      } else if (e.code === 'KeyE' && !menu && atPortal) {
        e.preventDefault();
        usePortal();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [active, atPortal, menu, useDoor, usePortal]);

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#050b1a', overflow: 'hidden', userSelect: 'none' }}>
      <Canvas
        shadows
        dpr={dpr}
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
        camera={{ fov: 58, near: 0.08, far: 140, position: [0, 1.8, 10] }}
        style={{ position: 'absolute', inset: 0 }}
        onCreated={(st) => {
          if (import.meta.env.DEV) (window as unknown as { __r3f?: unknown }).__r3f = st;
        }}
      >
        <color attach="background" args={['#0b0f16']} />
        <PerformanceMonitor
          bounds={() => [45, 58]}
          flipflops={3}
          onDecline={() => {
            if (!forced && quality === 'high') setQuality('low');
            else setDpr((d) => Math.max(0.6, d - 0.15));
          }}
          onIncline={() => setDpr((d) => Math.min(1.25, d + 0.1))}
        />
        <Suspense fallback={null}>
          <WorldEnvironment intensity={0.5} />
          <CorridorWorld runtime={runtime} doorFx={doorFx} onDoorClick={onDoorClick} reflections={quality === 'high'} />
          <TeacherPortal active={atPortal} onClick={onPortalClick} />
          <ThirdPersonPlayer runtime={runtime} colliders={WORLD_COLLIDERS} rig={CAMERA_RIG} />
          <DoorProbe runtime={runtime} onChange={setActive} />
          <PortalProbe runtime={runtime} onChange={setAtPortal} />
          <PostFX quality={quality} />
        </Suspense>
      </Canvas>

      <LocationChip runtime={runtime} />
      <div style={{ position: 'absolute', left: 16, bottom: 16 }}>
        <ControlsCard />
      </div>
      <button
        type="button"
        onClick={() => setMenu(true)}
        style={{ ...panel, ...labelStyle, position: 'absolute', top: 16, right: 16, padding: '10px 14px', cursor: 'pointer' }}
      >
        Menu · Esc
      </button>

      {active && !menu && fade < 0.5 && (
        <PromptPill
          title={active.dept.clinic ? `Enter ${active.dept.label}` : active.dept.label}
          sub={active.dept.clinic ? `Room ${active.room}` : `Room ${active.room} · coming soon`}
          tone={active.dept.clinic ? 'go' : 'soon'}
        />
      )}
      {!active && atPortal && !menu && fade < 0.5 && <PromptPill title="Enter the Teacher Portal" sub="Lecture hall · शिक्षक पोर्टल" />}
      {toast && <Toast key={toast.id} title={toast.title} body={toast.body} />}

      {menu && (
        <PauseMenu title="Paused">
          <MenuButton primary autoFocus onClick={() => setMenu(false)}>Resume</MenuButton>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...labelStyle, fontSize: 11, color: UI.primary }}>Voice language</span>
            <LangToggle className="lang-toggle--end" />
          </div>
          <MenuButton onClick={() => store.setScreen('triage')}>Triage drill</MenuButton>
          <MenuButton onClick={() => store.setScreen('library')}>Case library</MenuButton>
          <MenuButton onClick={() => store.setScreen('splash')}>Leave the hospital</MenuButton>
        </PauseMenu>
      )}
      <Fade opacity={fade} />
      <LoadingOverlay />
    </div>
  );
}
