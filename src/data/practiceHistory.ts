// Progress-dashboard fields for a practice-mode debrief row (see
// evalHistory.ts). Kept out of progress.ts so that file stays free of
// runtime imports for the Node unit tests.

import { store } from '../game/store';
import type { ActivePatient } from '../game/types';
import type { CaseEvaluationInput } from '../agents/customTools';
import type { SimpleDebrief } from '../agents/simpleDebrief';
import { getCaseClinic } from './cases';
import type { EvalHistoryEntry } from './evalHistory';
import { entryScore, skillsFromDomainNames, skillsFromEvaluation } from './progress';

export function practiceHistoryExtras(
  encounter: ActivePatient,
  evaluation: CaseEvaluationInput,
  simple: SimpleDebrief | null,
): Pick<EvalHistoryEntry, 'mode' | 'specialty' | 'score' | 'skillScores' | 'alerts'> {
  const caseId = encounter.case.id;
  const fromSimple = simple ? skillsFromDomainNames(simple.domains) : {};
  return {
    mode: 'practice',
    specialty: getCaseClinic(caseId),
    score: simple ? simple.score : entryScore({ evaluation } as EvalHistoryEntry),
    skillScores: Object.keys(fromSimple).length ? fromSimple : skillsFromEvaluation(evaluation),
    alerts: store
      .getState()
      .coachAlerts.filter((a) => a.caseId === caseId)
      .map((a) => ({ severity: a.severity, title: a.title })),
  };
}
