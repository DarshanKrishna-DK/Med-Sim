import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  FORMULARY_PATH, LIS_PATH, buildFormulary, buildLis, renderFormulary, renderLis,
} from '../export/lis.ts';
import { getTestReport } from '../../src/data/defaultTestResults.ts';
import { POLYCLINIC_CASES } from '../../src/data/polyclinicPatients.ts';

const lf = (s: string) => s.replace(/\r\n/g, '\n');

test('backend/data/lis.json and formulary.json match src/data (run `node scripts/export/lis.ts`)', () => {
  assert.equal(lf(readFileSync(LIS_PATH, 'utf8')), renderLis(buildLis()));
  assert.equal(lf(readFileSync(FORMULARY_PATH, 'utf8')), renderFormulary(buildFormulary()));
});

test('every result the app would show can be reproduced from lis.json', () => {
  const lis = JSON.parse(readFileSync(LIS_PATH, 'utf8'));
  for (const c of Object.values(POLYCLINIC_CASES).flat()) {
    for (const testId of Object.keys(lis.tests)) {
      const own = c.testResults.find((r) => r.testId === testId);
      const want = getTestReport(testId, own?.result, !!own?.abnormal);
      const row = lis.cases[c.id].r[testId];
      const got = row?.[0]
        ? { text: row[0], abnormal: !!row[1] }
        : { text: lis.defaults[testId] ?? 'Study completed. No significant findings.', abnormal: false };
      assert.deepEqual(got, want, `${c.id}/${testId}`);
    }
  }
});

test('the lab file holds no drug data and the pharmacy file holds no results', () => {
  const lis = JSON.parse(readFileSync(LIS_PATH, 'utf8'));
  const formulary = JSON.parse(readFileSync(FORMULARY_PATH, 'utf8'));
  assert.deepEqual(Object.keys(lis).sort(), ['cases', 'defaults', 'tests', 'v']);
  assert.deepEqual(Object.keys(formulary).sort(), ['meds', 'v']);
  for (const row of Object.values(lis.cases) as Record<string, unknown>[]) {
    assert.deepEqual(Object.keys(row).sort(), ['a', 'g', 'r']);
  }
});
