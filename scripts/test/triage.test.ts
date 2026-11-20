/**
 * Triage drill: deterministic shift, deterioration curves, scoring and the
 * EN / Hindi / Kannada voice command parser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { TRIAGE_CASES, ACTIONS } from '../../src/triage/cases.ts';
import {
  buildShift, caseById, escalatedRel, firedEvents, scorePatient, scoreShift, speedPoints,
  trueVitals, vitalsAt, type Assignment,
} from '../../src/triage/engine.ts';
import { parseTriageCommand } from '../../src/triage/voice.ts';

test('there are 12 to 15 vignettes, every action id is valid and stable cases never deteriorate', () => {
  assert.ok(TRIAGE_CASES.length >= 12 && TRIAGE_CASES.length <= 15);
  for (const c of TRIAGE_CASES) {
    assert.ok(ACTIONS[c.action], c.id);
    for (const a of c.alsoOk) assert.ok(ACTIONS[a], c.id);
    if (c.esi >= 3) assert.equal(c.det, undefined, `${c.id} should be stable`);
    if (c.esi <= 2) assert.ok(c.det && c.det.events.length > 0, `${c.id} needs a deterioration curve`);
  }
});

test('buildShift is seeded: same seed same shift, with a guaranteed acuity mix', () => {
  const a = buildShift(1);
  assert.deepEqual(a, buildShift(1));
  assert.notDeepEqual(a.map((p) => p.caseId), buildShift(2).map((p) => p.caseId));
  for (const seed of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
    const s = buildShift(seed);
    assert.equal(s.length, 5);
    assert.equal(new Set(s.map((p) => p.caseId)).size, 5);
    const levels = s.map((p) => caseById(p.caseId).esi);
    assert.ok(levels.some((l) => l === 1) && levels.some((l) => l === 2) && levels.some((l) => l >= 4));
    for (const p of s) assert.ok(p.sampleS >= 10 && p.sampleS <= 15);
    assert.ok(s[s.length - 1].arrivalS < 200);
  }
});

test('untreated critical patients deteriorate; escalation freezes the decline', () => {
  const c = caseById('op-poisoning');
  const t0 = trueVitals(c, 0, null);
  const t90 = trueVitals(c, 90, null);
  assert.ok(t90.spo2 < t0.spo2 && t90.gcs < t0.gcs && t90.hr < t0.hr);
  const frozen = trueVitals(c, 90, 20);
  assert.ok(frozen.spo2 > t90.spo2);
  assert.deepEqual(trueVitals(c, 90, 20), trueVitals(c, 200, 20));

  const dengue = caseById('dengue-shock');
  assert.ok(trueVitals(dengue, 100, null).sbp < dengue.vitals.sbp);
  assert.ok(trueVitals(dengue, 100, null).hr > dengue.vitals.hr);

  const ankle = caseById('ankle');
  assert.deepEqual(trueVitals(ankle, 250, null), ankle.vitals);
});

test('displayed vitals refresh only on the sample interval and are repeatable', () => {
  const shift = buildShift(1);
  const p = shift[0];
  const c = caseById(p.caseId);
  const a = vitalsAt(c, p, p.sampleS + 1, null, 1);
  const b = vitalsAt(c, p, p.sampleS * 2 - 1, null, 1);
  assert.deepEqual(a, b);
  assert.deepEqual(a, vitalsAt(c, p, p.sampleS + 1, null, 1));
});

test('fired events stop once the patient is escalated', () => {
  const c = caseById('snakebite');
  assert.deepEqual(firedEvents(c, 59, null), []);
  assert.equal(firedEvents(c, 200, null).length, 2);
  assert.equal(firedEvents(c, 200, 70).length, 1);
  assert.equal(firedEvents(c, 200, 10).length, 0);
});

const patient = (caseId: string, arrivalS = 10) => ({ bed: 1, caseId, arrivalS, sampleS: 12 });

test('perfect fast triage scores 100 with nothing missed', () => {
  const p = patient('mi');
  const a: Assignment = { level: 2, action: 'ecg', atS: p.arrivalS + 12 };
  const r = scorePatient(p, a, 200);
  assert.equal(r.total, 100);
  assert.equal(r.missedEvents.length, 0);
  assert.equal(r.dangerousUndertriage, false);
});

test('late or wrong triage loses points and misses deterioration events', () => {
  const p = patient('op-poisoning');
  assert.equal(escalatedRel(p, { level: 3, action: 'waiting', atS: 50 }), null);
  const under = scorePatient(p, { level: 3, action: 'waiting', atS: p.arrivalS + 20 }, 200);
  assert.equal(under.dangerousUndertriage, true);
  assert.equal(under.levelPts, 0);
  assert.equal(under.missedEvents.length, 2);
  assert.ok(under.total < 30);

  const late = scorePatient(p, { level: 1, action: 'resus', atS: p.arrivalS + 55 }, 200);
  assert.equal(late.missedEvents.length, 1); // the event at 40 s fired, the one at 70 s did not
  assert.equal(late.penalty, 10);

  const never = scorePatient(p, undefined, 200);
  assert.equal(never.total, 0);
  assert.equal(never.missedEvents.length, 2);
});

test('over-triage is penalised less than under-triage; speed points taper', () => {
  const p = patient('ankle');
  const over = scorePatient(p, { level: 3, action: 'fast', atS: p.arrivalS + 10 }, 200);
  const under = scorePatient(p, { level: 5, action: 'fast', atS: p.arrivalS + 10 }, 200);
  assert.ok(over.levelPts > under.levelPts);
  assert.equal(speedPoints(1, 30), 20);
  assert.equal(speedPoints(1, 90), 0);
  assert.equal(speedPoints(1, 60), 10);
  assert.equal(speedPoints(4, null), 0);
});

test('shift summary averages patients and counts safety events', () => {
  const shift = buildShift(1);
  const perfect: Record<number, Assignment> = {};
  for (const p of shift) {
    const c = caseById(p.caseId);
    perfect[p.bed] = { level: c.esi, action: c.action, atS: p.arrivalS + 5 };
  }
  const good = scoreShift(shift, perfect, 250);
  assert.equal(good.score, 100);
  assert.equal(good.missedEvents, 0);
  const none = scoreShift(shift, {}, 300);
  assert.equal(none.score, 0);
  assert.ok(none.missedEvents > 0);
});

test('voice parser: English', () => {
  assert.deepEqual(parseTriageCommand('Bed one is red, oxygen and IV access'), { bed: 1, level: 1, action: 'resus' });
  assert.deepEqual(parseTriageCommand('patient 3 orange ECG'), { bed: 3, level: 2, action: 'ecg' });
  assert.deepEqual(parseTriageCommand('bed four green fast track'), { bed: 4, level: 4, action: 'fast' });
  assert.deepEqual(parseTriageCommand('bed 2 ESI 2 stroke alert'), { bed: 2, level: 2, action: 'stroke' });
  assert.deepEqual(parseTriageCommand('bed five blue, waiting area with recheck'), { bed: 5, level: 5, action: 'waiting' });
  assert.deepEqual(parseTriageCommand('bed 3 level 3'), { bed: 3, level: 3 });
  assert.deepEqual(parseTriageCommand('hello there'), {});
});

test('voice parser: Hindi and Kannada number words and colours', () => {
  assert.deepEqual(parseTriageCommand('bed teen lal oxygen lagao'), { bed: 3, level: 1, action: 'resus' });
  assert.deepEqual(parseTriageCommand('बेड दो नारंगी ईसीजी'), { bed: 2, level: 2, action: 'ecg' });
  assert.deepEqual(parseTriageCommand('bed ondu kempu'), { bed: 1, level: 1 });
  assert.deepEqual(parseTriageCommand('ಬೆಡ್ ಮೂರು ಹಸಿರು'), { bed: 3, level: 4 });
  assert.deepEqual(parseTriageCommand('number paanch neela'), { bed: 5, level: 5 });
});
