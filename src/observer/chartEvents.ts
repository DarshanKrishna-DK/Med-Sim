/**
 * Turns store changes on the seated patient into observer chart events
 * (`medsim.event`). Pure: label lookups are injected so `node --test` can
 * run it without the data catalogues.
 */

import type { ActivePatient, CoachAlert, NurseRun } from '../game/types';
import type { ChartEvent } from './messages';

export interface ChartSlice {
  patient: ActivePatient | null;
  coachAlerts: ReadonlyArray<CoachAlert>;
  agentRuns: ReadonlyArray<NurseRun>;
}

export interface ChartLabels {
  test: (id: string) => string;
  medication: (id: string) => string;
  diagnosis: (id: string) => string;
  exam: (system: string) => string;
}

const added = <T,>(prev: ReadonlyArray<T> | undefined, next: ReadonlyArray<T> | undefined): T[] => {
  const before = new Set(prev ?? []);
  return (next ?? []).filter((x) => !before.has(x));
};

/** Events between two snapshots of the same case. A different (or no)
 *  previous patient counts as an empty chart. */
export function diffChart(prev: ChartSlice, next: ChartSlice, labels: ChartLabels, now = Date.now()): ChartEvent[] {
  const out: ChartEvent[] = [];
  const p = next.patient;
  if (!p) return out;
  const was = prev.patient && prev.patient.case.id === p.case.id ? prev.patient : null;

  for (const id of added(was?.orderedTestIds, p.orderedTestIds)) {
    out.push({ kind: 'order', label: `Test ordered: ${labels.test(id)}`, at: now });
  }
  // Room mode: a department's result arrives after the order.
  for (const [id, r] of Object.entries(p.testReports ?? {})) {
    if (was?.testReports?.[id]) continue;
    out.push({
      kind: 'order',
      label: `Result: ${labels.test(id)}${r.abnormal ? ' (abnormal)' : ''}`,
      detail: r.text || undefined,
      severity: r.critical ? 'danger' : r.abnormal ? 'warning' : 'info',
      at: now,
    });
  }
  const line = (x: { medicationId: string; prescribedAt: number }) => `${x.medicationId}|${x.prescribedAt}`;
  const had = new Set((was?.prescriptions ?? []).map(line));
  for (const rx of (p.prescriptions ?? []).filter((x) => !had.has(line(x)))) {
    out.push({
      kind: 'prescription',
      label: `Prescribed: ${labels.medication(rx.medicationId)}`,
      detail: [rx.dose, rx.duration].filter(Boolean).join(', ') || undefined,
      at: now,
    });
  }
  const onRx = new Set((p.prescriptions ?? []).map((x) => x.medicationId));
  for (const rx of was?.prescriptions ?? []) {
    if (!onRx.has(rx.medicationId)) out.push({ kind: 'prescription', label: `Taken off: ${labels.medication(rx.medicationId)}`, severity: 'warning', at: now });
  }
  const heldBefore = new Set((was?.rxReview ?? []).filter((r) => r.status === 'held').map((r) => r.ref));
  for (const r of p.rxReview ?? []) {
    if (r.status !== 'held' || heldBefore.has(r.ref)) continue;
    out.push({ kind: 'prescription', label: `Held by pharmacy: ${labels.medication(r.medicationId)}`, detail: r.reason || undefined, severity: 'danger', at: now });
  }
  if (p.followUp && (!was?.followUp || was.followUp.inDays !== p.followUp.inDays || was.followUp.reason !== p.followUp.reason)) {
    out.push({ kind: 'followup', label: p.followUp.inDays === 0 ? 'Follow-up later today' : `Follow-up in ${p.followUp.inDays} days`, detail: p.followUp.reason || undefined, at: now });
  }
  for (const sys of added(was?.examsPerformed, p.examsPerformed)) {
    if (!p.examResults?.[sys]) out.push({ kind: 'exam', label: `Examining: ${labels.exam(sys)}`, at: now });
  }
  for (const [sys, res] of Object.entries(p.examResults ?? {})) {
    if (!res || was?.examResults?.[sys as keyof typeof p.examResults]) continue;
    const abnormal = res.findings.some((f) => f.abnormal);
    out.push({
      kind: 'exam',
      label: `Exam findings: ${labels.exam(sys)}${abnormal ? ' (abnormal)' : ''}`,
      detail: res.summary || undefined,
      severity: abnormal ? 'warning' : 'info',
      at: now,
    });
  }
  if (p.submittedDiagnosisId && p.submittedDiagnosisId !== was?.submittedDiagnosisId) {
    out.push({ kind: 'diagnosis', label: `Diagnosis submitted: ${labels.diagnosis(p.submittedDiagnosisId)}`, at: now });
  }

  const seenAlerts = new Set(prev.coachAlerts.map((a) => a.id));
  for (const a of next.coachAlerts) {
    if (seenAlerts.has(a.id) || a.caseId !== p.case.id) continue;
    out.push({ kind: 'alert', label: `Alert: ${a.title}`, detail: a.short || undefined, severity: a.severity, at: now });
  }

  const doneBefore = new Set(prev.agentRuns.filter((r) => r.status !== 'running').map((r) => r.id));
  for (const r of next.agentRuns) {
    if (r.status === 'running' || doneBefore.has(r.id) || r.caseId !== p.case.id || r.intent === 'none') continue;
    if (r.status === 'error') {
      out.push({ kind: 'nurse', label: `Nurse could not act on: "${r.utterance}"`, detail: r.error, severity: 'warning', at: now });
    } else if (r.applied || r.spokenConfirmation) {
      out.push({ kind: 'nurse', label: `Nurse executed: "${r.utterance}"`, detail: r.spokenConfirmation, at: now });
    }
  }
  for (const e of out) if (e.detail === undefined) delete e.detail;
  return out;
}

/** Everything already on the chart, for a late-joining observer. */
export function chartSoFar(slice: ChartSlice, labels: ChartLabels, at = Date.now()): ChartEvent[] {
  return diffChart({ patient: null, coachAlerts: [], agentRuns: [] }, slice, labels, at);
}
