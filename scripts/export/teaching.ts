/**
 * Exports the teacher's catalogue: which practice cases and lesson topics exist.
 *   backend/data/teaching.json
 * No patient identity, no complaint, no results and no diagnosis per case: topics are
 * listed per specialty in alphabetical order, so a case cannot be matched to its diagnosis.
 *
 * Run `node scripts/export/teaching.ts` after editing src/data/*.
 * scripts/test/teaching-export.test.ts fails when the file is out of date.
 */

import { writeFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import process from 'node:process';
import { POLYCLINIC_CASES, POLYCLINIC_DIAGNOSIS_LABELS, getCaseSpecialty } from '../../src/data/polyclinicPatients.ts';
import { CLINIC_LABELS, type ClinicId } from '../../src/game/clinic.ts';

export const TEACHING_PATH = resolve(dirname(fileURLToPath(import.meta.url)), '../../backend/data/teaching.json');

export interface Teaching {
  v: 1;
  /** clinicId -> label and the lesson topics of that specialty */
  clinics: Record<string, { label: string; topics: string[] }>;
  /** caseId -> [clinicId, history questions, abnormal tests, critical treatments, communication station] */
  cases: Record<string, [string, number, number, number, 0 | 1]>;
}

export function buildTeaching(): Teaching {
  const out: Teaching = { v: 1, clinics: {}, cases: {} };
  for (const [clinic, cases] of Object.entries(POLYCLINIC_CASES)) {
    if (clinic === 'all-specialties' || !cases.length) continue;
    const topics = new Set<string>();
    for (const c of cases) {
      if (out.cases[c.id] || getCaseSpecialty(c.id) !== clinic) continue;
      out.cases[c.id] = [
        clinic,
        c.anamnesis.length,
        c.testResults.filter((r) => r.abnormal).length,
        c.criticalTreatmentIds.length,
        c.emotionProfile ? 1 : 0,
      ];
      const label = POLYCLINIC_DIAGNOSIS_LABELS[c.correctDiagnosisId];
      if (label) topics.add(label);
    }
    out.clinics[clinic] = { label: CLINIC_LABELS[clinic as ClinicId] ?? clinic, topics: [...topics].sort() };
  }
  return out;
}

const lines = (record: Record<string, unknown>): string =>
  Object.entries(record)
    .map(([k, v]) => `${JSON.stringify(k)}:${JSON.stringify(v)}`)
    .join(',\n');

export function renderTeaching(t: Teaching): string {
  return `{"v":${t.v},"clinics":{\n${lines(t.clinics)}\n},"cases":{\n${lines(t.cases)}\n}}\n`;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const t = buildTeaching();
  writeFileSync(TEACHING_PATH, renderTeaching(t));
  console.log(`teaching.json: ${Object.keys(t.cases).length} cases, ${Object.keys(t.clinics).length} specialties`);
}
