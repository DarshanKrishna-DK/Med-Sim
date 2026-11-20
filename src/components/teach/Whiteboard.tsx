import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { BOARD_H, BOARD_W, DIAGRAM, HAND_FONT, buildStepDrawing, type Shape } from './layout';
import { estimateSpeechMs, type Lesson } from './lesson';
import { loadHandFont } from './boardTexture';
import { UI, labelStyle, panel } from '../world/worldUi';

export type BoardStep = number | 'quiz';

/** Minimum on-screen time after the last stroke, so the eye can settle. */
const SETTLE_MS = 1400;
/** If the teacher is still talking, wait at most this long past the plan. */
const MAX_SPEECH_OVERRUN_MS = 7000;

function stepDurationMs(lesson: Lesson, i: number, drawTotal: number): number {
  return Math.max(drawTotal * 1000 + SETTLE_MS, estimateSpeechMs(lesson.steps[i].narration) + 900);
}

// ───────── SVG drawing of one step ─────────

function ShapeEl({ s }: { s: Shape }) {
  if (s.t === 'path') {
    return (
      <>
        {s.fill && (
          <path d={s.d} fill={s.fill} stroke="none" className="wb-fade" style={{ animationDelay: `${s.delay + s.dur * 0.7}s` }} />
        )}
        <path
          d={s.d}
          fill="none"
          stroke={s.stroke}
          strokeWidth={s.w}
          strokeLinecap="round"
          strokeLinejoin="round"
          pathLength={1}
          className="wb-stroke"
          style={{ animationDelay: `${s.delay}s`, animationDuration: `${s.dur}s` }}
        />
      </>
    );
  }
  return (
    <text
      x={s.x}
      y={s.y}
      fill={s.color}
      fontSize={s.size}
      fontWeight={s.bold ? 700 : 400}
      textAnchor={s.anchor}
      transform={s.rotate ? `rotate(${s.rotate} ${s.x} ${s.y})` : undefined}
      className="wb-write"
      style={{ animationDelay: `${s.delay}s`, animationDuration: `${s.dur}s` }}
    >
      {s.text}
    </text>
  );
}

function StepSvg({ lesson, index }: { lesson: Lesson; index: number }) {
  const drawing = useMemo(() => buildStepDrawing(lesson.steps[index], index), [lesson, index]);
  const head = drawing.shapes.filter((s) => !s.diagram);
  const diag = drawing.shapes.filter((s) => s.diagram);
  return (
    <svg viewBox={`0 0 ${BOARD_W} ${BOARD_H}`} style={{ display: 'block', width: '100%', height: '100%', fontFamily: HAND_FONT }} role="img" aria-label={`${lesson.steps[index].heading}: ${lesson.steps[index].points.join('; ')}`}>
      <text x={BOARD_W - 36} y={40} textAnchor="end" fontSize={22} fill="#7b8592">
        {lesson.title}
      </text>
      {head.map((s, i) => (
        <ShapeEl key={i} s={s} />
      ))}
      <g transform={`translate(${DIAGRAM.x} ${DIAGRAM.y})`}>
        {diag.map((s, i) => (
          <ShapeEl key={i} s={s} />
        ))}
      </g>
    </svg>
  );
}

// ───────── icons ─────────

const Icon = {
  play: <path d="M7 5v14l12-7z" fill="currentColor" />,
  pause: <path d="M7 5h4v14H7zM13 5h4v14h-4z" fill="currentColor" />,
  replay: <path d="M12 5a7 7 0 1 1-6.6 4.7M5 4v5h5" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round" />,
  prev: <path d="M15 6l-6 6 6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />,
  next: <path d="M9 6l6 6-6 6" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />,
};

function IconButton({ label, onClick, children, primary }: { label: string; onClick: () => void; children: React.ReactNode; primary?: boolean }) {
  return (
    <button
      type="button"
      aria-label={label}
      title={label}
      onClick={onClick}
      style={{
        width: 40,
        height: 40,
        display: 'grid',
        placeItems: 'center',
        border: `2px solid ${UI.line}`,
        background: primary ? UI.primary : UI.bg,
        color: primary ? '#0b1f4b' : UI.text,
        boxShadow: '2px 2px 0 0 #061431',
        cursor: 'pointer',
        flex: 'none',
      }}
    >
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true">
        {children}
      </svg>
    </button>
  );
}

// ───────── quiz card ─────────

function QuizCard({
  lesson,
  answered,
  onAnswer,
  onReplay,
  onNewTopic,
}: {
  lesson: Lesson;
  answered: number | null;
  onAnswer: (i: number) => void;
  onReplay: () => void;
  onNewTopic?: () => void;
}) {
  const q = lesson.quiz;
  const correct = answered !== null && answered === q.answerIndex;
  return (
    <div style={{ position: 'absolute', inset: 0, padding: '4% 5%', fontFamily: HAND_FONT, color: '#1f2328', display: 'flex', flexDirection: 'column', gap: 12, overflow: 'auto' }}>
      <div style={{ fontSize: 'clamp(22px, 2.6vw, 34px)', fontWeight: 700, color: '#c0392b' }}>Quick quiz</div>
      <div style={{ fontSize: 'clamp(18px, 2vw, 28px)', fontWeight: 700, lineHeight: 1.25 }}>{q.question}</div>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(240px, 1fr))', gap: 10, marginTop: 4 }}>
        {q.options.map((o, i) => {
          const isAns = i === q.answerIndex;
          const picked = answered === i;
          const done = answered !== null;
          const border = done ? (isAns ? '#23804a' : picked ? '#c0392b' : '#c9ced6') : '#1f4fbf';
          const bg = done ? (isAns ? 'rgba(35,128,74,.12)' : picked ? 'rgba(192,57,43,.1)' : 'transparent') : 'transparent';
          return (
            <button
              key={i}
              type="button"
              disabled={done}
              onClick={() => onAnswer(i)}
              style={{
                textAlign: 'left',
                fontFamily: HAND_FONT,
                fontSize: 'clamp(16px, 1.7vw, 22px)',
                color: '#1f2328',
                padding: '10px 14px',
                border: `3px solid ${border}`,
                borderRadius: 14,
                background: bg,
                cursor: done ? 'default' : 'pointer',
                display: 'flex',
                gap: 10,
                alignItems: 'center',
              }}
            >
              <span style={{ fontWeight: 700, color: border, minWidth: 22 }}>{'ABCD'[i]}</span>
              <span>{o}</span>
            </button>
          );
        })}
      </div>
      {answered !== null && (
        <div role="status" style={{ fontSize: 'clamp(16px, 1.7vw, 22px)', lineHeight: 1.3, color: correct ? '#23804a' : '#c0392b' }}>
          <b>{correct ? 'Correct!' : `Not quite. The answer is ${'ABCD'[q.answerIndex]}.`}</b> <span style={{ color: '#1f2328' }}>{q.why}</span>
        </div>
      )}
      {answered !== null && (
        <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap', marginTop: 'auto' }}>
          <button type="button" onClick={onReplay} style={chipBtn}>
            Replay lesson
          </button>
          {onNewTopic && (
            <button type="button" onClick={onNewTopic} style={{ ...chipBtn, background: UI.primary, color: '#0b1f4b' }}>
              New topic
            </button>
          )}
        </div>
      )}
    </div>
  );
}

const chipBtn: CSSProperties = {
  ...labelStyle,
  fontSize: 12,
  padding: '10px 14px',
  border: `2px solid ${UI.line}`,
  background: UI.bg,
  color: UI.text,
  boxShadow: '2px 2px 0 0 #061431',
  cursor: 'pointer',
};

// ───────── player ─────────

export interface WhiteboardProps {
  lesson: Lesson;
  /** True while the teacher's voice is audible; holds auto-advance. */
  isSpeaking: () => boolean;
  /** A step (or the quiz) starts playing: speak its narration. */
  onStep: (step: BoardStep) => void;
  onQuizAnswer: (index: number, correct: boolean) => void;
  /** Changing this number pauses playback (e.g. the student asks a question). */
  pauseToken?: number;
  onNewTopic?: () => void;
  onHide?: () => void;
}

export function Whiteboard({ lesson, isSpeaking, onStep, onQuizAnswer, pauseToken = 0, onNewTopic, onHide }: WhiteboardProps) {
  const n = lesson.steps.length;
  const [step, setStep] = useState<BoardStep>(0);
  const [playing, setPlaying] = useState(true);
  const [runKey, setRunKey] = useState(0);
  const [elapsed, setElapsed] = useState(0);
  const [answered, setAnswered] = useState<number | null>(null);
  const [, setFontTick] = useState(0);
  const speakingRef = useRef(isSpeaking);
  speakingRef.current = isSpeaking;
  const onStepRef = useRef(onStep);
  onStepRef.current = onStep;

  useEffect(() => {
    void loadHandFont().then(() => setFontTick((t) => t + 1));
  }, []);

  const durations = useMemo(
    () => lesson.steps.map((s, i) => stepDurationMs(lesson, i, buildStepDrawing(s, i).total)),
    [lesson],
  );

  // A step begins: tell the parent (narration), reset the clock.
  const elapsedRef = useRef(0);
  useEffect(() => {
    elapsedRef.current = 0;
    setElapsed(0);
    onStepRef.current(step);
  }, [step, runKey]);

  // External pause (the student started talking).
  const firstToken = useRef(pauseToken);
  useEffect(() => {
    if (pauseToken !== firstToken.current) setPlaying(false);
  }, [pauseToken]);

  // Clock + auto-advance.
  useEffect(() => {
    if (!playing || step === 'quiz') return;
    const dur = durations[step];
    let last = performance.now();
    const id = window.setInterval(() => {
      const now = performance.now();
      elapsedRef.current += now - last;
      last = now;
      const e = elapsedRef.current;
      setElapsed(e);
      if (e >= dur && (!speakingRef.current() || e >= dur + MAX_SPEECH_OVERRUN_MS)) {
        window.clearInterval(id);
        setStep(step + 1 < n ? step + 1 : 'quiz');
      }
    }, 100);
    return () => window.clearInterval(id);
  }, [playing, step, durations, n]);

  const jump = useCallback((s: BoardStep) => {
    setPlaying(true);
    setStep(s);
    setRunKey((k) => k + 1);
  }, []);

  const replayAll = useCallback(() => {
    setAnswered(null);
    jump(0);
  }, [jump]);

  const togglePlay = useCallback(() => {
    if (step === 'quiz') return replayAll();
    setPlaying((p) => !p);
  }, [step, replayAll]);

  // Space = play/pause, arrows = prev/next (ignored while typing).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'BUTTON' || t.isContentEditable)) return;
      if (e.code === 'Space') {
        e.preventDefault();
        togglePlay();
      } else if (e.code === 'ArrowRight') {
        jump(typeof step === 'number' && step + 1 < n ? step + 1 : 'quiz');
      } else if (e.code === 'ArrowLeft') {
        jump(step === 'quiz' ? n - 1 : Math.max(0, step - 1));
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [togglePlay, jump, step, n]);

  const answer = (i: number) => {
    if (answered !== null) return;
    setAnswered(i);
    onQuizAnswer(i, i === lesson.quiz.answerIndex);
  };

  const idx = step === 'quiz' ? n : step;
  const stepFrac = step === 'quiz' ? 1 : Math.min(1, elapsed / durations[step]);
  const progress = (idx + (step === 'quiz' ? 0 : stepFrac)) / n;
  const caption = step === 'quiz' ? lesson.quiz.question : lesson.steps[step].narration;

  return (
    <div style={{ ...panel, padding: 12, display: 'flex', flexDirection: 'column', gap: 10, height: '100%', boxSizing: 'border-box' }}>
      <style>{`
        .wb-stroke{stroke-dasharray:1;stroke-dashoffset:1;animation-name:wb-draw;animation-timing-function:cubic-bezier(.45,.05,.4,1);animation-fill-mode:forwards}
        .wb-write{clip-path:inset(-20% 100% -20% -2%);animation-name:wb-write;animation-timing-function:steps(14,end);animation-fill-mode:forwards}
        .wb-fade{opacity:0;animation:wb-fade .4s ease forwards}
        .wb-paused .wb-stroke,.wb-paused .wb-write,.wb-paused .wb-fade{animation-play-state:paused}
        @keyframes wb-draw{to{stroke-dashoffset:0}}
        @keyframes wb-write{to{clip-path:inset(-20% -2% -20% -2%)}}
        @keyframes wb-fade{to{opacity:1}}
        @media (prefers-reduced-motion: reduce){.wb-stroke,.wb-write,.wb-fade{animation-duration:.01s!important;animation-delay:0s!important}}
      `}</style>

      <div style={{ display: 'flex', alignItems: 'baseline', gap: 12, minWidth: 0 }}>
        <span style={{ ...labelStyle, color: UI.primary, flex: 'none' }}>Whiteboard</span>
        <span style={{ fontFamily: UI.heading, fontSize: 30, lineHeight: 1, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }}>{lesson.title}</span>
        <span style={{ ...labelStyle, fontSize: 11, color: UI.amber, flex: 'none' }}>{lesson.level === 'intern' ? 'Intern level' : 'Student level'}</span>
        {onHide && (
          <button type="button" onClick={onHide} style={{ ...chipBtn, marginLeft: 'auto', padding: '6px 10px', fontSize: 11 }} title="Show the classroom (B)">
            Room view · B
          </button>
        )}
      </div>

      {/* the board: aluminium frame + white surface */}
      <div
        className={playing ? '' : 'wb-paused'}
        style={{
          position: 'relative',
          aspectRatio: `${BOARD_W} / ${BOARD_H}`,
          width: '100%',
          maxHeight: 'calc(100% - 150px)',
          margin: '0 auto',
          background: 'linear-gradient(160deg,#ffffff 0%,#f6f8fa 55%,#eef1f4 100%)',
          border: '6px solid #b9c0c8',
          boxShadow: 'inset 0 0 0 2px #e6e9ed, 0 0 0 2px #6d7681',
          borderRadius: 4,
          overflow: 'hidden',
        }}
      >
        {step === 'quiz' ? (
          <QuizCard lesson={lesson} answered={answered} onAnswer={answer} onReplay={replayAll} onNewTopic={onNewTopic} />
        ) : (
          <StepSvg key={`${step}-${runKey}`} lesson={lesson} index={step} />
        )}
        {!playing && step !== 'quiz' && (
          <button
            type="button"
            onClick={togglePlay}
            aria-label="Resume lesson"
            style={{ position: 'absolute', inset: 0, background: 'rgba(11,31,75,.18)', border: 'none', cursor: 'pointer', display: 'grid', placeItems: 'center' }}
          >
            <span style={{ ...panel, ...labelStyle, padding: '10px 16px' }}>Paused · Space to resume</span>
          </button>
        )}
      </div>

      {/* caption: what the teacher is saying for this step */}
      <div style={{ fontFamily: UI.label, fontSize: 15, lineHeight: 1.35, minHeight: 40, color: UI.text }}>
        <span style={{ ...labelStyle, fontSize: 11, color: UI.primary, marginRight: 8 }}>{step === 'quiz' ? 'Quiz' : `Step ${idx + 1}/${n}`}</span>
        {caption}
      </div>

      {/* player bar */}
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <IconButton label="Previous step (Left arrow)" onClick={() => jump(step === 'quiz' ? n - 1 : Math.max(0, step - 1))}>
          {Icon.prev}
        </IconButton>
        <IconButton label={playing && step !== 'quiz' ? 'Pause (Space)' : 'Play (Space)'} onClick={togglePlay} primary>
          {playing && step !== 'quiz' ? Icon.pause : Icon.play}
        </IconButton>
        <IconButton label="Next step (Right arrow)" onClick={() => jump(typeof step === 'number' && step + 1 < n ? step + 1 : 'quiz')}>
          {Icon.next}
        </IconButton>
        <IconButton label="Replay this step" onClick={() => jump(step)}>
          {Icon.replay}
        </IconButton>
        <div style={{ flex: 1, display: 'grid', gap: 6, minWidth: 0 }}>
          <div style={{ display: 'flex', gap: 6 }}>
            {lesson.steps.map((s, i) => (
              <button
                key={i}
                type="button"
                onClick={() => jump(i)}
                title={`${i + 1}. ${s.heading}`}
                aria-label={`Go to step ${i + 1}: ${s.heading}`}
                aria-current={i === idx ? 'step' : undefined}
                style={{ flex: 1, height: 10, border: `2px solid ${UI.line}`, background: i < idx ? UI.primary : i === idx ? UI.amber : UI.bg, cursor: 'pointer', padding: 0 }}
              />
            ))}
            <button
              type="button"
              onClick={() => jump('quiz')}
              title="Quiz"
              aria-label="Go to the quiz"
              style={{ flex: 'none', width: 30, height: 10, border: `2px solid ${UI.line}`, background: step === 'quiz' ? UI.amber : UI.bg, cursor: 'pointer', padding: 0 }}
            />
          </div>
          <div style={{ height: 6, background: UI.bg, border: `1px solid ${UI.line}` }} aria-hidden="true">
            <div style={{ height: '100%', width: `${Math.round(progress * 1000) / 10}%`, background: UI.primary, transition: 'width .1s linear' }} />
          </div>
        </div>
        <span style={{ ...labelStyle, fontSize: 11, flex: 'none', minWidth: 64, textAlign: 'right' }}>
          {step === 'quiz' ? 'Quiz' : `${idx + 1} / ${n}`}
        </span>
      </div>
    </div>
  );
}
