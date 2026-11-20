import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from 'react';
import { store, useStore } from '../../game/store';
import { LANG_NAME } from '../../game/lang';
import { getEvalHistory, saveEvalHistory } from '../../data/evalHistory';
import { AppHeader } from '../ui/chrome';
import { LangToggle } from '../ui/LangToggle';
import { ExaminerPortrait } from '../viva/ExaminerPortrait';
import { useVivaSession, type VivaSession } from '../viva/useVivaSession';
import { vivaHistoryPayload } from '../viva/vivaHistory';
import {
  VERDICT_LABEL,
  VIVA_DURATION_MS,
  VIVA_QUESTION_COUNT,
  VIVA_SUBJECTS,
  VIVA_YEARS,
  formatClock,
  gradeTranscript,
  normalizeGrade,
  normalizePlan,
  scoreBand,
  subjectById,
  yearLabel,
  type SavedViva,
  type VivaQuestion,
  type VivaSetup,
  type VivaVerdict,
} from '../viva/vivaCore';
import { EXAMINER } from '../../voice/vivaPersona';
import '../../styles/viva.css';

// Viva voce exam hall: pick a subject, topic and year, then a voice examiner
// (Agora Conversational AI + Murf) asks a hidden plan of 8 questions one at a
// time over about six minutes. Typed answers work with voice off. Marked by
// POST /agent/viva/grade and saved to progress history (mode 'viva').

type Phase = 'setup' | 'exam' | 'marking' | 'result';

const CUSTOM = '__custom__';

const STATUS_LABEL: Record<string, string> = {
  uninitialized: 'Typed viva',
  loading: 'Connecting voice...',
  ready: 'Listening',
  listening: 'Hearing you',
  thinking: 'Thinking',
  speaking: 'Speaking',
  error: 'Voice off, type answers',
};

const BAND_WORD: Record<string, string> = {
  excellent: 'Excellent',
  good: 'Good',
  satisfactory: 'Satisfactory',
  borderline: 'Borderline',
  'clear-fail': 'Needs work',
};
const BAND_TONE: Record<string, string> = {
  excellent: 'ok',
  good: 'ok',
  satisfactory: 'urgent',
  borderline: 'critical',
  'clear-fail': 'critical',
};
const VERDICT_TONE: Record<VivaVerdict, string> = {
  correct: 'ok',
  partial: 'urgent',
  incorrect: 'critical',
  'not asked': 'muted',
};

async function postJson<T>(path: string, body: unknown): Promise<T> {
  const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  if (!r.ok) throw new Error(`${r.status}: ${(await r.text().catch(() => '')).slice(0, 160)}`);
  return (await r.json()) as T;
}

export default function VivaScreen() {
  const viewedId = useStore((s) => s.viewedEvalHistoryId);
  const reviewed = useMemo(() => (viewedId ? getEvalHistory(viewedId)?.viva ?? null : null), [viewedId]);
  useEffect(() => () => store.clearViewedEval(), []);

  return (
    <div className="page paper dots">
      <AppHeader />
      {reviewed ? (
        <main className="viva wrap">
          <VivaResult saved={reviewed} onAgain={() => store.clearViewedEval()} />
        </main>
      ) : (
        <VivaHall />
      )}
    </div>
  );
}

function VivaHall() {
  const lang = useStore((s) => s.lang);
  const [phase, setPhase] = useState<Phase>('setup');
  const [subjectId, setSubjectId] = useState('pharmacology');
  const subject = subjectById(subjectId);
  const [topicPick, setTopicPick] = useState(subject.topics[0]);
  const [customTopic, setCustomTopic] = useState('');
  const [yearId, setYearId] = useState<string>(subject.year);
  const [plan, setPlan] = useState<VivaQuestion[] | null>(null);
  const [planState, setPlanState] = useState<'idle' | 'loading' | 'ready' | 'error'>('idle');
  const [planError, setPlanError] = useState('');
  const [markError, setMarkError] = useState('');
  const [result, setResult] = useState<SavedViva | null>(null);
  const [, setTick] = useState(0);

  const session = useVivaSession();
  const setupRef = useRef<VivaSetup | null>(null);
  const planPromise = useRef<Promise<VivaQuestion[] | null> | null>(null);
  const runId = useRef(0);
  const done = useRef(new Set<string>());
  const timeUpFired = useRef(false);
  const finishing = useRef(false);
  const voiceMode = useRef(true);
  const durationMs = useRef(0);
  // The session object is rebuilt every render; timers and callbacks read it
  // through refs so the 500 ms clock tick does not reset them.
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const linesRef = useRef(session.lines);
  linesRef.current = session.lines;
  const planRef = useRef<VivaQuestion[] | null>(null);

  const topic = (topicPick === CUSTOM ? customTopic : topicPick).trim();

  const pickSubject = (id: string) => {
    const s = subjectById(id);
    setSubjectId(s.id);
    setTopicPick(s.topics[0]);
    setYearId(s.year);
  };

  const loadPlan = useCallback(
    (setup: VivaSetup, fresh: boolean, run: number) => {
      setPlanState('loading');
      setPlanError('');
      const body = { subject: setup.subject, topic: setup.topic, year: yearLabel(setup.year), lang: setup.lang, count: VIVA_QUESTION_COUNT, fresh };
      const attempt = async (): Promise<VivaQuestion[] | null> => {
        let lastErr = '';
        for (let i = 0; i < 2; i++) {
          try {
            const qs = normalizePlan(await postJson<unknown>('/agent/viva/plan', body));
            if (qs.length) return qs;
            lastErr = 'empty plan';
          } catch (e) {
            lastErr = e instanceof Error ? e.message : String(e);
          }
          if (runId.current !== run) return null;
        }
        throw new Error(lastErr);
      };
      const p = attempt()
        .then((qs) => {
          if (!qs || runId.current !== run) return null;
          planRef.current = qs;
          setPlan(qs);
          setPlanState('ready');
          sessionRef.current.setPlan(qs);
          return qs;
        })
        .catch((e: unknown) => {
          if (runId.current !== run) return null;
          setPlanState('error');
          setPlanError(e instanceof Error ? e.message : String(e));
          return null;
        });
      planPromise.current = p;
    },
    [],
  );

  const begin = (voice: boolean, forceFresh = false) => {
    if (!topic) return;
    const setup: VivaSetup = { subjectId: subject.id, subject: subject.label, topic, year: yearId, lang };
    const key = `${setup.subjectId}|${setup.topic.toLowerCase()}|${setup.year}|${setup.lang}`;
    const fresh = forceFresh || done.current.has(key);
    done.current.add(key);
    setupRef.current = setup;
    runId.current += 1;
    timeUpFired.current = false;
    finishing.current = false;
    voiceMode.current = voice;
    planRef.current = null;
    setPlan(null);
    setResult(null);
    setMarkError('');
    session.primePlan([]);
    session.start(setup, { voice });
    loadPlan(setup, fresh, runId.current);
    setPhase('exam');
  };

  const mark = useCallback(async () => {
    const setup = setupRef.current;
    if (!setup) return;
    setMarkError('');
    setPhase('marking');
    const qs = planRef.current ?? (await planPromise.current);
    if (!qs || !qs.length) {
      setMarkError('The question plan never arrived, so this viva cannot be marked. Start a new one.');
      return;
    }
    const lines = linesRef.current;
    try {
      const raw = await postJson<unknown>('/agent/viva/grade', {
        subject: setup.subject,
        topic: setup.topic,
        year: yearLabel(setup.year),
        plan: qs,
        transcript: gradeTranscript(lines),
        lang: setup.lang,
      });
      const grade = normalizeGrade(raw);
      if (!grade) throw new Error('The examiner returned an unreadable marking sheet.');
      const saved: SavedViva = {
        ...grade,
        subjectId: setup.subjectId,
        subject: setup.subject,
        topic: setup.topic,
        year: setup.year,
        lang: setup.lang,
        durationSec: Math.round(Math.min(durationMs.current, VIVA_DURATION_MS + 60000) / 1000),
        transcript: lines.slice(-80),
      };
      saveEvalHistory(vivaHistoryPayload(saved));
      setResult(saved);
      setPhase('result');
    } catch (e) {
      setMarkError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const finish = useCallback(() => {
    if (finishing.current) return;
    finishing.current = true;
    durationMs.current = sessionRef.current.elapsedMs();
    sessionRef.current.hangUp();
    void mark();
  }, [mark]);

  // Calm clock: tick twice a second; at zero the examiner closes the viva.
  useEffect(() => {
    if (phase !== 'exam') return;
    const id = window.setInterval(() => {
      setTick((t) => t + 1);
      if (!timeUpFired.current && sessionRef.current.elapsedMs() >= VIVA_DURATION_MS) {
        timeUpFired.current = true;
        sessionRef.current.timeUp();
      }
    }, 500);
    return () => window.clearInterval(id);
  }, [phase]);

  // The examiner said "That will be all": let the line finish, then mark.
  useEffect(() => {
    if (phase !== 'exam' || !session.closed) return;
    // Live: the closing transcript arrives as the line ends. Typed: Murf still has to read it out.
    const id = window.setTimeout(finish, voiceMode.current && sessionRef.current.live ? 1500 : 5000);
    return () => window.clearTimeout(id);
  }, [phase, session.closed, finish]);

  if (phase === 'setup') {
    return (
      <main className="viva wrap">
        <div className="library-head">
          <p className="kicker">Viva voce</p>
          <h1 className="page-title">The examination hall.</h1>
          <p className="page-lede">
            A university viva with a senior examiner, out loud. One question at a time, harder when you are strong,
            a hint when you stall. About six minutes, then a marking sheet that quotes your own answers.
          </p>
        </div>
        <div className="viva-setup-grid">
          <section className="viva-setup" aria-labelledby="viva-setup-title">
            <h2 id="viva-setup-title" className="section-title">Choose your viva</h2>
            <div className="viva-fields">
              <div>
                <label className="field-label" htmlFor="viva-subject">Subject</label>
                <select id="viva-subject" className="input" value={subjectId} onChange={(e) => pickSubject(e.target.value)}>
                  {VIVA_SUBJECTS.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="viva-year">Year / difficulty</label>
                <select id="viva-year" className="input" value={yearId} onChange={(e) => setYearId(e.target.value)}>
                  {VIVA_YEARS.map((y) => (
                    <option key={y.id} value={y.id}>{y.label}</option>
                  ))}
                </select>
              </div>
              <div className="viva-field-wide">
                <label className="field-label" htmlFor="viva-topic">Topic</label>
                <select id="viva-topic" className="input" value={topicPick} onChange={(e) => setTopicPick(e.target.value)}>
                  {subject.topics.map((t) => (
                    <option key={t} value={t}>{t}</option>
                  ))}
                  <option value={CUSTOM}>Your own topic...</option>
                </select>
                {topicPick === CUSTOM && (
                  <input
                    className="input viva-custom"
                    value={customTopic}
                    onChange={(e) => setCustomTopic(e.target.value)}
                    placeholder={`Any ${subject.label.toLowerCase()} topic, e.g. "Cholinergic drugs"`}
                    maxLength={100}
                    aria-label="Your own topic"
                    autoFocus
                  />
                )}
              </div>
              <div className="viva-field-wide">
                <span className="field-label">Language</span>
                <LangToggle />
              </div>
            </div>
            <p className="viva-summary">
              {subject.label} / {topic || '...'} / {yearLabel(yearId)}
            </p>
            <div className="row-actions">
              <button type="button" className="btn btn-primary btn-lg" disabled={!topic} onClick={() => begin(true)}>
                Start viva
              </button>
              <button type="button" className="btn btn-ghost btn-lg" disabled={!topic} onClick={() => begin(false)}>
                Type my answers instead
              </button>
            </div>
            <p className="muted-note">Start viva uses your microphone. The examiner speaks {LANG_NAME[lang]}; switch above.</p>
          </section>
          <aside className="viva-side">
            <ExaminerPortrait mouth={() => 0} speaking={false} label={`${EXAMINER.name}, waiting at the examiner's desk`} />
            <p className="viva-nameplate">
              <strong>{EXAMINER.name}</strong>
              <span>{EXAMINER.title}</span>
            </p>
            <ul className="viva-rules">
              <li>{VIVA_QUESTION_COUNT} questions from a hidden plan, easy first, applied last.</li>
              <li>Answer aloud like the real viva. "I don't know, sir" is allowed; he will give one hint.</li>
              <li>Marked per question: correct, partly correct, incorrect or not asked, with your words quoted.</li>
              <li>Reading list from standard Indian textbooks for what you missed.</li>
            </ul>
          </aside>
        </div>
      </main>
    );
  }

  if (phase === 'result' && result) {
    return (
      <main className="viva wrap">
        <VivaResult
          saved={result}
          onAgain={() => setPhase('setup')}
          onRetake={() => begin(voiceMode.current, true)}
        />
      </main>
    );
  }

  if (phase === 'marking') {
    return (
      <main className="viva wrap">
        <div className="viva-marking" role="status" aria-live="polite">
          {markError ? (
            <>
              <h1 className="page-title">The examiner could not mark this viva</h1>
              <p className="page-lede">{markError}</p>
              <div className="row-actions">
                {plan && (
                  <button type="button" className="btn btn-primary" onClick={() => void mark()}>
                    Try marking again
                  </button>
                )}
                <button type="button" className="btn btn-ghost" onClick={() => setPhase('setup')}>
                  Back to the hall
                </button>
              </div>
            </>
          ) : (
            <>
              <p className="kicker">Viva over</p>
              <h1 className="page-title">The examiner is writing your marks...</h1>
              <p className="page-lede">Each answer is checked against the key points, quoting what you said.</p>
            </>
          )}
        </div>
      </main>
    );
  }

  return (
    <ExamHall
      session={session}
      setup={setupRef.current!}
      plan={plan}
      planState={planState}
      planError={planError}
      onRetryPlan={() => setupRef.current && loadPlan(setupRef.current, true, runId.current)}
      onFinish={finish}
    />
  );
}

function ExamHall({
  session,
  setup,
  plan,
  planState,
  planError,
  onRetryPlan,
  onFinish,
}: {
  session: VivaSession;
  setup: VivaSetup;
  plan: VivaQuestion[] | null;
  planState: string;
  planError: string;
  onRetryPlan: () => void;
  onFinish: () => void;
}) {
  const [draft, setDraft] = useState('');
  const logEnd = useRef<HTMLLIElement>(null);
  const total = plan?.length ?? VIVA_QUESTION_COUNT;
  const remaining = VIVA_DURATION_MS - session.elapsedMs();
  const fraction = Math.max(0, Math.min(1, remaining / VIVA_DURATION_MS));
  const current = session.qIndex < 0 ? 0 : Math.min(total, session.qIndex + 1);
  const speaking = session.status === 'speaking';
  const typedMode = !session.live && session.status !== 'loading';

  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'nearest' });
  }, [session.lines.length]);

  const send = (e: FormEvent) => {
    e.preventDefault();
    const text = draft.trim();
    if (!text) return;
    setDraft('');
    void session.answer(text);
  };

  return (
    <main className="viva viva-exam wrap">
      <header className="viva-bar">
        <div className="viva-bar-topic">
          <span className="chip">{setup.subject}</span>
          <span className="viva-bar-title">{setup.topic}</span>
          <span className="muted-note">{yearLabel(setup.year)}</span>
        </div>
        <div className="viva-counter" aria-label={current ? `Question ${current} of ${total}` : 'Viva starting'}>
          <span className="viva-counter-text">{current ? `Question ${current} of ${total}` : 'Warming up'}</span>
          <span className="viva-pips" aria-hidden="true">
            {Array.from({ length: total }, (_, i) => (
              <i key={i} className={i < current ? 'is-done' : ''} />
            ))}
          </span>
        </div>
        <div className="viva-clock" role="timer" aria-label={`${formatClock(remaining)} left`}>
          <span className="viva-clock-time">{formatClock(remaining)}</span>
          <span className="viva-clock-bar" aria-hidden="true">
            <i style={{ transform: `scaleX(${fraction.toFixed(3)})` }} />
          </span>
        </div>
        <button type="button" className="btn btn-end btn-sm" onClick={onFinish}>
          End viva
        </button>
      </header>

      <div className="viva-stage">
        <section className="viva-examiner" aria-label="Examiner">
          <ExaminerPortrait mouth={session.mouth} speaking={speaking} label={`${EXAMINER.name}, ${speaking ? 'speaking' : 'listening'}`} />
          <p className="viva-nameplate">
            <strong>{EXAMINER.name}</strong>
            <span className={`viva-status viva-status--${session.status}`}>{STATUS_LABEL[session.status] ?? session.status}</span>
          </p>
          <p className="viva-caption" aria-live="polite">{session.examinerCaption || '...'}</p>
          {planState === 'loading' && <p className="muted-note">The examiner is settling his question paper...</p>}
          {planState === 'error' && (
            <p className="viva-warn">
              Question paper failed ({planError.slice(0, 80)}).{' '}
              <button type="button" className="btn btn-quiet btn-sm" onClick={onRetryPlan}>Retry</button>
            </p>
          )}
          {session.error && <p className="viva-warn">{session.error}</p>}
          {session.progress && session.status === 'loading' && <p className="muted-note">{session.progress}</p>}
        </section>

        <section className="viva-transcript" aria-label="Transcript">
          <h2 className="block-title">Transcript</h2>
          <ol className="viva-log">
            {session.lines.map((l, i) => (
              <li key={i} className={`viva-line viva-line--${l.who}`}>
                <span className="viva-line-who">{l.who === 'examiner' ? EXAMINER.short : 'You'}</span>
                <span className="viva-line-text">{l.text}</span>
              </li>
            ))}
            {session.thinking && (
              <li className="viva-line viva-line--examiner">
                <span className="viva-line-who">{EXAMINER.short}</span>
                <span className="viva-line-text muted-note">Hmm...</span>
              </li>
            )}
            <li ref={logEnd} aria-hidden="true" className="viva-log-end" />
          </ol>
          <form className="viva-answer" onSubmit={send}>
            <label className="sr-only" htmlFor="viva-answer-input">Your answer</label>
            <input
              id="viva-answer-input"
              className="input"
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={typedMode ? 'Type your answer and press Enter' : 'Speak, or type an answer here'}
              autoComplete="off"
              maxLength={600}
              autoFocus={typedMode}
            />
            <button type="submit" className="btn btn-primary" disabled={!draft.trim() || session.thinking}>
              Answer
            </button>
          </form>
          {session.live && (
            <button type="button" className="btn btn-ghost btn-sm viva-mic" onClick={session.toggleMic} aria-pressed={session.micMuted}>
              {session.micMuted ? 'Unmute microphone' : 'Mute microphone'}
            </button>
          )}
        </section>
      </div>
    </main>
  );
}

export function VivaResult({ saved, onAgain, onRetake }: { saved: SavedViva; onAgain: () => void; onRetake?: () => void }) {
  const band = scoreBand(saved.score);
  const minutes = Math.floor(saved.durationSec / 60);
  const seconds = saved.durationSec % 60;
  return (
    <section className="viva-result" aria-labelledby="viva-result-title">
      <header className="viva-result-head">
        <div>
          <p className="kicker">Viva voce result</p>
          <h1 id="viva-result-title" className="page-title">
            {saved.subject}: {saved.topic}
          </h1>
          <p className="muted-note">
            {yearLabel(saved.year)} · {saved.asked} of {saved.total} questions asked · {minutes}:{String(seconds).padStart(2, '0')} · {LANG_NAME[saved.lang] ?? 'English'}
          </p>
        </div>
        <div className="viva-score">
          <span className="viva-score-num">{saved.score}</span>
          <span className="viva-score-max">/100</span>
          <span className={`tag tag--${BAND_TONE[band]}`}>{BAND_WORD[band]}</span>
        </div>
      </header>

      {saved.examinerComment && (
        <blockquote className="viva-comment">
          <p>"{saved.examinerComment}"</p>
          <footer>{EXAMINER.name}</footer>
        </blockquote>
      )}

      <h2 className="section-title">Question by question</h2>
      <ol className="viva-marks">
        {saved.perQuestion.map((p, i) => (
          <li key={p.id} className={`viva-mark viva-mark--${p.verdict.replace(' ', '-')}`}>
            <div className="viva-mark-head">
              <span className="viva-mark-n">{i + 1}</span>
              <p className="viva-mark-q">{p.q}</p>
              <span className={`tag tag--${VERDICT_TONE[p.verdict]}`}>{VERDICT_LABEL[p.verdict]}</span>
            </div>
            {p.verdict !== 'not asked' && (
              <p className="viva-mark-said">
                <span className="field-label">You said</span>
                {p.said ? `"${p.said}"` : <em>No answer on record.</em>}
              </p>
            )}
            <p className="viva-mark-expected">
              <span className="field-label">Expected</span>
              {p.expected}
            </p>
            {p.note && <p className="muted-note">{p.note}</p>}
          </li>
        ))}
      </ol>

      <div className="viva-columns">
        <div className="viva-box">
          <h3 className="block-title">Strengths</h3>
          {saved.strengths.length ? <ul>{saved.strengths.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="muted-note">None noted this time.</p>}
        </div>
        <div className="viva-box">
          <h3 className="block-title">Revise next</h3>
          {saved.gaps.length ? <ul>{saved.gaps.map((s) => <li key={s}>{s}</li>)}</ul> : <p className="muted-note">No gaps noted.</p>}
        </div>
        <div className="viva-box">
          <h3 className="block-title">Recommended reading</h3>
          {saved.recommendedReading.length ? (
            <ul>{saved.recommendedReading.map((s) => <li key={s}>{s}</li>)}</ul>
          ) : (
            <p className="muted-note">Your standard textbook chapter on this topic.</p>
          )}
        </div>
      </div>

      <div className="row-actions">
        <button type="button" className="btn btn-primary" onClick={onAgain}>
          Take another viva
        </button>
        {onRetake && (
          <button type="button" className="btn btn-secondary" onClick={onRetake}>
            Same topic, new questions
          </button>
        )}
        <button type="button" className="btn btn-ghost" onClick={() => store.setScreen('progress')}>
          My progress
        </button>
      </div>
    </section>
  );
}
