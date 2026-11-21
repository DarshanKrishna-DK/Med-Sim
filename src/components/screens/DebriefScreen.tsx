import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { ProfileBadge } from '../ui/ProfileBadge';
import { ThinkingOrb } from 'thinking-orbs';
import { ClipboardArt } from '../ui/pixel/MedArt';
import { store, useStore } from '../../game/store';
import { useDebrief } from '../../agents/useDebrief';
import type { CaseEvaluationInput, CriterionResult, DomainScore, VerdictBand } from '../../agents/customTools';
import { getRecommendation } from '../../data/guidelines';
import { getEvalHistory, saveEvalHistory } from '../../data/evalHistory';
import { practiceHistoryExtras } from '../../data/practiceHistory';
import { POLYCLINIC_DIAGNOSIS_LABELS } from '../../data/polyclinicPatients';
import { testById } from '../../data/tests';
import { medicationById } from '../../data/medications';
import type { ActivePatient } from '../../game/types';
import { AppHeader } from '../ui/chrome';
import { FacultyMarksCard } from '../observer/FacultyMarksCard';
import { fmtMs, voiceMetrics } from '../../voice/voiceMetrics';
import { logEncounterOnce, logbookLinkFor, subscribeLogbook } from '../../agents/logbook';
import { SendResultButton } from '../ui/SendResultButton';
import { buildResultPayload } from '../../agents/resultSend';
import { getProfile } from '../../game/profile';
import { getCaseClinic } from '../../data/cases';
import { CLINIC_LABELS } from '../../game/clinic';

const VERDICT: Record<VerdictBand, { word: string; tone: 'good' | 'mid' | 'bad' }> = {
  excellent: { word: 'Excellent', tone: 'good' },
  good: { word: 'Good', tone: 'good' },
  satisfactory: { word: 'Satisfactory', tone: 'mid' },
  borderline: { word: 'Borderline', tone: 'bad' },
  'clear-fail': { word: 'Clear fail', tone: 'bad' },
};

const DOMAIN_LABEL = {
  data_gathering: 'History and data gathering',
  clinical_management: 'Clinical management',
  interpersonal: 'Communication',
} as const;

/** Guard against a list that arrived as a string split into characters
 *  (seen from /agent/debrief/simple when the model returns a string). */
function asBullets(list: string[]): string[] {
  if (list.length > 1 && list.every((x) => x.length <= 1)) {
    return list.join('').split(/\n+|(?<=\.)\s+(?=[A-Z])/).map((x) => x.trim()).filter(Boolean);
  }
  return list;
}

const dxLabel = (id: string | null) =>
  id ? POLYCLINIC_DIAGNOSIS_LABELS[id] ?? id.replace(/-/g, ' ') : null;

export function DebriefScreen() {
  const viewedId = useStore((s) => s.viewedEvalHistoryId);
  const lastEncounter = useStore((s) => s.lastEncounter);
  const seated = useStore((s) => s.polyclinic.patient);
  const reviewed = useMemo(() => (viewedId ? getEvalHistory(viewedId) : null), [viewedId]);
  const [attempt, setAttempt] = useState(0);
  const [mode, setMode] = useState<'auto' | 'simple'>('auto');

  useEffect(() => () => store.clearViewedEval(), []);

  const encounter: ActivePatient | null = reviewed?.patientSnapshot ?? lastEncounter ?? seated;

  return (
    <div className="page paper dots">
      <AppHeader />
      <main className="debrief wrap">
        {!encounter ? (
          <div className="empty empty--page">
            <div className="empty-figure">
              <ClipboardArt />
            </div>
            <p className="empty-title">Nothing to debrief yet</p>
            <p className="empty-body">Finish a consultation and the attending's marking appears here.</p>
            <button type="button" className="btn btn-primary" onClick={() => store.setScreen('library')}>
              Choose a case
            </button>
          </div>
        ) : reviewed ? (
          <DebriefBody encounter={encounter} evaluation={reviewed.evaluation} source={null} savedAt={reviewed.savedAt} />
        ) : (
          <LiveDebrief
            key={`${attempt}-${mode}`}
            encounter={encounter}
            mode={mode}
            onRetry={(m) => {
              setMode(m);
              setAttempt((a) => a + 1);
            }}
          />
        )}
      </main>
    </div>
  );
}

function LiveDebrief({
  encounter,
  mode,
  onRetry,
}: {
  encounter: ActivePatient;
  mode: 'auto' | 'simple';
  onRetry: (mode: 'auto' | 'simple') => void;
}) {
  const d = useDebrief(encounter, { mode });
  const saved = useRef(false);

  useEffect(() => {
    if (saved.current || !d.evaluation) return;
    saved.current = true;
    const c = encounter.case;
    const dx = encounter.submittedDiagnosisId ?? c.correctDiagnosisId;
    const extras = practiceHistoryExtras(encounter, d.evaluation, d.simple);
    void logEncounterOnce(encounter, extras.specialty, extras.score);
    saveEvalHistory({
      caseId: c.id,
      caseName: c.name,
      caseAge: c.age,
      caseGender: c.gender,
      diagnosisLabel: dxLabel(dx) ?? dx,
      verdict: d.evaluation.global_rating,
      evaluation: d.evaluation,
      patientSnapshot: encounter,
      ...extras,
    });
  }, [d.evaluation, encounter]);

  if (d.evaluation) {
    return <DebriefBody encounter={encounter} evaluation={d.evaluation} source={d.source} />;
  }

  if (d.status === 'error' || d.status === 'aborted') {
    return (
      <div className="debrief-wait">
        <h1 className="page-title">The attending couldn't finish the debrief</h1>
        <p className="page-lede">{d.error ?? 'The grading stream closed early.'} Your encounter is kept, so try again.</p>
        <div className="row-actions">
          <button type="button" className="btn btn-primary" onClick={() => onRetry('auto')}>Try again</button>
          <button type="button" className="btn btn-ghost" onClick={() => onRetry('simple')}>Use the quick debrief</button>
        </div>
        <EncounterSummary encounter={encounter} />
      </div>
    );
  }

  const narration = d.partialNarration.trim();
  return (
    <div className="debrief-wait">
      <div className="wait-head">
        <ThinkingOrb state="solving" size={64} theme="light" aria-label="The attending is marking your consultation" />
        <div>
          <h1 className="page-title">The attending is marking your consultation</h1>
          <p className="page-lede">
            {d.status === 'streaming'
              ? 'Reading the encounter against the case rubric and the guidelines it cites.'
              : 'Packaging what you asked, ordered, diagnosed and prescribed.'}
          </p>
        </div>
      </div>
      {narration && (
        <div className="narration" aria-live="polite">
          <p className="field-label">Attending's notes so far</p>
          <p className="narration-text">{narration.length > 900 ? '…' + narration.slice(-900) : narration}</p>
        </div>
      )}
      <EncounterSummary encounter={encounter} />
    </div>
  );
}

function DebriefBody({
  encounter,
  evaluation,
  source,
  savedAt,
}: {
  encounter: ActivePatient;
  evaluation: CaseEvaluationInput;
  source: 'managed-agent' | 'simple' | null;
  savedAt?: number;
}) {
  const v = VERDICT[evaluation.global_rating] ?? VERDICT.satisfactory;
  const highlights = asBullets(evaluation.highlights);
  const improvements = asBullets(evaluation.improvements);
  const c = encounter.case;
  const logbookUrl = useSyncExternalStore(
    subscribeLogbook,
    () => logbookLinkFor(c.id, encounter.arrivedAt),
  );
  const domains = (Object.keys(DOMAIN_LABEL) as Array<keyof typeof DOMAIN_LABEL>).map((k) => ({
    key: k,
    label: DOMAIN_LABEL[k],
    score: evaluation.domain_scores[k],
    criteria: evaluation.criteria.filter((x) => x.domain === k),
  }));
  const sessionLang = useStore((s) => s.lang);
  const clinic = getCaseClinic(c.id);
  const submitted = encounter.submittedDiagnosisId;
  const resultPayload = buildResultPayload({
    profile: getProfile(),
    caseId: c.id,
    caseTitle: `${c.name}, ${c.age}${c.gender}`,
    patientName: c.name,
    specialty: clinic ? CLINIC_LABELS[clinic] : '',
    chiefComplaint: c.chiefComplaint,
    verdict: v.word,
    domains: domains.map((d) => ({ name: d.label, score: d.score?.raw ?? 0, max: d.score?.max ?? 0 })),
    strengths: highlights,
    improvements,
    narrative: evaluation.narrative,
    diagnosisChosen: dxLabel(submitted ?? null),
    diagnosisCorrect: dxLabel(c.correctDiagnosisId),
    diagnosisIsCorrect: submitted ? submitted === c.correctDiagnosisId : false,
    prescriptions: (encounter.prescriptions ?? []).map((p) => `${medicationById(p.medicationId)?.name ?? p.medicationId} ${p.dose}`),
    tests: encounter.orderedTestIds.map((t) => testById(t)?.name ?? t),
    lang: sessionLang,
  });

  return (
    <article className="debrief-body">
      <header className="verdict">
        <div className="verdict-meta">
          <ProfileBadge />
          <p className="field-label">
            Debrief · {c.name}, {c.age}{c.gender}
            {savedAt ? ` · ${new Date(savedAt).toLocaleDateString()}` : ''}
          </p>
          <h1 className={`verdict-word verdict-word--${v.tone}`}>{v.word}</h1>
          <p className="verdict-narrative">{evaluation.narrative}</p>
          {(() => { const vs = voiceMetrics.statsFor(encounter.case.id); return vs && vs.avgE2eMs !== null ? <p className="muted-note">Voice: average response {fmtMs(vs.avgE2eMs)} over {vs.turns} turns, {vs.interruptions} interruptions (Agora Conversational AI + Murf Falcon).</p> : null; })()}
          {logbookUrl && (
            <p className="muted-note">
              <a className="step-link" href={logbookUrl} target="_blank" rel="noreferrer noopener">Logged to your CBME logbook</a>
            </p>
          )}
          {source === 'simple' && (
            <p className="muted-note">Quick debrief: the full rubric marker was unavailable.</p>
          )}
        </div>
        <div className="row-actions">
          <button type="button" className="btn btn-primary btn-lg" onClick={() => store.acceptNextPatient()}>
            See the next patient
          </button>
          <button type="button" className="btn btn-ghost btn-lg" onClick={() => store.setScreen('library')}>
            Back to cases
          </button>
        </div>
        <SendResultButton sendKey={`debrief:${c.id}:${encounter.arrivedAt}`} payload={resultPayload} auto={!savedAt} />
      </header>

      {evaluation.safety_breach && (
        <section className="breach" role="alert">
          <h2 className="breach-title">Safety issue</h2>
          <p>{evaluation.safety_breach.what}</p>
          <Cite refId={evaluation.safety_breach.guideline_ref} />
        </section>
      )}

      <section className="scores" aria-label="Domain scores">
        {domains.map((d) => (
          <ScoreBar key={d.key} label={d.label} score={d.score} />
        ))}
      </section>

      <section className="two-col">
        <div>
          <h2 className="block-title">What went well</h2>
          {highlights.length ? (
            <ul className="notes notes--good">{highlights.map((h, i) => <li key={i}>{h}</li>)}</ul>
          ) : (
            <p className="muted-note">Nothing singled out.</p>
          )}
        </div>
        <div>
          <h2 className="block-title">What to work on</h2>
          {improvements.length ? (
            <ul className="notes notes--work">{improvements.map((h, i) => <li key={i}>{h}</li>)}</ul>
          ) : (
            <p className="muted-note">Nothing flagged.</p>
          )}
        </div>
      </section>

      {evaluation.criteria.length > 0 && (
        <section className="criteria-wrap">
          <h2 className="section-title">Marking sheet</h2>
          {domains.filter((d) => d.criteria.length > 0).map((d) => (
            <div key={d.key} className="criteria-group">
              <h3 className="block-title">{d.label}</h3>
              <ul className="criteria">
                {d.criteria.map((cr) => <Criterion key={cr.criterion_id} cr={cr} />)}
              </ul>
            </div>
          ))}
        </section>
      )}

      <FacultyMarksCard caseId={c.id} encounterAt={encounter.arrivedAt} />
      <EncounterSummary encounter={encounter} />
    </article>
  );
}

function ScoreBar({ label, score }: { label: string; score: DomainScore }) {
  const pct = score.max > 0 ? Math.max(0, Math.min(1, score.raw / score.max)) : 0;
  const tone = VERDICT[score.verdict]?.tone ?? 'mid';
  const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
  return (
    <div className="score">
      <div className="score-head">
        <span className="score-label">{label}</span>
        <span className="score-num">{fmt(score.raw)}<span className="score-max">/{fmt(score.max)}</span></span>
      </div>
      <div className="score-track" role="meter" aria-valuemin={0} aria-valuemax={score.max} aria-valuenow={score.raw} aria-label={label}>
        <span className={`score-fill score-fill--${tone}`} style={{ width: `${pct * 100}%` }} />
      </div>
      <span className="score-verdict">{VERDICT[score.verdict]?.word}</span>
    </div>
  );
}

const CRIT_LABEL: Record<CriterionResult['verdict'], string> = {
  met: 'Met',
  'partially-met': 'Partly met',
  missed: 'Missed',
};

function Criterion({ cr }: { cr: CriterionResult }) {
  return (
    <li className={`criterion criterion--${cr.verdict}`}>
      <span className="criterion-verdict">{CRIT_LABEL[cr.verdict]}</span>
      <div>
        <p className="criterion-evidence">{cr.evidence}</p>
        <Cite refId={cr.guideline_ref} />
      </div>
    </li>
  );
}

function Cite({ refId }: { refId?: string | null }) {
  if (!refId) return null;
  const r = getRecommendation(refId);
  if (!r) return null;
  const tags = [r.rec.recClass && `Class ${r.rec.recClass}`, r.rec.lev && `LoE ${r.rec.lev}`, r.rec.gradeStrength]
    .filter(Boolean)
    .join(', ');
  return (
    <p className="cite">
      <a href={r.guideline.url} target="_blank" rel="noreferrer">
        {r.guideline.body} {r.guideline.year}
      </a>
      {tags ? ` (${tags})` : ''}: {r.rec.text}
    </p>
  );
}

function EncounterSummary({ encounter }: { encounter: ActivePatient }) {
  const c = encounter.case;
  const runs = useStore((s) => s.agentRuns);
  const nurseRuns = runs.filter((r) => r.caseId === c.id && r.intent !== 'none').length;
  const submitted = encounter.submittedDiagnosisId;
  const correct = submitted ? submitted === c.correctDiagnosisId : null;
  return (
    <section className="summary" aria-labelledby="summary-title">
      <h2 id="summary-title" className="section-title">Your encounter</h2>
      <dl className="summary-grid">
        <div>
          <dt>Diagnosis</dt>
          <dd>
            {submitted ? (
              <>
                {dxLabel(submitted)}{' '}
                <span className={`tag ${correct ? 'tag--ok' : 'tag--critical'}`}>{correct ? 'Correct' : 'Not the case diagnosis'}</span>
              </>
            ) : (
              'None submitted'
            )}
          </dd>
        </div>
        <div>
          <dt>Tests</dt>
          <dd>{encounter.orderedTestIds.length ? encounter.orderedTestIds.map((t) => testById(t)?.name ?? t).join(', ') : 'None'}</dd>
        </div>
        <div>
          <dt>Prescriptions</dt>
          <dd>
            {(encounter.prescriptions ?? []).length
              ? (encounter.prescriptions ?? []).map((p) => `${medicationById(p.medicationId)?.name ?? p.medicationId} ${p.dose}`).join('; ')
              : 'None'}
          </dd>
        </div>
        <div>
          <dt>Follow-up</dt>
          <dd>{encounter.followUp ? `${encounter.followUp.inDays} days: ${encounter.followUp.reason}` : 'None'}</dd>
        </div>
        {nurseRuns > 0 && (
          <div>
            <dt>Nurse orders</dt>
            <dd>{nurseRuns} handled by the charge nurse</dd>
          </div>
        )}
      </dl>
    </section>
  );
}
