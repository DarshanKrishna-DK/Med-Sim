import { useEffect, useRef, useState } from 'react';
import { ensureAudioContext } from '../../voice/conversationStore';
import '../../styles/osce.css';

/** Short square-wave chime on the shared AudioContext (already unlocked by
 *  the "Start station" click). `bell` = the end-of-station double tone. */
export function playOsceChime(kind: 'warning' | 'bell') {
  try {
    const ctx = ensureAudioContext();
    const tones = kind === 'bell' ? [880, 660, 880, 660] : [988, 988];
    const step = kind === 'bell' ? 0.22 : 0.18;
    tones.forEach((f, i) => {
      const t0 = ctx.currentTime + i * step;
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'square';
      osc.frequency.value = f;
      gain.gain.setValueAtTime(0.0001, t0);
      gain.gain.exponentialRampToValueAtTime(0.12, t0 + 0.01);
      gain.gain.exponentialRampToValueAtTime(0.0001, t0 + step * 0.9);
      osc.connect(gain).connect(ctx.destination);
      osc.start(t0);
      osc.stop(t0 + step);
    });
  } catch {
    /* no Web Audio: the visual warning still shows */
  }
}

function fmt(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** OSCE station countdown for the encounter HUD: 1-minute warning chime,
 *  then the bell and `onTimeUp` at zero (fires once). */
export function OsceTimer({ startedAt, durationMs, onTimeUp }: { startedAt: number; durationMs: number; onTimeUp: () => void }) {
  const [now, setNow] = useState(() => Date.now());
  const warned = useRef(false);
  const ended = useRef(false);
  const onTimeUpRef = useRef(onTimeUp);
  onTimeUpRef.current = onTimeUp;

  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 250);
    return () => window.clearInterval(t);
  }, []);

  const left = startedAt + durationMs - now;

  useEffect(() => {
    if (!warned.current && left <= 60_000 && left > 0) {
      warned.current = true;
      playOsceChime('warning');
    }
    if (!ended.current && left <= 0) {
      ended.current = true;
      playOsceChime('bell');
      onTimeUpRef.current();
    }
  }, [left]);

  const tone = left <= 0 ? 'is-over' : left <= 60_000 ? 'is-warning' : '';
  return (
    <span
      className={`hud-timer osce-timer ${tone}`}
      role="timer"
      aria-label={`OSCE station, ${fmt(left)} left`}
    >
      <span className="osce-timer-tag">OSCE</span>
      {fmt(left)}
      <span className="sr-only" role="status">
        {tone === 'is-warning' ? 'One minute left' : tone === 'is-over' ? 'Time is up' : ''}
      </span>
    </span>
  );
}
