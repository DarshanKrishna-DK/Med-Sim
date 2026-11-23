import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from 'react';
import { Brand } from '../ui/chrome';
import { ObserverSession, type ObserverView } from '../../observer/observerSession';
import { facultyTokenFromUrl, observeCodeFromUrl } from '../../observer/observeParam';
import { FacultyDesk } from '../observer/FacultyDesk';
import { LIMITS, OSCE_DOMAINS, type ChartEvent, type MarkDomain } from '../../observer/messages';
import type { RoomSummary } from '../../room/reducer';
import '../../styles/observer.css';
import '../../styles/agentroom.css';

const NAME_KEY = 'medsim:observer-name';

function readName(): string {
  try {
    return localStorage.getItem(NAME_KEY) ?? '';
  } catch {
    return '';
  }
}

/** Faculty observer page (?observe=<code>): listen to the live consultation
 *  as an Agora audience member, follow the transcript and chart, whisper to
 *  the student and send OSCE marks. */
export default function ObserverScreen() {
  const code = useMemo(() => observeCodeFromUrl(), []);
  const facultyToken = useMemo(() => facultyTokenFromUrl(), []);
  const session = useMemo(() => new ObserverSession(), []);
  const view = useSyncExternalStore(session.subscribe, session.getView);
  const [name, setName] = useState(readName);

  useEffect(() => {
    const onHide = () => session.leave();
    window.addEventListener('pagehide', onHide);
    return () => {
      window.removeEventListener('pagehide', onHide);
      session.leave();
    };
  }, [session]);

  const start = () => {
    if (!code) return;
    try {
      localStorage.setItem(NAME_KEY, name.trim());
    } catch {
      /* private mode */
    }
    void session.start(code, name);
  };

  return (
    <div className="obs-page">
      <header className="obs-top">
        <Brand />
        <div className="obs-top-case">
          <span className="obs-top-kicker">{view.osce ? 'OSCE station' : 'Consultation'} · faculty observer</span>
          <span className="obs-top-label">{view.caseLabel || 'Live consultation'}</span>
        </div>
        <StatusChip view={view} />
        {view.phase === 'live' && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => session.leave()}>
            Leave
          </button>
        )}
      </header>

      {!code ? (
        <Gate title="This observer link is not valid">
          <p className="obs-gate-body">Ask the student to invite you again from the consultation (Invite faculty, bottom left).</p>
        </Gate>
      ) : view.phase === 'idle' || view.phase === 'joining' || view.phase === 'error' ? (
        <Gate title="Observe a live consultation">
          <p className="obs-gate-body">
            You will hear the student and the AI patient, see the live transcript and chart, and can send the student
            quiet notes and an OSCE marking sheet. You join as a silent listener: your microphone is never used and
            nobody in the room can hear you.
          </p>
          {facultyToken && (
            <p className="obs-gate-body">
              You were invited as faculty: if the pharmacy holds a drug, you decide whether it is given. Nurse Asha
              records your decision in the hospital&apos;s BAND agent room.
            </p>
          )}
          <label className="field-label" htmlFor="obs-name">Your name (shown to the student)</label>
          <input
            id="obs-name"
            className="input"
            value={name}
            maxLength={LIMITS.examiner}
            placeholder="Dr. Rao"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && start()}
          />
          {view.phase === 'error' && <p className="obs-error" role="alert">{view.error}</p>}
          <button type="button" className="btn btn-primary btn-lg btn-block" disabled={view.phase === 'joining'} onClick={start}>
            {view.phase === 'joining' ? 'Joining...' : 'Start observing'}
          </button>
        </Gate>
      ) : view.phase === 'ended' && !view.lines.length ? (
        <Gate title="You left the session">
          <p className="obs-gate-body">{view.error || 'Reload this page to observe again while the link is valid.'}</p>
        </Gate>
      ) : (
        <main className="obs-grid">
          <section className="obs-col obs-col--left" aria-label="Who is speaking and the chart">
            <div className="obs-speakers">
              <Speaker session={session} who="student" label="Student doctor" present={view.studentInCall} />
              <Speaker session={session} who="patient" label="AI patient" present={view.patientInCall} />
              {view.audioMode && (
                <p className="obs-hint">
                  {view.audioMode === 'audience' ? 'Audience role: no microphone, nobody can hear you.' : 'Listen-only: no microphone, nobody can hear you.'}
                </p>
              )}
            </div>
            {view.room && <RoomFeed room={view.room} />}
            <ChartFeed events={view.events} synced={view.synced} />
          </section>
          <section className="obs-col obs-col--mid" aria-label="Live transcript">
            <Transcript view={view} />
          </section>
          <section className="obs-col obs-col--right" aria-label="Faculty tools">
            {facultyToken && <FacultyDesk token={facultyToken} />}
            <Whisper session={session} view={view} />
            <MarkingSheet session={session} view={view} />
          </section>
        </main>
      )}
    </div>
  );
}

function Gate({ title, children }: { title: string; children: ReactNode }) {
  return (
    <main className="obs-gate">
      <div className="obs-gate-card">
        <h1 className="obs-gate-title">{title}</h1>
        {children}
      </div>
    </main>
  );
}

function StatusChip({ view }: { view: ObserverView }) {
  if (view.phase === 'live') {
    const label = view.studentInCall || view.patientInCall ? 'Live' : view.studentOnline ? 'Call ended' : 'Waiting';
    return <span className={`obs-chip ${label === 'Live' ? 'obs-chip--live' : ''}`}>{label}</span>;
  }
  if (view.phase === 'ended') return <span className="obs-chip">Ended</span>;
  return null;
}

function Speaker({ session, who, label, present }: { session: ObserverSession; who: 'student' | 'patient'; label: string; present: boolean }) {
  const bar = useRef<HTMLSpanElement>(null);
  const tile = useRef<HTMLDivElement>(null);
  useEffect(() => {
    let raf = 0;
    let smooth = 0;
    const tick = () => {
      smooth = smooth * 0.6 + session.level(who) * 0.4;
      if (bar.current) bar.current.style.transform = `scaleX(${Math.min(1, smooth).toFixed(3)})`;
      tile.current?.classList.toggle('is-speaking', smooth > 0.08);
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [session, who]);
  return (
    <div ref={tile} className={`obs-speaker obs-speaker--${who}`}>
      <span className="obs-speaker-name">{label}</span>
      <span className="obs-speaker-state">{present ? 'In the call' : 'Not in the call'}</span>
      <span className="obs-meter" aria-hidden="true">
        <span ref={bar} className="obs-meter-fill" />
      </span>
    </div>
  );
}

const KIND_LABEL: Record<ChartEvent['kind'], string> = {
  order: 'Order',
  prescription: 'Rx',
  followup: 'Follow-up',
  exam: 'Exam',
  alert: 'Alert',
  diagnosis: 'Diagnosis',
  nurse: 'Nurse',
};

/** The student's Agent Room, read only. */
function RoomFeed({ room }: { room: RoomSummary }) {
  return (
    <div className="obs-panel obs-room">
      <p className="field-label">Agent Room (BAND)</p>
      <p className="obs-hint">In the room: {room.participants.map((p) => (p.human ? `${p.name} (human)` : p.name)).join(', ') || 'Asha'}</p>
      <ol aria-live="polite">
        {[...room.items].reverse().map((i, n) => (
          <li key={`${i.at}-${n}`} className={i.tone ? `is-${i.tone}` : undefined}>
            <b>{i.who}</b> {i.what}
          </li>
        ))}
      </ol>
    </div>
  );
}

function ChartFeed({ events, synced }: { events: ChartEvent[]; synced: boolean }) {
  return (
    <div className="obs-panel obs-chart">
      <p className="field-label">Live chart</p>
      {events.length === 0 ? (
        <p className="obs-empty">{synced ? 'No orders, exams or alerts yet.' : 'Waiting for the student’s chart...'}</p>
      ) : (
        <ol className="obs-events">
          {[...events].reverse().map((e, i) => (
            <li key={`${e.at}-${i}`} className={`obs-event obs-event--${e.kind} ${e.severity ? `is-${e.severity}` : ''}`}>
              <span className="obs-event-kind">{KIND_LABEL[e.kind]}</span>
              <span className="obs-event-text">
                {e.label}
                {e.detail && <span className="obs-event-detail">{e.detail}</span>}
              </span>
              <time className="obs-event-time">{new Date(e.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</time>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function Transcript({ view }: { view: ObserverView }) {
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [view.lines]);
  return (
    <div className="obs-panel obs-transcript">
      <p className="field-label">Live transcript</p>
      <div
        ref={box}
        className="obs-lines"
        aria-live="polite"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
        }}
      >
        {view.lines.length === 0 ? (
          <p className="obs-empty">The transcript appears here as the student and the patient speak.</p>
        ) : (
          view.lines.map((l) => (
            <p key={l.id} className={`obs-line obs-line--${l.who} ${l.partial ? 'is-partial' : ''}`}>
              <span className="obs-line-who">{l.who === 'doctor' ? 'Student' : 'Patient'}</span>
              <span className="obs-line-text">{l.text}</span>
            </p>
          ))
        )}
      </div>
    </div>
  );
}

function Whisper({ session, view }: { session: ObserverSession; view: ObserverView }) {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const send = async () => {
    if (!text.trim() || busy) return;
    setBusy(true);
    const ok = await session.sendWhisper(text);
    setBusy(false);
    if (ok) setText('');
  };
  return (
    <div className="obs-panel obs-whisper">
      <label className="field-label" htmlFor="obs-whisper">Whisper to the student</label>
      <p className="obs-hint">Appears as a quiet note on their screen. The patient never hears it.</p>
      <div className="obs-whisper-row">
        <input
          id="obs-whisper"
          className="input"
          value={text}
          maxLength={LIMITS.whisper}
          placeholder="Ask about red flags before you prescribe"
          disabled={view.phase !== 'live'}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => e.key === 'Enter' && void send()}
        />
        <button type="button" className="btn btn-primary btn-sm" disabled={!text.trim() || busy || view.phase !== 'live'} onClick={() => void send()}>
          Send
        </button>
      </div>
      {!view.studentOnline && view.phase === 'live' && <p className="obs-hint obs-hint--warn">The student's tab is not connected right now.</p>}
      {view.whispers.length > 0 && (
        <ul className="obs-sent">
          {[...view.whispers].reverse().slice(0, 4).map((w) => (
            <li key={w.id}>
              <span>{w.text}</span>
              <span className={`obs-tick ${w.delivered ? 'is-done' : ''}`}>{w.delivered ? 'Seen' : 'Sent'}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function MarkingSheet({ session, view }: { session: ObserverSession; view: ObserverView }) {
  const [scores, setScores] = useState<Partial<Record<MarkDomain, number>>>({});
  const [comment, setComment] = useState('');
  const [busy, setBusy] = useState(false);
  const complete = OSCE_DOMAINS.every((d) => scores[d.key]);
  const submit = async () => {
    if (!complete || busy) return;
    setBusy(true);
    await session.sendMarks(scores as Record<MarkDomain, number>, comment);
    setBusy(false);
  };
  return (
    <div className="obs-panel obs-marks">
      <p className="field-label">OSCE marking sheet</p>
      <p className="obs-hint">1 = clear fail, 3 = borderline pass, 5 = excellent.</p>
      {OSCE_DOMAINS.map((d) => (
        <fieldset key={d.key} className="obs-domain">
          <legend>{d.label}</legend>
          <div className="obs-scale">
            {[1, 2, 3, 4, 5].map((n) => (
              <label key={n} className={scores[d.key] === n ? 'is-on' : ''}>
                <input
                  type="radio"
                  name={`obs-${d.key}`}
                  value={n}
                  checked={scores[d.key] === n}
                  onChange={() => setScores((s) => ({ ...s, [d.key]: n }))}
                />
                {n}
              </label>
            ))}
          </div>
        </fieldset>
      ))}
      <label className="field-label" htmlFor="obs-comment">Comment</label>
      <textarea
        id="obs-comment"
        className="input obs-comment"
        rows={3}
        maxLength={LIMITS.comment}
        value={comment}
        placeholder="One strength, one thing to work on"
        onChange={(e) => setComment(e.target.value)}
      />
      <button type="button" className="btn btn-primary btn-block" disabled={!complete || busy || view.phase !== 'live'} onClick={() => void submit()}>
        {view.marks ? 'Resend marks' : 'Send marks to the student'}
      </button>
      {view.marks && (
        <p className={`obs-hint ${view.marks.delivered ? 'obs-hint--ok' : ''}`} role="status">
          {view.marks.delivered ? 'Received by the student and saved with their debrief.' : 'Sent, waiting for the student’s tab to confirm...'}
        </p>
      )}
    </div>
  );
}
