/**
 * Exports the departments' own records from the case data:
 *   backend/data/lis.json        laboratory and imaging results (no drug data)
 *   backend/data/formulary.json  the pharmacy formulary (no results)
 *
 * Run `node scripts/export/lis.ts` after editing src/data/*.
 * scripts/test/lis-export.test.ts fails when the files are out of date.
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { TESTS } from '../../src/data/tests.ts';
import { DEFAULT_RESULTS } from '../../src/data/defaultTestResults.ts';
import { MEDICATIONS } from '../../src/data/medications.ts';
import { POLYCLINIC_CASES } from '../../src/data/polyclinicPatients.ts';
import { PATIENT_CASES } from '../../src/data/patients.ts';

const DATA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../backend/data');
export const LIS_PATH = resolve(DATA_DIR, 'lis.json');
export const FORMULARY_PATH = resolve(DATA_DIR, 'formulary.json');

type CaseRow = { a: number; g: string; r: Record<string, [string, 0 | 1]> };

export interface Lis {
  v: 1;
  /** testId -> [name, category] */
  tests: Record<string, [string, string]>;
  /** testId -> the report shown when the case has no result of its own */
  defaults: Record<string, string>;
  /** caseId -> age, gender, results {testId: [text, abnormal]} */
  cases: Record<string, CaseRow>;
}

export interface Formulary {
  v: 1;
  /** medicationId -> [name, form, category, class, defaultDose, defaultDuration] */
  meds: Record<string, [string, string, string, string, string, string]>;
}

/** Stored order is irrelevant to the reader, so one case per line keeps diffs small. */
function lines(record: Record<string, unknown>): string {
  return Object.entries(record)
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(',\n');
}

export function buildLis(): Lis {
  const lis: Lis = { v: 1, tests: {}, defaults: {}, cases: {} };
  for (const t of TESTS) lis.tests[t.id] = [t.name, t.category];
  for (const [id, text] of Object.entries(DEFAULT_RESULTS)) if (id in lis.tests) lis.defaults[id] = text;
  for (const c of [...Object.values(POLYCLINIC_CASES).flat(), ...PATIENT_CASES]) {
    if (lis.cases[c.id]) continue;
    const row: CaseRow = { a: c.age, g: c.gender, r: {} };
    // The app reads results with Array.find, so the first entry for a test wins.
    for (const r of c.testResults) if (!(r.testId in row.r)) row.r[r.testId] = [r.result, r.abnormal ? 1 : 0];
    lis.cases[c.id] = row;
  }
  return lis;
}

export function buildFormulary(): Formulary {
  const out: Formulary = { v: 1, meds: {} };
  for (const m of MEDICATIONS) {
    out.meds[m.id] = [m.name, m.form, m.category, m.class, m.defaultDose, m.defaultDuration];
  }
  return out;
}

export function renderLis(lis: Lis): string {
  return (
    `{"v":${lis.v},"tests":{\n${lines(lis.tests)}\n},"defaults":{\n${lines(lis.defaults)}\n},` +
    `"cases":{\n${lines(lis.cases)}\n}}\n`
  );
}

export function renderFormulary(f: Formulary): string {
  return `{"v":${f.v},"meds":{\n${lines(f.meds)}\n}}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const lis = buildLis();
  const formulary = buildFormulary();
  writeFileSync(LIS_PATH, renderLis(lis));
  writeFileSync(FORMULARY_PATH, renderFormulary(formulary));
  console.log(
    `lis.json: ${Object.keys(lis.cases).length} cases, ${Object.keys(lis.tests).length} tests; ` +
      `formulary.json: ${Object.keys(formulary.meds).length} medications`,
  );
}
