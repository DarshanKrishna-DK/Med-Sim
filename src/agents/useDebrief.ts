// One-stop debrief hook for the UI: tries the Managed Agent attending and
// falls back to the simple single-call debrief (/agent/debrief/simple).
//
//   const encounter = useStore((s) => s.lastEncounter);
//   const d = useDebrief(encounter);          // transcript auto-resolved
//   d.status / d.evaluation / d.source / d.simple / d.error
//
// `evaluation` is always a CaseEvaluationInput (simple results are mapped
// onto it), so one renderer handles both sources.

import { useMemo } from 'react';
import type { ActivePatient } from '../game/types';
import type { ChatMessage } from '../voice/claude';
import { getLastTranscript } from '../voice/conversationStore';
import { buildDebriefRequest } from './debriefRequest';
import { requestSimpleDebrief, simpleDebriefToEvaluation } from './simpleDebrief';
import { useAttendingDebrief, type UseAttendingDebriefResult } from './useAttendingDebrief';

export interface UseDebriefOptions {
  enabled?: boolean;
  /** Explicit transcript; defaults to the cached conversation for the case. */
  transcript?: ChatMessage[];
  /** 'auto' (default): Managed Agent, then simple fallback.
   *  'simple': skip the Managed Agent. */
  mode?: 'auto' | 'simple';
  timeoutMs?: number;
}

export function useDebrief(
  encounter: ActivePatient | null,
  opts: UseDebriefOptions = {},
): UseAttendingDebriefResult {
  const request = useMemo(
    () => (encounter ? buildDebriefRequest(encounter.case, encounter) : null),
    [encounter],
  );
  return useAttendingDebrief(request, {
    enabled: opts.enabled,
    skipManagedAgent: opts.mode === 'simple',
    timeoutMs: opts.timeoutMs,
    fallback: encounter
      ? async (signal) => {
          const transcript = opts.transcript ?? getLastTranscript(encounter.case.id);
          const simple = await requestSimpleDebrief(encounter, transcript, signal);
          return { evaluation: simpleDebriefToEvaluation(encounter.case.id, simple), simple };
        }
      : undefined,
  });
}
