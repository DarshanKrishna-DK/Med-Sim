/**
 * Tests for Nurse Asha's local (LLM-free) mistake rules in
 * `src/agents/coachRules.ts`: nurse steps that were refused or flagged
 * become alerts immediately; clinical utterance detection is conservative.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { activeAlert, alertsFromNurseRun, looksClinicalUtterance } from '../../src/agents/coachRules.ts';
import type { NurseRun } from '../../src/game/types.ts';

function run(steps: NurseRun['steps'], applied: NurseRun['applied'] = { orderedTestIds: [], prescriptions: [] }): NurseRun {
  return {
    id: 'r1', caseId: 'case-1', utterance: 'start amoxicillin', source: 'typed', status: 'done',
    startedAt: 0, finishedAt: 1, intent: 'order', steps, applied,
  };
}

test('refused prescription for allergy becomes a danger alert', () => {
  const alerts = alertsFromNurseRun(run([
    { tool: 'check_allergies_and_interactions', args: { medicationId: 'amoxicillin' }, ok: true, summary: 'x',
      result: { ok: true, safe: false, hardConflicts: ['documented allergy (penicillin class) conflicts with Amoxicillin'], warnings: [] } },
    { tool: 'prescribe', args: { medicationId: 'amoxicillin' }, ok: false, summary: 'Refused amoxicillin',
      result: { ok: false, refused: true, reason: 'documented allergy (penicillin class) conflicts with Amoxicillin' } },
  ]));
  assert.equal(alerts.length, 1, 'same title is collapsed');
  assert.equal(alerts[0].severity, 'danger');
  assert.equal(alerts[0].title, 'Allergy conflict');
  assert.equal(alerts[0].source, 'nurse');
  assert.equal(alerts[0].caseId, 'case-1');
  assert.ok(alerts[0].short.split(' ').length <= 19);
});

test('interaction warnings become a warning alert, "already prescribed" does not', () => {
  const warn = alertsFromNurseRun(run([
    { tool: 'prescribe', args: { medicationId: 'ibuprofen' }, ok: true, summary: 'Prescribed',
      result: { ok: true, warnings: ['NSAID/aspirin with an anticoagulant raises bleeding risk'] } },
  ]));
  assert.equal(warn[0]?.severity, 'warning');
  const none = alertsFromNurseRun(run([
    { tool: 'prescribe', args: { medicationId: 'ibuprofen' }, ok: true, summary: 'Prescribed',
      result: { ok: true, warnings: ['already prescribed this encounter'] } },
  ]));
  assert.deepEqual(none, []);
});

test('failed catalog lookup is ignored when the run still applied something', () => {
  const steps: NurseRun['steps'] = [
    { tool: 'find_in_catalog', args: { query: 'blood count' }, ok: false, summary: 'Found: nothing', result: { ok: false } },
  ];
  assert.deepEqual(alertsFromNurseRun(run(steps, { orderedTestIds: ['cbc'], prescriptions: [] })), []);
  const alone = alertsFromNurseRun(run(steps));
  assert.equal(alone[0]?.severity, 'info');
});

test('runs that are not orders or not done raise nothing', () => {
  const r = run([{ tool: 'prescribe', args: {}, ok: false, summary: 'x', result: { refused: true, reason: 'allergy' } }]);
  assert.deepEqual(alertsFromNurseRun({ ...r, intent: 'none' }), []);
  assert.deepEqual(alertsFromNurseRun({ ...r, status: 'running' }), []);
});

test('clinical utterance detection skips questions and small talk', () => {
  assert.equal(looksClinicalUtterance("I think it's just a viral infection, no need for tests"), true);
  assert.equal(looksClinicalUtterance('Do you have any allergies to antibiotics?'), false);
  assert.equal(looksClinicalUtterance('Good morning, how are you'), false);
});

test('activeAlert returns the newest undismissed alert', () => {
  const base = { caseId: 'c', title: 't', short: 's', explanation: 'e', suggestion: '', source: 'coach' as const, createdAt: 0 };
  const a = { ...base, id: 'a', severity: 'danger' as const };
  const b = { ...base, id: 'b', severity: 'info' as const, dismissed: true };
  assert.equal(activeAlert([a, b])?.id, 'a');
  assert.equal(activeAlert([{ ...a, dismissed: true }]), null);
});
