import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { KeyCap, UI, labelStyle, panel } from '../world/worldUi';
import { PriyaSprite } from './PriyaSprite';
import { useReceptionSession } from './useReceptionSession';
import { RECEPTIONIST } from '../../voice/receptionistPersona';
import { openAssignment, submitToTeacher, useAssignment } from '../../assignments/client';
import { formatDue } from '../../assignments/core';
import { useProfile, openProfileDialog } from '../../game/profile';

const STATUS_LABEL: Record<string, string> = {
  uninitialized: 'Voice off',
  loading: 'Connecting...',
  ready: 'Listening',
  listening: 'Hearing you',
  thinking: 'Thinking...',
  speaking: 'Speaking',
  error: 'Voice error',
};

const btn: CSSProperties = {
  ...labelStyle,
  fontSize: 11,
  padding: '9px 10px',
  border: `2px solid ${UI.line}`,
  background: UI.bg,
  color: UI.text,
  boxShadow: '2px 2px 0 0 #061431',
  cursor: 'pointer',
};
const primaryBtn: CSSProperties = { ...btn, background: UI.primary, color: '#0b1f4b' };
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

const SUGGESTIONS = ["What's pending on my assignment?", 'How am I doing?', 'Email my report to my teacher'];

/** Front-desk overlay: Priya's avatar, live captions, text box and mic. */
export function ReceptionPanel({ onClose }: { onClose: () => void }) {
  const desk = useReceptionSession();
  const view = useAssignment();
  const profile = useProfile();
  const [draft, setDraft] = useState('');
  const [code, setCode] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const logEnd = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);
  useEffect(() => {
    logEnd.current?.scrollIntoView({ block: 'end' });
  }, [desk.log.length]);
  const hangUp = desk.hangUp;
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        hangUp();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [hangUp, onClose]);

  const send = (t: string) => {
    if (!t.trim()) return;
    setDraft('');
    void desk.send(t);
  };

  const submit = async () => {
    if (!profile) {
      openProfileDialog();
      return;
    }
    setSubmitting(true);
    const res = await submitToTeacher();
    setSubmitting(false);
    if (res.ok) void desk.say(`Done! I've emailed your report to ${res.teacherName || 'your teacher'}. Good luck!`);
    else void desk.say(`Sorry, I couldn't send it. ${res.reason ?? ''}`);
  };

  const a = view.assignment;
  const p = view.progress;
  const statusText = desk.busy ? 'Working...' : (STATUS_LABEL[desk.status] ?? desk.status);

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label={RECEPTIONIST.title}
      style={{ position: 'absolute', inset: 0, background: 'rgba(5,11,26,.5)', display: 'grid', placeItems: 'center', zIndex: 45, padding: 16 }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div style={{ ...panel, width: 'min(760px, 100%)', maxHeight: 'calc(100vh - 32px)', display: 'grid', gridTemplateColumns: 'minmax(0, 230px) minmax(0, 1fr)', gap: 0, overflow: 'hidden' }}>
        {/* left: Priya + assignment */}
        <div style={{ background: UI.bg, borderRight: `2px solid ${UI.line}`, padding: 14, display: 'grid', alignContent: 'start', gap: 10, overflow: 'auto' }}>
          <div style={{ display: 'grid', placeItems: 'center', background: '#16326e', border: `2px solid ${UI.line}`, padding: '10px 0 4px' }}>
            <PriyaSprite talking={desk.talking} busy={desk.busy} size={150} />
          </div>
          <div>
            <div style={{ fontFamily: UI.heading, fontSize: 30, lineHeight: 1 }}>{RECEPTIONIST.title}</div>
            <div style={{ ...labelStyle, fontSize: 10, opacity: 0.8, marginTop: 4 }}>Front desk · MedSim General</div>
          </div>
          {a && p ? (
            <div style={{ border: `2px solid ${p.overdue ? UI.amber : UI.line}`, padding: 10, display: 'grid', gap: 6 }}>
              <div style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>Your assignment · {a.code}</div>
              <div style={{ fontFamily: UI.heading, fontSize: 22, lineHeight: 1 }}>{a.title}</div>
              <div style={{ fontFamily: UI.label, fontSize: 13 }}>
                {p.done}/{p.total} done · due {formatDue(a.dueDate)}
                {p.average !== null && <> · avg {Math.round(p.average)}</>}
              </div>
              {p.pending.length > 0 && (
                <div style={{ fontFamily: UI.label, fontSize: 12, opacity: 0.85 }}>Pending: {p.pending.map((i) => i.label).join(', ')}</div>
              )}
              <button type="button" style={{ ...primaryBtn, marginTop: 4 }} onClick={() => void submit()} disabled={submitting}>
                {submitting ? 'Sending...' : 'Submit to teacher'}
              </button>
            </div>
          ) : (
            <form
              onSubmit={(e) => {
                e.preventDefault();
                if (code.trim()) void openAssignment(code);
              }}
              style={{ display: 'grid', gap: 6 }}
            >
              <span style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>Have an assignment code?</span>
              <div style={{ display: 'flex', gap: 6 }}>
                <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} maxLength={6} placeholder="AB3K9Q" aria-label="Assignment code" style={{ ...input, letterSpacing: '.2em' }} />
                <button type="submit" style={btn}>Open</button>
              </div>
              {view.error && <span style={{ fontFamily: UI.label, fontSize: 12, color: UI.amber }}>{view.error}</span>}
            </form>
          )}
        </div>

        {/* right: captions, log, input */}
        <div style={{ padding: 14, display: 'flex', flexDirection: 'column', gap: 10, minHeight: 0, minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...labelStyle, fontSize: 10, padding: '3px 6px', background: desk.live ? UI.primary : UI.bg, color: desk.live ? '#0b1f4b' : UI.text, border: `2px solid ${UI.line}` }}>
              {statusText}
            </span>
            <button
              type="button"
              onClick={() => {
                desk.hangUp();
                onClose();
              }}
              style={{ ...btn, marginLeft: 'auto' }}
              aria-label="Close reception"
            >
              Close · Esc
            </button>
          </div>

          <div style={{ background: UI.bg, border: `2px solid ${UI.line}`, padding: '10px 12px', fontFamily: UI.label, fontSize: 16, lineHeight: 1.4, minHeight: 64 }} aria-live="polite">
            <span style={{ ...labelStyle, fontSize: 10, color: UI.primary, display: 'block', marginBottom: 4 }}>Priya</span>
            {desk.caption}
          </div>
          {desk.youCaption && (
            <div style={{ fontFamily: UI.label, fontSize: 13, opacity: 0.8, textAlign: 'right' }}>
              <span style={{ ...labelStyle, fontSize: 9, color: UI.amber }}>You </span>
              {desk.youCaption}
            </div>
          )}

          <div style={{ flex: 1, minHeight: 90, maxHeight: 220, overflow: 'auto', display: 'grid', alignContent: 'start', gap: 6 }}>
            {desk.log.map((l) =>
              l.who === 'action' ? (
                <div key={l.id} style={{ ...labelStyle, fontSize: 10, letterSpacing: '.06em', color: l.ok ? UI.primary : UI.amber, borderLeft: `3px solid ${l.ok ? UI.primary : UI.amber}`, paddingLeft: 8 }}>
                  {l.ok ? 'Done' : 'Failed'} · {l.text}
                </div>
              ) : (
                <div key={l.id} style={{ fontFamily: UI.label, fontSize: 13, lineHeight: 1.35, textAlign: l.who === 'you' ? 'right' : 'left' }}>
                  <span style={{ ...labelStyle, fontSize: 9, color: l.who === 'you' ? UI.amber : UI.primary }}>{l.who === 'you' ? 'You' : 'Priya'}</span>
                  <div>{l.text}</div>
                </div>
              ),
            )}
            <div ref={logEnd} />
          </div>

          {desk.error && (
            <div role="alert" style={{ fontFamily: UI.label, fontSize: 13, color: UI.amber }}>
              {desk.error}{' '}
              <button type="button" onClick={desk.clearError} style={{ ...btn, padding: '2px 6px', fontSize: 10 }}>OK</button>
            </div>
          )}
          {desk.status === 'loading' && desk.progress && <div style={{ ...labelStyle, fontSize: 10, opacity: 0.8 }}>{desk.progress}</div>}

          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
            {SUGGESTIONS.map((s) => (
              <button key={s} type="button" onClick={() => send(s)} style={{ ...btn, padding: '6px 8px', fontSize: 10, textTransform: 'none', letterSpacing: '.04em' }}>
                {s}
              </button>
            ))}
          </div>

          <form
            onSubmit={(e) => {
              e.preventDefault();
              send(draft);
            }}
            style={{ display: 'flex', gap: 6 }}
          >
            <button
              type="button"
              onClick={desk.toggle}
              style={desk.live || desk.status === 'loading' ? btn : primaryBtn}
              aria-label={desk.live ? 'Hang up voice' : 'Talk to Priya by voice'}
              title={desk.live ? 'Hang up' : 'Talk by voice'}
            >
              {desk.live || desk.status === 'loading' ? 'Hang up' : 'Mic'}
            </button>
            {desk.live && (
              <button type="button" onClick={desk.toggleMic} style={btn} aria-pressed={desk.micMuted}>
                {desk.micMuted ? 'Unmute' : 'Mute'}
              </button>
            )}
            <input
              ref={inputRef}
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder={desk.live ? 'Speak, or type to Priya...' : 'Type to Priya...'}
              aria-label="Message to reception"
              style={input}
            />
            <button type="submit" style={primaryBtn} disabled={desk.busy}>Send</button>
          </form>
          <div style={{ ...labelStyle, fontSize: 9, opacity: 0.6, display: 'flex', alignItems: 'center' }}>
            <KeyCap>Esc</KeyCap> back to the lobby
          </div>
        </div>
      </div>
    </div>
  );
}
