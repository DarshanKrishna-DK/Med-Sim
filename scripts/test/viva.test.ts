/**
 * Viva voce: question counter, plan/grade normalisers, history row and the
 * examiner persona (one question at a time, hidden plan, language rule).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  VIVA_SUBJECTS,
  advanceQuestion,
  askHistory,
  formatClock,
  gradeTranscript,
  isClosingLine,
  matchQuestion,
  normalizeGrade,
  normalizePlan,
  scoreBand,
  vivaCaseId,
  type SavedViva,
  type VivaQuestion,
} from '../../src/components/viva/vivaCore.ts';
import { vivaHistoryPayload } from '../../src/components/viva/vivaHistory.ts';
import { buildVivaPersona, buildVivaPlanPrompt, examinerGreeting, timeUpLine } from '../../src/voice/vivaPersona.ts';

const PLAN: VivaQuestion[] = [
  { id: 'q1', q: 'Classify cholinergic drugs.', keyPoints: ['Direct acting', 'Anticholinesterases'], difficulty: 1, followUps: ['Examples?'] },
  { id: 'q2', q: 'What is the mechanism of action of atropine?', keyPoints: ['Competitive muscarinic antagonist'], difficulty: 1, followUps: [] },
  { id: 'q3', q: 'Why is neostigmine preferred over physostigmine in myasthenia gravis?', keyPoints: ['Quaternary', 'Direct NM action'], difficulty: 2, followUps: [] },
  { id: 'q4', q: 'Name two uses of beta blockers in thyrotoxicosis.', keyPoints: ['Tremor', 'Tachycardia'], difficulty: 3, followUps: [] },
];

test('every MBBS subject has topics and a valid year', () => {
  const ids = VIVA_SUBJECTS.map((s) => s.id);
  for (const id of ['anatomy', 'physiology', 'biochemistry', 'pharmacology', 'pathology', 'microbiology', 'forensic-medicine', 'community-medicine', 'medicine', 'surgery', 'obg', 'paediatrics']) {
    assert.ok(ids.includes(id), id);
  }
  for (const s of VIVA_SUBJECTS) {
    assert.ok(s.topics.length >= 5, s.id);
    assert.ok(['1', '2', '3', '4', 'intern'].includes(s.year));
  }
});

test('matchQuestion finds the plan question the examiner is asking', () => {
  assert.equal(matchQuestion('Hmm. Tell me, what is the mechanism of action of atropine?', PLAN, 0), 1);
  assert.equal(matchQuestion('Very good. Why neostigmine and not physostigmine in myasthenia?', PLAN, 2), 2);
  assert.equal(matchQuestion('Hmm, go on.', PLAN, 0), -1);
  // Never looks backwards.
  assert.equal(matchQuestion('Classify cholinergic drugs.', PLAN, 1), -1);
});

test('advanceQuestion only moves forward', () => {
  let cur = -1;
  cur = advanceQuestion(cur, 'Let us start. Classify cholinergic drugs.', PLAN);
  assert.equal(cur, 0);
  cur = advanceQuestion(cur, 'Examples?', PLAN);
  assert.equal(cur, 0);
  cur = advanceQuestion(cur, 'Very good. Next question. Something unrelated?', PLAN);
  assert.equal(cur, 1);
  cur = advanceQuestion(cur, 'Classify cholinergic drugs again.', PLAN);
  assert.equal(cur, 1);
  cur = advanceQuestion(cur, 'Name two uses of beta blockers in thyrotoxicosis.', PLAN);
  assert.equal(cur, 3);
  cur = advanceQuestion(cur, 'Next question.', PLAN);
  assert.equal(cur, 3, 'capped at the last question');
  // Hindi line with the English marker still counts.
  assert.equal(advanceQuestion(0, 'ठीक है। Next question. एट्रोपिन क्या करता है?', PLAN), 1);
  // A greeting-style question does not start question 1.
  assert.equal(advanceQuestion(-1, 'Shall we begin?', PLAN), -1);
});

test('closing line and clock formatting', () => {
  assert.ok(isClosingLine('Okay, time is up. Thank you. That will be all.'));
  assert.ok(isClosingLine('धन्यवाद। That will be all.'));
  assert.ok(!isClosingLine('Is that all?'));
  assert.equal(formatClock(6 * 60 * 1000), '6:00');
  assert.equal(formatClock(61_500), '1:02');
  assert.equal(formatClock(-5), '0:00');
});

test('normalizePlan and normalizeGrade are defensive', () => {
  const plan = normalizePlan({ questions: [...PLAN, { q: 'no key points', keyPoints: [] }, null, { q: 'x', keyPoints: ['y'], difficulty: 9 }] });
  assert.equal(plan.length, 5);
  assert.equal(plan[4].difficulty, 2);
  assert.deepEqual(normalizePlan('nope'), []);
  assert.equal(normalizeGrade({ score: 50 }), null);
  const g = normalizeGrade({
    score: 140,
    perQuestion: [{ id: 'q1', verdict: 'correct', said: 'two types', expected: 'x' }, { id: 'q2', verdict: 'weird' }],
    strengths: ['a'],
    gaps: 'not a list',
  });
  assert.ok(g);
  assert.equal(g.score, 100);
  assert.equal(g.perQuestion[1].verdict, 'not asked');
  assert.equal(g.asked, 1);
  assert.deepEqual(g.gaps, []);
});

test('transcripts for grading and for the typed examiner', () => {
  const lines = [
    { who: 'examiner' as const, text: 'Good morning. Shall we begin?', at: 0 },
    { who: 'student' as const, text: 'Yes sir.', at: 1000 },
    { who: 'student' as const, text: 'Ready.', at: 1500 },
    { who: 'examiner' as const, text: 'Classify cholinergic drugs.', at: 2000 },
    { who: 'student' as const, text: '  ', at: 2500 },
  ];
  assert.deepEqual(gradeTranscript(lines).map((l) => l.role), ['examiner', 'student', 'student', 'examiner']);
  const h = askHistory(lines);
  assert.equal(h[0].role, 'user');
  assert.equal(h[0].content, 'Yes sir.\nReady.');
  assert.equal(h[1].role, 'assistant');
  assert.equal(h.length, 2);
});

test('history row is a regular evaluation with mode viva', () => {
  const saved: SavedViva = {
    score: 62,
    asked: 3,
    total: 4,
    perQuestion: [
      { id: 'q1', q: PLAN[0].q, difficulty: 1, verdict: 'correct', expected: 'Direct and indirect', said: 'direct and indirect acting', note: '' },
      { id: 'q2', q: PLAN[1].q, difficulty: 1, verdict: 'partial', expected: 'Muscarinic antagonist', said: 'it blocks', note: '' },
      { id: 'q3', q: PLAN[2].q, difficulty: 2, verdict: 'incorrect', expected: 'Quaternary', said: '', note: '' },
      { id: 'q4', q: PLAN[3].q, difficulty: 3, verdict: 'not asked', expected: 'Tremor', said: '', note: '' },
    ],
    strengths: ['Classification'],
    gaps: ['Anticholinesterases'],
    recommendedReading: ['KD Tripathi, Essentials of Medical Pharmacology: Cholinergic system'],
    examinerComment: 'Fair.',
    subjectId: 'pharmacology',
    subject: 'Pharmacology',
    topic: 'Autonomic drugs',
    year: '2',
    lang: 'en',
    durationSec: 300,
    transcript: [],
  };
  const row = vivaHistoryPayload(saved, 1_000_000);
  assert.equal(row.mode, 'viva');
  assert.equal(row.subject, 'Pharmacology');
  assert.equal(row.score, 62);
  assert.equal(row.verdict, scoreBand(62));
  assert.equal(row.caseId, vivaCaseId(saved));
  assert.equal(row.caseId, 'viva:pharmacology:autonomic-drugs');
  assert.equal(row.evaluation.criteria.length, 3, 'not-asked questions are not criteria');
  assert.deepEqual(row.evaluation.domain_scores.data_gathering, { raw: 1.5, max: 2, verdict: 'good' });
  assert.equal(row.evaluation.domain_scores.clinical_management.raw, 0);
  assert.deepEqual(row.skillScores, { reasoning: 62 });
  assert.equal(row.patientSnapshot.arrivedAt, 1_000_000 - 300_000);
  assert.ok(row.viva);
});

test('examiner persona: one question at a time, hidden plan, language', () => {
  const setup = { subjectId: 'pharmacology', subject: 'Pharmacology', topic: 'Autonomic drugs', year: '2nd year MBBS', lang: 'en' as const };
  const base = buildVivaPersona(setup);
  assert.match(base, /ONE question per turn/);
  assert.match(base, /NEVER lecture/);
  assert.match(base, /Next question/);
  assert.match(base, /That will be all\./);
  assert.doesNotMatch(base, /HIDDEN QUESTION PLAN/);
  const withPlan = buildVivaPlanPrompt(setup, PLAN);
  assert.match(withPlan, /HIDDEN QUESTION PLAN \(4 questions/);
  assert.ok(withPlan.includes('Competitive muscarinic antagonist'));
  const hi = buildVivaPlanPrompt({ ...setup, lang: 'hi' }, PLAN);
  assert.match(hi, /whole viva in Hindi/);
  assert.match(hi, /Devanagari/);
  assert.match(examinerGreeting(setup), /Pharmacology viva, on Autonomic drugs/);
  assert.ok(isClosingLine(timeUpLine('hi')));
  assert.ok(isClosingLine(timeUpLine('kn')));
  for (const s of [base, withPlan, hi, examinerGreeting(setup)]) assert.ok(!s.includes(String.fromCharCode(0x2014)), 'no em dashes');
});
