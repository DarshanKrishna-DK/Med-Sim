// OSCE station marking: request builder + fetch for POST /agent/debrief/osce,
// and the React hook the result screen uses. Pure types/helpers live in
// osceCore.ts.

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoachAlert, OsceSession } from '../game/types';
import { getLastTranscript } from '../voice/conversationStore';
import { getRubricFor } from '../data/autoRubric';
import { medicationById } from '../data/medications';
import { TREATMENTS } from '../data/treatments';
import { buildSimpleDebriefPayload } from './simpleDebrief';
import { normalizeOsceResult, type OsceResult } from './osceCore';

const TIMEOUT_MS = 90_000;

/** Auto-rubric labels carry raw treatment ids; show names instead. */
function prettyRubric(session: OsceSession) {
  const c = session.encounter!.case;
  const rubric = getRubricFor(c);
  if (c.rubric) return rubric;
  const name = (id: string) => medicationById(id)?.name ?? TREATMENTS.find((t) => t.id === id)?.name ?? id.replace(/-/g, ' ');
  return {
    ...rubric,
    clinical_management: rubric.clinical_management.map((cr) => {
      const m = /^Deliver critical action: (.+)$/.exec(cr.label);
      return m ? { ...cr, label: `Delivers critical action: ${name(m[1])}` } : cr;
    }),
  };
}

/** Request body for POST /agent/debrief/osce. The candidate name never
 *  leaves the browser. */
export function buildOscePayload(session: OsceSession) {
  const enc = session.encounter;
  if (!enc) throw new Error('No station encounter to mark.');
  const transcript = getLastTranscript(enc.case.id);
  const base = buildSimpleDebriefPayload(enc, transcript);
  const end = session.endedAt ?? Date.now();
  return {
    ...base,
    // The bell is captured after the goodbye line, so cap at the station length.
    elapsedSeconds: Math.min(Math.round(session.durationMs / 1000), Math.round((end - (session.startedAt ?? enc.arrivedAt)) / 1000)),
    stationSeconds: Math.round(session.durationMs / 1000),
    rubric: prettyRubric(session),
    coachAlerts: session.alerts.map((a: CoachAlert) => ({
      severity: a.severity,
      title: a.title,
      short: a.short,
      explanation: a.explanation,
    })),
  };
}

export async function requestOsceMarking(session: OsceSession, signal?: AbortSignal): Promise<OsceResult> {
  let r: Response;
  try {
    r = await fetch('/agent/debrief/osce', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildOscePayload(session)),
      signal,
    });
  } catch (err) {
    if ((err as { name?: string })?.name === 'AbortError') throw err;
    throw new Error('Marking backend unreachable, start backend/server.py on :8787.');
  }
  if (!r.ok) {
    const text = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`/agent/debrief/osce ${r.status}${text ? `: ${text}` : ''}`);
  }
  return normalizeOsceResult(await r.json());
}

export interface OsceMarkingState {
  status: 'idle' | 'marking' | 'done' | 'error';
  result: OsceResult | null;
  error: string | null;
  retry: () => void;
}

/** Marks the session once (per retry). Pass null to stay idle. */
export function useOsceMarking(session: OsceSession | null): OsceMarkingState {
  const [attempt, setAttempt] = useState(0);
  const [state, setState] = useState<Omit<OsceMarkingState, 'retry'>>({ status: 'idle', result: null, error: null });
  const sessionRef = useRef(session);
  sessionRef.current = session;
  const key = session ? `${session.caseId}:${session.endedAt ?? 0}` : '';

  useEffect(() => {
    const s = sessionRef.current;
    if (!s || !s.encounter) return;
    const ctl = new AbortController();
    let cancelled = false;
    const timer = window.setTimeout(() => ctl.abort(), TIMEOUT_MS);
    setState({ status: 'marking', result: null, error: null });
    requestOsceMarking(s, ctl.signal)
      .then((result) => {
        if (!cancelled) setState({ status: 'done', result, error: null });
      })
      .catch((err: unknown) => {
        if (cancelled) return;
        if (ctl.signal.aborted && (err as { name?: string })?.name === 'AbortError') {
          setState({ status: 'error', result: null, error: 'The examiner took too long to mark the station.' });
          return;
        }
        setState({ status: 'error', result: null, error: err instanceof Error ? err.message : String(err) });
      })
      .finally(() => window.clearTimeout(timer));
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      ctl.abort();
    };
  }, [key, attempt]);

  const retry = useCallback(() => setAttempt((a) => a + 1), []);
  return { ...state, retry };
}
