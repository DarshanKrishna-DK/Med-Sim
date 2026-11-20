// Progress-history row for a finished viva voce. Builds a regular
// EvalHistoryEntry (mode 'viva', like the OT drill does) so History and
// Progress count it without special cases; the viva result screen reads the
// full marking from `viva`. Pure (type-only imports) for the Node tests.

import type { EvalHistoryEntry } from '../../data/evalHistory';
import type { ActivePatient } from '../../game/types';
import { VERDICT_LABEL, scoreBand, vivaCaseId, yearLabel, type SavedViva } from './vivaCore.ts';

export type VivaHistoryPayload = Omit<EvalHistoryEntry, 'id' | 'savedAt'>;

export function vivaHistoryPayload(v: SavedViva, now = Date.now()): VivaHistoryPayload {
  const caseId = vivaCaseId(v);
  const band = scoreBand(v.score);
  const asked = v.perQuestion.filter((p) => p.verdict !== 'not asked');
  const credit = (p: (typeof asked)[number]) => (p.verdict === 'correct' ? 1 : p.verdict === 'partial' ? 0.5 : 0);
  const recall = asked.filter((p) => p.difficulty === 1);
  const applied = asked.filter((p) => p.difficulty !== 1);
  const dom = (items: typeof asked) => {
    const raw = items.reduce((n, p) => n + credit(p), 0);
    return { raw, max: items.length, verdict: scoreBand(items.length ? (raw / items.length) * 100 : 0) };
  };
  const snapshot: ActivePatient = {
    case: {
      id: caseId,
      name: `${v.subject} viva`,
      age: 0,
      gender: 'M',
      severity: 'stable',
      arrivalBlurb: `Viva voce: ${v.subject}, ${v.topic} (${yearLabel(v.year)}).`,
      chiefComplaint: v.topic,
      vitals: { hr: 0, bp: '-', spo2: 0, temp: 0, rr: 0 },
      anamnesis: [],
      testResults: [],
      correctDiagnosisId: '',
      acceptableTreatmentIds: [],
      criticalTreatmentIds: [],
      diagnosisOptions: [],
    },
    bedIndex: -30,
    status: 'discharged',
    askedQuestionIds: [],
    orderedTestIds: [],
    testOrderedAt: {},
    completedTestIds: [],
    givenTreatmentIds: [],
    submittedDiagnosisId: null,
    arrivedAt: now - v.durationSec * 1000,
    deadlineMs: now,
  };
  return {
    caseId,
    caseName: `${v.subject} viva`,
    caseAge: 0,
    caseGender: 'M',
    diagnosisLabel: `Viva: ${v.topic}`,
    verdict: band,
    evaluation: {
      case_id: caseId,
      global_rating: band,
      domain_scores: {
        data_gathering: dom(recall),
        clinical_management: dom(applied),
        interpersonal: { raw: asked.length, max: Math.max(1, v.total), verdict: scoreBand(v.total ? (asked.length / v.total) * 100 : 0) },
      },
      criteria: asked.map((p) => ({
        criterion_id: `viva-${p.id}`,
        domain: p.difficulty === 1 ? ('data_gathering' as const) : ('clinical_management' as const),
        verdict: p.verdict === 'correct' ? ('met' as const) : p.verdict === 'partial' ? ('partially-met' as const) : ('missed' as const),
        evidence: `${p.q} ${VERDICT_LABEL[p.verdict]}.${p.said ? ` You said: "${p.said}".` : ''} Expected: ${p.expected}`,
        guideline_ref: null,
      })),
      safety_breach: null,
      highlights: v.strengths,
      improvements: v.gaps,
      narrative: `Viva voce, ${v.subject} (${v.topic}): ${v.score}/100 over ${asked.length} of ${v.total} questions. ${v.examinerComment}`.trim(),
    },
    patientSnapshot: snapshot,
    mode: 'viva',
    subject: v.subject,
    score: v.score,
    skillScores: { reasoning: v.score },
    alerts: [],
    viva: v,
  };
}
