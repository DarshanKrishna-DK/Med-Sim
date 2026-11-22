import { Fragment, useEffect, useMemo, useRef, useState, type FormEvent, type ReactNode } from 'react';
import { useAgentRoom, useOsceLive } from '../../game/store';
import type { ActivePatient } from '../../game/types';
import { encounterIdOf } from '../../room/chart';
import {
  answerQuestion,
  cancelDelegation,
  inviteFaculty,
  openRoom,
  requestOverride,
  retryDelegation,
  sayToFaculty,
} from '../../room/client';
import {
  awaitingFaculty,
  elapsedSeconds,
  facultyMember,
  facultyName,
  facultyPresent,
  heldDelegations,
  isHumanMessage,
  isOpen,
  isSideConversation,
  isSlim,
  knowledge,
  FACTS,
  notShared,
  openQuestion,
  ROLE_LABEL,
  sharedFields,
  ticker,
  tracker,
  type RoomQuestion,
  type RoomState,
} from '../../room/reducer';
import type { Delegation, RoomDelivery, RoomMessage, RoomParticipant, RoomRole } from '../../room/types';
import { useStaffSpeaking } from '../../voice/speech';
import { Icon } from './HudControls';
import { RoomAvatar } from './RoomAvatar';
import '../../styles/agentroom.css';

/* The BAND agent room, docked in the left column of the consultation. What you
 * see is the room as its participants see it: who was mentioned, what each
 * hand-off carried, and what never reached whom. */

const clock = (iso: string) => {
  const t = Date.parse(iso);
  return Number.isFinite(t) ? new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
};

const firstName = (p: RoomParticipant): string => {
  const parts = p.name.trim().split(/\s+/);
  return p.human ? p.name : parts[parts.length - 1];
};

const listOf = (names: string[]): string =>
  names.length <= 1 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names[names.length - 1]}`;

/** Re-render once a second while something is running. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [active]);
  return now;
}

/** Run a room action, with a busy flag and a readable failure. */
function useAction(): { busy: boolean; error: string; run: (fn: () => Promise<unknown>) => Promise<boolean> } {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const run = async (fn: () => Promise<unknown>) => {
    if (busy) return false;
    setBusy(true);
    setError('');
    try {
      await fn();
      return true;
    } catch (err) {
      setError(err instanceof Error && err.message.length < 120 ? err.message : 'That did not reach the room. Try again.');
      return false;
    } finally {
      setBusy(false);
    }
  };
  return { busy, error, run };
}

// ── panel ────────────────────────────────────────────────────────────────

export function AgentRoomPanel({ patient }: { patient: ActivePatient }) {
  const all = useAgentRoom();
  const encounterId = encounterIdOf(patient);
  const room = all?.encounterId === encounterId ? all : null;
  const osce = useOsceLive();
  const [choice, setChoice] = useState<{ id: string; lively: boolean; open: boolean } | null>(null);

  // Idempotent: one room per seated patient, whatever StrictMode does.
  useEffect(() => {
    openRoom(patient);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [encounterId]);

  // The first hand-off (or a human arriving) opens the panel; after that the
  // doctor's own choice stands until the next patient.
  const lively = !!room && (room.delegations.length > 0 || room.faculty.length > 0);
  const open = choice && choice.id === encounterId && choice.lively === lively ? choice.open : lively;

  const enabled = !!room?.enabled;
  const conn = room?.connection ?? 'connecting';
  const live = enabled ? (conn === 'idle' ? 'live' : conn) : conn === 'connecting' ? 'connecting' : 'off';
  const line = !room || live === 'off' ? 'Not connected. Asha handles orders on her own.' : live === 'connecting' && !lively ? 'Connecting to BAND' : ticker(room);
  const attention = !!room && (!!openQuestion(room) || awaitingFaculty(room));

  return (
    <section className={`aroom hud-panel ${open ? 'is-open' : ''} ${attention ? 'needs-you' : ''}`} aria-label="Agent Room">
      <header className="aroom-head">
        <button
          type="button"
          className="aroom-toggle"
          aria-expanded={open}
          aria-controls="aroom-body"
          onClick={() => setChoice({ id: encounterId, lively, open: !open })}
        >
          <span className="aroom-title">Agent Room</span>
          <span className="aroom-band">BAND</span>
          <span className={`aroom-live aroom-live--${live}`}>
            <span className="aroom-live-dot" aria-hidden="true" />
            {live === 'live' ? 'live' : live === 'connecting' ? 'connecting' : live === 'offline' ? 'reconnecting' : 'off'}
          </span>
          {Icon.chevron(open)}
        </button>
      </header>
      {!open && (
        <p className="aroom-ticker" role="status">
          {attention && <span className="aroom-ticker-flag">Needs you</span>}
          <span className="aroom-ticker-text">{line}</span>
        </p>
      )}
      <div id="aroom-body" className="aroom-body" hidden={!open}>
        {open && (room && enabled ? <RoomBody room={room} osce={osce} /> : <Offline reason={room?.reason} connecting={live === 'connecting'} />)}
      </div>
    </section>
  );
}

function Offline({ reason, connecting }: { reason?: string; connecting: boolean }) {
  return (
    <div className="aroom-empty">
      <p>
        {connecting
          ? 'Connecting to the hospital departments on BAND.'
          : 'The departments are not connected, so Asha carries out orders herself and results come back at once.'}
      </p>
      {reason && !connecting && <p className="aroom-fine">{reason}</p>}
    </div>
  );
}

function RoomBody({ room, osce }: { room: RoomState; osce: boolean }) {
  const open = room.delegations.some(isOpen);
  const now = useNow(open);
  const q = openQuestion(room);
  const held = heldDelegations(room);
  const troubled = room.delegations.filter((d) => d.status === 'timeout' || d.status === 'failed');
  const active = room.delegations.filter(isOpen);
  const empty = room.messages.length === 0 && room.delegations.length === 0 && room.faculty.length === 0;

  return (
    <>
      <RoomLink room={room} />
      <Roster room={room} />
      {empty ? (
        <div className="aroom-empty">
          <p>Order a drug, a test or a scan and Asha brings in that department, and only that one; their conversation appears here as it happens.</p>
        </div>
      ) : (
        <div className="aroom-mid">
          <div className="aroom-flow">
          {(q || active.length > 0 || held.length > 0 || troubled.length > 0 || room.faculty.length > 0) && (
            <div className="aroom-tray">
              {q && <QuestionCard key={`${q.ref}-${q.seq}`} room={room} q={q} />}
              <FacultyBanner room={room} />
              {held.map((d) => (
                <HoldCard key={d.ref} room={room} d={d} osce={osce} />
              ))}
              {troubled.map((d) => (
                <TroubleCard key={d.ref} d={d} />
              ))}
              {active.map((d) => (
                <WorkCard key={d.ref} room={room} d={d} now={now} />
              ))}
            </div>
          )}
          <div className="aroom-scroll">
            <Messages room={room} />
          </div>
          </div>
        </div>
      )}
      <RoomFoot room={room} />
    </>
  );
}

function RoomLink({ room }: { room: RoomState }) {
  if (!room.roomId) return null;
  return (
    <p className="aroom-link">
      <span>
        Room <code>{room.roomId.slice(0, 8)}</code>
      </span>
      {room.url && (
        <a href={room.url} target="_blank" rel="noreferrer noopener">
          Open in BAND<span className="sr-only"> (new tab)</span>
        </a>
      )}
    </p>
  );
}

// ── roster ───────────────────────────────────────────────────────────────

function Roster({ room }: { room: RoomState }) {
  const speaking = useStaffSpeaking()?.speaker ?? null;
  const latest = [...room.participants].reverse().find((p) => room.joinedFor[p.id]);
  if (room.participants.length === 0) return null;
  return (
    <div className="aroom-roster">
      <ul aria-label="In the room">
        {room.participants.map((p) => {
          const human = p.human || p.role === 'faculty';
          const talking = speaking === p.role;
          const why = room.joinedFor[p.id];
          return (
            <li
              key={p.id}
              className={`aroom-seat ar-role--${p.role} ${human ? 'is-human' : ''} ${talking ? 'is-speaking' : ''}`}
              title={why ? `${p.name}, ${p.title}. ${human ? `Invited: ${why}` : `Added to ${why}`}` : `${p.name}, ${p.title}`}
            >
              <span className="aroom-face">
                <RoomAvatar role={p.role} size={32} />
                <span className={`aroom-dot ${p.online ? 'is-on' : ''}`} aria-hidden="true" />
                {talking && (
                  <span className="aroom-eq" aria-hidden="true">
                    <i /><i /><i />
                  </span>
                )}
              </span>
              <span className="aroom-seat-name">{human ? firstName(p) : ROLE_LABEL[p.role]}</span>
              {human && <span className="aroom-human">Human</span>}
              <span className="sr-only">
                {p.name}, {p.title}, {p.online ? 'online' : 'offline'}
                {talking ? ', speaking now' : ''}
              </span>
            </li>
          );
        })}
      </ul>
      {latest && (
        <p className="aroom-because" key={latest.id}>
          {latest.human || latest.role === 'faculty' ? `${latest.name} was invited: ${room.joinedFor[latest.id]}` : `Asha added ${firstName(latest)} to ${room.joinedFor[latest.id]}`}
        </p>
      )}
    </div>
  );
}

// ── cards ────────────────────────────────────────────────────────────────

function WorkCard({ room, d, now }: { room: RoomState; d: Delegation; now: number }) {
  const { busy, error, run } = useAction();
  const secs = elapsedSeconds(d, now);
  return (
    <article className={`aroom-card ar-role--${d.target}`} aria-label={`${ROLE_LABEL[d.target]}: ${d.label}`}>
      <p className="aroom-card-head">
        <span className="aroom-card-who">{ROLE_LABEL[d.target]}</span>
        <span className="aroom-card-label">{d.label}</span>
        <span className="aroom-secs">{secs} s</span>
      </p>
      <ol className="aroom-track" aria-label="Progress">
        {tracker(room, d).map((s) => (
          <li key={s.label} className={`is-${s.state}`} aria-current={s.state === 'now' ? 'step' : undefined}>
            <span>{s.label}</span>
          </li>
        ))}
      </ol>
      {secs >= 20 && (
        <p className="aroom-card-actions">
          <button type="button" className="aroom-mini" disabled={busy} onClick={() => void run(() => cancelDelegation(d.ref))}>
            Cancel
          </button>
          {error && <span role="alert">{error}</span>}
        </p>
      )}
    </article>
  );
}

function TroubleCard({ d }: { d: Delegation }) {
  const { busy, error, run } = useAction();
  return (
    <article className={`aroom-card aroom-card--trouble ar-role--${d.target}`}>
      <p className="aroom-card-head">
        <span className="aroom-card-who">{ROLE_LABEL[d.target]}</span>
        <span className="aroom-card-label">{d.label}</span>
      </p>
      <p className="aroom-card-text">
        {d.status === 'timeout' ? `${ROLE_LABEL[d.target]} has not replied. The order is still pending.` : d.summary || 'The hand-off failed. The order is still pending.'}
      </p>
      <p className="aroom-card-actions">
        <button type="button" className="aroom-mini aroom-mini--go" disabled={busy} onClick={() => void run(() => retryDelegation(d.ref))}>
          Try again
        </button>
        <button type="button" className="aroom-mini" disabled={busy} onClick={() => void run(() => cancelDelegation(d.ref))}>
          Cancel the order
        </button>
        {error && <span role="alert">{error}</span>}
      </p>
    </article>
  );
}

interface Verdict {
  reason: string;
  suggestion: string;
  evidence: Array<{ source: string; detail: string }>;
}

function verdictOf(room: RoomState, ref: string): Verdict {
  const m = [...room.messages].reverse().find((x) => (x.ref === ref || x.payload?.originalRef === ref) && (x.kind === 'verdict' || x.kind === 'recall'));
  const p = (m?.payload ?? {}) as Record<string, unknown>;
  const s = p.suggestion as { name?: unknown; dose?: unknown } | undefined;
  const evidence = Array.isArray(p.evidence)
    ? p.evidence
        .map((e) => e as Record<string, unknown>)
        .filter((e) => e && typeof e === 'object')
        .map((e) => ({ source: String(e.source ?? ''), detail: String(e.detail ?? '') }))
        .filter((e) => e.source || e.detail)
        .slice(0, 5)
    : [];
  return {
    reason: typeof p.reason === 'string' ? p.reason : '',
    suggestion: s && typeof s === 'object' && s.name ? [s.name, s.dose].filter(Boolean).join(', ') : '',
    evidence,
  };
}

function HoldCard({ room, d, osce }: { room: RoomState; d: Delegation; osce: boolean }) {
  const v = verdictOf(room, d.ref);
  const { busy, error, run } = useAction();
  const [asked, setAsked] = useState(false);
  const who = facultyPresent(room) ? facultyName(room) : 'faculty';
  return (
    <article className="aroom-card aroom-card--hold" aria-label={`On hold: ${d.label}`}>
      <p className="aroom-card-head">
        <span className="aroom-hold">Hold</span>
        <span className="aroom-card-label">{d.label}</span>
      </p>
      <p className="aroom-card-text">{v.reason || d.summary || 'The pharmacist is holding this drug.'}</p>
      <p className="aroom-fine">Not on the prescription. Only a human can release it.</p>
      {v.evidence.length > 0 && (
        <details className="aroom-more">
          <summary>Evidence ({v.evidence.length})</summary>
          <ul>
            {v.evidence.map((e, i) => (
              <li key={i}>
                <b>{e.source}</b> {e.detail}
              </li>
            ))}
          </ul>
        </details>
      )}
      {v.suggestion && !osce && <p className="aroom-card-text aroom-suggest">Pharmacy suggests {v.suggestion}</p>}
      <p className="aroom-card-actions">
        {asked ? (
          <span role="status">Asked {who}. Waiting for a human decision.</span>
        ) : (
          <button
            type="button"
            className="aroom-mini aroom-mini--gold"
            disabled={busy}
            onClick={() => void run(() => requestOverride(d.ref)).then((ok) => ok && setAsked(true))}
          >
            Ask faculty to override
          </button>
        )}
        <button type="button" className="aroom-mini" disabled={busy} onClick={() => void run(() => cancelDelegation(d.ref))}>
          Drop the drug
        </button>
        {error && <span role="alert">{error}</span>}
      </p>
    </article>
  );
}

function QuestionCard({ room, q }: { room: RoomState; q: RoomQuestion }) {
  const [typing, setTyping] = useState(false);
  const [text, setText] = useState('');
  const { busy, error, run } = useAction();
  const send = (t: string) => run(() => answerQuestion(q.ref, t));
  const label = room.delegations.find((d) => d.ref === q.ref)?.label;
  return (
    <article className={`aroom-card aroom-card--ask ar-role--${q.from}`} aria-label={`${ROLE_LABEL[q.from]} asks you`}>
      <p className="aroom-card-head">
        <span className="aroom-card-who">{ROLE_LABEL[q.from]} asks you</span>
        {label && <span className="aroom-card-label aroom-card-label--dim">{label}</span>}
      </p>
      <p className="aroom-question">{q.text}</p>
      {typing ? (
        <form
          className="aroom-answer"
          onSubmit={(e: FormEvent) => {
            e.preventDefault();
            if (text.trim()) void send(text.trim());
          }}
        >
          <label className="sr-only" htmlFor="aroom-answer">Your answer</label>
          <input id="aroom-answer" className="input" autoFocus value={text} onChange={(e) => setText(e.target.value)} autoComplete="off" placeholder="Your answer" />
          <button type="submit" className="aroom-mini aroom-mini--go" disabled={busy || !text.trim()}>
            Answer
          </button>
        </form>
      ) : (
        <p className="aroom-card-actions">
          <button type="button" className="aroom-mini aroom-mini--go" disabled={busy} onClick={() => void send('Yes')}>Yes</button>
          <button type="button" className="aroom-mini aroom-mini--go" disabled={busy} onClick={() => void send('No')}>No</button>
          <button type="button" className="aroom-mini" disabled={busy} onClick={() => setTyping(true)}>Type</button>
          <span className="aroom-fine">or just say it</span>
        </p>
      )}
      {error && <p className="aroom-fine" role="alert">{error}</p>}
    </article>
  );
}

function FacultyBanner({ room }: { room: RoomState }) {
  const p = facultyMember(room);
  if (!facultyPresent(room)) {
    const last = room.faculty[room.faculty.length - 1];
    if (last?.action !== 'invited') return null;
    return (
      <p className="aroom-banner aroom-banner--wait" role="status">
        Waiting for {facultyMember(room)?.name ?? 'a faculty member'} to answer in BAND.
      </p>
    );
  }
  return (
    <div className="aroom-banner" role="status">
      <RoomAvatar role="faculty" size={28} />
      <p>
        <b>{p?.name ?? facultyName(room)}</b> is in the room. A person, not an agent.
      </p>
    </div>
  );
}

// ── messages ─────────────────────────────────────────────────────────────

const TICK: Record<RoomDelivery, { n: 1 | 2; label: string }> = {
  sent: { n: 1, label: 'Sent' },
  delivered: { n: 2, label: 'Delivered' },
  processing: { n: 2, label: 'Working on it' },
  processed: { n: 2, label: 'Done' },
  failed: { n: 1, label: 'Failed' },
};

function Ticks({ d }: { d: RoomDelivery }) {
  const t = TICK[d];
  if (!t) return null;
  return (
    <span className={`aroom-ticks aroom-ticks--${d}`} title={t.label}>
      <svg width="18" height="10" viewBox="0 0 18 10" aria-hidden="true" shapeRendering="crispEdges" fill="none" stroke="currentColor" strokeWidth="2">
        {d === 'failed' ? <path d="m4 2 6 6M10 2 4 8" /> : <path d="m1 5 3 3 6-7" />}
        {t.n === 2 && <path d="m8 7 1 1 6-7" />}
      </svg>
      <span className="aroom-tick-label">{t.label}</span>
    </span>
  );
}

function Mention({ role }: { role: RoomRole }) {
  return <span className={`aroom-mention ar-role--${role}`}>@{ROLE_LABEL[role]}</span>;
}

const ACTION_WORD: Record<string, string> = {
  thought: 'thinks',
  tool_call: 'ran',
  tool_result: 'got',
  error: 'hit an error',
  system: '',
};

function Slim({ m }: { m: RoomMessage }) {
  return (
    <li className={`aroom-slim aroom-slim--${m.type} ar-role--${m.from}`}>
      <span className="aroom-slim-who">
        {m.type === 'system' ? '' : `${ROLE_LABEL[m.from] ?? m.fromName} ${ACTION_WORD[m.type] ?? ''}`}
      </span>{' '}
      {m.type === 'tool_call' ? <code>{m.text || String(m.payload?.name ?? 'a tool')}</code> : <span>{m.text || (m.payload?.success === false ? 'no result' : 'done')}</span>}
    </li>
  );
}

function Shared({ room, m }: { room: RoomState; m: RoomMessage }) {
  const fields = sharedFields(m.payload);
  if (!fields.length || !m.to.length) return null;
  return (
    <details className="aroom-more">
      <summary>What was shared</summary>
      <p>{fields.join(', ')}</p>
      {m.to
        .filter((r) => r !== 'nurse' && r !== 'faculty')
        .map((r) => {
          const missing = notShared(room, r);
          return missing.length ? (
            <p key={r} className="aroom-withheld">
              Not shared with {ROLE_LABEL[r]}: {missing.join(', ')}
            </p>
          ) : null;
        })}
    </details>
  );
}

function Bubble({ room, m }: { room: RoomState; m: RoomMessage }) {
  const human = isHumanMessage(m);
  const name = human ? m.fromName || facultyName(room) : ROLE_LABEL[m.from] ?? m.fromName;
  return (
    <li className={`aroom-msg ar-role--${m.from} ${human ? 'is-human' : ''}`}>
      <RoomAvatar role={human ? 'faculty' : m.from} size={24} />
      <div className="aroom-msg-main">
        <p className="aroom-msg-head">
          <span className="aroom-msg-name">{name}</span>
          {human && <span className="aroom-human">Human</span>}
          <time dateTime={m.at}>{clock(m.at)}</time>
        </p>
        <p className="aroom-msg-text">
          {m.to.map((r) => (
            <Fragment key={r}>
              <Mention role={r} />{' '}
            </Fragment>
          ))}
          {m.text}
        </p>
        {m.delivery && m.to.length > 0 && <Ticks d={m.delivery} />}
        <Shared room={room} m={m} />
      </div>
    </li>
  );
}

interface Group {
  side: string | null;
  items: RoomMessage[];
}

/** Consecutive department-to-department messages read as one aside. */
function grouped(messages: RoomMessage[]): Group[] {
  const out: Group[] = [];
  for (const m of messages) {
    const side = isSideConversation(m) ? listOf([...new Set([m.from, ...m.to])].sort().map((r) => ROLE_LABEL[r])) : null;
    const last = out[out.length - 1];
    if (last && last.side === side) last.items.push(m);
    else out.push({ side, items: [m] });
  }
  return out;
}

function Messages({ room }: { room: RoomState }) {
  const groups = useMemo(() => grouped(room.messages), [room.messages]);
  const end = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const box = useRef<HTMLElement | null>(null);

  // Follow the conversation unless the doctor scrolled up to read.
  useEffect(() => {
    const el = end.current?.closest<HTMLElement>('.aroom-scroll') ?? null;
    box.current = el;
    if (!el) return;
    const onScroll = () => {
      stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    // The tray above grows and shrinks; keep the last message in view.
    const ro = new ResizeObserver(() => {
      if (stick.current) el.scrollTop = el.scrollHeight;
    });
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', onScroll);
      ro.disconnect();
    };
  }, []);
  useEffect(() => {
    const el = box.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [room.messages]);

  const render = (m: RoomMessage): ReactNode => (isSlim(m) ? <Slim key={m.id} m={m} /> : <Bubble key={m.id} room={room} m={m} />);
  return (
    <>
      <ol className="aroom-msgs" role="log" aria-label="Room messages" aria-live="polite" aria-relevant="additions">
        {groups.map((g) =>
          g.side ? (
            <li key={`side-${g.items[0].id}`} className="aroom-side">
              <p className="aroom-side-label">
                <svg width="10" height="12" viewBox="0 0 10 12" aria-hidden="true" shapeRendering="crispEdges">
                  <path d="M2 5V3h1V2h4v1h1v2h1v6H1V5Zm2 0h2V4H4Z" fill="currentColor" />
                </svg>
                Private to {g.side}. Asha did not receive this.
              </p>
              <ol>{g.items.map(render)}</ol>
            </li>
          ) : (
            g.items.map(render)
          ),
        )}
      </ol>
      <div ref={end} />
    </>
  );
}

// ── footer: reply to the human, invite, who knows what ───────────────────

function RoomFoot({ room }: { room: RoomState }) {
  const present = facultyPresent(room);
  const name = facultyName(room);
  const asked = awaitingFaculty(room);
  const [text, setText] = useState('');
  const [link, setLink] = useState('');
  const { busy, error, run } = useAction();
  const invited = room.faculty.some((f) => f.action === 'invited') || !!link;

  return (
    <footer className="aroom-foot">
      {present ? (
        <form
          className={`aroom-reply ${asked ? 'is-asked' : ''}`}
          onSubmit={(e) => {
            e.preventDefault();
            const t = text.trim();
            if (t) void run(() => sayToFaculty(t)).then((ok) => ok && setText(''));
          }}
        >
          <label className="sr-only" htmlFor="aroom-reply">Reply to {name}</label>
          <input
            id="aroom-reply"
            className="input"
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder={`Reply to ${name}`}
            autoComplete="off"
          />
          <button type="submit" className="aroom-mini aroom-mini--gold" disabled={busy || !text.trim()}>
            Reply
          </button>
        </form>
      ) : (
        <p className="aroom-card-actions">
          <button
            type="button"
            className="aroom-mini"
            disabled={busy}
            onClick={() => void run(async () => setLink((await inviteFaculty())?.url ?? ''))}
          >
            {invited ? 'Invite faculty again' : 'Invite faculty'}
          </button>
          {link && (
            <a className="aroom-fine" href={link} target="_blank" rel="noreferrer noopener">
              Open their room link
            </a>
          )}
        </p>
      )}
      {error && <p className="aroom-fine" role="alert">{error}</p>}
      <KnowledgeTable room={room} />
    </footer>
  );
}

function KnowledgeTable({ room }: { room: RoomState }) {
  const know = useMemo(() => knowledge(room), [room]);
  const roles = room.participants.map((p) => p.role).filter((r, i, a) => r !== 'nurse' && r !== 'faculty' && a.indexOf(r) === i);
  const rows = FACTS.filter((f) => Object.values(know).some((v) => v?.includes(f)));
  if (!roles.length || !rows.length) return null;
  return (
    <details className="aroom-more aroom-know">
      <summary>Who knows what</summary>
      <table>
        <thead>
          <tr>
            <th scope="col"><span className="sr-only">Fact</span></th>
            {roles.map((r) => (
              <th key={r} scope="col" className={`ar-role--${r}`}>{ROLE_LABEL[r]}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((f) => (
            <tr key={f}>
              <th scope="row">{f}</th>
              {roles.map((r) => {
                const yes = know[r]?.includes(f);
                return (
                  <td key={r} className={`ar-role--${r} ${yes ? 'is-yes' : ''}`}>
                    <span aria-hidden="true" />
                    <span className="sr-only">{yes ? 'yes' : 'no'}</span>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </details>
  );
}
