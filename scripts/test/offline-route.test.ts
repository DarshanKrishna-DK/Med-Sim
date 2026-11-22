/**
 * Offline router (src/voice/offlineRoute.ts) against the truth table shared with
 * backend/intent.py, plus phrases that are not in it.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { classifyOffline, type OfflineContext } from '../../src/voice/offlineRoute.ts';
import { looksLikeOrder } from '../../src/agents/nurseIntent.ts';

interface Case {
  u: string;
  lang: string;
  target: string;
  action: string | null;
  tag: string;
  tier?: string;
  context?: OfflineContext;
}

const { cases } = JSON.parse(readFileSync(new URL('../../backend/tests/fixtures/intent_cases.json', import.meta.url), 'utf8')) as { cases: Case[] };
const hit = (c: Case) => {
  const r = classifyOffline(c.u, c.context ?? {});
  return r.target === c.target && (c.action === null || r.action === c.action);
};
const miss = (c: Case) => {
  const r = classifyOffline(c.u, c.context ?? {});
  return `${c.tag} "${c.u}" want ${c.target}/${c.action} got ${r.target}/${r.action}`;
};

test('at least 92 percent of the shared table', () => {
  const bad = cases.filter((c) => !hit(c));
  assert.ok(1 - bad.length / cases.length >= 0.92, `${bad.length}/${cases.length}\n${bad.map(miss).join('\n')}`);
});

test('every listed known bug', () => {
  const known = cases.filter((c) => /^[BC]\d+$/.test(c.tag));
  assert.ok(known.length >= 60);
  assert.deepEqual(known.filter((c) => !hit(c)).map(miss), []);
});

test('no language is left behind', () => {
  for (const lang of new Set(cases.map((c) => c.lang))) {
    const mine = cases.filter((c) => c.lang === lang);
    const ok = mine.filter(hit).length / mine.length;
    assert.ok(ok >= 0.9, `${lang} ${(ok * 100).toFixed(0)}%`);
  }
});

// Not in the fixture: guards against rules that only fit it.
const FRESH: Array<[string, string, OfflineContext?]> = [
  ['Good morning, what brings you here today?', 'patient'],
  ['Since when have you had the cough', 'patient'],
  ['Any allergies that you know of?', 'patient'],
  ['Is the pain worse at night?', 'patient'],
  ['Do you have sugar or BP problems?', 'patient'],
  ['I think this is a viral infection, nothing to worry about', 'patient'],
  ['Your chest x-ray looks fine', 'patient'],
  ['Please take these tablets after food', 'patient'],
  ['My sister is also a doctor', 'patient'],
  ['Are you working as a nurse?', 'patient'],
  ['मुझे आशा है आप जल्दी ठीक हो जाएंगे', 'patient'],
  ['বুকে ব্যথা কত দিন ধরে', 'patient'],
  ['ನಿಮಗೆ ಜ್ವರ ಯಾವಾಗಿನಿಂದ ಇದೆ', 'patient'],
  ['Nurse, please start a saline drip', 'nurse'],
  ['Sister, one ECG please', 'nurse'],
  ['Order a troponin and a chest x-ray', 'nurse'],
  ['Start him on azithromycin 500 once daily for three days', 'nurse'],
  ['Book a review in ten days', 'nurse'],
  ['आशा जी, सीबीसी करवा दीजिए', 'nurse'],
  ['ಒಂದು ಸಿಬಿಸಿ ಮಾಡಿಸಿ', 'nurse'],
  ['Cancel the ultrasound', 'nurse'],
  ['Asha, how am I doing?', 'coach'],
  ['Any hints?', 'coach'],
  ['Let me listen to your lungs', 'exam'],
  ['I am going to press on your tummy', 'exam'],
  ['Pharmacist, is ibuprofen safe for her?', 'pharmacist'],
  ['Ask the pharmacist about the interaction', 'pharmacist'],
  ['Lab, when will the potassium be ready?', 'lab'],
  ['Ask radiology what they see on the film', 'radiology'],
  ['Call the professor, please', 'faculty'],
  ['Override the hold, I will take responsibility', 'faculty'],
  ['yes she is pregnant', 'radiology', { pendingQuestion: { role: 'radiology', ref: 'img_1' } }],
  ['no known allergies', 'pharmacist', { pendingQuestion: { role: 'pharmacist', ref: 'rx_1' } }],
  ['How is your pain now?', 'patient', { pendingQuestion: { role: 'pharmacist', ref: 'rx_1' } }],
  ['because the rash was mild and years ago', 'faculty', { awaitingFaculty: true }],
  ['Asha, how are you feeling today?', 'patient', { patientName: 'Asha Devi' }],
];

test('fresh phrases', () => {
  const bad = FRESH.filter(([u, want, ctx]) => classifyOffline(u, ctx).target !== want).map(([u, want, ctx]) => `${u}: want ${want} got ${classifyOffline(u, ctx).target}`);
  assert.deepEqual(bad, []);
});

test('days are not "give" in Bengali, dizzy is not "do" in Marathi', () => {
  assert.equal(looksLikeOrder('তিন দিন ধরে জ্বর'), false);
  assert.equal(looksLikeOrder('मला चकरा येतात'), false);
  assert.equal(looksLikeOrder('We do not need an ECG today'), false);
  assert.equal(looksLikeOrder('You should stop smoking'), false);
});

test('empty and noise go nowhere', () => {
  for (const u of ['', '   ', '?', 'hmm', 'okay']) assert.equal(classifyOffline(u).target, 'patient', u);
});
