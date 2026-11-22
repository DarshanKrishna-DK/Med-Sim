// Simple (single-call) debrief, fallback when the Managed Agent attending
// path is unavailable. POST /agent/debrief/simple returns a flat grade; we
// also map it onto the `CaseEvaluationInput` shape so the existing
// evaluation UI can render either source unchanged.

import type { ActivePatient, ExamSystem } from '../game/types';
import type { ChatMessage } from '../voice/claude';
import type { CaseEvaluationInput, VerdictBand } from './customTools';
import { TESTS } from '../data/tests';
import { TREATMENTS } from '../data/treatments';
import { MEDICATIONS } from '../data/medications';
import { DIAGNOSIS_LABELS } from '../data/patients';
import { POLYCLINIC_DIAGNOSIS_LABELS } from '../data/polyclinicPatients';

export interface SimpleDebriefDomain {
  name: string;
  score: number;
  notes: string;
}

export interface SimpleDebrief {
  /** Overall score, 0–100. */
  score: number;
  domains: SimpleDebriefDomain[];
  strengths: string[];
  improvements: string[];
  summary: string;
}

export interface SimpleDebriefAction {
  /** Seconds from patient arrival, or null if unknown. */
  t: number | null;
  kind: 'question' | 'exam' | 'test' | 'treatment' | 'prescription' | 'diagnosis' | 'followUp';
  detail: string;
}

const EXAM_NAMES: Partial<Record<ExamSystem, string>> = {
  general: 'general examination', vitals: 'vital signs', cardio: 'cardiovascular system',
  resp: 'respiratory system', abdomen: 'abdomen', neuro: 'nervous system', msk: 'musculoskeletal system',
  skin: 'skin', ent: 'ear, nose and throat', eye: 'eyes', obgyn: 'obstetric/gynaecological', paeds: 'growth and development',
};

function diagnosisLabel(id: string | null): string | null {
  if (!id) return null;
  return POLYCLINIC_DIAGNOSIS_LABELS[id] ?? DIAGNOSIS_LABELS[id] ?? id;
}

/** Request body for POST /agent/debrief/simple (exported for docs/tests). */
export function buildSimpleDebriefPayload(encounter: ActivePatient, transcript: ChatMessage[]) {
  const c = encounter.case;
  const since = (ts: number | undefined) =>
    typeof ts === 'number' ? Math.round((ts - encounter.arrivedAt) / 1000) : null;
  const qById = new Map(c.anamnesis.map((q) => [q.id, q]));
  const testName = new Map(TESTS.map((t) => [t.id, t.name]));
  const txName = new Map(TREATMENTS.map((t) => [t.id, t.name]));
  const medName = new Map(MEDICATIONS.map((m) => [m.id, m.name]));

  const actions: SimpleDebriefAction[] = [
    ...encounter.askedQuestionIds.map((id) => ({
      t: null,
      kind: 'question' as const,
      detail: qById.get(id)?.question ?? id,
    })),
    ...(encounter.examsPerformed ?? []).map((sys) => {
      const r = encounter.examResults?.[sys];
      return {
        t: since(r?.performedAt),
        kind: 'exam' as const,
        detail: `Examined ${EXAM_NAMES[sys] ?? sys}${r?.summary ? `: ${r.summary}` : ''}`,
      };
    }),
    ...encounter.orderedTestIds.map((id) => ({
      t: since(encounter.testOrderedAt[id]),
      kind: 'test' as const,
      detail: `${testName.get(id) ?? id}${encounter.completedTestIds.includes(id) ? '' : ' (result still pending at the end)'}`,
    })),
    ...encounter.givenTreatmentIds.map((id) => ({
      t: null,
      kind: 'treatment' as const,
      detail: txName.get(id) ?? id,
    })),
    ...(encounter.prescriptions ?? []).map((rx) => ({
      t: since(rx.prescribedAt),
      kind: 'prescription' as const,
      detail: `${medName.get(rx.medicationId) ?? rx.medicationId}, ${rx.dose}, ${rx.duration}`,
    })),
    // Held or still being checked: ordered, but never given to the patient.
    ...(encounter.rxReview ?? []).map((r) => ({
      t: since(r.at),
      kind: 'treatment' as const,
      detail:
        r.status === 'held'
          ? `NOT prescribed, held by the pharmacist: ${medName.get(r.medicationId) ?? r.medicationId}${r.reason ? ` (${r.reason})` : ''}`
          : `NOT yet prescribed, pharmacist still checking: ${medName.get(r.medicationId) ?? r.medicationId}`,
    })),
    ...(encounter.submittedDiagnosisId
      ? [{
          t: null,
          kind: 'diagnosis' as const,
          detail: diagnosisLabel(encounter.submittedDiagnosisId) ?? encounter.submittedDiagnosisId,
        }]
      : []),
    ...(encounter.followUp
      ? [{
          t: null,
          kind: 'followUp' as const,
          detail: `Follow-up ${encounter.followUp.inDays === 0 ? 'later today' : `in ${encounter.followUp.inDays} days`}: ${encounter.followUp.reason}`,
        }]
      : []),
  ];

  return {
    caseId: c.id,
    patient: {
      name: c.name,
      age: c.age,
      gender: c.gender,
      severity: c.severity,
      chiefComplaint: c.chiefComplaint,
      vitals: c.vitals,
    },
    correctDiagnosis: { id: c.correctDiagnosisId, name: diagnosisLabel(c.correctDiagnosisId) },
    submittedDiagnosis: encounter.submittedDiagnosisId
      ? { id: encounter.submittedDiagnosisId, name: diagnosisLabel(encounter.submittedDiagnosisId) }
      : null,
    actions,
    examsPerformed: (encounter.examsPerformed ?? []).map((sys) => ({
      system: sys,
      abnormalFindings: (encounter.examResults?.[sys]?.findings ?? [])
        .filter((f) => f.abnormal)
        .map((f) => `${f.label}: ${f.value}`),
    })),
    transcript: transcript.map((m) => ({ role: m.role, content: m.content })),
    elapsedSeconds: Math.round((Date.now() - encounter.arrivedAt) / 1000),
    ...(c.rubric ? { rubric: c.rubric } : {}),
  };
}

function asStringList(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && x.trim() !== '') : [];
}

/** Normalise a score to 0–100 (accepts 0–1, 0–10, or 0–100 scales). */
function to100(n: unknown): number {
  const x = Number(n);
  if (!Number.isFinite(x) || x < 0) return 0;
  if (x <= 1) return Math.round(x * 100);
  if (x <= 10) return Math.round(x * 10);
  return Math.min(100, Math.round(x));
}

export async function requestSimpleDebrief(
  encounter: ActivePatient,
  transcript: ChatMessage[],
  signal?: AbortSignal,
): Promise<SimpleDebrief> {
  let r: Response;
  try {
    r = await fetch('/agent/debrief/simple', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildSimpleDebriefPayload(encounter, transcript)),
      signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    throw new Error('Debrief backend unreachable, start backend/server.py on :8787.');
  }
  if (!r.ok) {
    const text = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`/agent/debrief/simple ${r.status}${text ? `: ${text}` : ''}`);
  }
  const raw = (await r.json()) as Partial<SimpleDebrief>;
  return {
    score: to100(raw.score),
    domains: Array.isArray(raw.domains)
      ? raw.domains.map((d) => ({
          name: String(d?.name ?? ''),
          score: to100(d?.score),
          notes: String(d?.notes ?? ''),
        }))
      : [],
    strengths: asStringList(raw.strengths),
    improvements: asStringList(raw.improvements),
    summary: typeof raw.summary === 'string' ? raw.summary : '',
  };
}

function band(score: number): VerdictBand {
  if (score < 40) return 'clear-fail';
  if (score < 55) return 'borderline';
  if (score < 70) return 'satisfactory';
  if (score < 85) return 'good';
  return 'excellent';
}

/** Map a SimpleDebrief onto the OSCE `CaseEvaluationInput` shape so the
 *  Managed-Agent evaluation renderer works for both sources. Domain scores
 *  are out of 100; `criteria` is empty (the simple path doesn't grade
 *  per-criterion). */
export function simpleDebriefToEvaluation(caseId: string, d: SimpleDebrief): CaseEvaluationInput {
  const find = (re: RegExp) => d.domains.find((x) => re.test(x.name.toLowerCase()));
  const dom = (re: RegExp) => {
    const raw = find(re)?.score ?? d.score;
    return { raw, max: 100, verdict: band(raw) };
  };
  return {
    case_id: caseId,
    global_rating: band(d.score),
    domain_scores: {
      data_gathering: dom(/data|history|gather/),
      clinical_management: dom(/clinical|manage|treat|diagnos/),
      interpersonal: dom(/interpersonal|communic|rapport|empathy/),
    },
    criteria: [],
    safety_breach: null,
    highlights: d.strengths,
    improvements: d.improvements,
    narrative: d.summary || 'Evaluation complete.',
  };
}
