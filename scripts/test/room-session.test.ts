/** BAND agent room: opening, reconnecting and exactly-once effects. */

import test from 'node:test';
import assert from 'node:assert/strict';

import { claimLine, parseRoomEvent, resetClaimedLines, resetExactlyOnce, RoomSession, type SessionDeps } from '../../src/room/session.ts';

type Conn = { url: string; open: () => void; event: (d: string) => void; error: () => void; closed: boolean };

function rig(opts: { enabled?: boolean; failOpen?: number } = {}) {
  const conns: Conn[] = [];
  const posts: Array<{ path: string; body: unknown }> = [];
  const timers: Array<() => void> = [];
  const applies: string[] = [];
  const speaks: string[] = [];
  let fail = opts.failOpen ?? 0;
  const deps: SessionDeps = {
    post: async (path, body) => {
      posts.push({ path, body });
      if (path.endsWith('/open') && fail-- > 0) throw new Error('down');
      return path.endsWith('/open') ? { enabled: opts.enabled ?? true } : { ok: true, ref: 'r', url: 'u' };
    },
    connect: (url, on) => {
      const c: Conn = { url, ...on, closed: false };
      conns.push(c);
      return { close: () => void (c.closed = true) };
    },
    setTimer: (fn) => timers.push(fn),
    clearTimer: () => undefined,
    onState: () => undefined,
    onApply: (a) => void applies.push(a.ref),
    onSpeak: (s) => void speaks.push(s.id),
  };
  const make = (encounterId = 'im-001-5') => new RoomSession({ encounterId, caseId: 'im-001', lang: 'en', osce: false, patient: {} }, deps);
  return { make, conns, posts, timers, applies, speaks };
}

const at = '2026-11-23T10:00:00.000Z';
const apply = (seq: number, ref = 'lab_1') => JSON.stringify({ seq, at, type: 'apply', apply: { ref, results: [] } });
const speak = (seq: number, id = 'sp1') =>
  JSON.stringify({ seq, at, type: 'speak', speak: { id, speaker: 'lab', text: 'x', lang: 'en', priority: 'result' } });
const tick = () => new Promise((res) => setImmediate(res));

test('opens once, streams from 0, goes live', async () => {
  resetExactlyOnce();
  const r = rig();
  const s = r.make();
  await Promise.all([s.start(), s.start()]);
  assert.equal(r.posts.length, 1);
  assert.equal(r.conns.length, 1);
  assert.equal(r.conns[0].url, '/agent/room/im-001-5/stream?after=0');
  r.conns[0].open();
  assert.equal(s.getState().connection, 'live');
});

test('apply and speak fire exactly once across replay, reconnect and a rebuilt session', async () => {
  resetExactlyOnce();
  const r = rig();
  const s = r.make();
  await s.start();
  r.conns[0].open();
  r.conns[0].event(apply(1));
  r.conns[0].event(speak(2));
  r.conns[0].event(apply(1)); // duplicate frame
  assert.deepEqual([r.applies, r.speaks], [['lab_1'], ['sp1']]);

  r.conns[0].error();
  assert.equal(r.conns[0].closed, true);
  assert.equal(s.getState().connection, 'offline');
  r.timers.pop()!();
  await tick();
  assert.equal(r.conns[1].url, '/agent/room/im-001-5/stream?after=2');
  r.conns[0].event(apply(9, 'ghost')); // late frame of the dead stream
  r.conns[1].event(apply(1));
  r.conns[1].event(speak(2));
  assert.deepEqual([r.applies, r.speaks], [['lab_1'], ['sp1']]);

  s.stop();
  const again = r.make(); // StrictMode / hot reload: same encounter, replay from 0
  await again.start();
  r.conns[2].event(apply(1));
  r.conns[2].event(speak(2));
  r.conns[2].event(apply(3)); // same ref, new seq: a real second change
  assert.deepEqual([r.applies, r.speaks], [['lab_1', 'lab_1'], ['sp1']]);
});

test('another encounter has its own keys', async () => {
  resetExactlyOnce();
  const r = rig();
  const a = r.make('im-001-5');
  const b = r.make('im-001-6');
  await a.start();
  await b.start();
  r.conns[0].event(apply(1));
  r.conns[1].event(apply(1));
  assert.equal(r.applies.length, 2);
  a.stop();
  r.conns[0].event(apply(2, 'late'));
  assert.equal(r.applies.length, 2, 'a stopped session does nothing');
});

test('disabled room never streams; a failing open retries then settles in legacy mode', async () => {
  const off = rig({ enabled: false });
  const s = off.make();
  await s.start();
  assert.equal(off.conns.length, 0);
  assert.equal(s.getState().connection, 'idle');

  const r = rig({ failOpen: 9 });
  const f = r.make();
  await f.start();
  for (let i = 0; i < 5 && r.timers.length; i++) {
    r.timers.pop()!();
    await tick();
  }
  assert.equal(f.getState().connection, 'idle');
  assert.equal(f.getState().enabled, false);
});

test('a status behind our cursor means the server log restarted: read it again', async () => {
  resetExactlyOnce();
  const r = rig();
  const s = r.make();
  await s.start();
  r.conns[0].open();
  r.conns[0].event(apply(40));
  const status = JSON.stringify({ seq: 0, at, type: 'status', enabled: true, departments: {} });
  r.conns[0].event(status);
  assert.equal(r.conns.length, 2);
  assert.equal(r.conns[1].url, '/agent/room/im-001-5/stream?after=0');
  r.conns[1].event(status);
  assert.equal(r.conns.length, 2, 'no loop');
});

test('actions hit the contract routes; answering clears the open question', async () => {
  const r = rig();
  const s = r.make();
  await s.start();
  r.conns[0].event(JSON.stringify({ seq: 1, at, type: 'question', ref: 'img_1', from: 'radiology', text: 'Pregnant?' }));
  await s.answer('img_1', 'No', 'en');
  assert.equal(s.getState().questions[0].answer, 'No');
  await s.ask('pharmacist', 'Safe?', 'hi');
  await s.inviteFaculty();
  await s.sayToFaculty('A rash');
  await s.override('rx_1', 'not a true allergy');
  await s.cancel('rx_1');
  await s.retryDelegation('rx_1');
  await s.close({ held: 1 });
  assert.deepEqual(
    r.posts.slice(1).map((p) => p.path.replace('/agent/room/im-001-5', '')),
    ['/answer', '/ask', '/faculty/invite', '/faculty/say', '/override', '/cancel', '/retry', '/close'],
  );
  assert.deepEqual(r.posts[2].body, { target: 'pharmacist', utterance: 'Safe?', lang: 'hi' });
});

test('malformed frames are ignored; the same sentence is claimed once', () => {
  assert.equal(parseRoomEvent('nope'), null);
  assert.equal(parseRoomEvent('{"seq":1}'), null);
  resetClaimedLines();
  assert.equal(claimLine('Sent to pharmacy, doctor.', 1000), true);
  assert.equal(claimLine('sent to pharmacy doctor', 2000), false);
  assert.equal(claimLine('Sent to pharmacy, doctor.', 40_000), true);
  assert.equal(claimLine('  ', 1), false);
});
