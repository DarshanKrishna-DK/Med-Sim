/**
 * Teacher assignment helpers (`src/assignments/core.ts`): code parsing,
 * item matching, progress, chip label and the reception prefilter. Pure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  assignedCaseIds,
  chipLabel,
  computeAssignmentProgress,
  formatDue,
  itemMatches,
  looksLikeReceptionRequest,
  parseAssignmentCode,
  type Assignment,
  type LocalAttemptRecord,
} from '../../src/assignments/core.ts';

const A: Assignment = {
  code: 'AB3K9Q',
  title: 'Week 3',
  dueDate: '2026-11-30',
  teacherName: 'Dr. Rao',
  passMark: 60,
  createdAt: 0,
  items: [
    { id: 'case:c1', kind: 'case', caseId: 'c1', subject: null, label: 'Ravi', specialty: 'Cardiology' },
    { id: 'case:c2', kind: 'case', caseId: 'c2', subject: null, label: 'Meena', specialty: 'Pulmonology' },
    { id: 'osce:any', kind: 'osce', caseId: null, subject: null, label: 'OSCE station', specialty: 'OSCE' },
    { id: 'viva:pharmacology', kind: 'viva', caseId: null, subject: 'Pharmacology', label: 'Viva: Pharmacology', specialty: null },
  ],
};

const att = (o: Partial<LocalAttemptRecord>): LocalAttemptRecord => ({ clientId: 'x', caseId: 'c1', kind: 'case', subject: null, score: 70, at: 1, ...o });
const NOV_21 = new Date(2026, 10, 21, 12).getTime();
const DEC_02 = new Date(2026, 11, 2, 12).getTime();

test('parseAssignmentCode accepts the unambiguous alphabet only', () => {
  assert.equal(parseAssignmentCode('?assignment=ab3k9q'), 'AB3K9Q');
  assert.equal(parseAssignmentCode('?x=1&assignment=AB3K9Q'), 'AB3K9Q');
  assert.equal(parseAssignmentCode('?assignment=AB0K9Q'), null); // 0 is excluded
  assert.equal(parseAssignmentCode('?assignment=AB3K9'), null);
  assert.equal(parseAssignmentCode('?observe=abc'), null);
});

test('itemMatches: case items accept practice or OSCE on that case; viva matches subject', () => {
  assert.ok(itemMatches(A.items[0], att({})));
  assert.ok(itemMatches(A.items[0], att({ kind: 'osce' })));
  assert.ok(!itemMatches(A.items[0], att({ caseId: 'c2' })));
  assert.ok(itemMatches(A.items[2], att({ kind: 'osce', caseId: 'zz' })));
  assert.ok(!itemMatches(A.items[2], att({ kind: 'case' })));
  assert.ok(itemMatches(A.items[3], att({ kind: 'viva', subject: 'pharmacology' })));
  assert.ok(!itemMatches(A.items[3], att({ kind: 'viva', subject: 'Anatomy' })));
});

test('computeAssignmentProgress: best score per item, average, pass and overdue', () => {
  const empty = computeAssignmentProgress(A, [], NOV_21);
  assert.equal(empty.done, 0);
  assert.equal(empty.total, 4);
  assert.equal(empty.average, null);
  assert.equal(empty.passed, false);
  assert.equal(empty.overdue, false);

  const some = computeAssignmentProgress(A, [att({ score: 50 }), att({ score: 80 }), att({ kind: 'osce', caseId: 'c9', score: 64 })], NOV_21);
  // c1 best of 50/80, and the OSCE on another case counts for "any OSCE station".
  assert.equal(some.done, 2);
  assert.deepEqual(some.doneIds, ['case:c1', 'osce:any']);
  assert.deepEqual(some.pending.map((i) => i.id), ['case:c2', 'viva:pharmacology']);
  assert.equal(some.average, 72);
  assert.equal(computeAssignmentProgress(A, [att({ score: 50 })], DEC_02).overdue, true);
});

test('computeAssignmentProgress: all done and over the pass mark passes', () => {
  const all = [
    att({ score: 80 }),
    att({ caseId: 'c2', score: 60 }),
    att({ kind: 'osce', caseId: 'c1', score: 70 }),
    att({ kind: 'viva', caseId: 'v', subject: 'Pharmacology', score: 50 }),
  ];
  const p = computeAssignmentProgress(A, all, NOV_21);
  assert.equal(p.done, 4);
  assert.equal(p.average, 65);
  assert.equal(p.passed, true);
  assert.equal(computeAssignmentProgress({ ...A, passMark: 70 }, all, NOV_21).passed, false);
});

test('chip label, due formatting and assigned case ids', () => {
  const p = computeAssignmentProgress(A, [att({})], NOV_21);
  assert.equal(chipLabel(A, p), 'Assignment: Week 3 (1/4 done, due 30 Nov)');
  assert.equal(formatDue(null), 'no due date');
  assert.deepEqual([...assignedCaseIds(A)], ['c1', 'c2']);
  assert.equal(assignedCaseIds(null).size, 0);
});

test('looksLikeReceptionRequest gates the desk agent', () => {
  assert.ok(looksLikeReceptionRequest('Can you email my report to my teacher?'));
  assert.ok(looksLikeReceptionRequest("what's pending on my assignment"));
  assert.ok(looksLikeReceptionRequest('How am I doing?'));
  assert.ok(!looksLikeReceptionRequest('Good morning Priya'));
});
