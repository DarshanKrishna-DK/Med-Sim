/** Communication-skills stations: shape, rubric and emotional persona. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { COMMS_CASES_BY_SPECIALTY, COMMS_DIAGNOSIS_LABELS } from '../../src/data/commsCases.ts';

const cases = COMMS_CASES_BY_SPECIALTY['communication-skills'];

test('eight stations with emotion profile and a communication rubric', () => {
  assert.equal(cases.length, 8);
  for (const c of cases) {
    assert.ok(c.emotionProfile, c.id);
    assert.ok(c.rubric && c.rubric.interpersonal.length >= 4, c.id);
    assert.ok(c.rubric!.safety_netting!.required_elements.length >= 3, c.id);
    for (const o of c.diagnosisOptions) assert.ok(COMMS_DIAGNOSIS_LABELS[o], `${c.id} ${o}`);
  }
  assert.ok(cases.some((c) => c.rubric!.interpersonal.some((r) => r.framework === 'NURSE')));
  assert.ok(cases.some((c) => c.rubric!.data_gathering.some((r) => r.framework === 'SPIKES')));
});

test('emotion profiles are complete and free of em dashes', () => {
  for (const c of cases) {
    const e = c.emotionProfile!;
    assert.ok(e.softenedBy.length >= 3 && e.escalatedBy.length >= 3 && e.reactions.length >= 4, c.id);
    // No em dash (U+2014) anywhere in the case text.
    assert.ok(!JSON.stringify(c).includes(String.fromCharCode(0x2014)), c.id);
  }
});
