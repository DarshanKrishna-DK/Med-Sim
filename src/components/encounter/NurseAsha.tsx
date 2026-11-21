import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type KeyboardEvent } from 'react';
import { store, useAgentRuns, useCoachAlerts, useOsceLive } from '../../game/store';
import type { CoachAlert } from '../../game/types';
import { isNurseSpeaking, speakAsNurse, subscribeNurseSpeaking } from '../../agents/nurseAgent';
import { explainAlert, requestHint } from '../../agents/coach';
import { activeAlert } from '../../agents/coachRules';
import { visibleRuns } from './NurseFeed';
import { Icon, IconButton } from './HudControls';

/* Nurse Asha: an original pixel-art mascot for the nurse agent. Drawn as
 * SVG rects (crispEdges) on a 24x22 grid; the face is a fixed base sprite
 * and each mood swaps the eye/mouth overlays and adds one small prop.
 * All motion is CSS (steps()) and rests under prefers-reduced-motion. */

export type AshaMood = 'idle' | 'listening' | 'working' | 'talking' | 'alert' | 'happy';

const PAL: Record<string, string> = {
  k: '#1d2433', // outline
  c: '#f7f6ef', // cap
  r: '#e8505b', // cap cross
  h: '#241712', // hair
  s: '#b9784f', // skin
  S: '#9b5f3d', // skin shade
  b: '#d4876b', // blush
  w: '#f7f6ef', // collar
  u: '#a8d8f2', // uniform
  U: '#7cbde3', // uniform shade
  n: '#f7f6ef', // name tag
};

// 16x20 base sprite, no eyes or mouth (those are mood overlays).
const BASE = [
  '....kkkkkkkk....',
  '...kcccrrccck...',
  '...kccrrrrcck...',
  '..kkcccrrccckk..',
  '..khhhhhhhhhhk..',
  '.khhhhhhhhhhhhk.',
  '.khhhsssssssshk.',
  '.khsssssssssshk.',
  '.khsssssssssshk.',
  '.khsssssssssshk.',
  '.khsbssssssbshk.',
  '..khsssssssshk..',
  '...kkSssssSkk...',
  '....kwSSSSwk....',
  '..kkuwwSSwwukk..',
  '.kuuuuuwwuuuuuk.',
  '.kuuuuuuuunnuuk.',
  '.kUuuuuuuuuuuUk.',
  '.kUuuuuuuuuuuUk.',
  '.kkkkkkkkkkkkkk.',
];

const OX = 4;
const OY = 2;
const E = PAL.k;
const M = '#6e2a22';
const T = '#e07a7a';

type Px = [number, number, number, number, string?];

function Rects({ px, fill, className }: { px: Px[]; fill: string; className?: string }) {
  return (
    <g className={className}>
      {px.map(([x, y, w, h, f], i) => (
        <rect key={i} x={OX + x} y={OY + y} width={w} height={h} fill={f ?? fill} />
      ))}
    </g>
  );
}

const EYES_OPEN: Px[] = [[5, 8, 1, 2], [10, 8, 1, 2]];
const EYES_CLOSED: Px[] = [[4, 9, 2, 1], [10, 9, 2, 1]];
const EYES_SIDE: Px[] = [[6, 8, 1, 2], [11, 8, 1, 2]];
const EYES_DOWN: Px[] = [[5, 9, 1, 1], [10, 9, 1, 1], [4, 8, 2, 1, PAL.S], [10, 8, 2, 1, PAL.S]];
const EYES_HAPPY: Px[] = [[4, 9, 1, 1], [5, 8, 1, 1], [6, 9, 1, 1], [9, 9, 1, 1], [10, 8, 1, 1], [11, 9, 1, 1]];
const EYES_WIDE: Px[] = [[4, 8, 2, 2], [10, 8, 2, 2], [4, 8, 1, 1, '#ffffff'], [10, 8, 1, 1, '#ffffff']];

const MOUTH_SMILE: Px[] = [[6, 10, 1, 1], [7, 11, 2, 1], [9, 10, 1, 1]];
const MOUTH_FLAT: Px[] = [[7, 11, 2, 1]];
const MOUTH_OPEN: Px[] = [[7, 10, 2, 1], [7, 11, 2, 1, T]];
const MOUTH_O: Px[] = [[7, 10, 2, 2]];
const MOUTH_GRIN: Px[] = [[6, 10, 4, 1], [7, 11, 2, 1, T]];

function Eyes({ mood }: { mood: AshaMood }) {
  if (mood === 'happy') return <Rects px={EYES_HAPPY} fill={E} />;
  if (mood === 'alert') return <Rects px={EYES_WIDE} fill={E} />;
  if (mood === 'working') return <Rects px={EYES_DOWN} fill={E} />;
  const open = mood === 'listening' ? EYES_SIDE : EYES_OPEN;
  return (
    <>
      <Rects px={open} fill={E} className="asha-eyes-open" />
      <Rects px={EYES_CLOSED} fill={E} className="asha-eyes-closed" />
    </>
  );
}

function Mouth({ mood }: { mood: AshaMood }) {
  if (mood === 'talking') {
    return (
      <>
        <Rects px={MOUTH_SMILE} fill={M} />
        <g className="asha-mouth-open">
          <rect x={OX + 6} y={OY + 10} width={4} height={2} fill={PAL.s} />
          <Rects px={MOUTH_OPEN} fill={M} />
        </g>
      </>
    );
  }
  if (mood === 'alert') return <Rects px={MOUTH_O} fill={M} />;
  if (mood === 'working') return <Rects px={MOUTH_FLAT} fill={M} />;
  if (mood === 'happy') return <Rects px={MOUTH_GRIN} fill={M} />;
  return <Rects px={MOUTH_SMILE} fill={M} />;
}

function Prop({ mood }: { mood: AshaMood }) {
  switch (mood) {
    case 'working':
      return (
        <g>
          {/* clipboard held at the chest */}
          <rect x={5} y={15} width={6} height={7} fill="#8a5a2b" />
          <rect x={6} y={16} width={4} height={5} fill="#f7f6ef" />
          <rect x={7} y={15} width={2} height={1} fill="#c9ced8" />
          <rect x={6} y={17} width={3} height={1} fill="#7a8396" />
          <rect x={6} y={19} width={4} height={1} fill="#7a8396" />
          {/* thinking dots */}
          <rect className="asha-dot" x={18} y={2} width={1} height={1} fill="#f0c24a" />
          <rect className="asha-dot asha-dot--2" x={20} y={2} width={1} height={1} fill="#f0c24a" />
          <rect className="asha-dot asha-dot--3" x={22} y={2} width={1} height={1} fill="#f0c24a" />
        </g>
      );
    case 'listening':
      return (
        <g fill="#a8e27c">
          <rect className="asha-wave" x={19} y={10} width={1} height={2} />
          <rect className="asha-wave asha-wave--2" x={21} y={9} width={1} height={4} />
          <rect className="asha-wave asha-wave--3" x={23} y={8} width={1} height={6} />
        </g>
      );
    case 'alert':
      return (
        <g className="asha-bang" fill="#ff6568">
          <rect x={20} y={2} width={2} height={5} />
          <rect x={20} y={8} width={2} height={2} />
        </g>
      );
    case 'happy':
      return (
        <g fill="#ffd76a">
          <g className="asha-spark">
            <rect x={1} y={5} width={1} height={3} />
            <rect x={0} y={6} width={3} height={1} />
          </g>
          <g className="asha-spark asha-spark--2">
            <rect x={21} y={3} width={1} height={3} />
            <rect x={20} y={4} width={3} height={1} />
          </g>
        </g>
      );
    default:
      return null;
  }
}

export function AshaSprite({ mood, size = 84 }: { mood: AshaMood; size?: number }) {
  const base = useMemo(
    () =>
      BASE.flatMap((row, y) =>
        Array.from(row).map((ch, x) =>
          PAL[ch] ? <rect key={`${x}-${y}`} x={OX + x} y={OY + y} width={1} height={1} fill={PAL[ch]} /> : null,
        ),
      ),
    [],
  );
  const head = base.slice(0, 13 * 16);
  const body = base.slice(13 * 16);
  return (
    <svg
      width={size}
      height={Math.round((size * 22) / 24)}
      viewBox="0 0 24 22"
      shapeRendering="crispEdges"
      className={`asha asha--${mood}`}
      role="img"
      aria-label={`Nurse Asha, ${mood}`}
    >
      <g className="asha-figure">
        {body}
        <g className="asha-head">
          {head}
          <rect x={OX + 3} y={OY + 11} width={1} height={1} fill="#f0c24a" />
          <Eyes mood={mood} />
          <Mouth mood={mood} />
        </g>
      </g>
      <Prop mood={mood} />
    </svg>
  );
}

// ── mood + header ────────────────────────────────────────────────────

const HAPPY_MS = 4500;
const ALERT_MS = 10000;
const LIVE_VOICE = ['ready', 'listening', 'thinking', 'speaking'];

function useNurseSpeaking(): boolean {
  return useSyncExternalStore(subscribeNurseSpeaking, isNurseSpeaking);
}

/** Re-render at `at` (ms epoch) so time-boxed moods expire on their own. */
function useWakeAt(at: number | null) {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (at === null) return;
    const ms = at - Date.now();
    if (ms <= 0) return;
    const t = window.setTimeout(() => setTick((n) => n + 1), ms + 30);
    return () => window.clearTimeout(t);
  }, [at]);
}

const NO_ALERTS: CoachAlert[] = [];

const SEV_LABEL: Record<CoachAlert['severity'], string> = { danger: 'Danger', warning: 'Warning', info: 'Note' };

/** Severity as shape + colour (never colour alone): octagon danger,
 *  triangle warning, square note. */
function SevGlyph({ severity }: { severity: CoachAlert['severity'] }) {
  return (
    <svg className={`asha-sev asha-sev--${severity}`} width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
      {severity === 'danger' && <path d="M6 1.5h6L16.5 6v6L12 16.5H6L1.5 12V6Z" fill="currentColor" />}
      {severity === 'warning' && <path d="M9 1.5 17 16H1Z" fill="currentColor" />}
      {severity === 'info' && <rect x="2" y="2" width="14" height="14" fill="currentColor" />}
      {severity === 'info' ? (
        <path d="M9 7.5v5M9 4.5v1.2" stroke="#0b1f4b" strokeWidth="2" />
      ) : (
        <path d={severity === 'warning' ? 'M9 6.5v4.5M9 12.6v1.4' : 'M9 4.5v5.5M9 11.6v1.8'} stroke="#0b1f4b" strokeWidth="2" />
      )}
    </svg>
  );
}

export function NurseAshaHeader({
  voiceStatus,
  onExplain,
}: {
  voiceStatus?: string;
  onExplain: (a: CoachAlert) => void;
}) {
  const runs = visibleRuns(useAgentRuns());
  const allAlerts = useCoachAlerts();
  // OSCE station: no hints. Alerts are still collected in the store and
  // revealed as critical errors on the marking sheet.
  const osceLive = useOsceLive();
  const alerts = osceLive ? NO_ALERTS : allAlerts;
  const speaking = useNurseSpeaking();
  const [historyOpen, setHistoryOpen] = useState(false);
  const alertBar = useRef<HTMLDivElement>(null);

  // The history list is a popover: an outside click closes it.
  useEffect(() => {
    if (!historyOpen) return;
    const onDown = (e: PointerEvent) => {
      if (!alertBar.current?.contains(e.target as Node)) setHistoryOpen(false);
    };
    document.addEventListener('pointerdown', onDown);
    return () => document.removeEventListener('pointerdown', onDown);
  }, [historyOpen]);

  const latest = runs[runs.length - 1];
  const running = runs.some((r) => r.status === 'running');
  const toast = activeAlert(alerts);
  const now = Date.now();

  const happyUntil =
    latest && latest.status === 'done' && latest.finishedAt && latest.steps.every((s) => s.ok)
      ? latest.finishedAt + HAPPY_MS
      : 0;
  const alarmUntil = toast && toast.severity !== 'info' ? toast.createdAt + ALERT_MS : 0;
  const nextWake = [happyUntil, alarmUntil].filter((t) => t > now).sort((a, b) => a - b)[0] ?? null;
  useWakeAt(nextWake);

  let mood: AshaMood = 'idle';
  if (speaking) mood = 'talking';
  else if (alarmUntil > now) mood = 'alert';
  else if (running) mood = 'working';
  else if (happyUntil > now) mood = 'happy';
  else if (voiceStatus && LIVE_VOICE.includes(voiceStatus)) mood = 'listening';

  // Info notes fade on their own; warnings and dangers wait for the doctor.
  useEffect(() => {
    if (!toast || toast.severity !== 'info' || toast.source === 'hint') return;
    const t = window.setTimeout(() => store.dismissCoachAlert(toast.id), 12000);
    return () => window.clearTimeout(t);
  }, [toast]);

  const open = alerts.filter((a) => !a.dismissed);
  const badgeSev = open.some((a) => a.severity === 'danger') ? 'danger' : open.some((a) => a.severity === 'warning') ? 'warning' : open.length ? 'info' : null;

  const bubble = toast
    ? toast.short
    : running
      ? 'On it, doctor...'
      : latest?.spokenConfirmation
        ? latest.spokenConfirmation
        : voiceStatus && LIVE_VOICE.includes(voiceStatus)
          ? "I'm listening, doctor. Just say the order."
          : "Hi doctor, I'm Asha. Say or type an order and I'll take care of it.";

  const closeHistory = (e: KeyboardEvent) => {
    if (e.key !== 'Escape' || !historyOpen) return;
    // Keep Esc from also opening the room's pause menu.
    e.stopPropagation();
    e.nativeEvent.stopImmediatePropagation();
    setHistoryOpen(false);
  };

  return (
    <div className="asha-head-wrap">
      <div className="asha-row">
        <div className="asha-frame">
          <AshaSprite mood={mood} size={56} />
        </div>
        <div className="asha-say">
          <p className="asha-name">
            Nurse Asha <span className="asha-mood">{mood === 'idle' ? 'on shift' : mood}</span>
          </p>
          <p className={`asha-bubble ${toast ? `asha-bubble--${toast.severity}` : ''}`} aria-live="polite">
            {bubble}
          </p>
        </div>
        {!osceLive && (
          <button type="button" className="asha-checkin" onClick={() => void requestHint()} title='Or say: "Asha, how am I doing?"'>
            How am I doing?
          </button>
        )}
      </div>

      {/* Fixed-height alert bar: the active alert takes this slot instead of
          pushing the chart down. Hidden for the whole OSCE station (no hints). */}
      {!osceLive && (
        <div
          ref={alertBar}
          className={`asha-alertbar ${toast ? `asha-alertbar--${toast.severity}` : ''}`}
          onKeyDown={closeHistory}
        >
          {toast ? (
            <div className="asha-toast" role="alert">
              <SevGlyph severity={toast.severity} />
              <span className="sr-only">{SEV_LABEL[toast.severity]}: </span>
              <span className="asha-toast-title">{toast.title}</span>
            </div>
          ) : (
            <p className="asha-allclear">{alerts.length ? 'No open alerts' : 'No alerts yet'}</p>
          )}
          {toast && (
            <>
              <IconButton tip="bottom" label="Ask Asha why" className="icon-btn--nurse" onClick={() => onExplain(toast)}>
                <span className="asha-q-glyph" aria-hidden="true">?</span>
              </IconButton>
              <IconButton tip="bottom" label="Dismiss alert" className="icon-btn--bare" onClick={() => store.dismissCoachAlert(toast.id)}>
                {Icon.close}
              </IconButton>
            </>
          )}
          {alerts.length > 0 && (
            <span className="tip-wrap tip-wrap--left">
              <button
                type="button"
                className={`icon-btn asha-history-toggle ${historyOpen ? 'is-active' : ''} ${badgeSev ? `has-open--${badgeSev}` : ''}`}
                aria-expanded={historyOpen}
                aria-controls="asha-history"
                aria-label={`Alert history, ${alerts.length} alert${alerts.length === 1 ? '' : 's'}, ${open.length} open`}
                onClick={() => setHistoryOpen((o) => !o)}
              >
                {Icon.bell}
                <span className="asha-history-count">{alerts.length}</span>
              </button>
              {!historyOpen && <span className="tip" aria-hidden="true">Alert history</span>}
            </span>
          )}
          {historyOpen && alerts.length > 0 && (
            <ol className="asha-history-list" id="asha-history" aria-label="Alert history">
              {[...alerts].reverse().map((a) => (
                <li key={a.id} className={`asha-hist asha-hist--${a.severity}`}>
                  <span className="asha-hist-dot" aria-hidden="true" />
                  <span className="asha-hist-title">{a.title}</span>
                  <time className="asha-hist-time" dateTime={new Date(a.createdAt).toISOString()}>
                    {new Date(a.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                  </time>
                  <button
                    type="button"
                    className="asha-hist-ask"
                    aria-label={`Ask Asha about: ${a.title}`}
                    onClick={() => {
                      setHistoryOpen(false);
                      onExplain(a);
                    }}
                  >
                    Why?
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>
      )}
    </div>
  );
}

// ── explain card ─────────────────────────────────────────────────────

interface Turn {
  q: string;
  a: string | null;
}

export function AshaExplain({ alert, onClose }: { alert: CoachAlert; onClose: () => void }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [q, setQ] = useState('');
  const busy = turns.some((t) => t.a === null);
  const scrollRef = useRef<HTMLDivElement>(null);
  const spokenFor = useRef<string | null>(null);

  // Asha says the explanation out loud once per opened alert.
  useEffect(() => {
    if (spokenFor.current === alert.id) return;
    spokenFor.current = alert.id;
    setTurns([]);
    // A check-in hint was already spoken when it arrived.
    if (alert.source !== 'hint') void speakAsNurse([alert.explanation, alert.suggestion].filter(Boolean).join(' '));
  }, [alert]);

  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [turns]);

  const ask = async (e: FormEvent) => {
    e.preventDefault();
    const question = q.trim() || 'Why is that wrong?';
    if (busy) return;
    setQ('');
    setTurns((t) => [...t, { q: question, a: null }]);
    const answer = await explainAlert(alert, question);
    setTurns((t) => t.map((x, i) => (i === t.length - 1 && x.a === null ? { ...x, a: answer } : x)));
    void speakAsNurse(answer);
  };

  return (
    <section
      className={`asha-explain asha-explain--${alert.severity}`}
      aria-label={`Asha explains: ${alert.title}`}
      onKeyDown={(e) => {
        if (e.key !== 'Escape') return;
        e.stopPropagation();
        e.nativeEvent.stopImmediatePropagation();
        onClose();
      }}
    >
      <header className="asha-explain-head">
        <AshaSprite mood="talking" size={40} />
        <div className="asha-explain-titles">
          <p className="asha-explain-kicker">{SEV_LABEL[alert.severity]} · Asha explains</p>
          <h3 className="asha-explain-title">{alert.title}</h3>
        </div>
        <IconButton tip="left" label="Close explanation" kbd="Esc" className="icon-btn--bare" onClick={onClose}>
          {Icon.close}
        </IconButton>
      </header>
      <div className="asha-explain-body" ref={scrollRef}>
        <p className="asha-explain-text">{alert.explanation}</p>
        {alert.suggestion && (
          <p className="asha-explain-next">
            <span>Next step</span> {alert.suggestion}
          </p>
        )}
        {turns.map((t, i) => (
          <div key={i} className="asha-turn">
            <p className="asha-turn-q">{t.q}</p>
            <p className="asha-turn-a">{t.a ?? 'Asha is thinking...'}</p>
          </div>
        ))}
      </div>
      <form className="asha-ask" onSubmit={ask}>
        <label htmlFor="asha-ask-input" className="sr-only">Ask Asha a follow-up question</label>
        <input
          id="asha-ask-input"
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Why is that wrong?"
          autoComplete="off"
        />
        <button type="submit" className="btn btn-nurse" disabled={busy}>
          Ask
        </button>
      </form>
    </section>
  );
}
