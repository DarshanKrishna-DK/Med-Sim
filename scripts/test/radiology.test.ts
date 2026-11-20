/**
 * Radiology reading room: the case file (images, credits, keys), the offline
 * grader that mirrors backend/radiology.py, and the persona prompt (it must
 * carry the answer key but tell the consultant never to reveal it early).
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { statSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  RAD_CASES,
  READING_TIP,
  diagnosisOptions,
  getRadCase,
  gradeOffline,
  keywordHit,
  normText,
  probeOffline,
  ruleDiagnosis,
  ruleFound,
  scoreFor,
} from '../../src/data/radiology.ts';
import { buildRadiologistCasePrompt, filmIntroLine } from '../../src/voice/radiologistPersona.ts';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

test('15 to 20 cases, every modality the spec asks for, unique ids', () => {
  assert.ok(RAD_CASES.length >= 15 && RAD_CASES.length <= 20, `got ${RAD_CASES.length}`);
  const ids = new Set(RAD_CASES.map((c) => c.id));
  assert.equal(ids.size, RAD_CASES.length);
  for (const m of ['cxr', 'axr', 'ecg', 'ct-head', 'us', 'xr-limb'] as const) {
    assert.ok(RAD_CASES.some((c) => c.modality === m), m);
    assert.ok(READING_TIP[m].steps.length >= 4, m);
  }
});

test('every image is local, under 400 KB, and credited', () => {
  for (const c of RAD_CASES) {
    assert.match(c.image, /^\/assets\/radiology\/[a-z0-9-]+\.jpg$/, c.id);
    const size = statSync(resolve(ROOT, 'public', c.image.slice(1))).size;
    assert.ok(size > 5_000 && size < 400 * 1024, `${c.id}: ${size} bytes`);
    assert.ok(c.credit.author && c.credit.license && c.credit.source.startsWith('https://commons.wikimedia.org/wiki/File:'), c.id);
    assert.ok(/^https:\/\//.test(c.credit.licenseUrl), c.id);
  }
});

test('answer keys are well formed and contain no em dashes', () => {
  for (const c of RAD_CASES) {
    assert.ok(c.findings.length >= 3, c.id);
    assert.ok(c.findings.some((f) => f.critical), `${c.id} has no must-not-miss finding`);
    assert.ok(c.findings.every((f) => f.keywords.length > 0 && f.probe), c.id);
    assert.equal(c.distractors.length, 3, c.id);
    assert.ok(c.teaching.length >= 3, c.id);
    const opts = diagnosisOptions(c);
    assert.equal(opts.length, 4);
    assert.ok(opts.includes(c.diagnosis));
    assert.deepEqual(diagnosisOptions(c), opts, 'option order is stable');
    assert.ok(ruleDiagnosis(c, c.diagnosis), `${c.id}: own diagnosis`);
    for (const d of c.distractors) assert.ok(!ruleDiagnosis(c, d), `${c.id}: distractor ${d}`);
    assert.ok(!JSON.stringify(c).includes('\u2014'), `${c.id} has an em dash`);
  }
});

test('keyword matching ignores fillers and respects negation within a clause', () => {
  const t = normText('No effusion, there is consolidation in the right lower zone. Costophrenic angles are clear.');
  assert.ok(keywordHit(t, 'consolidation in the right'));
  assert.ok(keywordHit(t, 'costophrenic angles clear'));
  assert.ok(keywordHit(t, 'no effusion'));
  assert.ok(!keywordHit(normText('there is no consolidation'), 'consolidation'));
});

test('offline grade mirrors the backend scoring', () => {
  const c = getRadCase('rad-cxr-lobar-pneumonia')!;
  const read =
    'PA film, adequate. Trachea is central. There is a dense consolidation in the right lower zone with loss of the right heart border, so right middle lobe. Costophrenic angles are clear. Left lung clear.';
  const found = ruleFound(c, read);
  assert.ok(!found.includes('air-bronchogram'));
  const g = gradeOffline(c, read, 'Right middle lobe pneumonia');
  assert.equal(g.score, scoreFor(c, found, true));
  assert.equal(g.score, 93); // 7 of 8 weight -> 52.5 + 40, rounded half up like the backend
  assert.deepEqual(g.missedFindings, ['Air bronchograms within the opacity']);
  assert.equal(g.gradedBy, 'offline');

  const bad = gradeOffline(c, 'Looks normal to me.', 'Normal chest radiograph');
  assert.equal(bad.diagnosisCorrect, false);
  assert.equal(bad.score, 0);
  assert.equal(bad.missedCritical.length, 2);
});

test('offline probe targets the first missed must-not-miss finding', () => {
  const c = getRadCase('rad-cxr-lobar-pneumonia')!;
  assert.match(probeOffline(c, 'Consolidation in the right lower zone.'), /right heart border/);
  const all = c.findings.map((f) => f.keywords[0]).join('. ');
  assert.match(probeOffline(c, all), /diagnosis/);
});

test('persona carries the key but forbids revealing it early', () => {
  const c = getRadCase('rad-ct-edh')!;
  const p = buildRadiologistCasePrompt(c, 'en');
  assert.ok(p.includes(c.diagnosis));
  assert.match(p, /never reveal the diagnosis before/i);
  assert.match(p, /exactly ONE short probing question/);
  assert.ok(!p.includes('\u2014'));
  assert.ok(buildRadiologistCasePrompt(c, 'hi').includes('Devanagari'));
  assert.ok(filmIntroLine(c).includes(c.patient.name));
});
