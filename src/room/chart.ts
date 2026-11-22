// Chart transitions for the seated patient (pure, no runtime imports, so the
// Node test runner can load it). The store delegates here.
//
// `prescriptions` only ever holds drugs that are really on the prescription.
// A drug the pharmacist is checking or holding lives in `rxReview`, so every
// consumer of `prescriptions` (print, voice prescription, send, debrief) is
// safe by construction.

import type { ActivePatient, RxReview } from '../game/types';
import type { Delegation, RoomTestResult } from './types';

type P = ActivePatient;

export interface RxLine {
  medicationId: string;
  dose: string;
  duration: string;
}

/** Stable id of one seated patient's encounter, safe in a URL path. */
export function encounterIdOf(p: { case: { id: string }; arrivedAt: number }): string {
  return `${p.case.id.replace(/[^A-Za-z0-9_-]+/g, '-')}-${p.arrivedAt}`;
}

export const pendingTestIds = (p: P): string[] => p.orderedTestIds.filter((t) => !p.completedTestIds.includes(t));

/** Pending results, pharmacy checks and holds: what End consultation asks about. */
export function pendingCounts(p: P): { results: number; checks: number; holds: number } {
  const review = p.rxReview ?? [];
  return {
    results: pendingTestIds(p).length,
    checks: review.filter((r) => r.status === 'verifying').length,
    holds: review.filter((r) => r.status === 'held').length,
  };
}

/** Order a test. `pending`: the result will arrive from the department. */
export function orderTest(p: P, testId: string, pending: boolean, now: number): P {
  if (p.orderedTestIds.includes(testId)) return p;
  return {
    ...p,
    orderedTestIds: [...p.orderedTestIds, testId],
    testOrderedAt: { ...p.testOrderedAt, [testId]: now },
    completedTestIds: pending ? p.completedTestIds : [...p.completedTestIds, testId],
  };
}

/** Results from a department: completes the tests and keeps the returned text. */
export function completeTests(p: P, results: readonly RoomTestResult[], now: number): P {
  let next = p;
  for (const r of results) {
    next = orderTest(next, r.testId, true, now);
    next = {
      ...next,
      completedTestIds: next.completedTestIds.includes(r.testId) ? next.completedTestIds : [...next.completedTestIds, r.testId],
      testReports: {
        ...next.testReports,
        [r.testId]: { text: r.result, abnormal: r.abnormal, critical: r.critical, at: now },
      },
    };
  }
  return next;
}

/** Cancel tests that have no result yet. A reported test cannot be undone. */
export function cancelTests(p: P, testIds: readonly string[]): P {
  const drop = new Set(testIds.filter((t) => p.orderedTestIds.includes(t) && !p.completedTestIds.includes(t)));
  if (!drop.size) return p;
  const testOrderedAt = { ...p.testOrderedAt };
  for (const t of drop) delete testOrderedAt[t];
  return { ...p, orderedTestIds: p.orderedTestIds.filter((t) => !drop.has(t)), testOrderedAt };
}

/** Put a drug on the prescription. Same drug again = same line (updated if the
 *  dose changed), never a duplicate. Clears any pending review of that drug. */
export function addPrescription(p: P, rx: RxLine, now: number): P {
  const line: RxLine = { medicationId: rx.medicationId, dose: rx.dose, duration: rx.duration };
  const list = p.prescriptions ?? [];
  const review = (p.rxReview ?? []).filter((r) => r.medicationId !== line.medicationId);
  const base: P = review.length !== (p.rxReview ?? []).length ? { ...p, rxReview: review } : p;
  const at = list.findIndex((x) => x.medicationId === line.medicationId);
  if (at < 0) return { ...base, prescriptions: [...list, { ...line, prescribedAt: now }] };
  const old = list[at];
  if (old.dose === line.dose && old.duration === line.duration) return base;
  const prescriptions = list.slice();
  prescriptions[at] = { ...line, prescribedAt: now };
  return { ...base, prescriptions };
}

/** Take a drug off: from the prescription and from any pharmacy review. */
export function removePrescription(p: P, medicationId: string): P {
  const list = p.prescriptions ?? [];
  const review = p.rxReview ?? [];
  const nextList = list.filter((x) => x.medicationId !== medicationId);
  const nextReview = review.filter((x) => x.medicationId !== medicationId);
  if (nextList.length === list.length && nextReview.length === review.length) return p;
  return { ...p, prescriptions: nextList, rxReview: nextReview };
}

/** Track a drug the pharmacist is checking or holding (upsert by drug). */
export function reviewPrescription(p: P, r: RxReview): P {
  const list = p.rxReview ?? [];
  const at = list.findIndex((x) => x.medicationId === r.medicationId);
  if (at < 0) return { ...p, rxReview: [...list, r] };
  const old = list[at];
  const merged: RxReview = { ...old, ...r };
  if (old.status === merged.status && old.ref === merged.ref && old.reason === merged.reason && old.dose === merged.dose) return p;
  const rxReview = list.slice();
  rxReview[at] = merged;
  return { ...p, rxReview };
}

/** Pharmacist recall of a drug that had already been released. */
export function recallPrescription(p: P, medicationId: string, reason: string, ref: string, now: number): P {
  const same = (x: { medicationId: string }) => x.medicationId === medicationId;
  const was = (p.prescriptions ?? []).find(same) ?? (p.rxReview ?? []).find(same);
  if (!was) return p;
  const next = removePrescription(p, medicationId);
  return reviewPrescription(next, {
    ref,
    medicationId,
    dose: was.dose,
    duration: was.duration,
    status: 'held',
    reason,
    at: now,
  });
}

/** Mirror a delegation onto the chart: which tests are out, which drugs are
 *  being checked or held. Releases and results only ever come from `apply`. */
export function applyDelegation(p: P, d: Delegation, now: number, first = true): P {
  if (d.action === 'run_test' || d.action === 'run_imaging') {
    const ids = d.testIds ?? [];
    if (d.status === 'cancelled') return cancelTests(p, ids);
    // Ordered once, when the hand-off is first seen: a test the department
    // could not run was taken off by `apply` and must not come back.
    if (!first) return p;
    return ids.reduce((acc, t) => orderTest(acc, t, true, now), p);
  }
  if (d.action !== 'verify_rx' || !d.medicationId) return p;
  const review = p.rxReview ?? [];
  const mine = review.find((r) => r.medicationId === d.medicationId);
  const without = () => ({ ...p, rxReview: review.filter((r) => r !== mine) });
  // Only the review this delegation opened; an active line stays.
  if (d.status === 'cancelled') return mine && mine.ref === d.ref ? without() : p;
  // The release itself arrives as `apply`. Nothing left to review.
  if (d.status === 'done' || d.status === 'overridden') return mine && mine.ref === d.ref && mine.status === 'verifying' ? without() : p;
  const status: RxReview['status'] = d.status === 'held' ? 'held' : 'verifying';
  if (status === 'verifying') {
    // Already released (its `apply` arrived first): never drag it back to "checking".
    if ((p.prescriptions ?? []).some((x) => x.medicationId === d.medicationId)) return p;
    // A newer check of the same drug owns the line; an older one is history.
    if (mine && mine.ref !== d.ref && mine.at > Date.parse(d.startedAt)) return p;
  }
  return reviewPrescription(p, {
    ref: d.ref,
    medicationId: d.medicationId,
    dose: d.dose ?? mine?.dose ?? '',
    duration: d.duration ?? mine?.duration ?? '',
    status,
    reason: status === 'held' ? d.summary ?? mine?.reason ?? '' : undefined,
    at: now,
  });
}

/** What the trainee can see for a test: the department's text, or the case's
 *  own text in legacy mode, or null while it is pending. */
export function visibleResult(
  p: P,
  testId: string,
  legacy: (testId: string, caseText: string | undefined, abnormal: boolean) => { text: string; abnormal: boolean },
): { text: string; abnormal: boolean; critical: boolean } | null {
  if (!p.completedTestIds.includes(testId)) return null;
  const back = p.testReports?.[testId];
  if (back) return { text: back.text, abnormal: back.abnormal, critical: back.critical };
  const c = p.case.testResults.find((r) => r.testId === testId);
  return { ...legacy(testId, c?.result, !!c?.abnormal), critical: false };
}
