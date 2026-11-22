import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { READS_PATH, buildReads, renderReads } from '../export/radiologyReads.ts';
import { OT_SCENARIOS } from '../../src/ot/scenarios.ts';

const lf = (s: string) => s.replace(/\r\n/g, '\n');
const data = (name: string) => resolve(dirname(fileURLToPath(import.meta.url)), '../../backend/data', name);

test('backend/data/radiology_reads.json matches src/data/radiologyCases.json (run `node scripts/export/radiologyReads.ts`)', () => {
  assert.equal(lf(readFileSync(READS_PATH, 'utf8')), renderReads(buildReads()));
});

test('only abnormal critical findings are telephoned', () => {
  const { films } = buildReads();
  assert.equal(films['rad-cxr-normal'].findings.some((f) => f.call), false);
  assert.equal(films['rad-cxr-pneumothorax'].findings.find((f) => f.id === 'pleural-line')?.call, true);
  assert.equal(films['rad-cxr-pneumothorax'].findings.find((f) => f.id === 'no-tension')?.call, false);
  for (const [id, f] of Object.entries(films)) {
    if (id !== 'rad-cxr-normal') assert.ok(f.findings.some((x) => x.call), `${id} has a finding to call`);
  }
});

test('his file holds no patient, no vignette and no teaching', () => {
  for (const f of Object.values(buildReads().films)) {
    assert.deepEqual(Object.keys(f).sort(), ['diagnosis', 'distractors', 'exclude', 'findings', 'keywords', 'study']);
  }
});

test('the blood bank knows every theatre patient and nobody else', () => {
  const bank = JSON.parse(readFileSync(data('bloodbank.json'), 'utf8')) as { patients: Record<string, unknown> };
  assert.deepEqual(Object.keys(bank.patients).sort(), OT_SCENARIOS.map((s) => s.id).sort());
});
