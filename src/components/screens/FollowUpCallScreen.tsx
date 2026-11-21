import { useCallback, useEffect, useRef, useState } from 'react';
import { Conversation, type ConversationStatus } from '../../voice/conversation';
import { AshaSprite, type AshaMood } from '../encounter/NurseAsha';
import { callApi, type CallInfo } from '../../voice/followupCall';
import '../../styles/followup.css';

type Phase = 'loading' | 'invalid' | 'idle' | 'connecting' | 'live' | 'saving' | 'done';

interface Caption { who: 'asha' | 'you'; text: string }

function mmss(s: number): string {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
}

function friendly(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  const detail = /"detail"\s*:\s*"([^"]+)"/.exec(msg)?.[1];
  if (detail) return detail;
  if (/permission/i.test(msg)) return 'Please allow microphone access, then tap the button again.';
  if (/microphone found/i.test(msg)) return 'No microphone found on this device.';
  if (/not configured|unreachable/i.test(msg)) return 'The clinic line is not available right now. Please try again later.';
  return msg;
}

function moodFor(phase: Phase, status: ConversationStatus): AshaMood {
  if (phase === 'done') return 'happy';
  if (phase === 'connecting' || phase === 'saving') return 'working';
  if (phase !== 'live') return 'idle';
  if (status === 'speaking') return 'talking';
  if (status === 'thinking') return 'working';
  if (status === 'listening') return 'listening';
  return 'idle';
}

/** /call/<token>: the patient's phone talks to Nurse Asha (Agora ConvoAI). Mobile first, no 3D. */
export default function FollowUpCallScreen({ token }: { token: string }) {
  const [phase, setPhase] = useState<Phase>('loading');
  const [info, setInfo] = useState<CallInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [status, setStatus] = useState<ConversationStatus>('uninitialized');
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [partial, setPartial] = useState<Caption | null>(null);
  const [muted, setMuted] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const convRef = useRef<Conversation | null>(null);
  const ctxRef = useRef<AudioContext | null>(null);
  const startedAt = useRef(0);
  const finishing = useRef(false);
  const capEnd = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    document.title = 'Call with Nurse Asha';
    callApi
      .info(token)
      .then((d) => { setInfo(d); setPhase('idle'); })
      .catch((e) => { setError(friendly(e)); setPhase('invalid'); });
  }, [token]);

  const finish = useCallback(async () => {
    const conv = convRef.current;
    if (!conv || finishing.current) return;
    finishing.current = true;
    const transcript = conv
      .getMessages()
      .filter((m) => m.content.trim() && m.content.trim() !== '…')
      .map((m) => ({ role: m.role, content: m.content }));
    conv.dispose(); // stops the agent through /call-api/<token>/stop
    convRef.current = null;
    try { await ctxRef.current?.close(); } catch { /* noop */ }
    ctxRef.current = null;
    setPartial(null);
    setPhase('saving');
    try {
      await callApi.summary(token, transcript);
    } catch (e) {
      console.warn('[medsim:followup] summary failed:', e);
    }
    setPhase('done');
  }, [token]);

  const start = async () => {
    if (convRef.current) return;
    setError(null);
    setCaptions([]);
    setPartial(null);
    setMuted(false);
    finishing.current = false;
    setPhase('connecting');
    const ctx = new AudioContext();
    ctxRef.current = ctx;
    const conv = new Conversation(
      ctx,
      {
        onStatus: (s, detail) => {
          setStatus(s);
          // Asha's agent leaves at the 4 minute cap (or when the line drops): wrap up.
          if (s === 'error' && detail === 'agent left') void finish();
        },
        onSubtitle: (sub) => {
          const who = sub.who === 'patient' ? 'asha' : 'you';
          if (!sub.text || sub.text === '…') return;
          if (sub.partial) setPartial({ who, text: sub.text });
          else setPartial((p) => (p && p.who === who ? null : p));
        },
      },
      {
        caseId: 'followup-call',
        clinicalAgents: false,
        initialMessage: { role: 'assistant', content: '' },
        startUrl: callApi.startUrl(token),
        startBody: {},
        stopUrl: callApi.stopUrl(token),
      },
    );
    convRef.current = conv;
    conv.subscribeMessages((msgs) => {
      setCaptions(
        msgs
          .filter((m) => m.content.trim())
          .map((m) => ({ who: m.role === 'assistant' ? 'asha' : 'you', text: m.content }) as Caption)
          .slice(-8),
      );
    });
    try {
      await conv.init();
      startedAt.current = Date.now();
      setElapsed(0);
      setPhase('live');
      setInfo((i) => (i ? { ...i, callsLeftToday: Math.max(0, i.callsLeftToday - 1) } : i));
    } catch (e) {
      conv.dispose();
      convRef.current = null;
      try { await ctx.close(); } catch { /* noop */ }
      setError(friendly(e));
      setPhase('idle');
    }
  };

  // Call clock + client-side fallback for the server's 4 minute cap.
  useEffect(() => {
    if (phase !== 'live') return;
    const max = info?.maxSeconds ?? 240;
    const t = window.setInterval(() => {
      const s = (Date.now() - startedAt.current) / 1000;
      setElapsed(s);
      if (s > max + 5) void finish();
    }, 500);
    return () => window.clearInterval(t);
  }, [phase, info?.maxSeconds, finish]);

  useEffect(() => () => { convRef.current?.dispose(); void ctxRef.current?.close().catch(() => undefined); }, []);

  useEffect(() => { capEnd.current?.scrollIntoView({ block: 'end' }); }, [captions, partial]);

  const toggleMute = () => {
    const next = !muted;
    convRef.current?.setMicMuted(next);
    setMuted(next);
  };

  const mood = moodFor(phase, status);
  const speaking = phase === 'live' && status === 'speaking';
  const listening = phase === 'live' && status === 'listening';
  const firstName = info?.patientName?.split(/\s+/)[0] ?? '';

  return (
    <main className="fu-call" aria-live="polite">
      <header className="fu-call-head">
        <span className="kicker">MedSim clinic</span>
        <h1 className="fu-call-title">Nurse Asha</h1>
        <span className="fu-call-sub">Follow-up call</span>
      </header>

      <div className={`fu-asha${speaking ? ' is-speaking' : ''}`}>
        <AshaSprite mood={mood} size={168} />
        <div className="fu-state" role="status">
          <span className={`fu-dot${speaking ? ' fu-dot--speak' : listening ? ' fu-dot--listen' : ''}`} aria-hidden="true" />
          {phase === 'live'
            ? speaking ? 'Asha is speaking' : status === 'thinking' ? 'Asha is thinking' : muted ? 'You are muted' : 'Asha is listening'
            : phase === 'connecting' ? 'Connecting...' : phase === 'saving' ? 'Saving your call...' : phase === 'done' ? 'Call ended' : 'Ready'}
          {phase === 'live' && <span className="fu-clock">{mmss(elapsed)} / {mmss(info?.maxSeconds ?? 240)}</span>}
        </div>
      </div>

      {phase === 'loading' && <p className="fu-note">Opening your call link...</p>}

      {phase === 'invalid' && (
        <section className="fu-card">
          <p className="fu-strong">This call link is not valid any more.</p>
          <p className="fu-note">{error ?? 'Please contact the clinic for a new link.'}</p>
        </section>
      )}

      {info && (phase === 'idle' || phase === 'connecting') && (
        <>
          <section className="fu-card">
            <p className="fu-strong">Hello {firstName || 'there'}</p>
            <p className="fu-note">
              Nurse Asha will ask how you are doing with your treatment. It takes about 3 minutes. You can talk in your own language.
            </p>
            {info.prescriptions.length > 0 && (
              <>
                <h2 className="block-title">Your medicines</h2>
                <ul className="fu-meds">
                  {info.prescriptions.map((m, i) => (
                    <li key={i}>
                      <span className="fu-med-name">{m.name}</span>
                      {(m.dose || m.duration) && <span className="fu-med-dose">{[m.dose, m.duration].filter(Boolean).join(', ')}</span>}
                    </li>
                  ))}
                </ul>
              </>
            )}
          </section>
          {error && <p className="fu-error" role="alert">{error}</p>}
          <button
            type="button"
            className="btn btn-primary btn-lg btn-block fu-start"
            onClick={() => void start()}
            disabled={phase === 'connecting' || info.callsLeftToday <= 0}
          >
            {phase === 'connecting' ? 'Connecting...' : 'Start call with Nurse Asha'}
          </button>
          <p className="fu-note fu-center">
            {info.callsLeftToday <= 0
              ? 'This link has been used 3 times today. Please try again tomorrow.'
              : 'Your phone will ask to use the microphone. In an emergency call 108.'}
          </p>
        </>
      )}

      {phase === 'live' && (
        <>
          <section className="fu-captions" aria-label="Live captions">
            {captions.length === 0 && !partial && <p className="fu-note">Asha will greet you in a moment...</p>}
            {captions.map((c, i) => (
              <p key={i} className={`fu-cap fu-cap--${c.who}`}><b>{c.who === 'asha' ? 'Asha' : 'You'}</b>{c.text}</p>
            ))}
            {partial && (
              <p className={`fu-cap fu-cap--${partial.who} fu-cap--partial`}><b>{partial.who === 'asha' ? 'Asha' : 'You'}</b>{partial.text}</p>
            )}
            <div ref={capEnd} />
          </section>
          <div className="fu-controls">
            <button type="button" className={`btn btn-secondary btn-lg fu-mute${muted ? ' is-on' : ''}`} onClick={toggleMute} aria-pressed={muted}>
              {muted ? 'Unmute' : 'Mute'}
            </button>
            <button type="button" className="btn btn-lg fu-hangup" onClick={() => void finish()}>
              Hang up
            </button>
          </div>
        </>
      )}

      {phase === 'saving' && <p className="fu-note fu-center">Sending the call notes to your doctor...</p>}

      {phase === 'done' && (
        <section className="fu-card fu-center">
          <p className="fu-strong">Thank you, your doctor will see this.</p>
          <p className="fu-note">Keep taking your medicines as prescribed. If you feel very unwell, go to the nearest emergency or call 108.</p>
          {info && info.callsLeftToday > 0 && (
            <button type="button" className="btn btn-secondary btn-block" onClick={() => { finishing.current = false; setPhase('idle'); }}>
              Call again
            </button>
          )}
        </section>
      )}
    </main>
  );
}
