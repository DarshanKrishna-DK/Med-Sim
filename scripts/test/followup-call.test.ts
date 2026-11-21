/**
 * Asha follow-up call: /call/<token> route parsing, call links in nurse run
 * steps and the localStorage registry of links per case.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  FOLLOWUP_STORAGE_KEY,
  callActionChips,
  callUrlsFromSteps,
  followupCallsForCase,
  parseCallToken,
  rememberFollowupCall,
  tokenFromCallUrl,
} from '../../src/voice/followupCall.ts';

test('parseCallToken accepts only /call/<token>', () => {
  assert.equal(parseCallToken('/call/AbC_def-12345'), 'AbC_def-12345');
  assert.equal(parseCallToken('/call/AbC_def-12345/'), 'AbC_def-12345');
  assert.equal(parseCallToken('/call/short'), null);
  assert.equal(parseCallToken('/call/abc$defghij'), null);
  assert.equal(parseCallToken('/call-api/AbC_def-12345'), null);
  assert.equal(parseCallToken('/'), null);
});

test('tokenFromCallUrl handles absolute and relative links', () => {
  assert.equal(tokenFromCallUrl('https://x.trycloudflare.com/call/Tok_en12345'), 'Tok_en12345');
  assert.equal(tokenFromCallUrl('/call/Tok_en12345?x=1'), 'Tok_en12345');
  assert.equal(tokenFromCallUrl('https://x/rx/abc'), null);
  assert.equal(tokenFromCallUrl(42), null);
});

test('callUrlsFromSteps reads result.calendar.callUrl', () => {
  const steps = [
    { result: { calendar: { callUrl: 'https://h/call/Tok_en12345' } } },
    { result: { calendar: { icsUrl: '/rx/ics/x' } } },
    { result: null },
    {},
  ];
  assert.deepEqual(callUrlsFromSteps(steps), ['https://h/call/Tok_en12345']);
  assert.deepEqual(callUrlsFromSteps(undefined), []);
});

test('rememberFollowupCall stores links per case, newest first, no duplicates', () => {
  const mem = new Map<string, string>();
  (globalThis as { localStorage?: unknown }).localStorage = {
    getItem: (k: string) => mem.get(k) ?? null,
    setItem: (k: string, v: string) => void mem.set(k, v),
    removeItem: (k: string) => void mem.delete(k),
  };
  try {
    rememberFollowupCall('im-001', '/call/Tok_en11111', 1);
    rememberFollowupCall('im-002', '/call/Tok_en22222', 2);
    rememberFollowupCall('im-001', '/call/Tok_en33333', 3);
    rememberFollowupCall('im-001', '/call/Tok_en11111', 4);
    assert.equal(rememberFollowupCall('im-001', 'not a link'), null);
    assert.deepEqual(followupCallsForCase('im-001').map((x) => x.token), ['Tok_en11111', 'Tok_en33333']);
    assert.equal(followupCallsForCase('im-002').length, 1);
    assert.ok(mem.has(FOLLOWUP_STORAGE_KEY));
  } finally {
    delete (globalThis as { localStorage?: unknown }).localStorage;
  }
});

test('callActionChips orders red flags, reschedules, then symptoms', () => {
  assert.deepEqual(callActionChips(undefined), []);
  const chips = callActionChips({
    symptoms: [{ symptom: 'mild nausea', adherence: 'partial', at: 3 }],
    reschedules: [{ whenText: 'tomorrow', startText: 'Sat 22 Nov, 10:00 AM', at: 2, booked: true, reminders: 1 }],
    redFlags: [{ symptom: 'chest pain', severity: 'emergency', at: 1, doctorNotified: true }],
  });
  assert.deepEqual(chips.map((c) => c.kind), ['flag', 'reschedule', 'symptom']);
  assert.equal(chips[0].label, 'Red flag: chest pain');
  assert.match(chips[0].title, /Doctor alerted/);
  assert.equal(chips[1].label, 'Moved to Sat 22 Nov, 10:00 AM');
  assert.match(chips[1].title, /Google Calendar/);
  assert.equal(chips[2].title, 'Adherence: partial');
});
