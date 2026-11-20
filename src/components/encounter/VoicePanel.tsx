import { useState, type FormEvent, type ReactNode } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import type { ConversationStatus } from '../../voice/conversation';
import type { VoiceSession } from './useVoiceSession';
import { isLive } from './useVoiceSession';
import { Kbd } from '../ui/chrome';
import { Icon, IconButton } from './HudControls';

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

/** Bottom voice dock: state orb + live subtitles, one primary control
 *  (Connect, or Mute / Hang up once live), a typed fallback, and the
 *  `footer` (keyboard hints) supplied by the HUD. */
export function VoicePanel({ voice, patientName, footer }: { voice: VoiceSession; patientName: string; footer?: ReactNode }) {
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
            <span className="voice-orb-off">{Icon.mic(voice.status === 'error')}</span>
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
                : `Connect and just talk. ${first} hears you the whole time, no push-to-talk.`}
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
          {voice.engaged && voice.status !== 'error' ? (
            <>
              <IconButton
                tip="top"
                label={voice.micMuted ? 'Unmute microphone' : 'Mute microphone'}
                className={voice.micMuted ? 'is-off' : ''}
                onClick={voice.toggleMic}
                disabled={!live}
                aria-pressed={voice.micMuted}
              >
                {Icon.mic(voice.micMuted)}
              </IconButton>
              <IconButton tip="top-end" label="Hang up" kbd="T" className="icon-btn--danger" onClick={voice.hangUp}>
                {Icon.hangUp}
              </IconButton>
            </>
          ) : (
            <button
              type="button"
              className="btn btn-primary voice-connect"
              aria-keyshortcuts="T"
              onClick={() => (voice.status === 'error' ? voice.toggle() : voice.connect())}
            >
              {Icon.mic()}
              {voice.status === 'error' ? 'Try again' : 'Connect voice'}
              <Kbd>T</Kbd>
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
        <IconButton tip="top-end" type="submit" label={`Say it to ${first}`} className="icon-btn--send" disabled={!text.trim()}>
          {Icon.send}
        </IconButton>
      </form>
      {hint && <p className="voice-form-hint" role="status">{hint}</p>}
      {footer}
    </section>
  );
}
