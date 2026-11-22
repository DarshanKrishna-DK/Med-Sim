import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { store } from '../../game/store';
import { LangToggle } from '../ui/LangToggle';
import { RAD_COLLIDERS, RAD_EXIT, RAD_SPAWN, RadiologyWorld } from '../world/RadiologyRoom';
import { ThirdPersonPlayer, isTypingTarget, makeRuntime, type PlayerRuntime } from '../world/ThirdPersonPlayer';
import { PostFX, WorldEnvironment, type FxQuality } from '../world/WorldFX';
import { Fade, KeyCap, MenuButton, PauseMenu, PromptPill, UI, labelStyle, panel } from '../world/worldUi';
import { loadSignFonts } from '../world/hindi';
import {
  MODALITY_LABEL,
  RAD_CASES,
  READING_TIP,
  diagnosisOptions,
  gradeOffline,
  probeOffline,
  type RadCase,
  type RadGrade,
  type RadModality,
} from '../../data/radiology';
import { RADIOLOGIST, filmIntroLine } from '../../voice/radiologistPersona';
import { useRadiologistSession, type RadiologistSession } from '../radiology/useRadiologistSession';

const CAMERA_RIG = { distance: 2.6, minDistance: 1.2, maxDistance: 5, pivotHeight: 1.58, shoulder: 0.4, ceiling: 3.0 };
const PANEL_W = 380;

function pickQuality(): FxQuality | null {
  try {
    const q = new URLSearchParams(window.location.search).get('fx');
    if (q === 'low' || q === 'high') return q;
  } catch {
    /* ignore */
  }
  return null;
}

function ExitProbe({ runtime, onChange }: { runtime: PlayerRuntime; onChange: (near: boolean) => void }) {
  const cur = useRef(false);
  useFrame(() => {
    const near = Math.hypot(runtime.pos.x - RAD_EXIT.x, runtime.pos.z - RAD_EXIT.z) < 1.3;
    if (near !== cur.current) {
      cur.current = near;
      onChange(near);
    }
  });
  return null;
}

const STATUS_LABEL: Record<string, string> = {
  uninitialized: 'Voice off',
  loading: 'Connecting...',
  ready: 'Listening',
  listening: 'Hearing you',
  thinking: 'Thinking...',
  speaking: 'Speaking',
  error: 'Voice error',
};

const smallBtn: CSSProperties = {
  ...labelStyle,
  fontSize: 11,
  padding: '8px 10px',
  border: `2px solid ${UI.line}`,
  background: UI.bg,
  color: UI.text,
  boxShadow: '2px 2px 0 0 #061431',
  cursor: 'pointer',
};

const field: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: UI.label,
  fontSize: 14,
  padding: '9px 10px',
  border: `2px solid ${UI.line}`,
  background: UI.bg,
  color: UI.text,
  outline: 'none',
};

const GOOD = '#7fe0a0';
const MISS = '#ffb454';

async function postJson<T>(path: string, body: unknown, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal });
  if (!r.ok) throw new Error(`${r.status}`);
  return (await r.json()) as T;
}

const DX_RE = /\b(?:my )?(?:diagnosis|impression)(?: is|:)\s+(.{3,120})$/i;

type Filter = 'all' | RadModality;

// ───────── film viewer ─────────

function FilmViewer({ c, onHide }: { c: RadCase; onHide: () => void }) {
  const [invert, setInvert] = useState(false);
  const [zoom, setZoom] = useState(false);
  const [bright, setBright] = useState(100);
  useEffect(() => {
    setInvert(false);
    setZoom(false);
    setBright(100);
  }, [c.id]);
  const canInvert = c.modality !== 'ecg';
  return (
    <div style={{ ...panel, background: '#03060c', height: '100%', display: 'flex', flexDirection: 'column', boxSizing: 'border-box' }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, padding: '8px 10px', borderBottom: `2px solid ${UI.line}`, background: UI.surface }}>
        <span style={{ ...labelStyle, color: UI.primary, fontSize: 11 }}>{MODALITY_LABEL[c.modality]}</span>
        <span style={{ fontFamily: UI.heading, fontSize: 24, lineHeight: 1 }}>{c.study}</span>
        <span style={{ marginLeft: 'auto', display: 'flex', gap: 6, alignItems: 'center' }}>
          <label style={{ ...labelStyle, fontSize: 10, display: 'flex', alignItems: 'center', gap: 6 }}>
            Window
            <input type="range" min={60} max={160} value={bright} onChange={(e) => setBright(Number(e.target.value))} aria-label="Brightness" style={{ width: 80 }} />
          </label>
          {canInvert && (
            <button type="button" onClick={() => setInvert((v) => !v)} aria-pressed={invert} style={{ ...smallBtn, padding: '4px 8px', fontSize: 10 }}>
              Invert
            </button>
          )}
          <button type="button" onClick={() => setZoom((v) => !v)} aria-pressed={zoom} style={{ ...smallBtn, padding: '4px 8px', fontSize: 10 }}>
            {zoom ? 'Fit' : 'Zoom'}
          </button>
          <button type="button" onClick={onHide} style={{ ...smallBtn, padding: '4px 8px', fontSize: 10 }}>
            Room view <span style={{ opacity: 0.7 }}>V</span>
          </button>
        </span>
      </div>
      <div style={{ flex: 1, minHeight: 0, overflow: zoom ? 'auto' : 'hidden', display: 'grid', placeItems: zoom ? 'start' : 'center', padding: 8 }}>
        <img
          src={c.image}
          alt={`${c.study} for this case. Describe what you see.`}
          onClick={() => setZoom((v) => !v)}
          style={{
            maxWidth: zoom ? 'none' : '100%',
            maxHeight: zoom ? 'none' : '100%',
            width: zoom ? '170%' : undefined,
            objectFit: 'contain',
            cursor: zoom ? 'zoom-out' : 'zoom-in',
            filter: `${invert ? 'invert(1) ' : ''}brightness(${bright}%)`,
          }}
        />
      </div>
      <div style={{ padding: '6px 10px', fontFamily: UI.label, fontSize: 11, opacity: 0.75, borderTop: `2px solid ${UI.line}` }}>
        Image: {c.credit.author},{' '}
        <a href={c.credit.licenseUrl} target="_blank" rel="noreferrer" style={{ color: UI.primary }}>
          {c.credit.license}
        </a>
        , via{' '}
        <a href={c.credit.source} target="_blank" rel="noreferrer" style={{ color: UI.primary }}>
          Wikimedia Commons
        </a>
        {c.credit.changes ? ` (${c.credit.changes})` : ''}. Synthetic teaching vignette.
      </div>
    </div>
  );
}

// ───────── results card ─────────

function ResultsCard({ c, grade, onNext, onRetry }: { c: RadCase; grade: RadGrade; onNext: () => void; onRetry: () => void }) {
  const tip = READING_TIP[c.modality];
  const tone = grade.score >= 75 ? GOOD : grade.score >= 45 ? UI.amber : '#ff7a6b';
  const crit = new Set(grade.missedCritical);
  return (
    <div style={{ ...panel, height: '100%', overflow: 'auto', padding: 14, boxSizing: 'border-box', display: 'grid', alignContent: 'start', gap: 12 }} role="region" aria-label="Your read, graded">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <div style={{ fontFamily: UI.heading, fontSize: 56, lineHeight: 0.9, color: tone }}>{grade.score}</div>
        <div>
          <div style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>Score / 100</div>
          <div style={{ fontFamily: UI.label, fontSize: 14, marginTop: 2 }}>
            {grade.diagnosisCorrect ? 'Diagnosis correct' : 'Diagnosis missed'}
            <span style={{ opacity: 0.6 }}> · {grade.gradedBy === 'llm' ? `graded by ${RADIOLOGIST.short}` : 'checklist grading'}</span>
          </div>
        </div>
      </div>
      <div style={{ background: UI.bg, border: `2px solid ${grade.diagnosisCorrect ? GOOD : MISS}`, padding: '8px 10px' }}>
        <div style={{ ...labelStyle, fontSize: 10, color: grade.diagnosisCorrect ? GOOD : MISS }}>Diagnosis</div>
        <div style={{ fontFamily: UI.heading, fontSize: 24, lineHeight: 1.05 }}>{grade.correctDiagnosis}</div>
      </div>
      <div style={{ fontFamily: UI.label, fontSize: 14, lineHeight: 1.45 }}>{grade.feedback}</div>

      <div>
        <div style={{ ...labelStyle, fontSize: 11, color: MISS, marginBottom: 6 }}>Missed findings ({grade.missedFindings.length})</div>
        {grade.missedFindings.length === 0 ? (
          <div style={{ fontFamily: UI.label, fontSize: 13, opacity: 0.8 }}>None. You covered every key finding.</div>
        ) : (
          <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 6 }}>
            {grade.missedFindings.map((f) => (
              <li key={f} style={{ fontFamily: UI.label, fontSize: 13, lineHeight: 1.35, padding: '6px 8px', background: 'rgba(255,180,84,.12)', borderLeft: `4px solid ${MISS}` }}>
                {crit.has(f) && <span style={{ ...labelStyle, fontSize: 9, color: '#0b1f4b', background: MISS, padding: '1px 5px', marginRight: 6 }}>Must not miss</span>}
                {f}
              </li>
            ))}
          </ul>
        )}
      </div>
      <div>
        <div style={{ ...labelStyle, fontSize: 11, color: GOOD, marginBottom: 6 }}>You found ({grade.foundFindings.length})</div>
        <ul style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 4 }}>
          {grade.foundFindings.map((f) => (
            <li key={f} style={{ fontFamily: UI.label, fontSize: 13, lineHeight: 1.35, paddingLeft: 10, borderLeft: `4px solid ${GOOD}` }}>
              {f}
            </li>
          ))}
        </ul>
      </div>
      <div style={{ background: UI.bg, border: `2px solid ${UI.line}`, padding: '8px 10px' }}>
        <div style={{ ...labelStyle, fontSize: 11, color: UI.primary, marginBottom: 6 }}>Systematic reading: {tip.name}</div>
        <ol style={{ margin: 0, paddingLeft: 18, fontFamily: UI.label, fontSize: 13, lineHeight: 1.4 }}>
          {tip.steps.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ol>
      </div>
      <div>
        <div style={{ ...labelStyle, fontSize: 11, color: UI.primary, marginBottom: 6 }}>Teaching points</div>
        <ul style={{ margin: 0, paddingLeft: 18, fontFamily: UI.label, fontSize: 13, lineHeight: 1.4 }}>
          {c.teaching.map((s) => (
            <li key={s}>{s}</li>
          ))}
        </ul>
      </div>
      <div style={{ display: 'flex', gap: 8 }}>
        <button type="button" onClick={onNext} style={{ ...smallBtn, flex: 1, background: UI.primary, color: '#0b1f4b', fontSize: 12 }}>
          Next film
        </button>
        <button type="button" onClick={onRetry} style={{ ...smallBtn, fontSize: 12 }}>
          Read again
        </button>
      </div>
    </div>
  );
}

// ───────── screen ─────────

export function RadiologyScreen() {
  const forced = useMemo(pickQuality, []);
  const [quality, setQuality] = useState<FxQuality>(forced ?? 'high');
  const [dpr, setDpr] = useState(1);
  const runtime = useMemo(() => makeRuntime(RAD_SPAWN.x, RAD_SPAWN.z, RAD_SPAWN.yaw), []);
  const [fade, setFade] = useState(1);
  const [menu, setMenu] = useState(false);
  const [nearExit, setNearExit] = useState(false);
  const leaving = useRef(false);

  const [filter, setFilter] = useState<Filter>('all');
  const [caseId, setCaseId] = useState(RAD_CASES[0].id);
  const c = useMemo(() => RAD_CASES.find((x) => x.id === caseId) ?? RAD_CASES[0], [caseId]);
  const list = useMemo(() => (filter === 'all' ? RAD_CASES : RAD_CASES.filter((x) => x.modality === filter)), [filter]);
  const [viewerOpen, setViewerOpen] = useState(true);
  const [draft, setDraft] = useState('');
  const [transcript, setTranscript] = useState<string[]>([]);
  const [dx, setDx] = useState<string | null>(null);
  const [customDx, setCustomDx] = useState('');
  const [probing, setProbing] = useState(false);
  const [grading, setGrading] = useState(false);
  const [grade, setGrade] = useState<RadGrade | null>(null);
  const transcriptRef = useRef<string[]>([]);
  transcriptRef.current = transcript;
  const caseRef = useRef(c);
  caseRef.current = c;
  const abortRef = useRef<AbortController | null>(null);
  const logEnd = useRef<HTMLDivElement>(null);
  const sessionRef = useRef<RadiologistSession | null>(null);

  const onStudentFinal = useCallback((text: string) => {
    setTranscript((t) => [...t.slice(-40), text]);
    const m = text.trim().match(DX_RE);
    if (m) {
      setCustomDx(m[1].replace(/[.?!]+$/, ''));
      setDx(null);
    }
  }, []);
  const session = useRadiologistSession({ onStudentFinal });
  sessionRef.current = session;

  // New film on the screen: reset the read and ground the consultant.
  const firstCase = useRef(true);
  useEffect(() => {
    abortRef.current?.abort();
    setDraft('');
    setTranscript([]);
    setDx(null);
    setCustomDx('');
    setGrade(null);
    setProbing(false);
    setGrading(false);
    sessionRef.current?.setCase(c);
    if (firstCase.current) firstCase.current = false;
    else sessionRef.current?.speak(filmIntroLine(c, store.getState().lang), { log: true });
  }, [c]);

  useEffect(() => {
    void loadSignFonts();
    const t = window.setTimeout(() => setFade(0), 120);
    if (import.meta.env.DEV) (window as unknown as { __medsimPlayer?: PlayerRuntime }).__medsimPlayer = runtime;
    return () => {
      window.clearTimeout(t);
      abortRef.current?.abort();
    };
  }, [runtime]);

  useEffect(() => {
    runtime.inputEnabled = !menu && !leaving.current;
  }, [menu, runtime]);

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [session.log.length]);

  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    runtime.inputEnabled = false;
    abortRef.current?.abort();
    setMenu(false);
    setFade(1);
    sessionRef.current?.hangUp();
    window.setTimeout(() => store.exitRadiologyToCorridor(), 600);
  }, [runtime]);

  const step = useCallback(
    (dir: 1 | -1) => {
      const idx = list.findIndex((x) => x.id === caseRef.current.id);
      const next = list[(idx + dir + list.length) % list.length] ?? list[0];
      if (next) setCaseId(next.id);
    },
    [list],
  );

  const pickFilter = (f: Filter) => {
    setFilter(f);
    const pool = f === 'all' ? RAD_CASES : RAD_CASES.filter((x) => x.modality === f);
    if (!pool.some((x) => x.id === caseRef.current.id) && pool[0]) setCaseId(pool[0].id);
  };

  /** Send the typed description to the consultant: live agent, else backend probe. */
  const sendDescription = useCallback(async () => {
    const text = draft.trim();
    if (!text || probing) return;
    setDraft('');
    const all = [...transcriptRef.current, text];
    setTranscript(all.slice(-40));
    const m = text.match(DX_RE);
    if (m) setCustomDx(m[1].replace(/[.?!]+$/, ''));
    const took = await sessionRef.current?.sendTyped(text);
    if (took) return;
    const cur = caseRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setProbing(true);
    try {
      const { question } = await postJson<{ question: string }>('/agent/radiology/probe', { caseId: cur.id, transcript: all, lang: store.getState().lang }, ac.signal);
      if (!ac.signal.aborted) sessionRef.current?.speak(question, { log: true });
    } catch {
      if (!ac.signal.aborted) sessionRef.current?.speak(probeOffline(cur, all.join('\n')), { log: true });
    } finally {
      if (!ac.signal.aborted) setProbing(false);
    }
  }, [draft, probing]);

  const committed = (customDx.trim() || dx || '').trim();
  const described = transcript.length > 0 || draft.trim().length > 0;

  const gradeRead = useCallback(async () => {
    if (!committed || grading) return;
    const cur = caseRef.current;
    const pending = draft.trim();
    const lines = pending ? [...transcriptRef.current, pending] : transcriptRef.current;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setGrading(true);
    let g: RadGrade;
    try {
      g = await postJson<RadGrade>(
        '/agent/radiology/grade',
        { caseId: cur.id, description: '', transcript: lines.slice(-60), diagnosis: committed, lang: store.getState().lang },
        ac.signal,
      );
    } catch {
      if (ac.signal.aborted) return;
      g = gradeOffline(cur, lines.join('\n'), committed);
    }
    if (ac.signal.aborted) return;
    setGrading(false);
    setGrade(g);
    setViewerOpen(true);
    sessionRef.current?.speak(
      g.diagnosisCorrect
        ? `Achha, I agree: ${g.correctDiagnosis}. ${g.missedFindings.length ? 'Look at what you missed on the card.' : 'Well read.'}`
        : `Not quite. This is ${g.correctDiagnosis}. Go through the card and look at the film again.`,
      { log: true },
    );
  }, [committed, grading, draft]);

  const retry = () => {
    setGrade(null);
    setTranscript([]);
    setDx(null);
    setCustomDx('');
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.repeat) return;
      if (e.code === 'Escape') {
        if (!leaving.current) setMenu((m) => !m);
        return;
      }
      if (menu) return;
      if (e.code === 'KeyE' && nearExit) {
        e.preventDefault();
        leave();
      } else if (e.code === 'KeyT') {
        e.preventDefault();
        sessionRef.current?.toggle();
      } else if (e.code === 'KeyV') {
        e.preventDefault();
        setViewerOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, nearExit, leave]);

  const live = session.live;
  const options = useMemo(() => diagnosisOptions(c), [c]);
  const idxInList = list.findIndex((x) => x.id === c.id);
  const filters: Filter[] = ['all', 'cxr', 'axr', 'ecg', 'ct-head', 'us', 'xr-limb'];

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#050b1a', overflow: 'hidden' }}>
      <Canvas
        shadows
        dpr={dpr}
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
        camera={{ fov: 56, near: 0.05, far: 60, position: [RAD_SPAWN.x, 1.9, RAD_SPAWN.z + 2.5] }}
        style={{ position: 'absolute', inset: 0 }}
        onCreated={(st) => {
          if (import.meta.env.DEV) (window as unknown as { __r3f?: unknown }).__r3f = st;
        }}
      >
        <color attach="background" args={['#06080c']} />
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
          <WorldEnvironment intensity={0.18} />
          <RadiologyWorld runtime={runtime} film={c} mouth={session.mouth} />
          <ThirdPersonPlayer runtime={runtime} colliders={RAD_COLLIDERS} rig={CAMERA_RIG} />
          <ExitProbe runtime={runtime} onChange={setNearExit} />
          <PostFX quality={quality} />
        </Suspense>
      </Canvas>

      {/* location */}
      <div style={{ ...panel, position: 'absolute', top: 16, left: 16, padding: '8px 12px', pointerEvents: 'none', zIndex: 5 }}>
        <div style={{ ...labelStyle, color: UI.primary, fontSize: 11 }}>Radiology · रेडियोलॉजी</div>
        <div style={{ fontFamily: UI.heading, fontSize: 28, lineHeight: 1, marginTop: 2 }}>Reading Room</div>
      </div>
      <button type="button" onClick={() => setMenu(true)} style={{ ...panel, ...labelStyle, position: 'absolute', top: 16, right: PANEL_W + 32, padding: '10px 14px', cursor: 'pointer', zIndex: 5 }}>
        Menu · Esc
      </button>

      {/* film viewer + results */}
      {viewerOpen && (
        <div style={{ position: 'absolute', left: 16, top: 76, right: PANEL_W + 32, bottom: 16, zIndex: 8, display: 'flex', gap: 12 }}>
          <div style={{ flex: grade ? 1.25 : 1, minWidth: 0 }}>
            <FilmViewer c={c} onHide={() => setViewerOpen(false)} />
          </div>
          {grade && (
            <div style={{ flex: 1, minWidth: 280, maxWidth: 460 }}>
              <ResultsCard c={c} grade={grade} onNext={() => step(1)} onRetry={retry} />
            </div>
          )}
        </div>
      )}
      {!viewerOpen && (
        <button
          type="button"
          onClick={() => setViewerOpen(true)}
          style={{ ...panel, ...labelStyle, position: 'absolute', left: 16, top: 84, padding: '10px 14px', cursor: 'pointer', zIndex: 8, display: 'flex', gap: 8, alignItems: 'center' }}
        >
          <KeyCap>V</KeyCap> Film viewer · {c.study}
        </button>
      )}

      {/* consultant panel */}
      <aside
        aria-label={`${RADIOLOGIST.name}, consultant radiologist`}
        style={{ ...panel, position: 'absolute', top: 16, right: 16, bottom: 16, width: PANEL_W, padding: 12, display: 'flex', flexDirection: 'column', gap: 9, zIndex: 9, boxSizing: 'border-box', overflow: 'auto' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 42, height: 42, flex: 'none', background: '#2b3a52', border: `2px solid ${UI.line}`, display: 'grid', placeItems: 'center', fontFamily: UI.heading, fontSize: 24, color: '#e6ebf2' }} aria-hidden="true">
            VR
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: UI.heading, fontSize: 26, lineHeight: 1 }}>{RADIOLOGIST.name}</div>
            <div style={{ ...labelStyle, fontSize: 10, opacity: 0.8 }}>{RADIOLOGIST.title}</div>
          </div>
          <span style={{ ...labelStyle, fontSize: 10, marginLeft: 'auto', padding: '3px 6px', background: live ? UI.primary : UI.bg, color: live ? '#0b1f4b' : UI.text, border: `2px solid ${UI.line}`, whiteSpace: 'nowrap' }}>
            {probing ? 'Thinking...' : STATUS_LABEL[session.status] ?? session.status}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            type="button"
            onClick={session.toggle}
            style={{ ...smallBtn, flex: 1, fontSize: 12, padding: '10px', background: live || session.status === 'loading' ? UI.bg : UI.primary, color: live || session.status === 'loading' ? UI.text : '#0b1f4b' }}
          >
            {live || session.status === 'loading' ? 'Hang up' : `Talk to ${RADIOLOGIST.short}`} <span style={{ opacity: 0.75 }}>· T</span>
          </button>
          {live && (
            <button type="button" onClick={session.toggleMic} style={smallBtn} aria-pressed={session.micMuted}>
              {session.micMuted ? 'Unmute' : 'Mute'}
            </button>
          )}
          <LangToggle className="lang-toggle--end" />
        </div>
        {session.status === 'loading' && session.progress && <div style={{ ...labelStyle, fontSize: 10, opacity: 0.8 }}>{session.progress}</div>}
        {session.error && (
          <div role="alert" style={{ fontFamily: UI.label, fontSize: 13, color: UI.amber, lineHeight: 1.3 }}>
            {session.error} You can still type your read below.{' '}
            <button type="button" onClick={session.clearError} style={{ ...smallBtn, padding: '2px 6px', fontSize: 10 }}>
              OK
            </button>
          </div>
        )}

        {/* case picker */}
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }} role="radiogroup" aria-label="Modality">
          {filters.map((f) => (
            <button
              key={f}
              type="button"
              role="radio"
              aria-checked={filter === f}
              onClick={() => pickFilter(f)}
              style={{ ...smallBtn, padding: '3px 6px', fontSize: 9, boxShadow: 'none', background: filter === f ? UI.amber : UI.bg, color: filter === f ? '#0b1f4b' : UI.text }}
            >
              {f === 'all' ? 'All' : MODALITY_LABEL[f]}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          <button type="button" onClick={() => step(-1)} style={{ ...smallBtn, padding: '6px 9px' }} aria-label="Previous film">
            ‹
          </button>
          <div style={{ flex: 1, textAlign: 'center' }}>
            <div style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>
              Film {idxInList + 1} of {list.length}
            </div>
            <div style={{ fontFamily: UI.heading, fontSize: 20, lineHeight: 1 }}>{c.study}</div>
          </div>
          <button type="button" onClick={() => step(1)} style={{ ...smallBtn, padding: '6px 9px' }} aria-label="Next film">
            ›
          </button>
        </div>

        {/* vignette */}
        <div style={{ background: UI.bg, border: `2px solid ${UI.line}`, padding: '8px 10px' }}>
          <div style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>
            {c.patient.name} · {c.patient.age}
            {c.patient.sex} · {c.patient.place}
          </div>
          <div style={{ fontFamily: UI.label, fontSize: 13, lineHeight: 1.4, marginTop: 4 }}>{c.vignette}</div>
        </div>

        {/* consultant line + log */}
        <div style={{ background: UI.bg, border: `2px solid ${UI.line}`, padding: '8px 10px', fontFamily: UI.label, fontSize: 14, lineHeight: 1.4, maxHeight: 96, overflow: 'auto' }} aria-live="polite">
          <span style={{ ...labelStyle, fontSize: 10, color: UI.primary, display: 'block', marginBottom: 3 }}>{RADIOLOGIST.short}</span>
          {session.caption}
        </div>
        <div style={{ flex: 1, minHeight: 50, overflow: 'auto', display: 'grid', alignContent: 'start', gap: 5 }}>
          {session.log.map((l) => (
            <div key={l.id} style={{ fontFamily: UI.label, fontSize: 12.5, lineHeight: 1.35, opacity: 0.92, textAlign: l.who === 'you' ? 'right' : 'left' }}>
              <span style={{ ...labelStyle, fontSize: 9, color: l.who === 'you' ? UI.amber : UI.primary }}>{l.who === 'you' ? 'You' : RADIOLOGIST.short}</span>
              <div>{l.text}</div>
            </div>
          ))}
          <div ref={logEnd} />
        </div>

        {/* 1. describe */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void sendDescription();
          }}
          style={{ display: 'grid', gap: 6 }}
        >
          <label htmlFor="rad-describe" style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>
            1 · Describe the film {live ? '(speak, or type)' : '(type, or press T to speak)'}
          </label>
          <textarea
            id="rad-describe"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                void sendDescription();
              }
            }}
            rows={3}
            placeholder="PA film, adequate. Trachea central. There is a dense consolidation in the right lower zone..."
            style={{ ...field, resize: 'vertical', minHeight: 64 }}
          />
          <button type="submit" disabled={!draft.trim() || probing} style={{ ...smallBtn, background: UI.primary, color: '#0b1f4b', opacity: !draft.trim() || probing ? 0.6 : 1 }}>
            {probing ? `${RADIOLOGIST.short} is looking...` : `Tell ${RADIOLOGIST.short}`}
          </button>
        </form>

        {/* 2. commit */}
        <div style={{ borderTop: `2px solid ${UI.line}`, paddingTop: 8, display: 'grid', gap: 6 }}>
          <div style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>2 · Commit to a diagnosis</div>
          <div role="radiogroup" aria-label="Diagnosis" style={{ display: 'grid', gap: 4 }}>
            {options.map((o) => (
              <button
                key={o}
                type="button"
                role="radio"
                aria-checked={dx === o && !customDx}
                disabled={!!grade}
                onClick={() => {
                  setDx(o);
                  setCustomDx('');
                }}
                style={{
                  ...smallBtn,
                  textTransform: 'none',
                  letterSpacing: '.02em',
                  fontSize: 12,
                  textAlign: 'left',
                  padding: '6px 8px',
                  boxShadow: 'none',
                  background: dx === o && !customDx ? UI.amber : UI.bg,
                  color: dx === o && !customDx ? '#0b1f4b' : UI.text,
                }}
              >
                {o}
              </button>
            ))}
          </div>
          <input
            value={customDx}
            onChange={(e) => setCustomDx(e.target.value)}
            disabled={!!grade}
            placeholder='Or type it ("my diagnosis is...")'
            aria-label="Your diagnosis"
            style={field}
          />
          <button
            type="button"
            onClick={() => void gradeRead()}
            disabled={!committed || grading || !!grade}
            title={!described ? 'Describe the film first for a fair score' : undefined}
            style={{ ...smallBtn, fontSize: 12, padding: '10px', background: committed && !grade ? UI.primary : UI.bg, color: committed && !grade ? '#0b1f4b' : UI.text, opacity: !committed || grading || grade ? 0.6 : 1 }}
          >
            {grading ? 'Grading...' : grade ? `Graded: ${grade.score}/100` : 'Grade my read'}
          </button>
          {!described && committed && !grade && (
            <div style={{ fontFamily: UI.label, fontSize: 12, color: UI.amber }}>You have not described any findings yet; they count for 60% of the score.</div>
          )}
        </div>
      </aside>

      {/* room actions */}
      {!viewerOpen && (
        <div style={{ position: 'absolute', left: 16, bottom: 16, zIndex: 6, display: 'grid', gap: 8, width: 250 }}>
          <div style={{ ...panel, padding: '10px 12px', pointerEvents: 'none' }}>
            <div style={{ ...labelStyle, color: UI.primary }}>Controls</div>
            {[
              ['WASD', 'Walk'],
              ['T', `Talk to ${RADIOLOGIST.short}`],
              ['V', 'Film viewer'],
              ['E', 'Exit door'],
              ['Esc', 'Menu'],
            ].map(([k, v]) => (
              <div key={k} style={{ display: 'flex', alignItems: 'center', gap: 2, marginTop: 6 }}>
                <KeyCap>{k}</KeyCap>
                <span style={{ ...labelStyle, fontSize: 11, opacity: 0.9 }}>{v}</span>
              </div>
            ))}
          </div>
          <button type="button" onClick={leave} style={{ ...panel, ...labelStyle, padding: '10px 14px', textAlign: 'left', cursor: 'pointer' }}>
            Leave reading room
          </button>
        </div>
      )}

      {!menu && nearExit && !viewerOpen && (
        <div style={{ position: 'absolute', left: 0, right: PANEL_W + 32, bottom: 0, top: 0, pointerEvents: 'none', zIndex: 7 }}>
          <PromptPill title="Return to corridor" sub="Radiology" />
        </div>
      )}

      {menu && (
        <PauseMenu title="Reading paused">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...labelStyle, fontSize: 11, color: UI.primary }}>Voice language</span>
            <LangToggle className="lang-toggle--end" />
          </div>
          <MenuButton primary autoFocus onClick={() => setMenu(false)}>
            Resume
          </MenuButton>
          <MenuButton
            onClick={() => {
              setMenu(false);
              setViewerOpen((o) => !o);
            }}
          >
            {viewerOpen ? 'Room view' : 'Film viewer'}
          </MenuButton>
          <MenuButton onClick={leave}>Leave reading room (back to corridor)</MenuButton>
        </PauseMenu>
      )}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 60 }}>
        <Fade opacity={fade} />
      </div>
    </div>
  );
}

export default RadiologyScreen;
