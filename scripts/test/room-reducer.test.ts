/** BAND agent room: the pure reducer over hub events and its derived helpers. */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  awaitingFaculty,
  closeSummary,
  elapsedSeconds,
  emptyRoom,
  factsIn,
  facultyPresent,
  heldDelegations,
  isSideConversation,
  knowledge,
  markAnswered,
  markToldFaculty,
  notShared,
  openQuestion,
  pendingFor,
  roomContext,
  roomReducer,
  roomSummary,
  sharedFields,
  ticker,
  timeline,
  tracker,
  type RoomState,
} from '../../src/room/reducer.ts';
import type { Delegation, RoomEvent, RoomMessage, RoomParticipant } from '../../src/room/types.ts';

const at = (s: number) => new Date(Date.UTC(2026, 10, 23, 10, 0, s)).toISOString();
let seq = 0;
const ev = (e: Record<string, unknown>, s = ++seq): RoomEvent => ({ seq: s, at: at(s), ...e }) as unknown as RoomEvent;
const run = (events: RoomEvent[], from: RoomState = emptyRoom('im-001-1')): RoomState => events.reduce(roomReducer, from);

const person = (id: string, role: string, name: string, human = false): RoomParticipant =>
  ({ id, role, name, title: '', human, online: true }) as RoomParticipant;
const rx = (over: Partial<Delegation> = {}): Delegation => ({
  ref: 'rx_1',
  action: 'verify_rx',
  target: 'pharmacist',
  status: 'sent',
  label: 'Amoxicillin 500 mg',
  startedAt: at(1),
  medicationId: 'amoxicillin',
  dose: '500 mg TDS',
  duration: '7 days',
  ...over,
});
const msg = (over: Partial<RoomMessage>): RoomMessage => ({
  id: 'm1',
  from: 'nurse',
  fromName: 'Nurse Asha',
  to: ['pharmacist'],
  text: 'Please verify.',
  type: 'text',
  human: false,
  at: at(1),
  ...over,
});

test('idempotent by seq: replaying the whole log changes nothing', () => {
  seq = 0;
  const log = [
    ev({ type: 'room', roomId: 'r-1', url: 'https://app.band.ai/rooms/r-1', title: 'T', participants: [person('a', 'nurse', 'Nurse Asha')] }),
    ev({ type: 'delegation', delegation: rx() }),
    ev({ type: 'message', message: msg({}) }),
    ev({ type: 'faculty', faculty: { action: 'joined', name: 'Dr Rao', text: '' } }),
  ];
  const once = run(log);
  assert.equal(run(log, once), once, 'same object back');
  assert.equal(once.lastSeq, 4);
  assert.equal(once.faculty.length, 1);
});

test('status is a snapshot and never moves the cursor', () => {
  const s = run([ev({ type: 'status', enabled: true, departments: { pharmacist: true } }, 99)]);
  assert.equal(s.enabled, true);
  assert.equal(s.lastSeq, 0);
  assert.equal(run([ev({ type: 'delegation', delegation: rx() }, 1)], s).delegations.length, 1);
});

test('messages and delegations upsert; delivery ticks move on the same bubble', () => {
  seq = 0;
  const s = run([
    ev({ type: 'message', message: msg({ delivery: 'sent' }) }),
    ev({ type: 'message', message: msg({ id: 'm2', text: 'other' }) }),
    ev({ type: 'message', message: msg({ delivery: 'processed' }) }),
    ev({ type: 'delegation', delegation: rx() }),
    ev({ type: 'delegation', delegation: rx({ status: 'working' }) }),
  ]);
  assert.deepEqual(s.messages.map((m) => [m.id, m.delivery]), [['m1', 'processed'], ['m2', undefined]]);
  assert.equal(s.delegations.length, 1);
  assert.deepEqual(s.stages.rx_1.map((x) => x.status), ['sent', 'working']);
});

test('tracker keeps the stop at Lab after the verdict', () => {
  seq = 0;
  const labels = (s: RoomState) => tracker(s, s.delegations[0]).map((x) => `${x.label}:${x.state}`);
  let s = run([ev({ type: 'delegation', delegation: rx() }), ev({ type: 'delegation', delegation: rx({ status: 'working' }) })]);
  assert.deepEqual(labels(s), ['sent:done', 'working:now', 'verdict:todo']);
  s = run([ev({ type: 'delegation', delegation: rx({ status: 'waiting', waitingOn: 'lab' }) })], s);
  assert.deepEqual(labels(s), ['sent:done', 'working:done', 'waiting on Lab:now', 'verdict:todo']);
  assert.match(ticker(s), /waiting on Lab/);
  s = run([ev({ type: 'delegation', delegation: rx({ status: 'held', summary: 'Penicillin allergy', finishedAt: at(20) }) })], s);
  assert.deepEqual(labels(s), ['sent:done', 'working:done', 'waiting on Lab:done', 'on hold:bad']);
  assert.equal(heldDelegations(s).length, 1);
  assert.equal(pendingFor(s, 'pharmacist').length, 0);
  assert.equal(elapsedSeconds(s.delegations[0], Date.parse(at(59))), 19);
});

test('added because: the delegation or message that brought a department in', () => {
  seq = 0;
  const asha = person('a', 'nurse', 'Nurse Asha');
  const meera = person('p', 'pharmacist', 'Meera');
  let s = run([
    ev({ type: 'room', roomId: 'r', url: 'u', title: 't', participants: [asha] }),
    ev({ type: 'room', roomId: 'r', url: 'u', title: 't', participants: [asha, meera] }),
  ]);
  assert.equal(s.joinedFor.p, undefined);
  s = run([ev({ type: 'delegation', delegation: rx() })], s);
  assert.equal(s.joinedFor.p, 'check Amoxicillin 500 mg');
  assert.equal(s.joinedFor.a, undefined);
  s = run([
    ev({ type: 'message', message: msg({ id: 'm9', from: 'pharmacist', fromName: 'Meera', to: ['lab'], text: 'eGFR?' }) }),
    ev({ type: 'room', roomId: 'r', url: 'u', title: 't', participants: [asha, meera, person('l', 'lab', 'Dev')] }),
  ], s);
  assert.equal(s.joinedFor.l, 'answer Pharmacy');
});

test('question: open, answered locally, answered in the room, closed by the verdict', () => {
  seq = 0;
  const img = (status: Delegation['status']) =>
    ev({ type: 'delegation', delegation: rx({ ref: 'img_1', action: 'run_imaging', target: 'radiology', status }) });
  let s = run([ev({ type: 'question', ref: 'img_1', from: 'radiology', text: 'Is she pregnant?' })]);
  assert.equal(openQuestion(s)?.ref, 'img_1');
  assert.deepEqual(roomContext(s).pendingQuestion, { role: 'radiology', ref: 'img_1' });
  assert.equal(openQuestion(markAnswered(s, 'img_1', 'No')), null);
  const viaRoom = run([
    ev({ type: 'message', message: msg({ id: 'ma', to: ['radiology'], kind: 'answer', action: 'safety_question', ref: 'img_1', payload: { answer: 'No' } }) }),
  ], s);
  assert.equal(openQuestion(viaRoom), null);
  assert.equal(viaRoom.questions[0].answer, 'No');
  s = run([img('working')], s);
  assert.ok(openQuestion(s), 'still open while the department works');
  s = run([img('done')], s);
  assert.equal(openQuestion(s), null);
});

test('a replayed question that was answered stays answered (server restart)', () => {
  const q = ev({ type: 'question', ref: 'r1', from: 'lab', text: 'Fasting?' }, 3);
  const s = markAnswered(run([q]), 'r1', 'Yes');
  assert.equal(openQuestion(run([q], { ...s, lastSeq: 0 })), null);
});

test('faculty: awaiting reply, replied, approved, left', () => {
  seq = 0;
  let s = run([
    ev({ type: 'room', roomId: 'r', url: 'u', title: 't', participants: [person('f', 'faculty', 'Dr Rao', true)] }),
    ev({ type: 'faculty', faculty: { action: 'joined', name: 'Dr Rao', text: '' } }),
  ]);
  assert.equal(facultyPresent(s), true);
  assert.equal(awaitingFaculty(s), false);
  const invitedOnly = run([ev({ type: 'faculty', faculty: { action: 'invited', name: 'Dr Rao', text: '' } }, 99)], { ...s, faculty: [] });
  assert.equal(facultyPresent(invitedOnly), false, 'on the roster, not here yet');
  s = run([ev({ type: 'faculty', faculty: { action: 'question', name: 'Dr Rao', text: 'What reaction?' } })], s);
  assert.equal(awaitingFaculty(s), true);
  assert.equal(awaitingFaculty(markToldFaculty(s)), false);
  const viaRoom = run([ev({ type: 'message', message: msg({ id: 'mf', to: ['faculty'], text: 'A rash only.' }) })], s);
  assert.equal(awaitingFaculty(viaRoom), false);
  s = run([ev({ type: 'faculty', faculty: { action: 'approve', name: 'Dr Rao', text: 'Go ahead', ref: 'rx_1' } })], s);
  assert.equal(awaitingFaculty(s), false);
  s = run([ev({ type: 'faculty', faculty: { action: 'left', name: 'Dr Rao', text: '' } })], s);
  assert.equal(facultyPresent(s), false);
});

test('side conversation excludes Asha and the faculty', () => {
  assert.equal(isSideConversation(msg({ from: 'pharmacist', to: ['lab'] })), true);
  assert.equal(isSideConversation(msg({ from: 'pharmacist', to: ['lab', 'nurse'] })), false);
  assert.equal(isSideConversation(msg({ from: 'nurse', to: ['lab'] })), false);
  assert.equal(isSideConversation(msg({ from: 'faculty', to: ['lab'], human: true })), false);
  assert.equal(isSideConversation(msg({ from: 'lab', to: ['pharmacist'], type: 'thought' })), false);
});

test('who knows what comes from payload keys, and not-shared is per role', () => {
  seq = 0;
  const payload = {
    caseId: 'im-001',
    medicationId: 'amoxicillin',
    medication: 'Amoxicillin',
    dose: '500 mg',
    patient: { age: 34, gender: 'F', allergies: 'penicillin', chiefComplaint: 'sore throat', history: ['asthma'] },
    current: [],
    osce: false,
  };
  assert.deepEqual(factsIn(payload, 'verify_rx'), ['age and sex', 'complaint', 'allergies', 'history', 'medicines']);
  assert.deepEqual(sharedFields(payload), ['medication', 'dose', 'age', 'gender', 'allergies', 'chief complaint', 'history']);
  const s = run([
    ev({ type: 'message', message: msg({ payload, action: 'verify_rx' }) }),
    ev({
      type: 'message',
      message: msg({ id: 'm2', to: ['lab'], action: 'run_test', payload: { caseId: 'im-001', tests: [{ testId: 'cbc', name: 'CBC' }], patient: { age: 34, gender: 'F' } } }),
    }),
  ]);
  assert.deepEqual(knowledge(s).lab, ['age and sex', 'tests ordered']);
  assert.ok(notShared(s, 'lab').includes('allergies'));
  assert.ok(notShared(s, 'lab').includes('medicines'));
  assert.ok(!notShared(s, 'pharmacist').includes('allergies'));
  assert.ok(notShared(s, 'pharmacist').includes('imaging'));
});

test('timeline, summary for observers and close counts', () => {
  seq = 0;
  const s = run([
    ev({ type: 'status', enabled: true, departments: {} }, 0),
    ev({ type: 'room', roomId: 'r', url: 'https://app.band.ai/rooms/r', title: 't', participants: [person('a', 'nurse', 'Nurse Asha')] }),
    ev({ type: 'delegation', delegation: rx() }),
    ev({ type: 'delegation', delegation: rx({ status: 'waiting', waitingOn: 'lab' }) }),
    ev({ type: 'delegation', delegation: rx({ status: 'held', summary: 'Penicillin allergy' }) }),
    ev({ type: 'faculty', faculty: { action: 'approve', name: 'Dr Rao', text: 'Not a true allergy' } }),
  ]);
  const lines = timeline(s).map((t) => `${t.who} ${t.what}`);
  assert.ok(lines.includes('Asha asked Pharmacy: Amoxicillin 500 mg'));
  assert.ok(lines.includes('Pharmacy asked Lab first'));
  assert.ok(lines.includes('Pharmacy Amoxicillin 500 mg: held. Penicillin allergy'));
  assert.ok(lines.includes('Dr Rao approved: Not a true allergy'));
  assert.equal(closeSummary(s, { tests: 2 }).held, 1);
  assert.equal(closeSummary(s, { tests: 2 }).tests, 2);
  assert.equal(roomSummary(s)?.participants.length, 1);
  assert.equal(roomSummary(emptyRoom('x')), null);
});
