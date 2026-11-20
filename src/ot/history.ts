// Progress-history row for a finished operation theatre drill. Builds a
// regular EvalHistoryEntry (mode 'ot') so History, Progress and the debrief
// review screen all render it without special cases.

import type { EvalHistoryEntry } from '../data/evalHistory';
import type { ActivePatient } from '../game/types';
import { gradeOf, type OTReport } from './engine.ts';
import { scenarioById } from './scenarios.ts';

export type OTHistoryPayload = Omit<EvalHistoryEntry, 'id' | 'savedAt'>;

const pct = (n: number, d: number) => (d > 0 ? Math.round((n / d) * 100) : 0);

export function otHistoryPayload(report: OTReport, now = Date.now()): OTHistoryPayload {
  const sc = scenarioById(report.scenarioId);
  const p = sc.patient;
  const evOk = report.events.filter((e) => e.outcome === 'correct' || e.outcome === 'prevented').length;
  const station = report.events.filter((e) => e.atStation || e.outcome === 'prevented').length;
  const ckOk = report.checklist.filter((c) => c.ok).length;
  const dom = (raw: number, max: number) => ({ raw, max, verdict: gradeOf(pct(raw, max)) });
  const criteria = [
    ...report.checklist.map((c) => ({
      criterion_id: `ot-${c.id}`,
      domain: 'data_gathering' as const,
      verdict: c.ok ? ('met' as const) : ('missed' as const),
      evidence: `WHO ${c.stage}: "${c.ask}" You said: ${c.answer ?? 'no answer'}.${c.ok ? '' : ` Correct: ${c.correctLabel}.`}`,
      guideline_ref: null,
    })),
    ...report.events.map((e) => ({
      criterion_id: `ot-${e.id}`,
      domain: 'clinical_management' as const,
      verdict: e.outcome === 'correct' || e.outcome === 'prevented' ? ('met' as const) : e.outcome === 'partial' ? ('partially-met' as const) : ('missed' as const),
      evidence: `${e.label}: ${e.outcome}${e.responseS !== null ? ` in ${e.responseS}s` : ''}. ${e.model}. ${e.teaching}`,
      guideline_ref: null,
    })),
  ];
  const highlights = report.events.filter((e) => e.outcome === 'correct' || e.outcome === 'prevented').map((e) => `${e.label}: ${e.outcome === 'prevented' ? 'anticipated' : `fixed in ${e.responseS ?? 0}s`}`);
  const improvements = [
    ...report.events.filter((e) => e.outcome === 'missed' || e.outcome === 'partial').map((e) => `${e.label}: ${e.model}`),
    ...report.checklist.filter((c) => !c.ok).map((c) => `WHO checklist, ${c.ask} Correct: ${c.correctLabel}`),
  ];
  const snapshot: ActivePatient = {
    case: {
      id: sc.id,
      name: p.name,
      age: p.age,
      gender: p.sex,
      severity: 'urgent',
      arrivalBlurb: sc.summary,
      chiefComplaint: p.procedure,
      vitals: { hr: sc.baseline.hr, bp: `${sc.baseline.sbp}/${sc.baseline.dbp}`, spo2: sc.baseline.spo2, temp: sc.baseline.temp, rr: 14 },
      anamnesis: [],
      testResults: [],
      correctDiagnosisId: '',
      acceptableTreatmentIds: [],
      criticalTreatmentIds: [],
      diagnosisOptions: [],
    },
    bedIndex: -20,
    status: 'discharged',
    askedQuestionIds: [],
    orderedTestIds: [],
    testOrderedAt: {},
    completedTestIds: [],
    givenTreatmentIds: [],
    submittedDiagnosisId: null,
    arrivedAt: now - report.durationS * 1000,
    deadlineMs: now,
  };
  return {
    caseId: sc.id,
    caseName: p.name,
    caseAge: p.age,
    caseGender: p.sex,
    diagnosisLabel: `Operation theatre: ${sc.title}`,
    verdict: report.grade,
    evaluation: {
      case_id: sc.id,
      global_rating: report.grade,
      domain_scores: {
        data_gathering: dom(ckOk, report.checklist.length),
        clinical_management: dom(report.events.reduce((n, e) => n + e.points, 0), report.events.length * 10),
        interpersonal: dom(station, report.events.length),
      },
      criteria,
      safety_breach: report.safety.length ? { what: report.safety.map((s) => s.text).join(' '), guideline_ref: null } : null,
      highlights,
      improvements,
      narrative: `OT drill, ${sc.title}: ${report.score}/100. ${evOk} of ${report.events.length} problems fixed or anticipated, WHO checklist ${report.checklistPct}%${report.avgResponseS !== null ? `, average response ${report.avgResponseS}s` : ''}${report.safety.length ? `, ${report.safety.length} safety error${report.safety.length > 1 ? 's' : ''}` : ''}.`,
    },
    patientSnapshot: snapshot,
    mode: 'ot',
    specialty: 'anesthesiology',
    score: report.score,
    skillScores: { treatment: report.eventPct, communication: report.checklistPct },
    alerts: report.safety.map((s) => ({ severity: 'danger' as const, title: s.text })),
  };
}
