import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { store } from '../../game/store';
import { LANG_LOCALE, readLang } from '../../game/lang';
import { speakAsNurse } from '../../agents/nurseAgent';
import {
  ACTION_IDS,
  ACTIONS,
  ESI_META,
  type ActionId,
  type EsiLevel,
  type TriageVitals,
} from '../../triage/cases';
import {
  SHIFT_CAP_S,
  arrivalAnnouncement,
  buildShift,
  caseById,
  escalatedRel,
  firedEvents,
  scoreShift,
  vitalsAt,
  type Assignment,
  type ShiftPatient,
} from '../../triage/engine';
import { parseTriageCommand } from '../../triage/voice';
import '../../styles/triage.css';

const LEVELS: EsiLevel[] = [1, 2, 3, 4, 5];
const DEMO_SEED = 1;

type Phase = 'ready' | 'running' | 'done';
interface Draft { level?: EsiLevel; action?: ActionId }

function tone(k: keyof TriageVitals, v: TriageVitals): 'ok' | 'warn' | 'bad' {
  switch (k) {
    case 'hr': return v.hr > 120 || v.hr < 50 ? 'bad' : v.hr > 100 ? 'warn' : 'ok';
    case 'sbp': return v.sbp < 90 ? 'bad' : v.sbp < 100 || v.sbp > 180 ? 'warn' : 'ok';
    case 'rr': return v.rr > 30 || v.rr < 8 ? 'bad' : v.rr > 22 ? 'warn' : 'ok';
    case 'spo2': return v.spo2 < 90 ? 'bad' : v.spo2 < 94 ? 'warn' : 'ok';
    case 'temp': return v.temp >= 40 ? 'bad' : v.temp >= 38 ? 'warn' : 'ok';
    case 'gcs': return v.gcs <= 12 ? 'bad' : v.gcs < 15 ? 'warn' : 'ok';
    default: return 'ok';
  }
}

function fmtClock(s: number): string {
  const m = Math.floor(s / 60);
  return `${m}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
}

// Browser speech recognition (Chrome/Edge). Typed as any: not in lib.dom.
type SpeechRec = {
  lang: string; interimResults: boolean; continuous: boolean;
  onresult: ((e: any) => void) | null; onend: (() => void) | null; onerror: (() => void) | null;
  start: () => void; stop: () => void;
};
function makeRecognizer(): SpeechRec | null {
  const w = window as any;
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? (new Ctor() as SpeechRec) : null;
}

export default function TriageDrillScreen() {
  const [seed, setSeed] = useState(DEMO_SEED);
  const shift = useMemo(() => buildShift(seed), [seed]);
  const [phase, setPhase] = useState<Phase>('ready');
  const [t, setT] = useState(0);
  const [endS, setEndS] = useState(0);
  const [assign, setAssign] = useState<Record<number, Assignment | undefined>>({});
  const [drafts, setDrafts] = useState<Record<number, Draft>>({});
  const [selected, setSelected] = useState(1);
  const [announce, setAnnounce] = useState(true);
  const [cmdText, setCmdText] = useState('');
  const [heard, setHeard] = useState('');
  const [listening, setListening] = useState(false);
  const announced = useRef(new Set<number>());
  const startedAt = useRef(0);
  const recRef = useRef<SpeechRec | null>(null);

  const arrived = shift.filter((p) => p.arrivalS <= t);
  const allDone = phase === 'running' && arrived.length === shift.length && shift.every((p) => assign[p.bed]);

  // Clock.
  useEffect(() => {
    if (phase !== 'running') return;
    const id = window.setInterval(() => setT((performance.now() - startedAt.current) / 1000), 250);
    return () => window.clearInterval(id);
  }, [phase]);

  // End conditions.
  useEffect(() => {
    if (phase === 'running' && (allDone || t >= SHIFT_CAP_S)) {
      setEndS(Math.min(t, SHIFT_CAP_S));
      setPhase('done');
      recRef.current?.stop();
    }
  }, [phase, allDone, t]);

  // Nurse announces arrivals.
  useEffect(() => {
    if (phase !== 'running') return;
    for (const p of arrived) {
      if (announced.current.has(p.bed)) continue;
      announced.current.add(p.bed);
      if (announce) void speakAsNurse(arrivalAnnouncement(p));
    }
  }, [phase, arrived, announce]);

  const start = useCallback(() => {
    announced.current = new Set();
    startedAt.current = performance.now();
    setAssign({});
    setDrafts({});
    setHeard('');
    setSelected(1);
    setT(0);
    setPhase('running');
  }, []);

  const commit = useCallback(
    (bed: number, level: EsiLevel, action: ActionId) => {
      setAssign((cur) => (cur[bed] ? cur : { ...cur, [bed]: { level, action, atS: t } }));
    },
    [t],
  );

  const patchDraft = useCallback(
    (bed: number, patch: Draft) => {
      setDrafts((cur) => ({ ...cur, [bed]: { ...cur[bed], ...patch } }));
    },
    [],
  );

  const applyCommand = useCallback(
    (raw: string) => {
      const cmd = parseTriageCommand(raw);
      setHeard(raw);
      if (phase !== 'running') return;
      const bed = cmd.bed ?? selected;
      const p = shift.find((x) => x.bed === bed);
      if (!p || p.arrivalS > t || assign[bed]) return;
      setSelected(bed);
      const next: Draft = { ...drafts[bed], ...(cmd.level ? { level: cmd.level } : {}), ...(cmd.action ? { action: cmd.action } : {}) };
      patchDraft(bed, next);
      if (next.level && next.action) commit(bed, next.level, next.action);
    },
    [phase, selected, shift, t, assign, drafts, patchDraft, commit],
  );

  const toggleMic = useCallback(() => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = makeRecognizer();
    if (!rec) {
      setHeard('Voice input needs Chrome or Edge. Type the command instead.');
      return;
    }
    rec.lang = LANG_LOCALE[readLang()];
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (e) => {
      const r = e.results[e.results.length - 1];
      if (r?.isFinal) applyCommand(String(r[0].transcript));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }, [listening, applyCommand]);

  useEffect(() => () => recRef.current?.stop(), []);

  const summary = useMemo(
    () => (phase === 'done' ? scoreShift(shift, assign, endS) : null),
    [phase, shift, assign, endS],
  );

  const goBack = () => store.setScreen('corridor');

  return (
    <div className="page night tri-page">
      <header className="tri-top">
        <div>
          <h1 className="tri-title">Triage shift</h1>
          <p className="tri-sub">Five patients, about three minutes. Assign an ESI colour and the first action.</p>
        </div>
        <div className="tri-top-right">
          {phase === 'running' && <span className="tri-clock" aria-live="off">{fmtClock(t)}</span>}
          <label className="tri-check">
            <input type="checkbox" checked={announce} onChange={(e) => setAnnounce(e.target.checked)} />
            Nurse Asha announces
          </label>
          <button type="button" className="btn btn-ghost" onClick={goBack}>Back to hospital</button>
          <button type="button" className="btn btn-ghost" onClick={() => store.setScreen('library')}>Case library</button>
        </div>
      </header>

      {phase === 'ready' && (
        <section className="tri-ready bevel-card">
          <h2 className="tri-h2">Shift {seed}</h2>
          <ul className="tri-legend">
            {LEVELS.map((l) => (
              <li key={l}>
                <span className="tri-dot" style={{ background: ESI_META[l].hex }} />
                <b>ESI {l} {ESI_META[l].colour}</b> {ESI_META[l].name}
              </li>
            ))}
          </ul>
          <p className="tri-hint">
            Untreated red and orange patients get worse: heart rate, blood pressure, oxygen and GCS drift.
            Say it or click it: &ldquo;bed one is red, oxygen and IV access&rdquo; (English, Hindi, Kannada).
          </p>
          <div className="tri-row">
            <button type="button" className="btn btn-primary btn-lg" onClick={start}>Start shift</button>
            <button type="button" className="btn btn-secondary" onClick={() => setSeed((s) => s + 1)}>Different shift</button>
          </div>
        </section>
      )}

      {phase === 'running' && (
        <>
          <div className="tri-cmd bevel-card">
            <button type="button" className={`btn ${listening ? 'btn-primary' : 'btn-secondary'}`} onClick={toggleMic} aria-pressed={listening}>
              {listening ? 'Listening... (click to stop)' : 'Speak a command'}
            </button>
            <form
              className="tri-cmd-form"
              onSubmit={(e) => {
                e.preventDefault();
                applyCommand(cmdText);
                setCmdText('');
              }}
            >
              <input
                className="input"
                value={cmdText}
                onChange={(e) => setCmdText(e.target.value)}
                placeholder={`e.g. "bed ${selected} is red, oxygen and IV access"`}
                aria-label="Type a triage command"
              />
              <button type="submit" className="btn btn-secondary">Apply</button>
            </form>
            {heard && <span className="tri-heard">Heard: {heard}</span>}
          </div>

          <ul className="tri-grid">
            {shift.map((p) => (
              <li key={p.bed}>
                <BedCard
                  p={p}
                  t={t}
                  seed={seed}
                  a={assign[p.bed]}
                  draft={drafts[p.bed] ?? {}}
                  selected={selected === p.bed}
                  onSelect={() => setSelected(p.bed)}
                  onDraft={(d) => patchDraft(p.bed, d)}
                  onCommit={(l, a) => commit(p.bed, l, a)}
                />
              </li>
            ))}
          </ul>
        </>
      )}

      {summary && (
        <section className="tri-end" aria-label="Shift results">
          <div className="tri-score bevel-card">
            <div className="tri-score-num">{summary.score}</div>
            <div>
              <h2 className="tri-h2">{summary.grade}</h2>
              <p className="tri-hint">
                Deterioration events missed: {summary.missedEvents}. Dangerous under-triage: {summary.dangerousUndertriage}.
                {summary.avgCriticalTimeS !== null && ` Average time to triage for red and orange: ${summary.avgCriticalTimeS} s.`}
              </p>
              <div className="tri-row">
                <button type="button" className="btn btn-primary" onClick={() => setPhase('ready')}>Run this shift again</button>
                <button type="button" className="btn btn-secondary" onClick={() => { setSeed((s) => s + 1); setPhase('ready'); }}>Next shift</button>
              </div>
            </div>
          </div>
          <ul className="tri-results">
            {summary.results.map((r) => {
              const c = caseById(r.caseId);
              return (
                <li key={r.bed} className="tri-result bevel-card" style={{ borderLeftColor: ESI_META[c.esi].hex }}>
                  <div className="tri-result-head">
                    <b>Bed {r.bed}: {c.age}{c.sex} {c.complaint}</b>
                    <span className="tri-pts">{r.total} / 100</span>
                  </div>
                  <p className="tri-correct">
                    Correct: <span className="tri-pill" style={{ background: ESI_META[c.esi].hex }}>ESI {c.esi} {ESI_META[c.esi].colour}</span>{' '}
                    {ACTIONS[c.action].label}
                    {r.assigned && (
                      <>
                        {' '}You: <span className="tri-pill" style={{ background: ESI_META[r.assigned.level].hex }}>ESI {r.assigned.level}</span>{' '}
                        {ACTIONS[r.assigned.action].label}
                      </>
                    )}
                  </p>
                  <ul className="tri-fb">{r.feedback.map((f, i) => <li key={i}>{f}</li>)}</ul>
                  <p className="tri-rule"><b>Rule:</b> {c.rule}</p>
                </li>
              );
            })}
          </ul>
        </section>
      )}
    </div>
  );
}

function BedCard(props: {
  p: ShiftPatient;
  t: number;
  seed: number;
  a: Assignment | undefined;
  draft: Draft;
  selected: boolean;
  onSelect: () => void;
  onDraft: (d: Draft) => void;
  onCommit: (l: EsiLevel, a: ActionId) => void;
}) {
  const { p, t, seed, a, draft } = props;
  if (p.arrivalS > t) {
    return (
      <div className="tri-card tri-empty">
        <span className="tri-bed">Bed {p.bed}</span>
        <span className="tri-muted">Empty. Next arrival soon.</span>
      </div>
    );
  }
  const c = caseById(p.caseId);
  const tRel = t - p.arrivalS;
  const esc = escalatedRel(p, a);
  const v = vitalsAt(c, p, tRel, esc, seed);
  const prev = tRel >= p.sampleS ? vitalsAt(c, p, tRel - p.sampleS, esc, seed) : v;
  const events = firedEvents(c, tRel, esc);
  const deteriorating = !a && events.length > 0;
  const rows: Array<[keyof TriageVitals, string, string]> = [
    ['hr', 'HR', String(v.hr)],
    ['sbp', 'BP', `${v.sbp}/${v.dbp}`],
    ['rr', 'RR', String(v.rr)],
    ['spo2', 'SpO2', `${v.spo2}%`],
    ['temp', 'Temp', v.temp.toFixed(1)],
    ['gcs', 'GCS', String(v.gcs)],
  ];
  const arrow = (k: keyof TriageVitals) => (v[k] > prev[k] ? '▲' : v[k] < prev[k] ? '▼' : '');

  return (
    <div
      className={`tri-card ${props.selected ? 'is-selected' : ''} ${deteriorating ? 'is-det' : ''}`}
      style={a ? { borderColor: ESI_META[a.level].hex } : undefined}
      onClick={props.onSelect}
    >
      <div className="tri-card-head">
        <svg className="tri-avatar" viewBox="0 0 40 40" aria-hidden="true">
          <circle cx="20" cy="20" r="19" fill="var(--surface-3)" stroke="var(--line-strong)" strokeWidth="2" />
          <circle cx="20" cy="15" r="6.5" fill="var(--muted)" />
          <path d="M7 36c1.5-9 7-12 13-12s11.5 3 13 12" fill="var(--muted)" />
        </svg>
        <div className="tri-who">
          <span className="tri-bed">Bed {p.bed}</span>
          <b>{c.age} {c.sex === 'M' ? 'male' : 'female'}</b>
        </div>
        <span className="tri-wait">{fmtClock(tRel)} waiting</span>
      </div>
      <p className="tri-complaint">{c.complaint}</p>
      <p className="tri-detail">{c.detail}</p>
      <div className="tri-vitals" role="group" aria-label={`Vitals bed ${p.bed}`}>
        {rows.map(([k, label, val]) => (
          <span key={k} className={`tri-vital is-${tone(k, v)}`}>
            <small>{label}</small>
            <b>{val}</b>
            <i>{arrow(k)}</i>
          </span>
        ))}
      </div>
      {deteriorating && <p className="tri-alert" role="alert">Deteriorating: {events[events.length - 1]}</p>}

      {a ? (
        <p className="tri-done">
          <span className="tri-pill" style={{ background: ESI_META[a.level].hex }}>ESI {a.level} {ESI_META[a.level].colour}</span>{' '}
          {ACTIONS[a.action].label}
        </p>
      ) : (
        <div className="tri-assign">
          <div className="tri-levels" role="group" aria-label="ESI level">
            {LEVELS.map((l) => (
              <button
                key={l}
                type="button"
                className={`tri-level ${draft.level === l ? 'is-on' : ''}`}
                style={{ ['--lv' as string]: ESI_META[l].hex }}
                aria-pressed={draft.level === l}
                onClick={(e) => { e.stopPropagation(); props.onDraft({ level: l }); }}
              >
                {l}
                <small>{ESI_META[l].colour}</small>
              </button>
            ))}
          </div>
          <select
            className="input"
            value={draft.action ?? ''}
            aria-label="First action"
            onClick={(e) => e.stopPropagation()}
            onChange={(e) => props.onDraft({ action: (e.target.value || undefined) as ActionId | undefined })}
          >
            <option value="">First action...</option>
            {ACTION_IDS.map((id) => <option key={id} value={id}>{ACTIONS[id].label}</option>)}
          </select>
          <button
            type="button"
            className="btn btn-primary btn-block"
            disabled={!draft.level || !draft.action}
            onClick={(e) => { e.stopPropagation(); if (draft.level && draft.action) props.onCommit(draft.level, draft.action); }}
          >
            Triage
          </button>
        </div>
      )}
    </div>
  );
}
