/**
 * The reading room's second read: what is shown, and that nothing is shown as
 * agreed or communicated before somebody said so. Pure.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { headline, parseSecondRead, stepTime, type SecondRead } from '../../src/components/radiology/secondRead.ts';

const side = (over: Record<string, unknown> = {}) => ({ kind: 'second_read', refId: 'r', status: 'waiting', final: false, url: '', ...over });

test('waiting, agreeing and differing', () => {
  const w = parseSecondRead(side())!;
  assert.equal(w.read, null);
  assert.equal(headline(w).tone, 'wait');
  const a = parseSecondRead(side({ status: 'agree', final: true, read: { outcome: 'agree', missed: [], diagnosisAgrees: true } }))!;
  assert.deepEqual([a.read!.outcome, headline(a).text, a.final], ['agree', 'Second read agrees', true]);
  const d = parseSecondRead(side({ status: 'discrepancy', read: { outcome: 'discrepancy', by: 'Radiologist Vikram', missed: [{ label: 'Free gas', critical: true }], diagnosisAgrees: false, diagnosis: 'Pneumoperitoneum' } }))!;
  assert.deepEqual(d.read!.missed, [{ label: 'Free gas', critical: true }]);
});

test('the chain keeps its order and its times', () => {
  const chain = [
    { at: '2026-11-23T05:00:00Z', who: 'nurse', what: 'Report sent for a second read' },
    { at: '2026-11-23T05:00:06Z', who: 'radiology', what: 'Second read: discrepancy' },
    { at: '2026-11-23T05:00:07Z', who: 'radiology', what: 'Called Nurse Asha: free gas' },
    { at: '2026-11-23T05:00:08Z', who: 'nurse', what: 'Acknowledged and read back: free gas' },
    { at: '2026-11-23T05:00:09Z', who: 'radiology', what: 'Read-back confirmed, loop closed' },
    { at: 1, who: 'stranger', what: 'x' },
    'junk',
  ];
  const s = parseSecondRead(side({ status: 'closed', final: true, chain }))!;
  assert.deepEqual(s.chain.map((c) => c.who), ['nurse', 'radiology', 'radiology', 'nurse', 'radiology']);
  assert.match(headline(s).text, /loop closed/);
  assert.ok(stepTime(s.chain[0].at));
  assert.equal(stepTime('nonsense'), '');
});

test('silence is never agreement and malformed states show nothing', () => {
  assert.match(headline(parseSecondRead(side({ status: 'no_reply' }))!).text, /has not replied/);
  for (const bad of [null, undefined, side({ status: 'new' }), side({ status: 'approved' })]) assert.equal(parseSecondRead(bad as never), null);
  const s = parseSecondRead(side({ status: 'agree', read: { outcome: 'great', missed: 'x' }, chain: 'x', url: 5 })) as SecondRead;
  assert.deepEqual([s.read, s.chain, s.url], [null, [], '']);
});
