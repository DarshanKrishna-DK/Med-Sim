import test from 'node:test';
import assert from 'node:assert/strict';
import { academicContext, asAcademic, clinicForSubject, finalScore, isSigned, nextStep, stampOf, statusLine, vivaDomains, type AcademicSide, type SignStatus } from '../../src/room/academicCore.ts';
import { deskNews, type DeskItem } from '../../src/room/deskCore.ts';
import { SideSession, roomIdOf, type SideDeps } from '../../src/room/sideSession.ts';
import type { RoomEvent, SideState } from '../../src/room/types.ts';
import { VIVA_SUBJECTS } from '../../src/components/viva/vivaCore.ts';
import { CLINIC_IDS } from '../../src/game/clinic.ts';

const side = (status: SignStatus, over: Partial<AcademicSide> = {}): AcademicSide => ({
  kind: 'academic', refId: 'r', status, final: false, url: '', total: 58, ...over,
});

test('only a human decision reads as signed', () => {
  for (const s of ['new', 'drafting', 'draft', 'awaiting_signoff', 'sent_back', 'unavailable'] as SignStatus[]) {
    assert.equal(isSigned(side(s)), false, s);
    assert.notEqual(stampOf(side(s)).tone, 'signed', s);
    assert.ok(statusLine(side(s)).length > 10, s);
  }
  const revised = side('revised', { adjustedScore: 64, signedBy: 'Dr Rao' });
  assert.equal(isSigned(revised), true);
  assert.equal(finalScore(revised), 64);
  assert.equal(finalScore(side('signed_off', { adjustedScore: 64 })), 58, 'a plain signature keeps the marking');
  assert.match(statusLine(revised), /Dr Rao with 64 instead of 58/);
});

test('the student gets one next step, and none while it is somebody else\'s move', () => {
  assert.equal(nextStep(side('draft'))?.action, 'invite');
  assert.equal(nextStep(side('sent_back'))?.label, 'Ask faculty to look again');
  assert.equal(nextStep(side('unavailable'))?.action, 'retry');
  for (const s of ['drafting', 'awaiting_signoff', 'signed_off', 'revised'] as SignStatus[]) assert.equal(nextStep(side(s)), null, s);
  assert.equal(nextStep(side('draft', { inviting: true })), null);
});

test('the request body is capped and foreign side states are refused', () => {
  const c = academicContext({
    resultKey: 'osce:1', what: 'osce', total: 57.6, markKey: 'card-001', patientNames: ['Ravi Kumar', 'x'], studentName: 'A',
    domains: Array.from({ length: 12 }, (_, i) => ({ name: `d${i}`, score: 1, max: 2, note: 'n'.repeat(500) })),
    strengths: [], improvements: ['a', 'b', 'c', 'd', 'e'],
  });
  assert.equal(c.total, 58);
  assert.equal((c.domains as unknown[]).length, 8);
  assert.equal((c.improvements as unknown[]).length, 4);
  assert.deepEqual(c.patientNames, ['Ravi Kumar']);
  assert.ok(!('resultKey' in c));
  assert.equal(asAcademic({ kind: 'desk', refId: 'r', status: 'draft', final: false, url: '' }), null);
  assert.equal(asAcademic({ ...side('draft'), status: 'hacked' as SignStatus }), null);
});

test('every viva subject practises in a clinic that exists', () => {
  for (const s of VIVA_SUBJECTS) assert.ok(CLINIC_IDS.includes(clinicForSubject(s.id)), s.id);
  const d = vivaDomains([
    { difficulty: 1, verdict: 'correct', q: 'a' },
    { difficulty: 2, verdict: 'partial', q: 'b' },
    { difficulty: 3, verdict: 'not asked', q: 'c' },
  ]);
  assert.deepEqual(d.map((x) => [x.name, x.score, x.max]), [['Recall questions', 10, 10], ['Applied questions', 5, 10]]);
});

test('each desk answer is delivered once, and a plan once', () => {
  const item: DeskItem = { sideId: 'side.desk.a', kind: 'desk', at: 0, seen: [], done: false };
  const s: SideState = { kind: 'desk', refId: 'a', status: 'answered', final: false, url: '', answers: [{ id: 'm1', by: 'Dr Rao', text: 'Yes.', spoken: 'x' }] };
  const a = deskNews(item, s);
  assert.deepEqual(a.news.map((n) => n.shown), ['Dr Rao replied: Yes.']);
  assert.deepEqual(deskNews(a.next, s).news, []);
  assert.equal(deskNews(a.next, s).next, a.next);
  const plan: DeskItem = { ...item, kind: 'desk_plan' };
  const ready: SideState = { kind: 'desk_plan', refId: 'a', status: 'ready', final: true, url: '', spoken: 's', plan: { status: 'ready', topic: 'ECG' } };
  const p = deskNews(plan, ready);
  assert.equal(p.news.length, 1);
  assert.equal(p.next.done, true);
  assert.deepEqual(deskNews({ ...plan, seen: ['plan'] }, ready).news, [], 'Priya already said it');
  assert.equal(deskNews(plan, { ...ready, status: 'failed' }).news[0].id, 'failed');
});

function rig(replies: Array<Record<string, unknown> | null | Error>) {
  const calls: Array<{ path: string; body?: unknown }> = [];
  const timers: Array<() => void> = [];
  const streams: Array<{ url: string; on: { open: () => void; event: (d: string) => void; error: () => void }; closed: boolean }> = [];
  const next = async () => {
    const r = replies.shift();
    if (r instanceof Error) throw r;
    return r as never;
  };
  const deps: SideDeps = {
    post: async (path, body) => { calls.push({ path, body }); return next(); },
    get: async (path) => { calls.push({ path }); return next(); },
    connect: (url, on) => { const s = { url, on, closed: false }; streams.push(s); return { close: () => { s.closed = true; } }; },
    setTimer: (fn) => { timers.push(fn); return fn; },
    clearTimer: () => undefined,
  };
  return { deps, calls, timers, streams };
}

const opened = (status: string, url = ''): Record<string, unknown> => ({ enabled: true, id: 'side.academic.r', side: { kind: 'academic', refId: 'r', status, final: false, url } });
const ev = (seq: number, status: string): string => JSON.stringify({ seq, at: '', type: 'side', side: { kind: 'academic', refId: 'r', status, final: false, url: 'https://app.band.ai/rooms/ab-12' } } as RoomEvent);

test('a side session opens, follows, reconnects with its room and survives a restarted log', async () => {
  const r = rig([opened('new'), opened('drafting')]);
  const states: string[] = [];
  const s = new SideSession({ open: { kind: 'academic', refId: 'r' } }, { onState: (x) => states.push(x.status) }, r.deps);
  await s.start();
  assert.equal(r.streams[0].url, '/agent/room/side.academic.r/stream?after=0');
  r.streams[0].on.event(ev(7, 'draft'));
  r.streams[0].on.event(ev(7, 'draft'));
  assert.deepEqual(states, ['new', 'draft']);
  r.streams[0].on.error();
  r.timers[0]();
  await new Promise((f) => setImmediate(f));
  assert.equal((r.calls[1].body as { roomId?: string }).roomId, 'ab-12', 'the room is offered back');
  assert.equal(r.streams[0].closed, true);
  r.streams[1].on.event(ev(2, 'signed_off')); // the new log counts from one again
  assert.deepEqual(states, ['new', 'draft', 'drafting', 'signed_off']);
  s.stop();
  r.streams[1].on.event(ev(3, 'draft'));
  assert.equal(states.length, 4, 'nothing after stop');
});

test('disabled, gone and unreachable rooms end quietly', async () => {
  const out: string[] = [];
  const off = rig([{ enabled: false, reason: 'no key' }]);
  await new SideSession({ open: { kind: 'academic', refId: 'r' } }, { onState: () => undefined, onDisabled: (x) => out.push(x) }, off.deps).start();
  const gone = rig([null]);
  await new SideSession({ id: 'side.desk.x' }, { onState: () => undefined, onGone: () => out.push('gone') }, gone.deps).start();
  const down = rig(Array.from({ length: 5 }, () => new Error('down')));
  const s = new SideSession({ open: { kind: 'academic', refId: 'r' } }, { onState: () => undefined, onDisabled: (x) => out.push(x) }, down.deps);
  for (let i = 0; i < 5; i++) await s.start();
  assert.deepEqual(out, ['no key', 'gone', 'not reachable']);
  assert.equal(roomIdOf('https://app.band.ai/rooms/7c1e4b90-5d2f'), '7c1e4b90-5d2f');
  assert.equal(roomIdOf('https://x/rooms/../etc'), '');
});
