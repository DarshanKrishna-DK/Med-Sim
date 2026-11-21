import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { leaveAssignment, submitToTeacher, useAssignment, type EmailResult } from '../../assignments/client';
import { chipLabel, formatDue } from '../../assignments/core';
import { getProfile, openProfileDialog } from '../../game/profile';
import { UI, labelStyle, panel } from '../world/worldUi';
import '../../styles/reception.css';

function useSubmit() {
  const [state, setState] = useState<{ busy: boolean; result: EmailResult | null }>({ busy: false, result: null });
  const run = async () => {
    if (!getProfile()) {
      openProfileDialog();
      return;
    }
    setState({ busy: true, result: null });
    setState({ busy: false, result: await submitToTeacher() });
  };
  return { ...state, run };
}

/** Popover body shared by the header chip and the corridor HUD chip. */
function Details({ onClose, align = 'right' }: { onClose: () => void; align?: 'left' | 'right' }) {
  const v = useAssignment();
  const sub = useSubmit();
  const a = v.assignment;
  const p = v.progress;
  if (!a || !p) return null;
  const done = new Set(p.doneIds);
  const btn: CSSProperties = { ...labelStyle, fontSize: 11, padding: '8px 10px', border: `2px solid ${UI.line}`, background: UI.bg, color: UI.text, cursor: 'pointer', boxShadow: '2px 2px 0 0 #061431' };
  return (
    <div role="dialog" aria-label={`Assignment ${a.title}`} style={{ ...panel, position: 'absolute', top: 'calc(100% + 8px)', [align]: 0, width: 300, padding: 12, display: 'grid', gap: 8, zIndex: 60, textTransform: 'none', letterSpacing: 0, whiteSpace: 'normal', textAlign: 'left' }}>
      <div style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>Assignment · {a.code}{a.teacherName ? ` · ${a.teacherName}` : ''}</div>
      <div style={{ fontFamily: UI.heading, fontSize: 24, lineHeight: 1 }}>{a.title}</div>
      <div style={{ fontFamily: UI.label, fontSize: 13 }}>
        {p.done}/{p.total} done · due {formatDue(a.dueDate)} · pass mark {a.passMark}
        {p.average !== null && <> · avg {Math.round(p.average)}</>}
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 4 }}>
        {a.items.map((i) => (
          <li key={i.id} style={{ fontFamily: UI.label, fontSize: 13, display: 'flex', gap: 6 }}>
            <span aria-hidden="true" style={{ color: done.has(i.id) ? UI.primary : UI.amber }}>{done.has(i.id) ? '■' : '□'}</span>
            <span>{i.label}</span>
            <span className="sr-only">{done.has(i.id) ? 'done' : 'pending'}</span>
          </li>
        ))}
      </ul>
      <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
        <button type="button" style={{ ...btn, background: UI.primary, color: '#0b1f4b' }} onClick={() => void sub.run()} disabled={sub.busy}>
          {sub.busy ? 'Sending...' : 'Submit to teacher'}
        </button>
        <button type="button" style={btn} onClick={() => { leaveAssignment(); onClose(); }}>Leave</button>
      </div>
      {sub.result && (
        <div role="status" style={{ fontFamily: UI.label, fontSize: 12, color: sub.result.ok ? UI.primary : UI.amber }}>
          {sub.result.ok ? `Report emailed to ${sub.result.teacherName || 'your teacher'} (${sub.result.to}).` : sub.result.reason}
        </div>
      )}
      <div style={{ fontFamily: UI.label, fontSize: 11, opacity: 0.7 }}>Or ask Priya at Reception in the hospital lobby.</div>
    </div>
  );
}

function useOutsideClose(open: boolean, close: () => void) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('mousedown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('mousedown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  }, [open, close]);
  return ref;
}

/** "Assignment: <title> (2/4 done, due 30 Nov)" in the app header. */
export function AssignmentChip() {
  const v = useAssignment();
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  if (!v.assignment || !v.progress) return null;
  const label = chipLabel(v.assignment, v.progress);
  const tone = v.progress.done === v.progress.total ? 'assignment-chip--done' : v.progress.overdue ? 'assignment-chip--overdue' : '';
  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button type="button" className={`assignment-chip ${tone}`} title={label} aria-expanded={open} onClick={() => setOpen((o) => !o)}>
        <span className="assignment-chip-text">{label}</span>
      </button>
      {open && <Details onClose={() => setOpen(false)} />}
    </div>
  );
}

/** Same chip for the 3D corridor HUD (pixel panel styling, top-left under the location). */
export function AssignmentHudChip({ style }: { style?: CSSProperties }) {
  const v = useAssignment();
  const [open, setOpen] = useState(false);
  const ref = useOutsideClose(open, () => setOpen(false));
  if (!v.assignment || !v.progress) return null;
  const p = v.progress;
  return (
    <div ref={ref} style={{ position: 'absolute', ...style }}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        style={{ ...panel, padding: '8px 12px', cursor: 'pointer', textAlign: 'left', borderColor: p.overdue ? UI.amber : UI.line, maxWidth: 300 }}
      >
        <div style={{ ...labelStyle, color: p.done === p.total ? UI.primary : UI.amber, fontSize: 10 }}>Assignment · {p.done}/{p.total} done</div>
        <div style={{ fontFamily: UI.heading, fontSize: 22, lineHeight: 1, marginTop: 2, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>{v.assignment.title}</div>
        <div style={{ ...labelStyle, fontSize: 9, opacity: 0.8, marginTop: 2 }}>Due {formatDue(v.assignment.dueDate)}</div>
      </button>
      {open && <Details align="left" onClose={() => setOpen(false)} />}
    </div>
  );
}
