import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { store, useStore } from '../../game/store';
import { LangToggle } from '../ui/LangToggle';
import { CLASS_COLLIDERS, CLASS_EXIT, CLASS_SPAWN, ClassroomWorld } from '../world/Classroom';
import { ThirdPersonPlayer, isTypingTarget, makeRuntime, type PlayerRuntime } from '../world/ThirdPersonPlayer';
import { PostFX, WorldEnvironment, type FxQuality } from '../world/WorldFX';
import { Fade, KeyCap, MenuButton, PauseMenu, PromptPill, UI, labelStyle, panel } from '../world/worldUi';
import { loadSignFonts } from '../world/hindi';
import { Whiteboard, type BoardStep } from '../teach/Whiteboard';
import { FALLBACK_LESSON, SUGGESTED_TOPICS, detectTopicRequest, fetchLesson, type Lesson, type LessonLevel } from '../teach/lesson';
import { useTeacherSession, type TeacherSession } from '../teach/useTeacherSession';
import { TEACHER } from '../../voice/teacherPersona';

const CAMERA_RIG = { distance: 2.8, minDistance: 1.2, maxDistance: 5.5, pivotHeight: 1.58, shoulder: 0.4, ceiling: 3.4 };
const PANEL_W = 360;

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
    const near = Math.hypot(runtime.pos.x - CLASS_EXIT.x, runtime.pos.z - CLASS_EXIT.z) < 1.3;
    if (near !== cur.current) {
      cur.current = near;
      onChange(near);
    }
  });
  return null;
}

const STATUS_LABEL: Record<string, string> = {
  uninitialized: 'Voice off',
  loading: 'Connecting…',
  ready: 'Listening',
  listening: 'Hearing you',
  thinking: 'Thinking…',
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

const input: CSSProperties = {
  flex: 1,
  minWidth: 0,
  fontFamily: UI.label,
  fontSize: 14,
  padding: '9px 10px',
  border: `2px solid ${UI.line}`,
  background: UI.bg,
  color: UI.text,
  outline: 'none',
};

export function ClassroomScreen() {
  const forced = useMemo(pickQuality, []);
  const [quality, setQuality] = useState<FxQuality>(forced ?? 'high');
  const [dpr, setDpr] = useState(1);
  const runtime = useMemo(() => makeRuntime(CLASS_SPAWN.x, CLASS_SPAWN.z, CLASS_SPAWN.yaw), []);
  const [fade, setFade] = useState(1);
  const [menu, setMenu] = useState(false);
  const [nearExit, setNearExit] = useState(false);
  const leaving = useRef(false);

  const lang = useStore((s) => s.lang);
  const langRef = useRef(lang);
  langRef.current = lang;
  const [lesson, setLesson] = useState<Lesson | null>(null);
  const [lessonKey, setLessonKey] = useState(0);
  const [boardStep, setBoardStep] = useState<BoardStep>(0);
  const [boardOpen, setBoardOpen] = useState(true);
  const [loadingTopic, setLoadingTopic] = useState<string | null>(null);
  const [lessonError, setLessonError] = useState('');
  const [pauseToken, setPauseToken] = useState(0);
  const [level, setLevel] = useState<LessonLevel>('student');
  const [topicDraft, setTopicDraft] = useState('');
  const [question, setQuestion] = useState('');
  const abortRef = useRef<AbortController | null>(null);
  const lessonRef = useRef<Lesson | null>(null);
  lessonRef.current = lesson;
  const levelRef = useRef(level);
  levelRef.current = level;
  const topicInput = useRef<HTMLInputElement>(null);
  const logEnd = useRef<HTMLDivElement>(null);

  const teacherRef = useRef<TeacherSession | null>(null);

  const startLesson = useCallback((rawTopic: string, opts: { typed?: boolean } = {}) => {
    const topic = rawTopic.trim();
    if (!topic) return;
    abortRef.current?.abort();
    const ac = new AbortController();
    abortRef.current = ac;
    setLessonError('');
    setLoadingTopic(topic);
    if (opts.typed) teacherRef.current?.speak(`Achha, ${topic}. Give me a moment, I will draw it on the board for you.`, { log: true });
    fetchLesson(topic, levelRef.current, ac.signal, langRef.current)
      .catch((err: unknown) => {
        if (ac.signal.aborted) throw err;
        // Built-in lesson keeps the demo alive when the backend is down.
        if (/cardiac|heart ?beat|heart cycle/i.test(topic)) return { ...FALLBACK_LESSON, level: levelRef.current };
        throw err;
      })
      .then((l) => {
        if (ac.signal.aborted) return;
        setLesson(l);
        setLessonKey((k) => k + 1);
        setBoardStep(0);
        setBoardOpen(true);
        setLoadingTopic(null);
        teacherRef.current?.setLesson(l);
      })
      .catch((err: unknown) => {
        if (ac.signal.aborted) return;
        setLoadingTopic(null);
        setLessonError(err instanceof Error ? err.message : String(err));
      });
  }, []);

  // Language switched with a lesson on the board: redraw it in the new language.
  const prevLang = useRef(lang);
  useEffect(() => {
    if (prevLang.current === lang) return;
    prevLang.current = lang;
    const l = lessonRef.current;
    if (l) startLesson(l.title);
  }, [lang, startLesson]);

  const onStudentFinal = useCallback(
    (text: string, typed: boolean) => {
      const topic = detectTopicRequest(text, !!lessonRef.current);
      if (topic) {
        startLesson(topic, { typed });
        return;
      }
      // A question mid-lesson: pause the board so the answer isn't talked over.
      if (lessonRef.current) setPauseToken((t) => t + 1);
      void teacherRef.current?.sendQuestion(text, typed);
    },
    [startLesson],
  );

  const teacher = useTeacherSession({ onStudentFinal });
  teacherRef.current = teacher;

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
  }, [teacher.log.length]);

  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    runtime.inputEnabled = false;
    abortRef.current?.abort();
    setMenu(false);
    setFade(1);
    teacherRef.current?.hangUp();
    window.setTimeout(() => store.exitClassroomToCorridor(), 600);
  }, [runtime]);

  const onStep = useCallback((step: BoardStep) => {
    const l = lessonRef.current;
    setBoardStep(step);
    if (!l) return;
    if (step === 'quiz') teacherRef.current?.speak(`Quiz time! ${l.quiz.question} Pick your answer on the board.`);
    else teacherRef.current?.speak(l.steps[step].narration);
  }, []);

  const onQuizAnswer = useCallback((i: number, correct: boolean) => {
    const l = lessonRef.current;
    if (!l) return;
    const ans = l.quiz.options[l.quiz.answerIndex];
    teacherRef.current?.speak(
      correct ? `Correct, well done! ${l.quiz.why}` : `Not quite, but good try. The answer is ${ans}. ${l.quiz.why}`,
      { log: true },
    );
    void i;
  }, []);

  const newTopic = useCallback(() => {
    setLesson(null);
    setBoardStep(0);
    teacherRef.current?.setLesson(null);
    window.setTimeout(() => topicInput.current?.focus(), 50);
  }, []);

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
        teacherRef.current?.toggle();
      } else if (e.code === 'KeyB' && lessonRef.current) {
        e.preventDefault();
        setBoardOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, nearExit, leave]);

  const submitTopic = (t: string) => {
    if (!t.trim()) return;
    setTopicDraft('');
    teacher.ask(`Teach me ${t.trim()}`);
  };

  const submitQuestion = () => {
    const q = question.trim();
    if (!q) return;
    setQuestion('');
    void teacher.ask(q);
  };

  const live = teacher.live;
  const statusText = STATUS_LABEL[teacher.status] ?? teacher.status;
  const stepLabel = lesson ? (boardStep === 'quiz' ? 'Quiz' : `Step ${boardStep + 1}/${lesson.steps.length}`) : '';

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#050b1a', overflow: 'hidden' }}>
      <Canvas
        shadows
        dpr={dpr}
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
        camera={{ fov: 56, near: 0.05, far: 80, position: [CLASS_SPAWN.x, 1.9, CLASS_SPAWN.z + 2.5] }}
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
          <ClassroomWorld runtime={runtime} lesson={lesson} step={boardStep} loadingTopic={loadingTopic ?? undefined} mouth={teacher.mouth} />
          <ThirdPersonPlayer runtime={runtime} colliders={CLASS_COLLIDERS} rig={CAMERA_RIG} />
          <ExitProbe runtime={runtime} onChange={setNearExit} />
          <PostFX quality={quality} />
        </Suspense>
      </Canvas>

      {/* location */}
      <div style={{ ...panel, position: 'absolute', top: 16, left: 16, padding: '8px 12px', pointerEvents: 'none', zIndex: 5 }}>
        <div style={{ ...labelStyle, color: UI.primary, fontSize: 11 }}>Teacher Portal · शिक्षक पोर्टल</div>
        <div style={{ fontFamily: UI.heading, fontSize: 28, lineHeight: 1, marginTop: 2 }}>Lecture Hall 1</div>
      </div>
      <button type="button" onClick={() => setMenu(true)} style={{ ...panel, ...labelStyle, position: 'absolute', top: 16, right: PANEL_W + 32, padding: '10px 14px', cursor: 'pointer', zIndex: 5 }}>
        Menu · Esc
      </button>

      {/* whiteboard view (kept mounted while hidden so playback continues) */}
      {lesson && (
        <div
          style={{
            position: 'absolute',
            left: 16,
            top: 76,
            right: PANEL_W + 32,
            bottom: 16,
            zIndex: 8,
            display: boardOpen ? 'block' : 'none',
          }}
        >
          <Whiteboard
            key={lessonKey}
            lesson={lesson}
            isSpeaking={teacher.isSpeaking}
            onStep={onStep}
            onQuizAnswer={onQuizAnswer}
            pauseToken={pauseToken}
            onNewTopic={newTopic}
            onHide={() => setBoardOpen(false)}
          />
        </div>
      )}
      {lesson && !boardOpen && (
        <button
          type="button"
          onClick={() => setBoardOpen(true)}
          style={{ ...panel, ...labelStyle, position: 'absolute', left: 16, top: 84, padding: '10px 14px', cursor: 'pointer', zIndex: 8, display: 'flex', gap: 8, alignItems: 'center' }}
        >
          <KeyCap>B</KeyCap> Whiteboard view · {stepLabel}
        </button>
      )}

      {/* teacher panel */}
      <aside
        aria-label={`${TEACHER.name}, your teacher`}
        style={{ ...panel, position: 'absolute', top: 16, right: 16, bottom: 16, width: PANEL_W, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, zIndex: 9, boxSizing: 'border-box' }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <div style={{ width: 44, height: 44, flex: 'none', background: '#7a1630', border: `2px solid ${UI.line}`, display: 'grid', placeItems: 'center', fontFamily: UI.heading, fontSize: 26, color: '#f3e3b0' }} aria-hidden="true">
            MI
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontFamily: UI.heading, fontSize: 28, lineHeight: 1 }}>{TEACHER.name}</div>
            <div style={{ ...labelStyle, fontSize: 10, opacity: 0.8 }}>{TEACHER.title}</div>
          </div>
          <span
            style={{ ...labelStyle, fontSize: 10, marginLeft: 'auto', padding: '3px 6px', background: live ? UI.primary : UI.bg, color: live ? '#0b1f4b' : UI.text, border: `2px solid ${UI.line}`, whiteSpace: 'nowrap' }}
          >
            {teacher.thinking ? 'Thinking…' : statusText}
          </span>
        </div>

        <div style={{ display: 'flex', gap: 8 }}>
          <button
            type="button"
            onClick={teacher.toggle}
            style={{ ...smallBtn, flex: 1, fontSize: 12, padding: '11px 10px', background: live || teacher.status === 'loading' ? UI.bg : UI.primary, color: live || teacher.status === 'loading' ? UI.text : '#0b1f4b' }}
          >
            {live || teacher.status === 'loading' ? 'Hang up' : 'Talk to Dr. Iyer'} <span style={{ opacity: 0.75 }}>· T</span>
          </button>
          {live && (
            <button type="button" onClick={teacher.toggleMic} style={smallBtn} aria-pressed={teacher.micMuted}>
              {teacher.micMuted ? 'Unmute' : 'Mute'}
            </button>
          )}
        </div>
        {teacher.status === 'loading' && teacher.progress && <div style={{ ...labelStyle, fontSize: 10, opacity: 0.8 }}>{teacher.progress}</div>}
        {teacher.error && (
          <div role="alert" style={{ fontFamily: UI.label, fontSize: 13, color: UI.amber, lineHeight: 1.3 }}>
            {teacher.error}{' '}
            <button type="button" onClick={teacher.clearError} style={{ ...smallBtn, padding: '2px 6px', fontSize: 10 }}>
              OK
            </button>
          </div>
        )}

        {/* session language: teacher voice, narration and the lesson text follow it */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>Teacher language</span>
          <LangToggle className="lang-toggle--end" />
        </div>

        {/* current teacher line */}
        <div style={{ background: UI.bg, border: `2px solid ${UI.line}`, padding: '10px 12px', fontFamily: UI.label, fontSize: 15, lineHeight: 1.4, maxHeight: 132, overflow: 'auto' }} aria-live="polite">
          <span style={{ ...labelStyle, fontSize: 10, color: UI.primary, display: 'block', marginBottom: 4 }}>{TEACHER.short}</span>
          {teacher.teacherCaption}
        </div>

        {/* conversation log */}
        <div style={{ flex: 1, minHeight: 60, overflow: 'auto', display: 'grid', alignContent: 'start', gap: 6 }}>
          {teacher.log.map((l) => (
            <div key={l.id} style={{ fontFamily: UI.label, fontSize: 13, lineHeight: 1.35, opacity: 0.92, textAlign: l.who === 'you' ? 'right' : 'left' }}>
              <span style={{ ...labelStyle, fontSize: 9, color: l.who === 'you' ? UI.amber : UI.primary }}>{l.who === 'you' ? 'You' : TEACHER.short}</span>
              <div>{l.text}</div>
            </div>
          ))}
          <div ref={logEnd} />
        </div>

        {/* ask */}
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitQuestion();
          }}
          style={{ display: 'flex', gap: 6 }}
        >
          <input
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            placeholder={live ? 'Speak, or type a question…' : 'Type a question for Dr. Iyer…'}
            aria-label="Ask the teacher"
            style={input}
          />
          <button type="submit" style={{ ...smallBtn, background: UI.primary, color: '#0b1f4b' }} disabled={teacher.thinking}>
            Ask
          </button>
        </form>

        {/* lesson picker */}
        <div style={{ borderTop: `2px solid ${UI.line}`, paddingTop: 10, display: 'grid', gap: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...labelStyle, color: UI.primary }}>New lesson</span>
            <div role="radiogroup" aria-label="Level" style={{ display: 'flex', marginLeft: 'auto' }}>
              {(['student', 'intern'] as const).map((lv) => (
                <button
                  key={lv}
                  type="button"
                  role="radio"
                  aria-checked={level === lv}
                  onClick={() => setLevel(lv)}
                  style={{ ...smallBtn, padding: '4px 8px', fontSize: 10, boxShadow: 'none', background: level === lv ? UI.amber : UI.bg, color: level === lv ? '#0b1f4b' : UI.text }}
                >
                  {lv}
                </button>
              ))}
            </div>
          </div>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              submitTopic(topicDraft);
            }}
            style={{ display: 'flex', gap: 6 }}
          >
            <input ref={topicInput} value={topicDraft} onChange={(e) => setTopicDraft(e.target.value)} placeholder='Any topic, or say "teach me…"' aria-label="Lesson topic" style={input} />
            <button type="submit" style={{ ...smallBtn, background: UI.primary, color: '#0b1f4b' }} disabled={!!loadingTopic}>
              Teach
            </button>
          </form>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SUGGESTED_TOPICS.map((t) => (
              <button key={t} type="button" onClick={() => submitTopic(t)} disabled={!!loadingTopic} style={{ ...smallBtn, padding: '6px 8px', fontSize: 10, textTransform: 'none', letterSpacing: '.04em' }}>
                {t}
              </button>
            ))}
          </div>
          {loadingTopic && (
            <div role="status" style={{ ...labelStyle, fontSize: 11, color: UI.amber }}>
              Preparing “{loadingTopic}” on the board…
            </div>
          )}
          {lessonError && (
            <div role="alert" style={{ fontFamily: UI.label, fontSize: 13, color: UI.amber, lineHeight: 1.3 }}>
              Couldn’t prepare that lesson: {lessonError}{' '}
              <button type="button" onClick={() => startLesson('Cardiac cycle')} style={{ ...smallBtn, padding: '3px 6px', fontSize: 10 }}>
                Try Cardiac cycle
              </button>
            </div>
          )}
        </div>
      </aside>

      {/* room actions */}
      {(!lesson || !boardOpen) && (
        <div style={{ position: 'absolute', left: 16, bottom: 16, zIndex: 6, display: 'grid', gap: 8, width: 250 }}>
          <div style={{ ...panel, padding: '10px 12px', pointerEvents: 'none' }}>
            <div style={{ ...labelStyle, color: UI.primary }}>Controls</div>
            {[
              ['WASD', 'Walk'],
              ['T', 'Talk to the teacher'],
              ['B', 'Whiteboard view'],
              ['Space', 'Play / pause lesson'],
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
            Leave lecture hall <span style={{ float: 'right', opacity: 0.8 }}>Esc</span>
          </button>
        </div>
      )}

      {!menu && nearExit && (!lesson || !boardOpen) && (
        <div style={{ position: 'absolute', left: 0, right: PANEL_W + 32, bottom: 0, top: 0, pointerEvents: 'none', zIndex: 7 }}>
          <PromptPill title="Return to corridor" sub="Teacher Portal" />
        </div>
      )}

      {menu && (
        <PauseMenu title="Class paused">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...labelStyle, fontSize: 11, color: UI.primary }}>Voice language</span>
            <LangToggle className="lang-toggle--end" />
          </div>
          <MenuButton primary autoFocus onClick={() => setMenu(false)}>Resume</MenuButton>
          {lesson && <MenuButton onClick={() => { setMenu(false); setBoardOpen((o) => !o); }}>{boardOpen ? 'Room view' : 'Whiteboard view'}</MenuButton>}
          <MenuButton onClick={leave}>Leave lecture hall (back to corridor)</MenuButton>
        </PauseMenu>
      )}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 60 }}>
        <Fade opacity={fade} />
      </div>
    </div>
  );
}

export default ClassroomScreen;
