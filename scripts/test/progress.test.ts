/**
 * Progress dashboard aggregation (`src/data/progress.ts`) and the OSCE
 * result normaliser (`src/agents/osceCore.ts`). Pure functions, no DOM.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  computeProgress,
  computeStreak,
  dayKey,
  entryScore,
  skillsFromDomainNames,
  type CatalogCase,
} from '../../src/data/progress.ts';
import { normalizeOsceResult, osceToEvaluation, ratingForScore, scoreItems } from '../../src/agents/osceCore.ts';
import type { EvalHistoryEntry } from '../../src/data/evalHistory.ts';

const at = (y: number, m: number, d: number, h = 10) => new Date(y, m - 1, d, h).getTime();

function dom(raw: number) {
  return { raw, max: 100, verdict: 'good' as const };
}

let seq = 0;
function entry(over: Partial<EvalHistoryEntry> & { caseId: string; savedAt: number }): EvalHistoryEntry {
  seq += 1;
  return {
    id: `e${seq}`,
    caseName: 'X',
    caseAge: 40,
    caseGender: 'F',
    diagnosisLabel: 'dx',
    verdict: 'good',
    evaluation: {
      case_id: over.caseId,
      global_rating: 'good',
      domain_scores: { data_gathering: dom(60), clinical_management: dom(60), interpersonal: dom(60) },
      criteria: [],
      highlights: [],
      improvements: [],
      narrative: 'n',
    },
    patientSnapshot: {} as EvalHistoryEntry['patientSnapshot'],
    ...over,
  };
}

const CATALOG: CatalogCase[] = [
  { id: 'c1', clinic: 'cardiology', name: 'A', complaint: 'chest pain' },
  { id: 'c2', clinic: 'cardiology', name: 'B', complaint: 'palpitations' },
  { id: 'c3', clinic: 'cardiology', name: 'C', complaint: 'breathless' },
  { id: 'c4', clinic: 'cardiology', name: 'D', complaint: 'syncope' },
  { id: 'c5', clinic: 'cardiology', name: 'E', complaint: 'oedema' },
  { id: 'd1', clinic: 'dermatology', name: 'F', complaint: 'rash' },
  { id: 'd2', clinic: 'dermatology', name: 'G', complaint: 'itch' },
];

test('empty history gives an empty summary', () => {
  const p = computeProgress([], CATALOG, at(2026, 11, 21));
  assert.equal(p.sessions, 0);
  assert.equal(p.avgScore, null);
  assert.deepEqual(p.trend, []);
  assert.deepEqual(p.suggestions, []);
  assert.deepEqual(p.streak, { current: 0, best: 0 });
});

test('entryScore prefers the saved score and derives one for old rows', () => {
  assert.equal(entryScore(entry({ caseId: 'c1', savedAt: 1, score: 77 })), 77);
  const old = entry({ caseId: 'c1', savedAt: 1 });
  old.evaluation.domain_scores = { data_gathering: dom(40), clinical_management: dom(70), interpersonal: dom(100) };
  assert.equal(entryScore(old), 70);
});

test('skillsFromDomainNames maps the simple debrief domains onto the six skills', () => {
  const s = skillsFromDomainNames([
    { name: 'History taking', score: 70 },
    { name: 'Diagnostic reasoning', score: 60 },
    { name: 'Test selection', score: 50 },
    { name: 'Treatment and safety', score: 40 },
    { name: 'Communication', score: 90 },
    { name: 'Disposition', score: 30 },
  ]);
  assert.deepEqual(s, { history: 70, reasoning: 60, tests: 50, treatment: 40, communication: 90, disposition: 30 });
});

test('aggregates averages, trend, specialties, weakest skills and mistakes', () => {
  const entries = [
    entry({ caseId: 'c1', savedAt: at(2026, 11, 18), score: 80, specialty: 'cardiology', mode: 'practice',
      skillScores: { history: 80, tests: 40 }, alerts: [{ severity: 'warning', title: 'Irrelevant test' }] }),
    entry({ caseId: 'd1', savedAt: at(2026, 11, 19), score: 40, mode: 'osce', // specialty from catalogue
      skillScores: { history: 60, tests: 20, communication: 90 },
      alerts: [{ severity: 'danger', title: 'Allergy conflict' }, { severity: 'warning', title: 'irrelevant TEST ' }] }),
    entry({ caseId: 'c2', savedAt: at(2026, 11, 21), score: 60, specialty: 'cardiology' }),
  ];
  const p = computeProgress(entries, CATALOG, at(2026, 11, 21, 18));
  assert.equal(p.sessions, 3);
  assert.equal(p.osceSessions, 1);
  assert.equal(p.avgScore, 60);
  assert.deepEqual(p.trend.map((t) => t.score), [80, 40, 60]);
  assert.deepEqual(p.trend.map((t) => t.mode), ['practice', 'osce', 'practice']);

  const card = p.bySpecialty.find((s) => s.clinic === 'cardiology');
  const derm = p.bySpecialty.find((s) => s.clinic === 'dermatology');
  assert.deepEqual(card, { clinic: 'cardiology', sessions: 2, avg: 70 });
  assert.deepEqual(derm, { clinic: 'dermatology', sessions: 1, avg: 40 });

  // Weakest first. c2 has no skillScores, so its evaluation domains (60) fill
  // history / treatment / communication.
  assert.equal(p.skills[0].key, 'tests');
  assert.equal(p.skills[0].avg, 30);
  const hist = p.skills.find((s) => s.key === 'history');
  assert.deepEqual(hist && { avg: hist.avg, n: hist.n }, { avg: 67, n: 3 });

  // Same title, different case: one recurring mistake counted twice.
  assert.equal(p.mistakes[0].title, 'Irrelevant test');
  assert.equal(p.mistakes[0].count, 2);
  assert.equal(p.mistakes[1].title, 'Allergy conflict');
  assert.equal(p.mistakes[1].severity, 'danger');

  // Weakest specialty is dermatology; d1 was attempted so d2 is suggested.
  assert.equal(p.weakestSpecialty, 'dermatology');
  assert.deepEqual(p.suggestions.map((c) => c.id), ['d2']);
});

test('suggestions skip a fully attempted specialty and cap at three', () => {
  const entries = [
    entry({ caseId: 'd1', savedAt: at(2026, 11, 1), score: 20 }),
    entry({ caseId: 'd2', savedAt: at(2026, 11, 2), score: 30 }),
    entry({ caseId: 'c1', savedAt: at(2026, 11, 3), score: 90 }),
  ];
  const p = computeProgress(entries, CATALOG, at(2026, 11, 3));
  assert.equal(p.weakestSpecialty, 'cardiology');
  assert.deepEqual(p.suggestions.map((c) => c.id), ['c2', 'c3', 'c4']);
});

test('recentDelta compares the last five sessions with the five before', () => {
  const scores = [50, 50, 50, 50, 50, 60, 70, 70, 70, 80];
  const entries = scores.map((s, i) => entry({ caseId: 'c1', savedAt: at(2026, 10, i + 1), score: s }));
  assert.equal(computeProgress(entries, CATALOG, at(2026, 10, 30)).recentDelta, 20);
  assert.equal(computeProgress(entries.slice(0, 1), CATALOG, at(2026, 10, 30)).recentDelta, null);
});

test('streak counts consecutive local days and survives until tomorrow', () => {
  const ts = [at(2026, 11, 10), at(2026, 11, 11), at(2026, 11, 12), at(2026, 11, 12, 22), at(2026, 11, 19), at(2026, 11, 20)];
  assert.deepEqual(computeStreak(ts, at(2026, 11, 20, 23)), { current: 2, best: 3 });
  assert.deepEqual(computeStreak(ts, at(2026, 11, 21, 8)), { current: 2, best: 3 }, 'yesterday keeps it alive');
  assert.deepEqual(computeStreak(ts, at(2026, 11, 22, 8)), { current: 0, best: 3 });
  // Month boundary.
  assert.deepEqual(computeStreak([at(2026, 10, 31), at(2026, 11, 1)], at(2026, 11, 1)), { current: 2, best: 2 });
  assert.equal(dayKey(at(2026, 1, 5)), '2026-01-05');
});

test('trend keeps only the last 20 sessions in order', () => {
  const entries = Array.from({ length: 25 }, (_, i) => entry({ caseId: 'c1', savedAt: at(2026, 9, 1) + i * 1000, score: i }));
  const p = computeProgress(entries.reverse(), CATALOG, at(2026, 9, 2));
  assert.equal(p.trend.length, 20);
  assert.equal(p.trend[0].score, 5);
  assert.equal(p.trend[19].score, 24);
});

test('normalizeOsceResult validates verdicts, scores and ratings', () => {
  const r = normalizeOsceResult({
    globalRating: 'stellar',
    domains: [
      { id: 'data_gathering', items: [
        { id: 'a', label: 'Onset', weight: 1, verdict: 'met', evidence: ' "when did it start" ' },
        { id: 'b', label: 'Radiation', weight: 3, verdict: 'maybe' },
      ] },
      { id: 'bogus', items: [] },
    ],
    criticalErrors: [{ severity: 'catastrophic', title: 'Allergy conflict' }, { title: '' }],
    skills: { history: 120, tests: 'x' },
    strengths: ['Good', 3, ''],
  });
  assert.equal(r.domains.length, 1);
  assert.equal(r.domains[0].items[1].verdict, 'not-met');
  assert.equal(r.domains[0].score, 25);
  assert.equal(r.score, 25);
  assert.equal(r.globalRating, 'clear-fail');
  assert.deepEqual(r.criticalErrors, [{ severity: 'warning', title: 'Allergy conflict', detail: '' }]);
  assert.deepEqual(r.skills, { history: 100 });
  assert.deepEqual(r.strengths, ['Good']);

  const ev = osceToEvaluation('c1', { ...r, globalRating: 'clear-pass' });
  assert.equal(ev.global_rating, 'good');
  assert.equal(ev.criteria.length, 2);
  assert.equal(ev.criteria[1].verdict, 'missed');
  assert.equal(ev.domain_scores.data_gathering.raw, 25);
});

test('scoreItems and ratingForScore bands', () => {
  const it = (verdict: 'met' | 'partial' | 'not-met', weight = 1) =>
    ({ id: 'x', domain: 'interpersonal' as const, label: 'x', weight, verdict, evidence: '', note: '' });
  assert.equal(scoreItems([it('met'), it('partial'), it('not-met', 2)]), 38);
  assert.equal(scoreItems([]), 0);
  assert.deepEqual([39, 40, 54, 55, 79, 80].map(ratingForScore),
    ['clear-fail', 'borderline', 'borderline', 'clear-pass', 'clear-pass', 'excellent']);
});
