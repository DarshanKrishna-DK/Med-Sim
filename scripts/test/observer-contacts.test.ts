/**
 * Observer contact book: phone / Telegram normalisation, fuzzy name match and
 * the "invite Darshan to observe" command parser.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  editDistance,
  findContact,
  normalizePhone,
  normalizeTelegram,
  parseInviteCommand,
  validateContact,
  type ObserverContact,
} from '../../src/observer/contacts.ts';

const book: ObserverContact[] = [
  { id: '1', name: 'Darshan Kumar', relation: 'teacher', phone: '+919876543210', telegram: '@darshan_k' },
  { id: '2', name: 'Meera Iyer', relation: 'senior', phone: '+919811111111' },
  { id: '3', name: 'Asha Rao', relation: 'family', phone: '+919822222222' },
  { id: '4', name: 'Ravi', relation: 'friend', phone: '+919833333333' },
  { id: '5', name: 'Ravi Shankar', relation: 'classmate', phone: '+919844444444' },
];

test('phone normalisation: 10 digits are +91, E.164 kept, junk rejected', () => {
  assert.equal(normalizePhone('9876543210'), '+919876543210');
  assert.equal(normalizePhone('98765 43210'), '+919876543210');
  assert.equal(normalizePhone('098765-43210'), '+919876543210');
  assert.equal(normalizePhone('919876543210'), '+919876543210');
  assert.equal(normalizePhone('+91 98765 43210'), '+919876543210');
  assert.equal(normalizePhone('0091 9876543210'), '+919876543210');
  assert.equal(normalizePhone('+1 (737) 250-8034'), '+17372508034');
  assert.equal(normalizePhone('12345'), null);
  assert.equal(normalizePhone('+12'), null);
  assert.equal(normalizePhone('call me'), null);
  assert.equal(normalizePhone(''), null);
});

test('telegram normalisation', () => {
  assert.equal(normalizeTelegram(''), '');
  assert.equal(normalizeTelegram(undefined), '');
  assert.equal(normalizeTelegram('Telegram'), 'telegram');
  assert.equal(normalizeTelegram('@Darshan_K'), '@darshan_k');
  assert.equal(normalizeTelegram('darshan_k'), '@darshan_k');
  assert.equal(normalizeTelegram('https://t.me/darshan_k'), '@darshan_k');
  assert.equal(normalizeTelegram('tg:123456789'), 'tg:123456789');
  assert.equal(normalizeTelegram('@ab'), null);
  assert.equal(normalizeTelegram('not a handle!'), null);
});

test('validateContact flags each bad field', () => {
  assert.deepEqual(validateContact({ name: 'Darshan', relation: 'teacher', phone: '9876543210' }), {});
  const e = validateContact({ name: 'D', relation: 'friend', phone: '12', telegram: '!!' });
  assert.ok(e.name && e.phone && e.telegram);
});

test('edit distance', () => {
  assert.equal(editDistance('darshan', 'darshan'), 0);
  assert.equal(editDistance('darshan', 'darshn'), 1);
  assert.equal(editDistance('darshan', 'dharshan'), 1);
  assert.equal(editDistance('kitten', 'sitting'), 3);
  assert.ok(editDistance('darshan', 'meera', 1) > 1);
});

test('findContact: case-insensitive, first name, one typo, ambiguity', () => {
  assert.equal(findContact('darshan', book)?.id, '1');
  assert.equal(findContact('DARSHAN KUMAR', book)?.id, '1');
  assert.equal(findContact('Dr. Darshan', book)?.id, '1');
  assert.equal(findContact('Dharshan', book)?.id, '1');
  assert.equal(findContact('darshn', book)?.id, '1');
  assert.equal(findContact('meera', book)?.id, '2');
  assert.equal(findContact('Mera', book)?.id, '2');
  assert.equal(findContact('Mira', book), null); // two edits away
  // Exact full-name match beats the shared first name.
  assert.equal(findContact('Ravi', book)?.id, '4');
  assert.equal(findContact('Ravi Shankar', book)?.id, '5');
  assert.equal(findContact('Priya', book), null);
  assert.equal(findContact('', book), null);
  assert.equal(findContact('Al', [{ id: 'x', name: 'Ali', relation: 'friend', phone: '+919800000000' }]), null);
});

test('findContact: two people with the same first name and no exact match is ambiguous', () => {
  const twins: ObserverContact[] = [
    { id: 'a', name: 'Priya Nair', relation: 'friend', phone: '+919800000001' },
    { id: 'b', name: 'Priya Shah', relation: 'senior', phone: '+919800000002' },
  ];
  assert.equal(findContact('Priya', twins), null);
  assert.equal(findContact('Priya Shah', twins)?.id, 'b');
});

test('parseInviteCommand: observer requests', () => {
  assert.deepEqual(parseInviteCommand('invite darshan to observe'), { name: 'darshan', explicit: true });
  assert.deepEqual(parseInviteCommand('Invite Darshan.'), { name: 'Darshan', explicit: true });
  assert.deepEqual(parseInviteCommand('Invite Darshan please'), { name: 'Darshan', explicit: true });
  assert.deepEqual(parseInviteCommand('call Darshan to watch'), { name: 'Darshan', explicit: true });
  assert.deepEqual(parseInviteCommand('Asha, ask Darshan to join'), { name: 'Darshan', explicit: true });
  assert.deepEqual(parseInviteCommand('Okay nurse, can you invite Darshan Kumar to observe this?'), {
    name: 'Darshan Kumar',
    explicit: true,
  });
  assert.deepEqual(parseInviteCommand('Asha please call Meera to come and watch'), { name: 'Meera', explicit: true });
  // A bare "call X" only counts when X is a saved contact (decided by the caller).
  assert.deepEqual(parseInviteCommand('call Darshan'), { name: 'Darshan', explicit: false });
});

test('parseInviteCommand: patient and clinical lines are not observer requests', () => {
  for (const t of [
    'Call me if it gets worse',
    'Invite your husband in',
    'Ask your mother to join us',
    'call the lab',
    'Asha, call security',
    'ask Darshan',
    'How long have you had the cough?',
    'Asha, order a CBC and urine dip',
    'I will invite you back next week',
    'invite',
  ]) {
    assert.equal(parseInviteCommand(t), null, t);
  }
});
