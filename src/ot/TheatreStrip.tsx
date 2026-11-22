import { useState, type CSSProperties } from 'react';
import { Bubble, Slim } from '../components/encounter/AgentRoomPanel';
import { RoomAvatar } from '../components/encounter/RoomAvatar';
import { UI, labelStyle, panel } from '../components/world/worldUi';
import { isSlim, ROLE_LABEL, type RoomState } from '../room/reducer';
import { BLOOD_WAIT_S, bloodOpen, type OTState } from './engine';
import { bloodLine, rxLine } from './roomState';
import type { OTAction } from './scenarios';
import '../styles/agentroom.css';

/* The theatre room, as small as it can be: who is there, what the drill is
 * waiting for, and the traffic when you want to read it. */

const GOOD = '#7fe0a0';
const TONE = { wait: UI.amber, good: GOOD, warn: '#ff7a6b' } as const;

const btn: CSSProperties = {
  ...labelStyle,
  fontSize: 10.5,
  minHeight: 32,
  padding: '6px 9px',
  border: `2px solid ${UI.line}`,
  background: UI.bg,
  color: UI.text,
  cursor: 'pointer',
  borderRadius: 0,
};

export function TheatreStrip({ s, room, url, doAct, compact }: { s: OTState; room: RoomState | null; url: string; doAct: (a: OTAction) => void; compact: boolean }) {
  const [choice, setChoice] = useState(false);
  const open = choice && !compact;
  const blood = bloodLine(s, BLOOD_WAIT_S);
  const rx = rxLine(s);
  const help = s.help;
  const messages = (room?.messages ?? []).filter((m) => m.type !== 'system').slice(-14);
  const people = room?.participants ?? [];
  return (
    <section
      className="aroom"
      aria-label="Theatre room"
      style={{ ...panel, position: 'absolute', right: 16, bottom: 16, width: 340, maxHeight: open ? 'calc(100vh - 220px)' : undefined, zIndex: 11, boxSizing: 'border-box', padding: 8, display: 'flex', flexDirection: 'column', gap: 6, minHeight: 0 }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span style={{ ...labelStyle, fontSize: 11, color: UI.primary }}>Theatre room</span>
        <span className="aroom-band">BAND</span>
        <span style={{ display: 'flex', gap: 3, marginLeft: 'auto' }}>
          {people.map((p) => (
            <span key={p.id} className={`ar-role--${p.role}`} title={`${p.name}, ${p.title}`}>
              <RoomAvatar role={p.role} size={24} />
              <span className="sr-only">{p.name}</span>
            </span>
          ))}
        </span>
        <button type="button" style={btn} aria-expanded={open} disabled={compact || messages.length === 0} onClick={() => setChoice((v) => !v)}>
          {open ? 'Hide' : `Read (${messages.length})`}
        </button>
      </div>

      <div role="status" style={{ display: 'grid', gap: 3, fontFamily: UI.label, fontSize: 12.5, lineHeight: 1.35 }}>
        {blood && (
          <div style={{ color: TONE[blood.tone] }}>
            {blood.text}
            {blood.left !== null && <span style={{ opacity: 0.85 }}> · {blood.left} s</span>}
          </div>
        )}
        {rx && s.rx.status !== 'release' && <div style={{ color: TONE[rx.tone] }}>{rx.text}</div>}
        {help && (
          <div style={{ color: help.status === 'replied' ? UI.text : help.status === 'unreachable' ? TONE.warn : UI.amber }}>
            {help.status === 'calling' && 'Calling the consultant...'}
            {help.status === 'called' && `${help.name} has your SBAR. Waiting for a reply.`}
            {help.status === 'unreachable' && 'The consultant could not be reached.'}
            {help.status === 'replied' && `${help.name}: ${help.text}`}
          </div>
        )}
        {!blood && !rx && !help && <div style={{ opacity: 0.75 }}>Sister Leela brings in the lab, pharmacy or a consultant only when the case needs them.</div>}
      </div>

      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        {s.blood?.status === 'sample' && (
          <button type="button" style={{ ...btn, background: UI.primary, color: '#0b1f4b' }} onClick={() => doAct({ kind: 'send-sample' })}>
            Send the sample
          </button>
        )}
        {bloodOpen(s) && (
          <button type="button" style={btn} onClick={() => doAct({ kind: 'fluid-bolus', fluid: 'blood', volumeMl: 250, emergency: true })}>
            Emergency O negative
          </button>
        )}
        <button type="button" style={btn} disabled={help?.status === 'calling'} onClick={() => doAct({ kind: 'call-help' })}>
          Call for help
        </button>
        {url && (
          <a href={url} target="_blank" rel="noreferrer noopener" style={{ ...btn, textDecoration: 'none', marginLeft: 'auto' }}>
            Open in BAND<span className="sr-only"> (new tab)</span>
          </a>
        )}
      </div>

      {open && room && (
        <ol className="aroom-msgs" role="log" aria-label="Theatre room messages" style={{ overflow: 'auto', minHeight: 0, background: UI.bg }}>
          {messages.map((m) => (isSlim(m) ? <Slim key={m.id} m={m} /> : <Bubble key={m.id} room={room} m={m} />))}
        </ol>
      )}
      <span className="sr-only">{people.map((p) => ROLE_LABEL[p.role]).join(', ')}</span>
    </section>
  );
}
