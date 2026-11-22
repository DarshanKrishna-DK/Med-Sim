/**
 * Router (src/voice/router.ts): backend call with fallback, dispatch table,
 * segmented turns (B10), one nurse run at a time, acks. Plus the patient's
 * context notes (src/voice/contextNotes.ts).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { newSuffix, routeUtterance, UtteranceDispatcher, type DispatchDeps, type RoomActions, type Route, type RouteContext } from '../../src/voice/router.ts';
import { ContextNotes, MAX_CHARS, MAX_NOTES, safeNote } from '../../src/voice/contextNotes.ts';

const flush = async () => {
  for (let i = 0; i < 4; i++) await new Promise((r) => setImmediate(r));
};

const route = (target: Route['target'], action: Route['action'] = 'order', confidence = 0.9): Route => ({ target, action, confidence, via: 'rule', text: '' });

function rig(opts: { routes?: (t: string) => Route; ctx?: RouteContext; room?: RoomActions | null; exam?: boolean; observer?: boolean } = {}) {
  const log: string[] = [];
  const timers = new Map<number, { fn: () => void; ms: number }>();
  let id = 0;
  let enc: string | null = 'e1';
  const nurse: Array<{ text: string; finish: () => void }> = [];
  const deps: DispatchDeps = {
    route: async (t) => ({ ...(opts.routes?.(t) ?? route('nurse')), text: t }),
    context: () => opts.ctx ?? {},
    encounter: () => enc,
    runNurse: (text) => {
      log.push(`nurse:${text}`);
      return new Promise<void>((res) => nurse.push({ text, finish: res }));
    },
    runExam: (t) => {
      log.push(`exam:${t}`);
      return opts.exam ?? true;
    },
    runObserver: (t) => {
      if (opts.observer) log.push(`observer:${t}`);
      return !!opts.observer;
    },
    requestHint: () => {
      log.push('hint');
    },
    room: () => opts.room ?? null,
    ack: (k) => log.push(`ack:${k}`),
    failed: () => log.push('failed'),
    silenceStaff: () => log.push('silence'),
    setTimeout: (fn, ms) => {
      timers.set(++id, { fn, ms });
      return id;
    },
    clearTimeout: (h) => {
      timers.delete(h as number);
    },
  };
  const d = new UtteranceDispatcher(deps);
  return {
    d,
    log,
    nurse,
    timers,
    setEnc: (e: string | null) => (enc = e),
    fire: () => {
      for (const [k, t] of [...timers]) {
        timers.delete(k);
        t.fn();
      }
    },
    say: (t: string, o?: Parameters<UtteranceDispatcher['handle']>[2]) => d.handle(t, 'voice', o),
  };
}

const roomOf = (log: string[], over: Partial<RoomActions> = {}): RoomActions => ({
  roomActive: () => true,
  askDepartment: async (r, t) => log.push(`ask:${r}:${t}`),
  answerQuestion: async (r, t) => log.push(`answer:${r}:${t}`),
  inviteFaculty: async (t) => log.push(`invite:${t}`),
  sayToFaculty: async (t) => log.push(`faculty:${t}`),
  requestOverride: async (r, t) => log.push(`override:${r}:${t}`),
  ...over,
});

// ── backend call ────────────────────────────────────────────────

const reply = (body: unknown, ok = true) => (async () => ({ ok, status: ok ? 200 : 500, json: async () => body })) as unknown as typeof fetch;

test('uses the backend route and sends the contract body', async () => {
  let sent: any = null;
  const f = (async (_u: string, init: RequestInit) => {
    sent = JSON.parse(String(init.body));
    return { ok: true, json: async () => ({ target: 'pharmacist', action: 'question', confidence: 0.9, via: 'llm', text: 'why?' }) };
  }) as unknown as typeof fetch;
  const r = await routeUtterance(' why is it held ', 'voice', { encounterId: 'e', lang: 'hi', patientName: 'Ravi', gender: 'M', caseId: 'c', pendingQuestion: { role: 'lab', ref: 'r' }, awaitingFaculty: true, heldRef: 'secret' }, { fetch: f });
  assert.deepEqual([r.target, r.action, r.via], ['pharmacist', 'question', 'llm']);
  assert.equal(sent.utterance, 'why is it held');
  assert.deepEqual(sent.context, { patientName: 'Ravi', gender: 'M', caseId: 'c', pendingQuestion: { role: 'lab', ref: 'r' }, awaitingFaculty: true });
  assert.equal(sent.encounterId, 'e');
});

test('falls back offline on errors, bad answers and timeouts', async () => {
  for (const f of [reply({}, false), reply({ target: 'moon' }), (async () => { throw new Error('down'); }) as unknown as typeof fetch]) {
    const r = await routeUtterance('Nurse, get an ECG', 'voice', {}, { fetch: f });
    assert.deepEqual([r.target, r.via], ['nurse', 'offline']);
  }
  const hang = ((_u: string, init: RequestInit) => new Promise((_res, rej) => init.signal!.addEventListener('abort', () => rej(new Error('abort'))))) as unknown as typeof fetch;
  const t0 = Date.now();
  const r = await routeUtterance('How long have you had the fever?', 'voice', {}, { fetch: hang, timeoutMs: 60 });
  assert.equal(r.target, 'patient');
  assert.ok(Date.now() - t0 < 1000);
});

// ── dispatch ────────────────────────────────────────────────────

test('dispatch table', async () => {
  const cases: Array<[Route, RouteContext, string[]]> = [
    [route('patient', 'none'), {}, []],
    [route('nurse'), {}, ['nurse:X']],
    [route('pharmacist', 'question'), {}, ['ask:pharmacist:X']],
    [route('lab', 'question'), {}, ['ask:lab:X']],
    [route('radiology', 'question'), {}, ['ask:radiology:X']],
    [route('lab', 'order'), {}, ['nurse:X']],
    [route('radiology', 'answer'), { pendingQuestion: { role: 'radiology', ref: 'img_1' } }, ['answer:img_1:X']],
    [route('patient', 'answer'), { pendingQuestion: { role: 'radiology', ref: 'img_1' } }, ['answer:img_1:X']],
    [route('faculty', 'invite'), {}, ['invite:X']],
    [route('faculty', 'answer'), { facultyPresent: true }, ['faculty:X']],
    [route('faculty', 'answer'), { facultyPresent: true, pendingQuestion: { role: 'lab', ref: 'q' } }, ['faculty:X']],
    [route('faculty', 'question'), { facultyPresent: false }, ['invite:X']],
    [route('nurse', 'override'), { heldRef: 'rx_9' }, ['override:rx_9:X']],
    [route('nurse', 'override'), {}, ['nurse:X']],
    [route('coach', 'hint'), {}, ['hint']],
    [route('exam', 'order'), {}, ['exam:X']],
  ];
  for (const [r, ctx, want] of cases) {
    const log: string[] = [];
    const x = rig({ routes: () => r, ctx, room: roomOf(log) });
    const h = await x.say('X');
    await flush();
    assert.deepEqual([...x.log, ...log], want, JSON.stringify(r));
    if (r.target === 'patient' && r.action === 'none') assert.equal(h.route.target, 'patient');
  }
});

test('without a room everything falls back to the nurse', async () => {
  for (const r of [route('pharmacist', 'question'), route('faculty', 'invite'), route('nurse', 'override')]) {
    for (const room of [null, { roomActive: () => false, askDepartment: async () => undefined } as RoomActions, { roomActive: () => true } as RoomActions]) {
      const x = rig({ routes: () => r, ctx: { heldRef: 'h' }, room });
      const h = await x.say('X');
      await flush();
      assert.deepEqual(x.log, ['nurse:X']);
      assert.equal(h.route.target, 'nurse');
    }
  }
});

test('a failed room request is announced, not lost', async () => {
  const x = rig({ routes: () => route('lab', 'question'), room: roomOf([], { askDepartment: async () => { throw new Error('503'); } }) });
  const h = await x.say('X');
  await h.done;
  assert.deepEqual(x.log, ['failed']);
});

test('observer: handled when the contact matches, else the nurse', async () => {
  const x = rig({ routes: () => route('observer', 'invite'), observer: true });
  assert.equal((await x.say('invite Darshan')).route.target, 'observer');
  assert.deepEqual(x.log, ['observer:invite Darshan']);
  const y = rig({ routes: () => route('observer', 'invite') });
  assert.equal((await y.say('invite Darshan')).route.target, 'nurse');
  const z = rig({ routes: () => route('patient', 'none'), observer: true });
  assert.equal((await z.say('Darshan should watch this')).route.target, 'observer');
});

test('the nurse command box sends unclaimed lines to the nurse', async () => {
  const x = rig({ routes: () => route('patient', 'none') });
  const h = await x.d.handle('two litres', 'typed', { defaultTarget: 'nurse' });
  await flush();
  assert.equal(h.route.target, 'nurse');
  assert.deepEqual(x.log, ['nurse:two litres']);
  const y = rig({ routes: () => route('coach', 'hint') });
  await y.d.handle('any hints', 'typed', { defaultTarget: 'nurse' });
  assert.deepEqual(y.log, ['hint']);
});

test('"stop talking" silences staff and runs nothing', async () => {
  const x = rig();
  await x.say('Asha, stop talking.');
  await x.say('ok');
  assert.equal(x.log[0], 'silence');
});

// ── B10 ─────────────────────────────────────────────────────────

test('segmented finals of one turn run only what is new', async () => {
  const x = rig();
  const say = (t: string, turn: string) => x.say(t, { turnId: turn });
  await say('order a CBC', '7');
  await say('order a CBC', '7');
  await say('Order a C.B.C.', '7');
  await say('order a CBC and an ECG', '7');
  await say('order a CBC and an ECG please', '8');
  for (let i = 0; i < 4; i++) {
    await flush();
    x.nurse[i]?.finish();
  }
  await flush();
  assert.deepEqual(x.log, ['nurse:order a CBC', 'nurse:and an ECG', 'nurse:order a CBC and an ECG please']);
});

test('a continuation stays with whoever the turn was for', async () => {
  const x = rig({ routes: (t) => (t.startsWith('order') ? route('nurse') : route('patient', 'none', 0.6)) });
  await x.say('order a CBC', { turnId: '1' });
  const h = await x.say('order a CBC and the usual ones', { turnId: '1' });
  assert.equal(h.route.target, 'nurse');
  const h2 = await x.say('order a CBC and the usual ones how are you feeling', { turnId: '1' });
  assert.equal(h2.route.target, 'patient');
});

test('newSuffix', () => {
  assert.equal(newSuffix('', 'hello there'), 'hello there');
  assert.equal(newSuffix('order a c b c', 'Order a CBC and ECG'), 'and ECG');
  assert.equal(newSuffix('order cbc, ecg', 'order cbc'), '');
  assert.equal(newSuffix('start amoxicilin now', 'start amoxicillin now and book a review'), 'and book a review');
  assert.equal(newSuffix('tell me about the pain', 'nurse get an ecg'), 'nurse get an ecg');
  assert.equal(newSuffix('एक ईसीजी करा दो', 'एक ईसीजी करा दो। और शुगर भी'), 'और शुगर भी');
  assert.equal(newSuffix('order an x-ray', 'order an X ray, and a CBC'), 'and a CBC');
});

// ── nurse queue and acks ────────────────────────────────────────

test('nurse runs are queued one at a time, for this patient only', async () => {
  const x = rig();
  await x.say('one thing');
  await x.say('two things');
  await x.say('three things');
  await flush();
  assert.deepEqual(x.log, ['nurse:one thing']);
  x.nurse[0].finish();
  await flush();
  assert.deepEqual(x.log, ['nurse:one thing', 'nurse:two things']);
  x.setEnc('e2');
  x.nurse[1].finish();
  await flush();
  assert.equal(x.log.length, 2, 'the third was for a patient who left');
});

test('ack only when the run is slow, and never after it is done', async () => {
  const x = rig();
  await x.say('order a CBC');
  await flush();
  assert.equal([...x.timers.values()][0].ms, 1200);
  x.fire();
  assert.deepEqual(x.log, ['nurse:order a CBC', 'ack:order']);
  x.nurse[0].finish();
  await flush();

  const y = rig({ routes: () => route('nurse', 'question') });
  await y.say('is it back');
  await flush();
  y.nurse[0].finish();
  await flush();
  assert.equal(y.timers.size, 0);
  assert.deepEqual(y.log, ['nurse:is it back']);

  const z = rig({ routes: () => route('nurse', 'none') });
  await z.say('thanks nurse');
  assert.equal(z.timers.size, 0, 'small talk gets no "right away"');
});

test('an utterance that was being routed when the patient changed does nothing', async () => {
  const x = rig();
  const p = x.say('order a CBC');
  x.setEnc('e2');
  const h = await p;
  await flush();
  assert.equal(h.route.target, 'patient');
  assert.deepEqual(x.log, []);
});

test('a throwing route or agent never rejects', async () => {
  const x = rig({ routes: () => { throw new Error('boom'); } });
  const h = await x.say('order a CBC');
  assert.equal(h.route.target, 'patient');
  await h.done;
});

// ── patient context notes ───────────────────────────────────────

test('notes are coalesced, serialised and bounded', async () => {
  const pushes: string[] = [];
  const timers: Array<() => void> = [];
  let release: (() => void) | null = null;
  const n = new ContextNotes({
    push: (b) => {
      pushes.push(b);
      return new Promise<void>((r) => (release = r));
    },
    setTimeout: (fn) => timers.push(fn),
    clearTimeout: () => undefined,
  });
  void n.add('The doctor is now examining your abdomen.');
  void n.add('The doctor is now examining your chest.');
  assert.equal(timers.length, 1, 'one push for both');
  timers.shift()!();
  await flush();
  assert.equal(pushes.length, 1);
  assert.match(pushes[0], /abdomen[\s\S]*chest/);
  void n.add('The doctor is now examining your eyes.');
  assert.equal(timers.length, 0, 'no second POST while one is in flight');
  release!();
  await flush();
  assert.equal(timers.length, 1);
  timers.shift()!();
  await flush();
  assert.match(pushes[1], /eyes/);
  release!();
  await flush();

  for (let i = 0; i < 60; i++) void n.add(`The doctor is now examining your toe number ${i} ${'x'.repeat(200)}.`);
  assert.ok(n.list().length <= MAX_NOTES);
  assert.ok(n.list().join('').length <= MAX_CHARS);
  assert.match(n.list()[n.list().length - 1], /number 59/);
  n.close();
  void n.add('late');
  assert.ok(!n.block().includes('late'));
});

test('the patient never hears tests, values or verdicts', () => {
  const same = 'The doctor has ordered some tests.';
  assert.equal(safeNote('The nurse has just done these tests on you: CBC, ECG.'), same);
  assert.equal(safeNote('The nurse has arranged these tests; nobody has the results yet: Chest X-ray.'), same);
  assert.equal(safeNote('Your potassium is 6.8 mmol/L and abnormal.'), '');
  assert.equal(safeNote('The pharmacist put amoxicillin on hold because of an allergy.'), '');
  assert.equal(safeNote('The doctor is no longer giving you amoxicillin; the pharmacy stopped it.'), 'The doctor is no longer giving you amoxicillin.');
  assert.equal(safeNote('A follow-up visit was booked in 7 days (review lab results).'), 'A follow-up visit was booked in 7 days.');
  const rx = 'The doctor has prescribed you: Normal saline (500 ml, once).';
  assert.equal(safeNote(rx), rx);
  const exam = 'The doctor is now examining your abdomen (tummy), pressing on it gently. If that area is tender, react.';
  assert.equal(safeNote(exam), exam);
  const phone = 'Your phone just buzzed: the clinic sent you your prescription, a voice note explaining it in your language, and your follow-up date. You may mention it briefly if it fits.';
  assert.equal(safeNote(phone), phone);
});
