import type { CSSProperties } from 'react';
import { RoomAvatar } from '../encounter/RoomAvatar';
import { UI, labelStyle } from '../world/worldUi';
import { headline, stepTime, type SecondRead } from './secondRead';
import '../../styles/agentroom.css';

/* The second read and, when a critical finding was missed, who was told and
 * when. Marks are above and are not touched by this. */

const TONE = { wait: UI.amber, good: '#7fe0a0', bad: '#ffb454' } as const;
const text: CSSProperties = { fontFamily: UI.label, fontSize: 13, lineHeight: 1.4 };

export function SecondReadCard({ s }: { s: SecondRead }) {
  const h = headline(s);
  const r = s.read;
  return (
    <section aria-label="Second read" style={{ background: UI.bg, border: `2px solid ${TONE[h.tone]}`, padding: '8px 10px', display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <RoomAvatar role="radiology" size={32} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>Second read</div>
          <div role="status" style={{ ...text, fontWeight: 700, color: TONE[h.tone] }}>{h.text}</div>
        </div>
        <span className="aroom-band">BAND</span>
      </div>
      {r && (
        <div style={{ ...text, display: 'grid', gap: 4 }}>
          {r.missed.length > 0 && <div style={{ opacity: 0.85 }}>{r.by} also reports:</div>}
          {r.missed.slice(0, 4).map((m) => (
            <div key={m.label} style={{ paddingLeft: 10, borderLeft: `4px solid ${m.critical ? TONE.bad : UI.line}` }}>
              {m.critical && <span style={{ ...labelStyle, fontSize: 9, color: '#0b1f4b', background: TONE.bad, padding: '1px 5px', marginRight: 6 }}>Critical</span>}
              {m.label}
            </div>
          ))}
          {!r.diagnosisAgrees && r.diagnosis && <div>His diagnosis: {r.diagnosis}.</div>}
        </div>
      )}
      {s.chain.length > 1 && (
        <ol aria-label="Who was told, and when" style={{ margin: 0, padding: 0, listStyle: 'none', display: 'grid', gap: 5 }}>
          {s.chain.map((c, i) => (
            <li key={i} className={`ar-role--${c.who}`} style={{ ...text, display: 'grid', gridTemplateColumns: '62px 20px 1fr', gap: 6, alignItems: 'start' }}>
              <time dateTime={c.at} style={{ opacity: 0.75, fontVariantNumeric: 'tabular-nums', fontSize: 12 }}>{stepTime(c.at)}</time>
              <RoomAvatar role={c.who} size={18} />
              <span>
                <span className="sr-only">{c.who === 'nurse' ? 'Nurse Asha: ' : 'Radiologist Vikram: '}</span>
                {c.what}
              </span>
            </li>
          ))}
        </ol>
      )}
      {s.url && (
        <a href={s.url} target="_blank" rel="noreferrer noopener" style={{ ...labelStyle, fontSize: 10, color: UI.primary, justifySelf: 'start' }}>
          Open in BAND<span className="sr-only"> (new tab)</span>
        </a>
      )}
    </section>
  );
}
