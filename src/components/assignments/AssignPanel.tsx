import { useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { CASES, type Case } from '../../data/cases';
import { CLINIC_IDS, CLINIC_LABELS, type ClinicId } from '../../game/clinic';
import { VIVA_SUBJECTS } from '../viva/vivaCore';
import { UI, labelStyle, panel } from '../world/worldUi';
import { todayKey } from '../../assignments/core';

// Teacher Portal "Assign to class": pick 1-5 cases (plus an optional OSCE
// station and viva subject), set a due date and pass mark, and get a 6-char
// code + link the class opens. POST /agent/assignments.

export const DEFAULT_TEACHER_EMAIL = 'darshankrishna2k2@gmail.com';
const MAX_CASES = 5;

const field: CSSProperties = {
  width: '100%',
  boxSizing: 'border-box',
  fontFamily: UI.label,
  fontSize: 14,
  padding: '8px 10px',
  border: `2px solid ${UI.line}`,
  background: UI.bg,
  color: UI.text,
  outline: 'none',
  borderRadius: 0,
};
const btn: CSSProperties = {
  ...labelStyle,
  fontSize: 11,
  padding: '9px 12px',
  border: `2px solid ${UI.line}`,
  background: UI.bg,
  color: UI.text,
  boxShadow: '2px 2px 0 0 #061431',
  cursor: 'pointer',
};
const primary: CSSProperties = { ...btn, background: UI.primary, color: '#0b1f4b' };

function Field({ label, children, htmlFor }: { label: string; children: ReactNode; htmlFor?: string }) {
  return (
    <label htmlFor={htmlFor} style={{ display: 'grid', gap: 4 }}>
      <span style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>{label}</span>
      {children}
    </label>
  );
}

function plusDays(n: number): string {
  return todayKey(Date.now() + n * 86_400_000);
}

const caseLabel = (c: Case) => `${c.name}, ${c.age}${c.sex}: ${c.complaint}`;

interface Created {
  code: string;
  link: string;
}

export function AssignPanel({ onClose }: { onClose: () => void }) {
  const [title, setTitle] = useState('');
  const [clinic, setClinic] = useState<ClinicId>('all-specialties');
  const [query, setQuery] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const [osce, setOsce] = useState<string>(''); // '' none, 'any', or a case id
  const [viva, setViva] = useState<string>('');
  const [due, setDue] = useState(plusDays(7));
  const [teacherName, setTeacherName] = useState('Dr. Meera Iyer');
  const [teacherEmail, setTeacherEmail] = useState(DEFAULT_TEACHER_EMAIL);
  const [passMark, setPassMark] = useState(60);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [created, setCreated] = useState<Created | null>(null);
  const [copied, setCopied] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);

  useEffect(() => titleRef.current?.focus(), []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopImmediatePropagation();
        onClose();
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose]);

  const clinics = useMemo(() => CLINIC_IDS.filter((id) => id === 'all-specialties' || CASES.some((c) => c.clinic === id)), []);
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CASES.filter((c) => (clinic === 'all-specialties' || c.clinic === clinic) && (!q || `${c.name} ${c.complaint} ${CLINIC_LABELS[c.clinic]}`.toLowerCase().includes(q))).slice(0, 60);
  }, [clinic, query]);
  const byId = useMemo(() => new Map(CASES.map((c) => [c.id, c])), []);

  const toggle = (id: string) => {
    if (picked.includes(id) && osce === id) setOsce('');
    setPicked((p) => (p.includes(id) ? p.filter((x) => x !== id) : p.length >= MAX_CASES ? p : [...p, id]));
  };

  const emailOk = /^[^@\s<>"',;]+@[^@\s<>"',;]+\.[A-Za-z]{2,}$/.test(teacherEmail.trim());
  const valid = title.trim().length >= 2 && picked.length >= 1 && emailOk && passMark >= 0 && passMark <= 100;

  const create = async () => {
    if (!valid || busy) return;
    setBusy(true);
    setError('');
    const items: Array<Record<string, unknown>> = picked.map((id) => {
      const c = byId.get(id)!;
      return { kind: 'case', caseId: id, label: caseLabel(c), specialty: CLINIC_LABELS[c.clinic] };
    });
    if (osce) {
      const c = osce === 'any' ? null : byId.get(osce);
      items.push({ kind: 'osce', caseId: c?.id ?? null, label: c ? `OSCE station: ${c.name}` : 'OSCE station (any case)', specialty: c ? CLINIC_LABELS[c.clinic] : 'OSCE' });
    }
    if (viva) {
      const s = VIVA_SUBJECTS.find((x) => x.id === viva);
      if (s) items.push({ kind: 'viva', subject: s.label, label: `Viva: ${s.label}`, specialty: 'Viva voce' });
    }
    try {
      const r = await fetch('/agent/assignments', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title: title.trim(), items, dueDate: due || null, teacherName: teacherName.trim(), teacherEmail: teacherEmail.trim(), passMark }),
      });
      const j = (await r.json().catch(() => ({}))) as { code?: string; link?: string; detail?: unknown };
      if (!r.ok || !j.code || !j.link) throw new Error(typeof j.detail === 'string' ? j.detail : `Could not create the assignment (${r.status})`);
      setCreated({ code: j.code, link: j.link });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const absLink = created ? `${window.location.origin}${created.link}` : '';
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(absLink);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      setCopied(false);
    }
  };

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-label="Assign to class"
      style={{ position: 'absolute', inset: 0, background: 'rgba(5,11,26,.6)', display: 'grid', placeItems: 'center', zIndex: 50, padding: 16 }}
      onKeyDown={(e) => e.stopPropagation()}
    >
      <div style={{ ...panel, width: 'min(820px, 100%)', maxHeight: 'calc(100vh - 32px)', overflow: 'auto', padding: 18, display: 'grid', gap: 12, boxSizing: 'border-box' }}>
        <div style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <div style={{ fontFamily: UI.heading, fontSize: 36, lineHeight: 1 }}>Assign to class</div>
          <span style={{ ...labelStyle, fontSize: 10, opacity: 0.8 }}>Teacher Portal</span>
          <button type="button" onClick={onClose} style={{ ...btn, marginLeft: 'auto' }}>Close · Esc</button>
        </div>

        {created ? (
          <div style={{ display: 'grid', gap: 12, justifyItems: 'start' }}>
            <div style={{ ...labelStyle, color: UI.primary }}>Assignment created. Share this with the class:</div>
            <div style={{ fontFamily: UI.heading, fontSize: 72, lineHeight: 1, letterSpacing: '.18em', padding: '8px 16px', background: UI.bg, border: `2px solid ${UI.primary}` }} aria-label={`Code ${created.code.split('').join(' ')}`}>
              {created.code}
            </div>
            <div style={{ fontFamily: UI.label, fontSize: 14, wordBreak: 'break-all' }}>{absLink}</div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
              <button type="button" style={primary} onClick={() => void copy()}>{copied ? 'Link copied' : 'Copy link'}</button>
              <button type="button" style={btn} onClick={() => { setCreated(null); setPicked([]); setTitle(''); }}>New assignment</button>
            </div>
            <div style={{ fontFamily: UI.label, fontSize: 13, opacity: 0.8 }}>
              Students open the link, play the cases, and Priya at Reception emails each report to {teacherEmail.trim()}.
            </div>
          </div>
        ) : (
          <>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              <Field label="Title" htmlFor="asg-title">
                <input id="asg-title" ref={titleRef} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Week 3: chest pain clinic" maxLength={120} style={field} />
              </Field>
              <Field label="Due date" htmlFor="asg-due">
                <input id="asg-due" type="date" value={due} min={todayKey()} onChange={(e) => setDue(e.target.value)} style={field} />
              </Field>
              <Field label="Pass mark (0-100)" htmlFor="asg-pass">
                <input id="asg-pass" type="number" min={0} max={100} value={passMark} onChange={(e) => setPassMark(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} style={field} />
              </Field>
              <Field label="Teacher name" htmlFor="asg-tname">
                <input id="asg-tname" value={teacherName} onChange={(e) => setTeacherName(e.target.value)} maxLength={80} style={field} />
              </Field>
              <Field label="Teacher email (reports go here)" htmlFor="asg-temail">
                <input id="asg-temail" type="email" value={teacherEmail} onChange={(e) => setTeacherEmail(e.target.value)} aria-invalid={!emailOk} style={{ ...field, borderColor: emailOk ? UI.line : UI.amber }} />
              </Field>
            </div>

            <div style={{ display: 'grid', gap: 6 }}>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
                <span style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>Cases ({picked.length}/{MAX_CASES})</span>
                <select value={clinic} onChange={(e) => setClinic(e.target.value as ClinicId)} aria-label="Specialty" style={{ ...field, width: 'auto' }}>
                  {clinics.map((id) => (
                    <option key={id} value={id}>{id === 'all-specialties' ? 'All specialties' : CLINIC_LABELS[id]}</option>
                  ))}
                </select>
                <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name or complaint" aria-label="Search cases" style={{ ...field, width: 220 }} />
              </div>
              {picked.length > 0 && (
                <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
                  {picked.map((id) => (
                    <button key={id} type="button" onClick={() => toggle(id)} style={{ ...btn, padding: '5px 8px', fontSize: 10, background: UI.primary, color: '#0b1f4b', textTransform: 'none', letterSpacing: '.03em' }} aria-label={`Remove ${byId.get(id)?.name}`}>
                      {byId.get(id)?.name} ×
                    </button>
                  ))}
                </div>
              )}
              <ul style={{ listStyle: 'none', margin: 0, padding: 0, maxHeight: 220, overflow: 'auto', border: `2px solid ${UI.line}`, background: UI.bg }}>
                {visible.map((c) => {
                  const on = picked.includes(c.id);
                  const full = !on && picked.length >= MAX_CASES;
                  return (
                    <li key={c.id}>
                      <label style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '6px 10px', cursor: full ? 'not-allowed' : 'pointer', opacity: full ? 0.5 : 1, borderBottom: `1px solid ${UI.line}` }}>
                        <input type="checkbox" checked={on} disabled={full} onChange={() => toggle(c.id)} />
                        <span style={{ fontFamily: UI.label, fontSize: 13, flex: 1, minWidth: 0 }}>{caseLabel(c)}</span>
                        <span style={{ ...labelStyle, fontSize: 9, opacity: 0.75 }}>{CLINIC_LABELS[c.clinic]}</span>
                      </label>
                    </li>
                  );
                })}
              </ul>
            </div>

            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
              <Field label="OSCE station (optional)" htmlFor="asg-osce">
                <select id="asg-osce" value={osce} onChange={(e) => setOsce(e.target.value)} style={field}>
                  <option value="">None</option>
                  <option value="any">Any OSCE station</option>
                  {picked.map((id) => (
                    <option key={id} value={id}>Station: {byId.get(id)?.name}</option>
                  ))}
                </select>
              </Field>
              <Field label="Viva subject (optional)" htmlFor="asg-viva">
                <select id="asg-viva" value={viva} onChange={(e) => setViva(e.target.value)} style={field}>
                  <option value="">None</option>
                  {VIVA_SUBJECTS.map((s) => (
                    <option key={s.id} value={s.id}>{s.label}</option>
                  ))}
                </select>
              </Field>
            </div>

            {error && <div role="alert" style={{ fontFamily: UI.label, fontSize: 13, color: UI.amber }}>{error}</div>}
            <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
              <button type="button" style={{ ...primary, opacity: valid ? 1 : 0.6 }} onClick={() => void create()} disabled={!valid || busy}>
                {busy ? 'Creating...' : 'Create assignment'}
              </button>
              {!valid && <span style={{ fontFamily: UI.label, fontSize: 12, opacity: 0.8 }}>Add a title, pick at least one case and a valid teacher email.</span>}
            </div>
          </>
        )}
      </div>
    </div>
  );
}
