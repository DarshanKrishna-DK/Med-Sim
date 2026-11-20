import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { store, useStore, POLYCLINIC_BED_INDEX } from '../../game/store';
import { disposePatientConversation, ensureAudioContext } from '../../voice/conversationStore';
import { ClinicRoomWorld, DOCTOR_SEAT, EXIT_POINT, ROOM_COLLIDERS } from '../world/ClinicRoom';
import { ThirdPersonPlayer, isTypingTarget, makeRuntime, type PlayerRuntime } from '../world/ThirdPersonPlayer';
import { PostFX, WorldEnvironment, type FxQuality } from '../world/WorldFX';
import { Fade, MenuButton, PauseMenu, PromptPill } from '../world/worldUi';
import { loadSignFonts } from '../world/hindi';

const CAMERA_RIG = {
  distance: 2.3,
  minDistance: 1.0,
  maxDistance: 4.5,
  pivotHeight: 1.55,
  seatedPivotHeight: 1.3,
  shoulder: 0.38,
  ceiling: 3.0,
};

type Near = 'exit' | 'patient' | null;

function RoomProbe({ runtime, seated, onChange }: { runtime: PlayerRuntime; seated: boolean; onChange: (n: Near) => void }) {
  const cur = useRef<Near>(null);
  useFrame(() => {
    let n: Near = null;
    const dExit = Math.hypot(runtime.pos.x - EXIT_POINT.x, runtime.pos.z - EXIT_POINT.z);
    if (dExit < 1.3) n = 'exit';
    else if (seated && Math.hypot(runtime.pos.x - DOCTOR_SEAT.x, runtime.pos.z + 3.4) < 3.2) n = 'patient';
    if (n !== cur.current) {
      cur.current = n;
      onChange(n);
    }
  });
  return null;
}

function pickQuality(): FxQuality | null {
  try {
    const q = new URLSearchParams(window.location.search).get('fx');
    if (q === 'low' || q === 'high') return q;
  } catch {
    /* ignore */
  }
  return null;
}

/** Room-level actions the HUD's overflow menu drives. */
export interface RoomControls {
  /** A patient is seated, so "next patient" makes sense. */
  canNext: boolean;
  nextPatient: () => void;
  leaveRoom: () => void;
}

/** The clinic room: realistic 3D consultation room in third person. The
 *  doctor starts seated at the desk; the case walks in and sits across.
 *  T toggles voice (handled by the encounter controller), N or the HUD's
 *  overflow menu finishes the case and calls the next patient, E at the
 *  door, Esc → Leave room or the overflow menu returns to the corridor. */
export function Scene({
  onTalk: _onTalk,
  lookEnabled,
  onRoom,
}: {
  onTalk: () => void;
  lookEnabled: boolean;
  onRoom?: (r: RoomControls) => void;
}) {
  const patient = useStore((s) => s.polyclinic.patient);
  const clinic = useStore((s) => s.polyclinic.clinic);
  const forced = useMemo(pickQuality, []);
  const [quality, setQuality] = useState<FxQuality>(forced ?? 'high');
  const [dpr, setDpr] = useState(1);
  const runtime = useMemo(() => makeRuntime(DOCTOR_SEAT.x, DOCTOR_SEAT.z, DOCTOR_SEAT.yaw, true), []);
  const [near, setNear] = useState<Near>(null);
  const [seated, setSeated] = useState(false);
  const [menu, setMenu] = useState(false);
  const [fade, setFade] = useState(1);
  const leaving = useRef(false);

  useEffect(() => {
    void loadSignFonts();
    const t = window.setTimeout(() => setFade(0), 120);
    if (import.meta.env.DEV) (window as unknown as { __medsimPlayer?: PlayerRuntime }).__medsimPlayer = runtime;
    return () => window.clearTimeout(t);
  }, [runtime]);

  useEffect(() => {
    runtime.inputEnabled = lookEnabled && !menu && !leaving.current;
  }, [lookEnabled, menu, runtime]);

  const leaveRoom = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    runtime.inputEnabled = false;
    setMenu(false);
    setFade(1);
    window.setTimeout(() => {
      disposePatientConversation(POLYCLINIC_BED_INDEX);
      store.exitToCorridor();
    }, 600);
  }, [runtime]);

  /** Done with this case: it is snapshotted for the debrief, the patient
   *  walks out and the clinic's next case walks in. Runs inside the click /
   *  keydown so the AudioContext stays unlocked for the next voice session. */
  const nextPatient = useCallback(() => {
    if (leaving.current) return;
    try {
      ensureAudioContext();
    } catch {
      /* voice panel surfaces it */
    }
    disposePatientConversation(POLYCLINIC_BED_INDEX);
    store.finishPolyclinicCase();
    store.acceptNextPatient();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.repeat || !lookEnabled) return;
      if (document.querySelector('.modal-layer')) return;
      if (e.code === 'Escape') {
        setMenu((m) => !m);
        return;
      }
      if (menu) return;
      if (e.code === 'KeyE' && near === 'exit') {
        e.preventDefault();
        leaveRoom();
      }
      if (e.code === 'KeyN' && patient && seated) {
        e.preventDefault();
        nextPatient();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [near, menu, lookEnabled, leaveRoom, nextPatient, patient, seated]);

  const onPhase = useCallback((p: string) => setSeated(p === 'seated'), []);
  const canNext = !!patient && seated;

  useEffect(() => {
    onRoom?.({ canNext, nextPatient, leaveRoom });
  }, [onRoom, canNext, nextPatient, leaveRoom]);

  return (
    <>
      <Canvas
        shadows
        dpr={dpr}
        className="scene-canvas"
        style={{ position: 'fixed', inset: 0 }}
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
        camera={{ fov: 56, near: 0.05, far: 60, position: [DOCTOR_SEAT.x + 0.4, 1.9, DOCTOR_SEAT.z - 2] }}
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
          <ClinicRoomWorld patient={patient} clinic={clinic} runtime={runtime} onPatientPhase={onPhase} />
          <ThirdPersonPlayer runtime={runtime} colliders={ROOM_COLLIDERS} rig={CAMERA_RIG} seat={DOCTOR_SEAT} />
          <RoomProbe runtime={runtime} seated={seated} onChange={setNear} />
          <PostFX quality={quality} />
        </Suspense>
      </Canvas>

      {!menu && near === 'exit' && <PromptPill title="Return to corridor" sub="Leave room" />}
      {menu && (
        <PauseMenu title="Consultation paused">
          <MenuButton primary autoFocus onClick={() => setMenu(false)}>Resume</MenuButton>
          <MenuButton onClick={() => { setMenu(false); nextPatient(); }}>Done, call the next patient</MenuButton>
          <MenuButton onClick={leaveRoom}>Leave room (back to corridor)</MenuButton>
        </PauseMenu>
      )}
      <div style={{ position: 'fixed', inset: 0, pointerEvents: 'none', zIndex: 60 }}>
        <Fade opacity={fade} />
      </div>
    </>
  );
}
