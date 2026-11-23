/**
 * Live faculty observer: RTM message parsing (agent transcripts + medsim.*),
 * transcript assembly, chart-event diffing, the ?observe= param and the
 * inline QR encoder.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  decodeRtmJson,
  mergeTurnText,
  parseAgentMessage,
  parseAgentRtmPayload,
  TranscriptAssembler,
} from '../../src/voice/transcriptParser.ts';
import {
  clampScore,
  encodeMedsim,
  isForMe,
  LIMITS,
  marksAverage,
  parseMedsimMessage,
  type MedsimMessage,
} from '../../src/observer/messages.ts';
import { chartSoFar, diffChart, type ChartLabels, type ChartSlice } from '../../src/observer/chartEvents.ts';
import { parseObserveCode } from '../../src/observer/observeParam.ts';
import { qrMatrix, qrPath } from '../../src/observer/qr.ts';
import type { ActivePatient, CoachAlert, NurseRun } from '../../src/game/types.ts';

const enc = (o: unknown) => new TextEncoder().encode(JSON.stringify(o));

// ── agent transcript parsing ──────────────────────────────────────

test('agent transcripts parse from string and bytes; junk is ignored', () => {
  assert.deepEqual(parseAgentRtmPayload(JSON.stringify({ object: 'user.transcription', text: ' chest pain ', final: true, turn_id: 3 })), {
    kind: 'user',
    text: 'chest pain',
    final: true,
    turnId: '3',
  });
  assert.deepEqual(parseAgentRtmPayload(enc({ object: 'assistant.transcription', text: 'It hurts', turn_status: 0, turn_id: 4 })), {
    kind: 'assistant',
    text: 'It hurts',
    turnStatus: 0,
    turnId: '4',
  });
  assert.equal(parseAgentRtmPayload(JSON.stringify({ object: 'user.transcription', text: '   ' })), null);
  assert.equal(parseAgentRtmPayload('not json'), null);
  assert.equal(parseAgentRtmPayload('[1,2]'), null);
  assert.deepEqual(parseAgentRtmPayload(JSON.stringify({ object: 'message.interrupt', turn_id: 9 })), { kind: 'interrupt', turnId: '9' });
  assert.equal(parseAgentRtmPayload(JSON.stringify({ object: 'medsim.hello' })), null);
  assert.equal(parseAgentMessage(decodeRtmJson('{"object":"user.transcription","text":"ok","final":"true"}'))?.kind, 'user');
});

test('mergeTurnText: cumulative replaces, segmented user finals append', () => {
  assert.equal(mergeTurnText('', 'a', 'user'), 'a');
  assert.equal(mergeTurnText('I have', 'I have pain', 'user'), 'I have pain');
  assert.equal(mergeTurnText('I have pain', 'since morning', 'user'), 'I have pain since morning');
  assert.equal(mergeTurnText('Hello', 'Totally new', 'assistant'), 'Totally new');
});

test('TranscriptAssembler shows partials, settles finals and seeds once', () => {
  const t = new TranscriptAssembler();
  assert.equal(t.seed([{ who: 'patient', text: 'Hi doctor.' }]), true);
  assert.equal(t.seed([{ who: 'doctor', text: 'ignored' }]), false);
  t.apply({ kind: 'user', text: 'what brings', final: false, turnId: '1' });
  assert.deepEqual(t.lines().at(-1), { id: 'doctor:1', who: 'doctor', text: 'what brings', partial: true });
  t.apply({ kind: 'user', text: 'What brings you in?', final: true, turnId: '1' });
  t.apply({ kind: 'assistant', text: 'My chest', turnStatus: 0, turnId: '2' });
  t.apply({ kind: 'assistant', text: 'My chest hurts.', turnStatus: 1, turnId: '2' });
  assert.deepEqual(
    t.lines().map((l) => [l.who, l.text, l.partial]),
    [
      ['patient', 'Hi doctor.', false],
      ['doctor', 'What brings you in?', false],
      ['patient', 'My chest hurts.', false],
    ],
  );
});

// ── medsim.* messages ─────────────────────────────────────────────

const roundTrip = (m: MedsimMessage) => parseMedsimMessage(decodeRtmJson(encodeMedsim(m)));

test('every medsim message type round-trips', () => {
  const marks = {
    id: 'm1',
    caseId: 'im-001',
    scores: { history: 4, examination: 3, diagnosis: 5, management: 2, communication: 4 },
    comment: 'Good ICE.',
    examiner: 'Dr Rao',
    sentAt: 1,
  };
  const msgs: MedsimMessage[] = [
    { object: 'medsim.event', caseId: 'im-001', events: [{ kind: 'order', label: 'Test ordered: ECG', at: 5 }] },
    { object: 'medsim.hello', examiner: 'Dr Rao' },
    { object: 'medsim.whisper', id: 'w1', text: 'Ask about radiation', examiner: 'Dr Rao', at: 2 },
    { object: 'medsim.marks', marks },
    { object: 'medsim.ack', id: 'w1', what: 'whisper' },
    {
      object: 'medsim.snapshot',
      caseId: 'im-001',
      caseLabel: 'Raj, 54M',
      osce: true,
      startedAt: 10,
      transcript: [{ who: 'patient', text: 'Hi' }],
      events: [],
    },
  ];
  for (const m of msgs) assert.deepEqual(roundTrip(m), m, m.object);
});

test('malformed medsim messages are rejected', () => {
  assert.equal(parseMedsimMessage({ object: 'medsim.whisper', id: 'x', text: '  ' }), null);
  assert.equal(parseMedsimMessage({ object: 'medsim.event', events: [{ kind: 'hack', label: 'x', at: 1 }] }), null);
  assert.equal(parseMedsimMessage({ object: 'medsim.unknown' }), null);
  assert.equal(parseMedsimMessage({ object: 'user.transcription', text: 'hi' }), null);
  assert.equal(parseMedsimMessage({ object: 'medsim.ack', id: 'a', what: 'other' }), null);
  // Scores must all be present and 1-5.
  const bad = { id: 'm', caseId: 'c', sentAt: 1, scores: { history: 6, examination: 3, diagnosis: 3, management: 3, communication: 3 } };
  assert.equal(parseMedsimMessage({ object: 'medsim.marks', marks: bad }), null);
  assert.equal(parseMedsimMessage({ object: 'medsim.marks', marks: { ...bad, scores: { history: 3 } } }), null);
});

test('scores clamp, whispers truncate, average is one decimal', () => {
  assert.equal(clampScore(4.4), 4);
  assert.equal(clampScore(0), null);
  assert.equal(clampScore('3'), null);
  const long = parseMedsimMessage({ object: 'medsim.whisper', id: 'w', text: 'x'.repeat(1000) });
  assert.equal(long?.object === 'medsim.whisper' && long.text.length, LIMITS.whisper);
  assert.equal(marksAverage({ scores: { history: 4, examination: 3, diagnosis: 5, management: 2, communication: 4 } }), 3.6);
});

test('targeting: USER messages are always mine, channel messages only when untargeted or to me', () => {
  const w = { object: 'medsim.whisper', id: 'w', text: 't', examiner: '', at: 0 } as const;
  assert.equal(isForMe({ ...w, to: '3000001' }, '3000001', 'MESSAGE'), true);
  assert.equal(isForMe({ ...w, to: '3000002' }, '3000001', 'MESSAGE'), false);
  assert.equal(isForMe(w, '3000001', 'MESSAGE'), true);
  assert.equal(isForMe({ ...w, to: '9' }, '3000001', 'USER'), true);
});

test('oversized snapshots are trimmed under the RTM size cap', () => {
  const transcript = Array.from({ length: 200 }, (_, i) => ({ who: 'doctor' as const, text: `line ${i} ` + 'y'.repeat(300) }));
  const out = encodeMedsim({ object: 'medsim.snapshot', caseId: 'c', caseLabel: 'L', osce: false, startedAt: 0, transcript, events: [] });
  assert.ok(new TextEncoder().encode(out).length <= LIMITS.maxBytes);
  const back = parseMedsimMessage(decodeRtmJson(out));
  assert.ok(back?.object === 'medsim.snapshot' && back.transcript.at(-1)?.text.startsWith('line 199'));
});

// ── chart events ──────────────────────────────────────────────────

const LABELS: ChartLabels = { test: (id) => id.toUpperCase(), medication: (id) => id, diagnosis: (id) => `dx:${id}`, exam: (s) => s };

function patient(over: Partial<ActivePatient> = {}): ActivePatient {
  return {
    case: { id: 'im-001' } as ActivePatient['case'],
    bedIndex: -10,
    status: 'in-bed',
    askedQuestionIds: [],
    orderedTestIds: [],
    testOrderedAt: {},
    completedTestIds: [],
    givenTreatmentIds: [],
    submittedDiagnosisId: null,
    arrivedAt: 1,
    deadlineMs: 2,
    ...over,
  };
}
const slice = (p: ActivePatient | null, alerts: CoachAlert[] = [], runs: NurseRun[] = []): ChartSlice => ({ patient: p, coachAlerts: alerts, agentRuns: runs });

test('diffChart emits orders, exams, alerts, nurse runs and the diagnosis once', () => {
  const a = patient();
  const alert: CoachAlert = { id: 'al1', caseId: 'im-001', severity: 'danger', title: 'Missed ECG', short: 'Get an ECG', explanation: '', suggestion: '', source: 'coach', createdAt: 0 };
  const run: NurseRun = { id: 'r1', caseId: 'im-001', utterance: 'get an ECG', source: 'voice', status: 'done', startedAt: 0, steps: [], intent: 'order', spokenConfirmation: 'ECG done' };
  const b = patient({
    orderedTestIds: ['ecg'],
    examsPerformed: ['cardio'],
    examResults: { cardio: { system: 'cardio', findings: [{ label: 'HS', value: 'S3', abnormal: true }], summary: 'S3 present', sound: 's3', performedAt: 3 } },
    submittedDiagnosisId: 'acs',
    prescriptions: [{ medicationId: 'aspirin', dose: '300 mg', duration: 'stat', prescribedAt: 3 }],
  });
  const ev = diffChart(slice(a), slice(b, [alert], [run]), LABELS, 7);
  const labels = ev.map((e) => e.label);
  assert.deepEqual(labels, [
    'Test ordered: ECG',
    'Prescribed: aspirin',
    'Exam findings: cardio (abnormal)',
    'Diagnosis submitted: dx:acs',
    'Alert: Missed ECG',
    'Nurse executed: "get an ECG"',
  ]);
  assert.equal(ev.find((e) => e.kind === 'alert')?.severity, 'danger');
  // No change, no events; a different case resets the baseline.
  assert.deepEqual(diffChart(slice(b, [alert], [run]), slice(b, [alert], [run]), LABELS), []);
  assert.equal(chartSoFar(slice(b), LABELS).length, 4);
});

// ── ?observe= param and QR ────────────────────────────────────────

test('parseObserveCode accepts only well-formed codes', () => {
  assert.equal(parseObserveCode('?observe=AbCd_-123456.0a1b2c3d4e'), 'AbCd_-123456.0a1b2c3d4e');
  assert.equal(parseObserveCode('?observe=<script>'), null);
  assert.equal(parseObserveCode('?observe=abc.def'), null);
  assert.equal(parseObserveCode(''), null);
});

test('QR encoder: sizes, finder patterns and the dark module', () => {
  const url = 'https://medsim.vercel.app/?observe=AbCdEf123456.0a1b2c3d4e';
  const m = qrMatrix(url);
  assert.equal(m.length, 33); // version 4 at level M
  const finderRow = [true, true, true, true, true, true, true, false];
  assert.deepEqual(m[0].slice(0, 8), finderRow);
  assert.deepEqual(m[0].slice(-7), finderRow.slice(0, 7));
  assert.equal(m[m.length - 8][8], true);
  assert.equal(qrMatrix('hi').length, 21);
  assert.throws(() => qrMatrix('x'.repeat(400)));
  const { size, d } = qrPath(m);
  assert.equal(size, 41);
  assert.match(d, /^M4 4h1v1h-1z/);
});

test('agent room summary: round trip, alone and inside a snapshot, with hostile fields dropped', () => {
  const room = {
    url: 'https://app.band.ai/rooms/r1',
    now: 'Pharmacy is waiting on Lab',
    participants: [{ role: 'nurse' as const, name: 'Nurse Asha', human: false }, { role: 'faculty' as const, name: 'Dr Rao', human: true }],
    items: [{ at: '2026-11-23T10:00:00Z', who: 'Pharmacy', what: 'Amoxicillin: held. Allergy', tone: 'bad' as const }],
  };
  assert.deepEqual(roundTrip({ object: 'medsim.room', caseId: 'im-001', room }), { object: 'medsim.room', caseId: 'im-001', room });
  const snap = roundTrip({ object: 'medsim.snapshot', caseId: 'im-001', caseLabel: 'x', osce: false, startedAt: 1, transcript: [], events: [], room });
  assert.deepEqual(snap && snap.object === 'medsim.snapshot' && snap.room, room);
  const bad = parseMedsimMessage({
    object: 'medsim.room', caseId: 'c',
    room: { url: 'javascript:alert(1)', participants: [{ role: 'root', name: 'x' }, 7], items: [{ who: 'A', what: 'b'.repeat(900), tone: 'x' }] },
  });
  assert.ok(bad && bad.object === 'medsim.room');
  assert.deepEqual([bad.room.url, bad.room.participants.length, bad.room.items[0].what.length, bad.room.items[0].tone], ['', 0, LIMITS.roomText, undefined]);
  assert.equal(parseMedsimMessage({ object: 'medsim.room', caseId: 'c' }), null);
});

test('faculty token: only a well-formed &fac= counts', async () => {
  const { parseFacultyToken } = await import('../../src/observer/observeParam.ts');
  const tok = 'aB3_-'.repeat(6) + 'xy';
  assert.equal(parseFacultyToken(`?observe=abc&fac=${tok}`), tok);
  assert.equal(parseFacultyToken('?observe=abc'), null);
  assert.equal(parseFacultyToken('?fac=short'), null);
  assert.equal(parseFacultyToken(`?fac=${tok}%3Cscript%3E`), null);
});
