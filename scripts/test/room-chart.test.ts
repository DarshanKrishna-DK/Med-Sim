/** BAND agent room: the chart transitions the store applies (pending, hold, recall). */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  addPrescription,
  applyDelegation,
  cancelTests,
  completeTests,
  encounterIdOf,
  orderTest,
  pendingCounts,
  recallPrescription,
  removePrescription,
  visibleResult,
} from '../../src/room/chart.ts';
import { diffChart } from '../../src/observer/chartEvents.ts';
import type { ActivePatient } from '../../src/game/types.ts';
import type { Delegation } from '../../src/room/types.ts';

const patient = (): ActivePatient =>
  ({
    case: { id: 'im/001', testResults: [{ testId: 'cbc', result: 'Case text', abnormal: true }] },
    arrivedAt: 5,
    orderedTestIds: [],
    testOrderedAt: {},
    completedTestIds: [],
    askedQuestionIds: [],
    givenTreatmentIds: [],
    submittedDiagnosisId: null,
  }) as unknown as ActivePatient;

const del = (over: Partial<Delegation> = {}): Delegation => ({
  ref: 'rx_1',
  action: 'verify_rx',
  target: 'pharmacist',
  status: 'sent',
  label: 'Amoxicillin',
  startedAt: new Date(100).toISOString(),
  medicationId: 'amoxicillin',
  dose: '500 mg',
  duration: '7 days',
  ...over,
});
const rx = { medicationId: 'amoxicillin', dose: '500 mg', duration: '7 days' };
const legacy = (_id: string, text: string | undefined, abnormal: boolean) => ({ text: text ?? 'Normal', abnormal });

test('encounter id is per seating and safe in a URL', () => {
  assert.equal(encounterIdOf(patient()), 'im-001-5');
});

test('legacy order completes at once; room order stays pending until results', () => {
  const instant = orderTest(patient(), 'cbc', false, 10);
  assert.deepEqual(visibleResult(instant, 'cbc', legacy), { text: 'Case text', abnormal: true, critical: false });

  let p = orderTest(patient(), 'cbc', true, 10);
  assert.equal(visibleResult(p, 'cbc', legacy), null);
  assert.equal(pendingCounts(p).results, 1);
  p = completeTests(p, [{ testId: 'cbc', name: 'CBC', result: 'Hb 6.1', abnormal: true, critical: true }], 20);
  assert.deepEqual(visibleResult(p, 'cbc', legacy), { text: 'Hb 6.1', abnormal: true, critical: true });
  assert.equal(pendingCounts(p).results, 0);
  // The nurse reply lands after the result: nothing goes back to pending.
  assert.equal(orderTest(p, 'cbc', true, 30), p);
});

test('a result that beats the order response still lands', () => {
  const p = completeTests(patient(), [{ testId: 'crp', name: 'CRP', result: '90', abnormal: true, critical: false }], 20);
  assert.deepEqual([p.orderedTestIds, p.completedTestIds], [['crp'], ['crp']]);
});

test('cancel only what has no result', () => {
  let p = orderTest(orderTest(patient(), 'cbc', true, 1), 'crp', true, 2);
  p = completeTests(p, [{ testId: 'cbc', name: 'CBC', result: 'ok', abnormal: false, critical: false }], 3);
  p = cancelTests(p, ['cbc', 'crp']);
  assert.deepEqual(p.orderedTestIds, ['cbc']);
  assert.equal('crp' in p.testOrderedAt, false);
});

test('a test the department could not run does not come back with the next status', () => {
  const d = del({ ref: 'lab_1', action: 'run_test', target: 'lab', medicationId: undefined, testIds: ['cbc', 'odd'] });
  let p = applyDelegation(patient(), d, 1, true);
  assert.deepEqual(p.orderedTestIds, ['cbc', 'odd']);
  p = cancelTests(p, ['odd']);
  p = applyDelegation(p, { ...d, status: 'done' }, 2, false);
  assert.deepEqual(p.orderedTestIds, ['cbc']);
});

test('a held drug is never on the prescription; override puts it there', () => {
  let p = applyDelegation(patient(), del(), 110);
  assert.equal(p.rxReview?.[0].status, 'verifying');
  assert.equal(p.prescriptions, undefined);
  p = applyDelegation(p, del({ status: 'held', summary: 'Penicillin allergy' }), 120);
  assert.deepEqual([p.rxReview?.[0].status, p.rxReview?.[0].reason], ['held', 'Penicillin allergy']);
  assert.equal((p.prescriptions ?? []).length, 0);
  p = applyDelegation(p, del({ status: 'overridden' }), 130);
  p = addPrescription(p, rx, 131);
  assert.equal(p.prescriptions?.length, 1);
  assert.equal(p.rxReview?.length, 0);
});

test('release arriving before a late "working" event is not dragged back', () => {
  let p = addPrescription(patient(), rx, 100);
  p = applyDelegation(p, del({ status: 'working' }), 110);
  assert.equal(p.prescriptions?.length, 1);
  assert.equal(p.rxReview ?? null, null);
});

test('re-ordering a held drug goes back to checking', () => {
  let p = applyDelegation(patient(), del({ status: 'held', summary: 'dose too high' }), 120);
  p = applyDelegation(p, del({ ref: 'rx_2', dose: '250 mg', startedAt: new Date(500).toISOString() }), 501);
  const r = p.rxReview ?? [];
  assert.deepEqual([r.length, r[0].status, r[0].ref, r[0].reason], [1, 'verifying', 'rx_2', undefined]);
});

test('prescriptions dedupe: same line is a no-op, a new dose updates it', () => {
  const p = addPrescription(patient(), rx, 1);
  assert.equal(addPrescription(p, rx, 2), p);
  const q = addPrescription(p, { ...rx, dose: '250 mg' }, 3);
  assert.deepEqual(q.prescriptions?.map((x) => [x.dose, x.prescribedAt]), [['250 mg', 3]]);
});

test('recall takes a released drug off and shows it held; stop just removes it', () => {
  const p = addPrescription(patient(), rx, 1);
  const r = recallPrescription(p, 'amoxicillin', 'K 6.8', 'rx_9', 50);
  assert.equal(r.prescriptions?.length, 0);
  assert.deepEqual([r.rxReview?.[0].status, r.rxReview?.[0].reason, r.rxReview?.[0].dose], ['held', 'K 6.8', '500 mg']);
  const s = removePrescription(p, 'amoxicillin');
  assert.equal(s.prescriptions?.length, 0);
  assert.equal((s.rxReview ?? []).length, 0);
  assert.equal(recallPrescription(patient(), 'nope', 'x', 'r', 1).rxReview, undefined);
});

test('observer feed: result back, held, taken off, and a swap of equal length', () => {
  const labels = { test: (x: string) => x, medication: (x: string) => x, diagnosis: (x: string) => x, exam: (x: string) => x };
  const slice = (p: ActivePatient) => ({ patient: p, coachAlerts: [], agentRuns: [] });
  let a = orderTest(addPrescription(patient(), rx, 1), 'cbc', true, 1);
  let b = completeTests(a, [{ testId: 'cbc', name: 'CBC', result: 'Hb 6', abnormal: true, critical: true }], 2);
  assert.deepEqual(diffChart(slice(a), slice(b), labels, 9).map((e) => e.label), ['Result: cbc (abnormal)']);
  a = b;
  b = addPrescription(recallPrescription(a, 'amoxicillin', 'allergy', 'rx_9', 3), { medicationId: 'azithromycin', dose: '500 mg', duration: '3 days' }, 4);
  assert.deepEqual(diffChart(slice(a), slice(b), labels, 9).map((e) => e.label), [
    'Prescribed: azithromycin',
    'Taken off: amoxicillin',
    'Held by pharmacy: amoxicillin',
  ]);
});
