import { useEffect, useMemo, useRef, useState } from 'react';
import { ThinkingOrb } from 'thinking-orbs';
import { store, useStore } from '../../game/store';
import { getEvalHistory, saveEvalHistory, type EvalHistoryEntry } from '../../data/evalHistory';
import { getCaseClinic } from '../../data/cases';
import { POLYCLINIC_DIAGNOSIS_LABELS } from '../../data/polyclinicPatients';
import { CLINIC_LABELS } from '../../game/clinic';
import type { ActivePatient, OsceSession } from '../../game/types';
import { useOsceMarking } from '../../agents/osceMarking';
import {
  OSCE_RATING_LABEL,
  osceToEvaluation,
  type OsceCriticalError,
  type OsceItemVerdict,
  type OsceResult,
} from '../../agents/osceCore';
import { AppHeader } from '../ui/chrome';
import { FacultyMarksCard } from '../observer/FacultyMarksCard';
import '../../styles/osce.css';

type SavedOsce = NonNullable<EvalHistoryEntry['osce']>;

const dxLabel = (id: string | null) => (id ? POLYCLINIC_DIAGNOSIS_LABELS[id] ?? id.replace(/-/g, ' ') : null);

const VERDICT_WORD: Record<OsceItemVerdict, string> = { met: 'Met', partial: 'Partly met', 'not-met': 'Not met' };
const SEV_WORD: Record<OsceCriticalError['severity'], string> = { danger: 'Critical', warning: 'Warning', info: 'Note' };

function tone(score: number): 'good' | 'mid' | 'bad' {
  return score >= 55 ? (score >= 70 ? 'good' : 'mid') : 'bad';
}

export function OsceResultScreen() {
  const viewedId = useStore((s) => s.viewedEvalHistoryId);
  const osce = useStore((s) => s.osce);
  const reviewed = useMemo(() => {
    const id = viewedId ?? osce?.savedId ?? null;
    const e = id ? getEvalHistory(id) : null;
    return e?.osce ? e : null;
  }, [viewedId, osce?.savedId]);

  useEffect(() => () => store.clearViewedEval(), []);

  return (
    <div className="page paper dots osce-page">
      <AppHeader />
      <main className="osce wrap">
        {reviewed ? (
          <Report entry={reviewed} result={reviewed.osce!} encounter={reviewed.patientSnapshot} />
        ) : osce?.encounter ? (
          <LiveMarking session={osce} />
        ) : (
          <div className="empty empty--page">
            <p className="empty-title">No OSCE station to mark</p>
            <p className="empty-body">Run a timed station and the examiner's marking sheet appears here.</p>
            <button type="button" className="btn btn-primary" onClick={() => store.openOsce()}>
              Start an OSCE station
            </button>
          </div>
        )}
      </main>
    </div>
  );
}

function LiveMarking({ session }: { session: OsceSession }) {
  const m = useOsceMarking(session);
  const saved = useRef(false);

  useEffect(() => {
    if (saved.current || !m.result || !session.encounter) return;
    saved.current = true;
    const enc = session.encounter;
    const c = enc.case;
    const dx = enc.submittedDiagnosisId ?? c.correctDiagnosisId;
    const evaluation = osceToEvaluation(c.id, m.result);
    const entry = saveEvalHistory({
      caseId: c.id,
      caseName: c.name,
      caseAge: c.age,
      caseGender: c.gender,
      diagnosisLabel: dxLabel(dx) ?? dx,
      verdict: evaluation.global_rating,
      evaluation,
      patientSnapshot: enc,
      mode: 'osce',
      specialty: getCaseClinic(c.id),
      score: m.result.score,
      skillScores: m.result.skills,
      alerts: session.alerts.map((a) => ({ severity: a.severity, title: a.title })),
      osce: {
        ...m.result,
        candidateName: session.candidateName || undefined,
        durationSec: Math.round(session.durationMs / 1000),
        elapsedSec: Math.min(
          Math.round(session.durationMs / 1000),
          Math.round(((session.endedAt ?? Date.now()) - (session.startedAt ?? enc.arrivedAt)) / 1000),
        ),
      },
    });
    store.setOsceSavedId(entry.id);
  }, [m.result, session]);

  if (m.status === 'error') {
    return (
      <div className="debrief-wait">
        <h1 className="page-title">The examiner couldn't mark the station</h1>
        <p className="page-lede">{m.error ?? 'Marking failed.'} Your station is kept, so try again.</p>
        <div className="row-actions">
          <button type="button" className="btn btn-primary" onClick={m.retry}>Try again</button>
          <button type="button" className="btn btn-ghost" onClick={() => store.exitOsce('library')}>Back to cases</button>
        </div>
      </div>
    );
  }

  // Saved: the screen re-renders from the stored entry (see OsceResultScreen).
  return (
    <div className="debrief-wait">
      <div className="wait-head">
        <ThinkingOrb state="solving" size={64} theme="light" aria-label="The examiner is marking your station" />
        <div>
          <h1 className="page-title">The bell has gone. The examiner is marking.</h1>
          <p className="page-lede">Checking your transcript and orders against the station checklist.</p>
        </div>
      </div>
    </div>
  );
}

function fmtClock(sec: number): string {
  const s = Math.max(0, Math.round(sec));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

function Report({ entry, result, encounter }: { entry: EvalHistoryEntry; result: SavedOsce; encounter: ActivePatient }) {
  const [candidate, setCandidate] = useState(result.candidateName ?? '');
  const c = encounter.case;
  const specialty = entry.specialty ?? getCaseClinic(c.id);
  const ratingTone = result.globalRating === 'clear-fail' || result.globalRating === 'borderline' ? 'bad' : 'good';
  const submitted = encounter.submittedDiagnosisId;
  const r: OsceResult = result;

  return (
    <article className="osce-report" aria-labelledby="osce-report-title">
      <header className="osce-report-head">
        <div className="osce-report-brand">
          <img src="/brand/medsim-logo-96.png" width={44} height={44} alt="" aria-hidden="true" draggable={false} />
          <div>
            <p className="kicker">MedSim · OSCE examiner report</p>
            <h1 id="osce-report-title" className="osce-report-title">Station marking sheet</h1>
          </div>
        </div>
        <div className="row-actions no-print">
          <button type="button" className="btn btn-primary" onClick={() => window.print()}>
            Print or save as PDF
          </button>
          <button type="button" className="btn btn-secondary" onClick={() => store.openOsce()}>
            New station
          </button>
          <button type="button" className="btn btn-ghost" onClick={() => store.setScreen('progress')}>
            My progress
          </button>
        </div>
      </header>

      <dl className="osce-meta">
        <div className="osce-meta-candidate">
          <dt><label htmlFor="osce-candidate">Candidate</label></dt>
          <dd>
            <input
              id="osce-candidate"
              className="input osce-candidate-input"
              value={candidate}
              onChange={(e) => setCandidate(e.target.value)}
              placeholder="Add your name for the printout"
              maxLength={60}
            />
          </dd>
        </div>
        <div>
          <dt>Date</dt>
          <dd>{new Date(entry.savedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</dd>
        </div>
        <div>
          <dt>Station</dt>
          <dd>{specialty ? CLINIC_LABELS[specialty] : 'Outpatient'} OPD</dd>
        </div>
        <div>
          <dt>Patient</dt>
          <dd>{c.name}, {c.age}{c.gender}: {c.chiefComplaint}</dd>
        </div>
        <div>
          <dt>Time used</dt>
          <dd>{fmtClock(result.elapsedSec)} of {fmtClock(result.durationSec)}</dd>
        </div>
        <div>
          <dt>Diagnosis</dt>
          <dd>
            {submitted ? dxLabel(submitted) : 'None submitted'}
            {submitted && (
              <span className={`tag ${submitted === c.correctDiagnosisId ? 'tag--ok' : 'tag--critical'}`}>
                {submitted === c.correctDiagnosisId ? 'Correct' : `Case: ${dxLabel(c.correctDiagnosisId)}`}
              </span>
            )}
          </dd>
        </div>
      </dl>

      <section className="osce-verdict" aria-label="Global rating">
        <div>
          <p className="field-label">Global rating</p>
          <p className={`osce-rating verdict-word--${ratingTone}`}>{OSCE_RATING_LABEL[r.globalRating]}</p>
        </div>
        <div className="osce-overall">
          <p className="field-label">Checklist score</p>
          <p className="osce-overall-num">{r.score}<span className="score-max">/100</span></p>
        </div>
        {r.examinerComment && <p className="verdict-narrative osce-comment">{r.examinerComment}</p>}
      </section>

      <section className="scores" aria-label="Domain scores">
        {r.domains.map((d) => (
          <div className="score" key={d.id}>
            <div className="score-head">
              <span className="score-label">{d.label}</span>
              <span className="score-num">{d.score}<span className="score-max">/100</span></span>
            </div>
            <div className="score-track" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={d.score} aria-label={d.label}>
              <span className={`score-fill score-fill--${tone(d.score)}`} style={{ width: `${d.score}%` }} />
            </div>
          </div>
        ))}
      </section>

      <section className="osce-errors" aria-labelledby="osce-errors-title">
        <h2 id="osce-errors-title" className="section-title">Critical errors</h2>
        <p className="muted-note">Mistake alerts the nurse recorded silently during the station.</p>
        {r.criticalErrors.length === 0 ? (
          <p className="osce-none">None raised. Safe practice throughout.</p>
        ) : (
          <ul className="osce-error-list">
            {r.criticalErrors.map((e, i) => (
              <li key={i} className={`osce-error osce-error--${e.severity}`}>
                <span className="osce-error-sev">{SEV_WORD[e.severity]}</span>
                <div>
                  <p className="osce-error-title">{e.title}</p>
                  {e.detail && <p className="osce-error-detail">{e.detail}</p>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="osce-checklist" aria-labelledby="osce-check-title">
        <h2 id="osce-check-title" className="section-title">Examiner checklist</h2>
        {r.domains.map((d) => (
          <div key={d.id} className="osce-domain">
            <h3 className="block-title">{d.label} · {d.score}/100</h3>
            <table className="osce-table">
              <thead>
                <tr>
                  <th scope="col">Item</th>
                  <th scope="col">Mark</th>
                  <th scope="col">Evidence</th>
                </tr>
              </thead>
              <tbody>
                {d.items.map((it) => (
                  <tr key={it.id} className={`osce-row osce-row--${it.verdict}`}>
                    <td className="osce-item">{it.label}</td>
                    <td><span className="osce-mark">{VERDICT_WORD[it.verdict]}</span></td>
                    <td>
                      {it.evidence && <q className="osce-quote">{it.evidence}</q>}
                      {it.note && <span className="osce-note">{it.note}</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}
      </section>

      {(r.strengths.length > 0 || r.improvements.length > 0) && (
        <section className="two-col">
          <div>
            <h2 className="block-title">What went well</h2>
            {r.strengths.length ? <ul className="notes notes--good">{r.strengths.map((h, i) => <li key={i}>{h}</li>)}</ul> : <p className="muted-note">Nothing singled out.</p>}
          </div>
          <div>
            <h2 className="block-title">What to work on</h2>
            {r.improvements.length ? <ul className="notes notes--work">{r.improvements.map((h, i) => <li key={i}>{h}</li>)}</ul> : <p className="muted-note">Nothing flagged.</p>}
          </div>
        </section>
      )}

      <FacultyMarksCard caseId={c.id} encounterAt={encounter.arrivedAt} saved={entry.facultyMarks} />
      <p className="osce-footnote">
        Synthetic training station marked by an AI examiner against the case checklist. Not a clinical or exam
        board assessment.
      </p>
    </article>
  );
}
