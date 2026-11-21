/**
 * Nurse prefilter in `src/agents/nurseIntent.ts`: loose orders, Hinglish and
 * anything addressed to the nurse reach the agent; questions to the patient
 * do not. Also the broadened coach hint trigger, exam phrasings and
 * natural observer invites.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { CLINICAL_WORDS, isAddressedToNurse, looksLikeOrder } from '../../src/agents/nurseIntent.ts';
import { classifyExam } from '../../src/agents/examClassifier.ts';
import { findContact, parseInviteCommand, type ObserverContact } from '../../src/observer/contacts.ts';

test('clinical word set is built from the catalogues', () => {
  for (const w of ['amoxicillin', 'paracetamol', 'troponin', 'cbc', 'xray', 'metformin']) assert.ok(CLINICAL_WORDS.has(w), w);
  for (const w of ['chest', 'blood', 'pain', 'test']) assert.ok(!CLINICAL_WORDS.has(w), w);
});

test('anything addressed to the nurse goes to the agent', () => {
  for (const t of [
    'Nurse, what do you think?',
    'Sister, can you help here',
    'Asha please',
    "Okay didi, let's wrap up",
    "Ma'am, one more thing",
    'can you ask the nurse to do it',
  ]) {
    assert.ok(isAddressedToNurse(t), t);
    assert.ok(looksLikeOrder(t), t);
  }
  assert.ok(!isAddressedToNurse('Tell me about your pain'));
});

test('loose orders are recognised', () => {
  for (const t of [
    'She needs an antibiotic.',
    'Get her sugar checked.',
    'Chest x-ray please',
    "Let's put him on fluids",
    'Bloods',
    'Sort out the pain',
    'ek ECG kara do',
    'paracetamol de do',
    'CBC and LFT',
    'I want a troponin and an ECG',
    'Should we get an ECG?',
    'start amoxicillin five hundred three times a day',
    'can we do a urinalysis',
    'book a follow-up in two weeks',
    'something for the acidity',
    'okay so I think we should give him some ondansetron for the vomiting',
    'drip laga do',
  ]) assert.ok(looksLikeOrder(t), t);
});

test('questions and history talk to the patient are not orders', () => {
  for (const t of [
    'Do you take any medication?',
    'Have you ever had an ECG before?',
    'How long have you had the fever',
    'Are you allergic to penicillin?',
    'Does your chest hurt when you breathe?',
    'Okay, and when did the pain start?',
    'Tell me about your pain.',
    "You've been taking metformin for two years now, right",
    'Hello, I am the doctor today.',
    'Hmm',
  ]) assert.ok(!looksLikeOrder(t), t);
});

test('looser exam phrasings and Hinglish', () => {
  const cases: Array<[string, string]> = [
    ['Check his chest.', 'resp'],
    ['Listen to the heart.', 'cardio'],
    ['Feel the tummy', 'abdomen'],
    ['Look in the throat', 'ent'],
    ['BP lena', 'vitals'],
    ['pulse dekho', 'vitals'],
    ['pet dabao', 'abdomen'],
    ['Have a quick listen to the chest', 'resp'],
    ['take her BP', 'vitals'],
  ];
  for (const [text, want] of cases) assert.equal(classifyExam(text), want, text);
  for (const text of [
    'Did you check your blood pressure at home?',
    'Does your chest hurt?',
    'How is your heart condition these days?',
    'Have you looked at your skin recently?',
  ]) assert.equal(classifyExam(text), null, text);
});

const book: ObserverContact[] = [
  { id: '1', name: 'Darshan Kumar', relation: 'teacher', phone: '+919876543210' },
  { id: '2', name: 'Meera', relation: 'friend', phone: '+919876543211' },
];

test('natural invite phrasings', () => {
  const cases: Array<[string, string]> = [
    ['can you ask Darshan to sit in on this', 'Darshan'],
    ['Darshan should watch this', 'Darshan'],
    ['get Darshan on the line', 'Darshan'],
    ['call my teacher Darshan', 'Darshan'],
    ['I want Darshan to see this', 'Darshan'],
  ];
  for (const [text, name] of cases) {
    const cmd = parseInviteCommand(text);
    assert.ok(cmd, text);
    assert.equal(cmd!.name, name, text);
    assert.equal(cmd!.explicit, true, text);
  }
  assert.equal(parseInviteCommand('She should take this twice a day'), null);
  assert.equal(parseInviteCommand('I want a CBC'), null);
});

test('relation words resolve to the single matching contact', () => {
  const cmd = parseInviteCommand('call my teacher');
  assert.ok(cmd);
  assert.equal(findContact(cmd!.name, book)?.name, 'Darshan Kumar');
  assert.equal(findContact('my friend', book)?.name, 'Meera');
  const two: ObserverContact[] = [...book, { id: '9', name: 'Ravi', relation: 'teacher', phone: '+919999999999' }];
  assert.equal(findContact('my teacher', two), null);
  assert.equal(findContact('sir', book)?.name, 'Darshan Kumar');
});
