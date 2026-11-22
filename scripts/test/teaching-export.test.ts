import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { TEACHING_PATH, buildTeaching, renderTeaching } from '../export/teaching.ts';
import { POLYCLINIC_CASES, getCaseSpecialty } from '../../src/data/polyclinicPatients.ts';

const lf = (s: string) => s.replace(/\r\n/g, '\n');

test('backend/data/teaching.json matches src/data (run `node scripts/export/teaching.ts`)', () => {
  assert.equal(lf(readFileSync(TEACHING_PATH, 'utf8')), renderTeaching(buildTeaching()));
});

test('every practice case exists in the clinic the file says, and every clinic has topics', () => {
  const t = JSON.parse(readFileSync(TEACHING_PATH, 'utf8'));
  const ids = new Set(Object.values(POLYCLINIC_CASES).flat().map((c) => c.id));
  assert.equal(Object.keys(t.cases).length, ids.size);
  for (const [id, row] of Object.entries(t.cases) as [string, unknown[]][]) {
    assert.ok(ids.has(id), id);
    assert.equal(getCaseSpecialty(id), row[0], id);
    assert.ok(t.clinics[row[0] as string], id);
  }
  for (const c of Object.values(t.clinics) as { label: string; topics: string[] }[]) {
    assert.ok(c.label && c.topics.length, c.label);
  }
});

test('the teacher file holds no patient identity', () => {
  const raw = readFileSync(TEACHING_PATH, 'utf8');
  for (const c of Object.values(POLYCLINIC_CASES).flat()) {
    if (c.name.trim().split(/\s+/).length > 1) assert.ok(!raw.includes(`"${c.name}"`), c.name);
    assert.ok(!raw.includes(c.chiefComplaint), c.id);
  }
});
