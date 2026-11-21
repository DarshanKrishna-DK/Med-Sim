/**
 * Consultation result to Telegram: destination rules, payload shape, partial-part note.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { buildResultPayload, isTelegramDest, partialNote, resultDestination } from '../../src/agents/resultSend.ts';

test('telegram destinations', () => {
  for (const ok of ['telegram', 'TG', 'tg:12345', 'tg:-100123', '@dr_demo']) assert.ok(isTelegramDest(ok), ok);
  for (const bad of ['', '+919876543210', 'a@b.com', '@x', "tg:abc'"]) assert.ok(!isTelegramDest(bad), bad);
});

test('profile field wins, else a Telegram-style patient contact, else nothing', () => {
  assert.equal(resultDestination('@dr_demo', 'telegram'), '@dr_demo');
  assert.equal(resultDestination('', 'tg:42'), 'tg:42');
  assert.equal(resultDestination('', '+919876543210'), '');
  assert.equal(resultDestination(undefined, ''), '');
});

test('payload is clean and bounded', () => {
  const p = buildResultPayload({
    to: ' telegram ',
    profile: { name: 'Ananya Rao', university: 'RGUHS' },
    caseId: 'gm-01',
    caseTitle: 'Ravi Kumar, 45M',
    patientName: 'Ravi Kumar',
    chiefComplaint: 'Fever — 3 days',
    verdict: 'Good',
    domains: [{ name: 'History', score: 8, max: 10 }, { name: 'Bad', score: Number.NaN, max: 10 }],
    strengths: ['a', '', 'b'],
    improvements: [],
    diagnosisChosen: 'Malaria',
    diagnosisCorrect: 'Malaria',
    diagnosisIsCorrect: true,
    score: null,
  });
  assert.equal(p.to, 'telegram');
  assert.equal(p.case.chiefComplaint, 'Fever - 3 days');
  assert.equal(p.evaluation.domain_scores.length, 1);
  assert.deepEqual(p.evaluation.strengths, ['a', 'b']);
  assert.equal(p.evaluation.score, undefined);
  assert.deepEqual(p.evaluation.diagnosis, { chosen: 'Malaria', correct: 'Malaria', isCorrect: true });
  assert.equal(p.lang, 'en');
  assert.ok(!JSON.stringify(p).includes('—'));
});

test('partial note lists missing optional parts', () => {
  assert.equal(partialNote({ text: { ok: true }, document: { ok: true }, audio: { ok: false, skipped: true } }), null);
  assert.equal(partialNote({ text: { ok: true }, document: { ok: false }, audio: { ok: false } }), 'PDF and voice not sent');
});
