import { useEffect, useState, useSyncExternalStore } from 'react';
import { fmtMs, voiceMetrics, type TurnStats } from '../../voice/voiceMetrics';

/** Collapsible "Voice engine" diagnostics. Toggle with the gauge icon or the M key.
 *  Appears once a voice session has produced any RTM traffic. */
export function VoiceMetricsPanel() {
  const snap = useSyncExternalStore(voiceMetrics.subscribe, voiceMetrics.getSnapshot);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key.toLowerCase() !== 'm' || e.ctrlKey || e.metaKey || e.altKey) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.isContentEditable)) return;
      setOpen((o) => !o);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const tracker = snap.tracker;
  if (!tracker) return null;

  const turns = tracker.turns.filter((t) => t.userFinalAt !== null);
  const lastTurn: TurnStats | undefined = turns[turns.length - 1];
  const sum = tracker.summary();
  const spark = tracker.answered().slice(-10);
  const max = Math.max(1, ...spark.map((t) => t.e2eMs ?? 0));
  const browserNote = (v: TurnStats | undefined, key: 'asr' | 'e2e') => {
    if (!v) return '';
    const src = key === 'asr' ? v.asrSource : v.e2eSource;
    return src === 'browser' ? ' (measured in browser)' : src === 'estimated' ? ' (estimated)' : '';
  };

  const box: React.CSSProperties = {
    position: 'fixed', left: 12, bottom: 12, zIndex: 60, font: '12px/1.4 system-ui, sans-serif',
    color: 'var(--ink, #1c1c1c)',
  };
  const card: React.CSSProperties = {
    width: 292, padding: '10px 12px', borderRadius: 10, marginBottom: 6,
    background: 'var(--paper, #fffdf8)', border: '1px solid var(--line, #d9d2c3)',
    boxShadow: '0 4px 18px rgba(0,0,0,.18)',
  };
  const row: React.CSSProperties = { display: 'flex', justifyContent: 'space-between', gap: 8 };

  return (
    <div style={box} data-voice-metrics>
      {open && (
        <div style={card} role="region" aria-label="Voice engine diagnostics">
          <strong>Voice engine</strong>
          <div style={{ opacity: 0.7, fontSize: 10.5, margin: '2px 0 8px' }}>
            Agora Conversational AI · Sarvam ASR · Sarvam LLM via MedSim proxy · Murf Falcon TTS
          </div>
          {!lastTurn ? (
            <div style={{ opacity: 0.7 }}>Waiting for the first exchange.</div>
          ) : (
            <>
              <div style={row}><span>ASR final{browserNote(lastTurn, 'asr')}</span><b>{fmtMs(lastTurn.asrMs)}</b></div>
              <div style={row}><span>LLM first token</span><b>{fmtMs(lastTurn.llmMs ?? lastTurn.llmSentenceMs)}</b></div>
              <div style={row}><span>TTS first byte</span><b>{fmtMs(lastTurn.ttsMs)}</b></div>
              <div style={row}><span>Response time{browserNote(lastTurn, 'e2e')}</span><b>{fmtMs(lastTurn.e2eMs)}</b></div>
            </>
          )}
          <svg width="268" height="34" viewBox="0 0 268 34" style={{ display: 'block', margin: '8px 0 4px' }} aria-label="Response time, last 10 turns">
            {spark.map((t, i) => {
              const h = Math.max(2, ((t.e2eMs ?? 0) / max) * 30);
              return <rect key={t.n} x={i * 27} y={32 - h} width={22} height={h} rx={2} fill="var(--accent, #2f7d6d)" opacity={i === spark.length - 1 ? 1 : 0.55} />;
            })}
          </svg>
          <div style={row}><span>Average response</span><b>{fmtMs(sum.avgE2eMs)}</b></div>
          <div style={row}><span>Avg ASR / LLM / TTS</span><b>{fmtMs(sum.avgAsrMs)} / {fmtMs(sum.avgLlmMs)} / {fmtMs(sum.avgTtsMs)}</b></div>
          <div style={row}><span>Interruptions</span><b>{sum.interruptions}</b></div>
          <div style={row}><span>Filler words played</span><b>{sum.fillers}</b></div>
          {sum.errors > 0 && <div style={{ ...row, color: '#b3261e' }}><span>Engine errors</span><b>{sum.errors}</b></div>}
          {!tracker.agoraMetricsSeen && (
            <div style={{ opacity: 0.7, fontSize: 10.5, marginTop: 6 }}>Agora sent no module metrics; times are measured in browser.</div>
          )}
        </div>
      )}
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-pressed={open}
        aria-label="Voice engine diagnostics (M)"
        title="Voice engine diagnostics (M)"
        style={{
          width: 30, height: 30, borderRadius: 15, border: '1px solid var(--line, #d9d2c3)',
          background: 'var(--paper, #fffdf8)', cursor: 'pointer', display: 'grid', placeItems: 'center', padding: 0,
        }}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round">
          <path d="M2 11a6 6 0 1 1 12 0" /><path d="M8 11l3-4" /><circle cx="8" cy="11" r="0.8" fill="currentColor" />
        </svg>
      </button>
    </div>
  );
}
