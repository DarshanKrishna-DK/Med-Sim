/**
 * Telegram-created cases (`src/data/customCasesCore.ts`): wire parsing,
 * merge into the library (dedupe, unknown specialty, malformed payloads)
 * and the ?case=<id> deep link. Pure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CUSTOM_BADGE, UNREVIEWED_BADGE, caseIdFromSearch, mergeCustomCases, parseCustomCase, reconcileCustomCases } from '../../src/data/customCasesCore.ts';

const CLINICS = new Set(['all-specialties', 'cardiology', 'pediatrics']);

const wire = (over: Record<string, unknown> = {}) => ({
  id: 'tg-abc123',
  name: 'Ravi Kumar',
  age: 54,
  gender: 'M',
  severity: 'urgent',
  arrivalBlurb: 'Walks in holding his chest.',
  chiefComplaint: 'My chest feels tight.',
  vitals: { hr: 104, bp: '150/92', spo2: 96, temp: 36.9, rr: 20 },
  anamnesis: [{ id: 'onset', question: 'When?', answer: 'Two weeks.', relevant: true }],
  testResults: [{ testId: 'ecg', result: 'ST depression', abnormal: true }],
  correctDiagnosisId: 'unstable-angina',
  diagnosisOptions: ['unstable-angina', 'stable-angina', 'gerd', 'costochondritis'],
  diagnosisLabels: { 'unstable-angina': 'Unstable Angina', gerd: 'GERD' },
  acceptableTreatmentIds: ['aspirin'],
  criticalTreatmentIds: ['aspirin'],
  specialty: 'cardiology',
  source: { title: 'Created via Telegram by Darsh', url: '' },
  synthetic: true,
  ...over,
});

test('parseCustomCase keeps the PatientCase fields and drops source', () => {
  const c = parseCustomCase(wire(), CLINICS);
  assert.ok(c);
  assert.equal(c.clinic, 'cardiology');
  assert.equal(c.createdBy, 'Created via Telegram by Darsh');
  assert.equal(c.patient.source, undefined);
  assert.equal(c.patient.vitals.bp, '150/92');
  assert.equal(c.diagnosisLabels['unstable-angina'], 'Unstable Angina');
  assert.equal(c.diagnosisLabels['stable-angina'], 'stable angina'); // missing label falls back to the id
  assert.equal('specialty' in c.patient, false);
});

test('parseCustomCase rejects malformed or foreign payloads', () => {
  assert.equal(parseCustomCase(null, CLINICS), null);
  assert.equal(parseCustomCase(wire({ id: 'card-001' }), CLINICS), null); // only tg- ids
  assert.equal(parseCustomCase(wire({ specialty: 'astrology' }), CLINICS), null);
  assert.equal(parseCustomCase(wire({ specialty: 'all-specialties' }), CLINICS), null);
  assert.equal(parseCustomCase(wire({ severity: 'meh' }), CLINICS), null);
  assert.equal(parseCustomCase(wire({ vitals: { hr: 'fast' } }), CLINICS), null);
  assert.equal(parseCustomCase(wire({ correctDiagnosisId: 'mi' }), CLINICS), null);
  assert.equal(parseCustomCase(wire({ testResults: [{ testId: 'ecg' }] }), CLINICS), null);
});

test('mergeCustomCases dedupes against known ids and within the batch', () => {
  const out = mergeCustomCases(
    [wire(), wire(), wire({ id: 'tg-new999', specialty: 'pediatrics', age: 4 }), wire({ id: 'tg-old111' }), 'junk'],
    new Set(['tg-old111']),
    CLINICS,
  );
  assert.deepEqual(out.map((c) => c.patient.id), ['tg-abc123', 'tg-new999']);
  assert.equal(out[1].clinic, 'pediatrics');
  assert.deepEqual(mergeCustomCases({ cases: [] }, new Set(), CLINICS), []);
  assert.equal(CUSTOM_BADGE, 'Created on Telegram');
});

test('an unreviewed case says so, an approved one says who it came from', () => {
  assert.deepEqual([parseCustomCase(wire(), CLINICS)!.badge, parseCustomCase(wire(), CLINICS)!.badgeTitle], [CUSTOM_BADGE, 'Created via Telegram by Darsh']);
  const u = parseCustomCase(wire({ reviewStatus: 'unreviewed' }), CLINICS)!;
  assert.equal(u.badge, UNREVIEWED_BADGE);
  assert.match(u.badgeTitle, /without a doctor's review/);
  const a = parseCustomCase(wire({ reviewStatus: 'approved' }), CLINICS)!;
  assert.equal(a.badge, CUSTOM_BADGE);
  assert.match(a.badgeTitle, /approved by a doctor/);
  assert.equal(parseCustomCase(wire({ reviewStatus: 7 }), CLINICS)!.badge, CUSTOM_BADGE);
});

test('reconcile takes out what the server no longer shows and updates badges', () => {
  const shown = new Map([['tg-abc123', UNREVIEWED_BADGE], ['tg-old111', CUSTOM_BADGE]]);
  const r = reconcileCustomCases([wire({ reviewStatus: 'approved' })], shown, CLINICS);
  assert.deepEqual(r.removed, ['tg-old111']);
  assert.deepEqual(r.changed.map((c) => [c.patient.id, c.badge]), [['tg-abc123', CUSTOM_BADGE]]);
  assert.deepEqual(reconcileCustomCases([wire({ reviewStatus: 'unreviewed' })], new Map([['tg-abc123', UNREVIEWED_BADGE]]), CLINICS), { removed: [], changed: [] });
  assert.deepEqual(reconcileCustomCases('down', shown, CLINICS), { removed: [], changed: [] });
  // a payload we cannot parse is not a deletion
  assert.deepEqual(reconcileCustomCases([{ id: 'tg-abc123' }, { id: 'tg-old111' }], shown, CLINICS), { removed: [], changed: [] });
});

test('caseIdFromSearch reads ?case= safely', () => {
  assert.equal(caseIdFromSearch('?case=tg-abc123'), 'tg-abc123');
  assert.equal(caseIdFromSearch('?x=1&case=card-001'), 'card-001');
  assert.equal(caseIdFromSearch(''), null);
  assert.equal(caseIdFromSearch('?case=%3Cscript%3E'), null);
});
