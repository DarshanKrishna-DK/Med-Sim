import { useState, type FormEvent } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import type { ConversationStatus } from '../../voice/conversation';
import type { VoiceSession } from './useVoiceSession';
import { isLive } from './useVoiceSession';
import { Kbd } from '../ui/chrome';
import { LangToggle } from '../ui/LangToggle';

type OrbState = 'listening' | 'working' | 'composing' | 'connecting' | 'breathing';

const ORB: Partial<Record<ConversationStatus, OrbState>> = {
  loading: 'connecting',
  ready: 'breathing',
  listening: 'listening',
  thinking: 'working',
  speaking: 'composing',
};

function statusLabel(s: ConversationStatus, firstName: string, muted: boolean): string {
  switch (s) {
    case 'loading':
      return 'Connecting';
    case 'ready':
      return muted ? 'Mic muted' : 'Live, go ahead';
    case 'listening':
      return muted ? 'Mic muted' : 'Listening';
    case 'thinking':
      return `${firstName} is thinking`;
    case 'speaking':
      return `${firstName} is speaking`;
    case 'error':
      return 'Voice failed';
    default:
      return 'Voice off';
  }
}

export function VoicePanel({ voice, patientName }: { voice: VoiceSession; patientName: string }) {
  const first = patientName.split(' ')[0] ?? patientName;
  const live = isLive(voice.status);
  const [text, setText] = useState('');
  const [hint, setHint] = useState('');

  const send = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t) return;
    const ok = await voice.sendText(t);
    if (ok) {
      setText('');
      setHint('');
    } else {
      setHint(live ? `${first} is mid-reply. Send again in a moment.` : 'Connect voice first, then type.');
    }
  };

  const orbState = ORB[voice.status];
  const patientText = voice.patientLine?.text?.trim();
  const doctorText = voice.doctorLine?.text?.trim();

  return (
    <section className={`voice hud-panel voice--${voice.status}`} aria-label="Voice conversation">
      <div className="voice-main">
        <div className="voice-orb" aria-hidden={!orbState}>
          {orbState ? (
            <ThinkingOrb state={orbState} size={64} theme="dark" aria-label={statusLabel(voice.status, first, voice.micMuted)} />
          ) : (
            <span className="voice-orb-off" />
          )}
        </div>

        <div className="voice-text">
          <p className="voice-status" role="status">
            <span className={`status-dot ${live && !voice.micMuted ? 'is-live' : ''}`} aria-hidden="true" />
            {statusLabel(voice.status, first, voice.micMuted)}
            {voice.status === 'loading' && voice.progress ? <span className="voice-progress"> · {voice.progress}</span> : null}
          </p>

          {voice.status === 'error' || (voice.error && !live) ? (
            <p className="voice-error" role="alert">{voice.error || 'The voice connection dropped.'}</p>
          ) : patientText ? (
            <p className={`subtitle ${voice.patientLine?.partial ? 'is-partial' : ''}`}>
              <span className="subtitle-who">{first}</span>
              <span className="subtitle-line">“{patientText}”</span>
            </p>
          ) : (
            <p className="voice-hint">
              {voice.engaged
                ? `Waiting for ${first} to speak.`
                : `Connect, then say hello. ${first} hears you the whole time; there's no push-to-talk.`}
            </p>
          )}

          {doctorText && live && (
            <p className={`subtitle subtitle--you ${voice.doctorLine?.partial ? 'is-partial' : ''}`}>
              <span className="subtitle-who">You</span>
              <span className="subtitle-line">{doctorText}</span>
            </p>
          )}
        </div>

        <div className="voice-controls">
          <LangToggle light />
          {voice.engaged && voice.status !== 'error' ? (
            <>
              <button
                type="button"
                className={`icon-btn icon-btn--lg ${voice.micMuted ? 'is-off' : ''}`}
                onClick={voice.toggleMic}
                disabled={!live}
                aria-pressed={voice.micMuted}
                aria-label={voice.micMuted ? 'Unmute microphone' : 'Mute microphone'}
                title={voice.micMuted ? 'Unmute' : 'Mute'}
              >
                <svg width="18" height="18" viewBox="0 0 18 18" aria-hidden="true">
                  <rect x="6" y="2" width="6" height="9.5" rx="3" fill="none" stroke="currentColor" strokeWidth="1.5" />
                  <path d="M3.5 9a5.5 5.5 0 0 0 11 0M9 14.5v2" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                  {voice.micMuted && <path d="m2.5 2.5 13 13" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />}
                </svg>
              </button>
              <button type="button" className="btn btn-ghost" onClick={voice.hangUp}>
                Hang up
              </button>
            </>
          ) : (
            <button type="button" className="btn btn-primary btn-lg" onClick={() => (voice.status === 'error' ? voice.toggle() : voice.connect())}>
              {voice.status === 'error' ? 'Try again' : 'Connect voice'}
            </button>
          )}
        </div>
      </div>

      <form className="voice-type" onSubmit={send}>
        <label htmlFor="say-to-patient" className="sr-only">Type to {first}</label>
        <input
          id="say-to-patient"
          className="input"
          value={text}
          onChange={(e) => { setText(e.target.value); if (hint) setHint(''); }}
          placeholder={`No mic? Type to ${first}`}
          autoComplete="off"
        />
        <button type="submit" className="btn btn-quiet" disabled={!text.trim()}>
          Say it
        </button>
        <span className="voice-keys" aria-hidden="true">
          <Kbd>T</Kbd> voice on/off
        </span>
      </form>
      {hint && <p className="voice-form-hint" role="status">{hint}</p>}
    </section>
  );
}
