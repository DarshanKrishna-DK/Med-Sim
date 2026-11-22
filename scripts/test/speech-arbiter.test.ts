/**
 * The one speech queue (src/voice/speechArbiter.ts) with a fake clock, plus its
 * pure helpers: sentence splitting, language of a line, echo guard, mic hold.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { SpeechArbiter, type ArbiterDeps, type Clip, type Playback, type SpeechLine, type SpeechOutcome } from '../../src/voice/speechArbiter.ts';
import { isEchoOf, majorityLang, splitForTts, voiceLang } from '../../src/voice/speechText.ts';
import { endStaffLines, holdMic, isMicHeld, isStaffEcho, noteStaffLine, onMicHold } from '../../src/voice/speechBus.ts';
import { ACK_ORDER, ACK_QUESTION, COACH_FAILED, COACH_LOOKING, DEPARTMENT_FAILED, FAREWELL_LINES, OBSERVER_LINES, RADIOLOGIST_HELLO, Rotator, farewellLine, observerLine, radiologistBack } from '../../src/voice/lines.ts';
import { LANGS } from '../../src/game/lang.ts';

// ── fake clock ──────────────────────────────────────────────────

const flush = async () => {
  for (let i = 0; i < 3; i++) await new Promise((r) => setImmediate(r));
};

class FakeClock {
  t = 0;
  private timers = new Map<number, { at: number; fn: () => void }>();
  private id = 0;
  now = () => this.t;
  setTimeout = (fn: () => void, ms: number) => {
    this.timers.set(++this.id, { at: this.t + ms, fn });
    return this.id;
  };
  clearTimeout = (h: unknown) => {
    this.timers.delete(h as number);
  };
  async advance(ms: number) {
    const until = this.t + ms;
    await flush();
    for (;;) {
      let next: [number, { at: number; fn: () => void }] | null = null;
      for (const e of this.timers) if (e[1].at <= until && (!next || e[1].at < next[1].at)) next = e;
      if (!next) break;
      this.timers.delete(next[0]);
      this.t = Math.max(this.t, next[1].at);
      next[1].fn();
      await flush();
    }
    this.t = until;
    await flush();
  }
}

interface Played {
  text: string;
  speaker: string;
  from: number;
  to: number | null;
  stopped: boolean;
  paused: boolean;
  volume: number;
}

function rig(over: Partial<ArbiterDeps> = {}, opts: { ms?: (text: string) => number; load?: (text: string) => number | 'hang' | 'fail' } = {}) {
  const clock = new FakeClock();
  const world = { patient: false, doctor: false, enc: 'e1' as string | null, interrupts: 0, duck: [] as boolean[], mic: 0, released: 0, aborted: 0 };
  const played: Played[] = [];
  const speaking: Array<string | null> = [];
  let overlap = false;
  const active = () => played.filter((p) => p.to === null && !p.paused).length;

  const arbiter = new SpeechArbiter({
    clock,
    player: {
      load: ({ text, speaker }, signal) =>
        new Promise<Clip>((resolve, reject) => {
          const d = opts.load?.(text) ?? 0;
          signal.addEventListener('abort', () => {
            world.aborted += 1;
            if (d !== 'hang') reject(new Error('aborted'));
          });
          const make = (): Clip => ({
            play: (): Playback => {
              const p: Played = { text, speaker, from: clock.now(), to: null, stopped: false, paused: false, volume: 1 };
              if (active() > 0) overlap = true;
              played.push(p);
              let done: (v: 'ended') => void = () => undefined;
              const donePromise = new Promise<'ended' | 'error'>((r) => (done = r));
              let left = opts.ms?.(text) ?? 1000;
              let started = clock.now();
              let h = clock.setTimeout(end, left);
              function end() {
                if (p.to !== null) return;
                p.to = clock.now();
                done('ended');
              }
              return {
                done: donePromise,
                stop: () => {
                  clock.clearTimeout(h);
                  p.stopped = p.to === null;
                  end();
                },
                pause: () => {
                  if (p.paused || p.to !== null) return;
                  p.paused = true;
                  left -= clock.now() - started;
                  clock.clearTimeout(h);
                },
                resume: () => {
                  if (!p.paused || p.to !== null) return;
                  p.paused = false;
                  if (active() > 1) overlap = true;
                  started = clock.now();
                  h = clock.setTimeout(end, left);
                },
                setVolume: (v) => (p.volume = v),
              };
            },
            release: () => (world.released += 1),
          });
          if (d === 'fail') reject(new Error('tts'));
          else if (d !== 'hang') d === 0 ? resolve(make()) : clock.setTimeout(() => resolve(make()), d);
        }),
    },
    holdMic: () => {
      world.mic += 1;
      let off = false;
      return () => {
        if (!off) world.mic -= 1;
        off = true;
      };
    },
    patientSpeaking: () => world.patient,
    doctorSpeaking: () => world.doctor,
    interruptPatient: () => (world.interrupts += 1),
    duckPatient: (on) => world.duck.push(on),
    encounter: () => world.enc,
    onSpeaking: (s) => speaking.push(s ? `${s.speaker}:${s.priority}` : null),
    ...over,
  });
  const say = (priority: SpeechLine['priority'], text: string, extra: Partial<SpeechLine> = {}) => {
    const out: { o: SpeechOutcome | null } = { o: null };
    void arbiter.enqueue({ speaker: 'nurse', text, priority, ...extra }).then((o) => (out.o = o));
    return out;
  };
  return { clock, world, played, speaking, arbiter, say, overlap: () => overlap, texts: () => played.map((p) => p.text) };
}

// ── queue ───────────────────────────────────────────────────────

test('lines never overlap and play by priority, then in order', async () => {
  const r = rig();
  r.say('chat', 'Chat one is here today.');
  await r.clock.advance(100); // already audible
  r.say('chat', 'Chat two is here today.');
  r.say('ack', 'An ack is here today.', { speaker: 'lab' });
  r.say('result', 'Result one is here today.');
  r.say('result', 'Result two is here today.');
  await r.clock.advance(20000);
  assert.deepEqual(r.texts(), ['Chat one is here today.', 'Result one is here today.', 'Result two is here today.', 'An ack is here today.', 'Chat two is here today.']);
  assert.equal(r.overlap(), false);
  for (let i = 1; i < r.played.length; i++) assert.ok(r.played[i].from >= r.played[i - 1].to!);
  assert.equal(r.world.mic, 0, 'mic given back');
});

test('urgent cuts a chat line but lets a result finish its sentence', async () => {
  const r = rig();
  const chat = r.say('chat', 'A long chat line that goes on.');
  await r.clock.advance(300);
  r.say('urgent', 'Stop, do not give that drug.');
  await r.clock.advance(50);
  assert.equal(chat.o, 'interrupted');
  assert.equal(r.played[0].stopped, true);
  await r.clock.advance(3000);

  const r2 = rig({}, { ms: () => 2000 });
  r2.say('result', 'The first sentence of the result is long enough. The second sentence of the result is long enough too.');
  await r2.clock.advance(500);
  r2.say('urgent', 'Potassium is critically high.');
  await r2.clock.advance(10000);
  assert.equal(r2.played[0].stopped, false);
  assert.equal(r2.played[1].text, 'Potassium is critically high.');
  assert.match(r2.played[2].text, /second sentence/);
  assert.equal(r2.overlap(), false);
});

test('duplicates: same key once per encounter, same text only briefly', async () => {
  const r = rig();
  const a = r.say('result', 'Hemoglobin is nine.', { key: 'room:1' });
  const dup = r.say('result', 'Hemoglobin is nine.', { key: 'room:1' });
  await r.clock.advance(5000);
  const late = r.say('result', 'Hemoglobin is nine.', { key: 'room:1' });
  await r.clock.advance(60000);
  assert.deepEqual([a.o, dup.o, late.o], ['spoken', 'duplicate', 'duplicate']);
  r.world.enc = 'e2';
  const next = r.say('result', 'Hemoglobin is nine.', { key: 'room:1' });
  await r.clock.advance(3000);
  assert.equal(next.o, 'spoken', 'a new encounter starts clean');

  const h1 = r.say('chat', 'You are on the right track.');
  const h2 = r.say('chat', 'You are on the right track.');
  await r.clock.advance(8000);
  const h3 = r.say('chat', 'You are on the right track.');
  await r.clock.advance(3000);
  assert.deepEqual([h1.o, h2.o, h3.o], ['spoken', 'duplicate', 'spoken']);
});

test('a pending ack disappears when its result arrives', async () => {
  const r = rig({}, { load: () => 400 });
  const ack = r.say('ack', 'Right away, doctor.');
  const other = r.say('ack', 'Pharmacy has it, doctor.', { ref: 'rx_2', speaker: 'nurse' });
  await r.clock.advance(100);
  const res = r.say('result', 'Done, the CBC is ordered.');
  await r.clock.advance(10000);
  assert.equal(ack.o, 'dropped');
  assert.equal(other.o, 'spoken', 'an ack for another order is kept');
  assert.equal(res.o, 'spoken');
  const ack2 = r.say('ack', 'Pharmacy is checking.', { ref: 'rx_3' });
  r.say('result', 'Amoxicillin is on hold.', { ref: 'rx_3', speaker: 'pharmacist' });
  await r.clock.advance(5000);
  assert.equal(ack2.o, 'dropped');
});

test('stale lines and lines of a finished encounter are dropped', async () => {
  const r = rig({}, { ms: () => 9000 });
  r.say('result', 'A very long result is being read.');
  const ack = r.say('ack', 'Right away, doctor.', { speaker: 'lab', dropIfStale: 3000 });
  const chat = r.say('chat', 'Something to chat about.');
  await r.clock.advance(4000);
  r.world.enc = 'e2';
  await r.clock.advance(6000);
  assert.equal(r.played[0].stopped, true, 'the old encounter is silenced');
  assert.equal(ack.o, 'dropped');
  assert.equal(chat.o, 'dropped');
  assert.equal(r.played.length, 1);
  assert.equal(r.world.mic, 0);
});

test('cancelAll stops the audio, empties the queue and frees the mic at once', async () => {
  const r = rig();
  const a = r.say('urgent', 'Stop everything now please.');
  const b = r.say('chat', 'And another thing to say.');
  await r.clock.advance(200);
  assert.equal(r.world.mic, 1);
  assert.equal(r.arbiter.isSpeaking(), true);
  r.arbiter.cancelAll('hang up');
  assert.equal(r.played[0].stopped, true);
  assert.equal(r.world.mic, 0);
  assert.equal(r.arbiter.isSpeaking(), false);
  await r.clock.advance(3000);
  assert.deepEqual([a.o, b.o], ['cancelled', 'cancelled']);
  assert.equal(r.played.length, 1);
  assert.equal(r.speaking[r.speaking.length - 1], null);
  // and the queue still works afterwards
  const c = r.say('chat', 'Hello again to you.');
  await r.clock.advance(3000);
  assert.equal(c.o, 'spoken');
});

test('cancelAll while the audio is still loading plays nothing', async () => {
  const r = rig({}, { load: () => 500 });
  const a = r.say('result', 'Never heard by anybody.');
  await r.clock.advance(100);
  r.arbiter.cancelAll('next patient');
  await r.clock.advance(5000);
  assert.equal(a.o, 'cancelled');
  assert.equal(r.played.length, 0);
  assert.equal(r.world.aborted, 1);
});

test('cancelKey stops only the matching lines', async () => {
  const r = rig();
  const a = r.say('chat', 'The explanation of the alert.', { key: 'explain:1' });
  const b = r.say('chat', 'Something else entirely.', { key: 'other' });
  await r.clock.advance(200);
  r.arbiter.cancelKey((k) => k.startsWith('explain:'));
  await r.clock.advance(3000);
  assert.deepEqual([a.o, b.o], ['cancelled', 'spoken']);
});

// ── the patient ─────────────────────────────────────────────────

test('waits for the patient to pause', async () => {
  const r = rig();
  r.world.patient = true;
  const a = r.say('result', 'The chest film is clear.');
  await r.clock.advance(3000);
  assert.equal(r.played.length, 0);
  r.world.patient = false;
  await r.clock.advance(2000);
  assert.equal(a.o, 'spoken');
  assert.ok(r.played[0].from >= 3300 - 100, 'after a short settle');
  assert.equal(r.world.interrupts, 0);
});

test('chat gives up after six seconds, a result asks the patient to pause', async () => {
  const r = rig();
  r.world.patient = true;
  const chat = r.say('chat', 'A chat line for later.');
  await r.clock.advance(7000);
  assert.equal(chat.o, 'dropped');
  const res = r.say('result', 'The result is in, doctor.');
  await r.clock.advance(5800);
  assert.equal(r.world.interrupts, 0);
  await r.clock.advance(400);
  assert.equal(r.world.interrupts, 1);
  r.world.patient = false;
  await r.clock.advance(3000);
  assert.equal(res.o, 'spoken');
  assert.deepEqual(r.world.duck, [], 'no overlap was needed');
});

test('urgent interrupts at once and goes after 2.5 s with the patient silenced', async () => {
  const r = rig();
  r.world.patient = true;
  const u = r.say('urgent', 'Penicillin allergy, stop.');
  await r.clock.advance(200);
  assert.equal(r.world.interrupts, 1);
  assert.equal(r.played.length, 0);
  await r.clock.advance(2500);
  assert.equal(r.played.length, 1);
  assert.equal(r.world.duck[0], true);
  await r.clock.advance(2000);
  assert.equal(u.o, 'spoken');
  assert.equal(r.world.duck[r.world.duck.length - 1], false, 'patient audio restored');
});

test('patient starts mid-line: chat stops, a result pauses and resumes', async () => {
  const r = rig({}, { ms: () => 2000 });
  const chat = r.say('chat', 'A chat line being said.');
  await r.clock.advance(300);
  r.world.patient = true;
  await r.clock.advance(600);
  assert.equal(chat.o, 'interrupted');
  r.world.patient = false;
  const res = r.say('result', 'The result being read out.');
  await r.clock.advance(900);
  r.world.patient = true;
  await r.clock.advance(500);
  assert.equal(r.played[1].paused, true);
  await r.clock.advance(2000);
  r.world.patient = false;
  await r.clock.advance(600);
  assert.equal(r.played[1].paused, false);
  await r.clock.advance(3000);
  assert.equal(res.o, 'spoken');
  assert.equal(r.played[1].stopped, false);
});

// ── the doctor ──────────────────────────────────────────────────

test('barge-in: chat and ack stop, result ducks and finishes, urgent continues', async () => {
  for (const p of ['chat', 'ack'] as const) {
    const r = rig();
    const line = r.say(p, 'Right away then, doctor.');
    await r.clock.advance(300);
    r.arbiter.doctorSpoke();
    assert.equal(r.world.mic, 0, 'the doctor is heard at once');
    await r.clock.advance(50);
    assert.equal(line.o, 'interrupted');
    assert.equal(r.played[0].stopped, true);
  }
  const r = rig();
  const res = r.say('result', 'The first long sentence of this result. The second long sentence of this result.');
  await r.clock.advance(300);
  r.arbiter.doctorSpoke();
  assert.equal(r.played[0].volume, 0.25);
  assert.equal(r.world.mic, 0);
  await r.clock.advance(500);
  r.arbiter.doctorSpoke(); // still talking
  await r.clock.advance(600);
  assert.equal(r.played.length, 1, 'waits while the doctor talks');
  assert.equal(r.played[0].stopped, false, 'sentence finished');
  assert.equal(res.o, null);
  await r.clock.advance(4000);
  assert.equal(r.played.length, 2, 'the rest follows');
  assert.equal(res.o, 'spoken');
  assert.equal(r.world.mic, 0);

  const u = rig();
  const urgent = u.say('urgent', 'Critical potassium, doctor.');
  await u.clock.advance(300);
  u.arbiter.doctorSpoke();
  assert.equal(u.played[0].volume, 1);
  assert.equal(u.world.mic, 1);
  await u.clock.advance(2000);
  assert.equal(urgent.o, 'spoken');
});

test('local voice activity counts as barge-in only when sustained', async () => {
  const r = rig({}, { ms: () => 3000 });
  const a = r.say('chat', 'A chat line being said.');
  await r.clock.advance(300);
  r.world.doctor = true;
  await r.clock.advance(150);
  r.world.doctor = false;
  await r.clock.advance(300);
  assert.equal(a.o, null, 'a cough does not stop it');
  r.world.doctor = true;
  await r.clock.advance(600);
  assert.equal(a.o, 'interrupted');
});

test('a line does not start while the doctor is talking', async () => {
  const r = rig();
  r.arbiter.doctorSpoke();
  r.say('ack', 'Right away then, doctor.');
  await r.clock.advance(500);
  assert.equal(r.played.length, 0);
  await r.clock.advance(1500);
  assert.equal(r.played.length, 1);
});

// ── room audio ──────────────────────────────────────────────────

test('the stethoscope owns the room: lines wait, chat stops, a result pauses', async () => {
  const r = rig({}, { ms: () => 2000 });
  const res = r.say('result', 'The result being read out.');
  await r.clock.advance(500);
  const release = r.arbiter.acquire('stethoscope');
  assert.equal(r.played[0].paused, true);
  const chat = r.say('chat', 'A chat line for later.');
  await r.clock.advance(4000);
  assert.equal(r.played.length, 1);
  release();
  release(); // idempotent
  await r.clock.advance(6000);
  assert.deepEqual([res.o, chat.o], ['spoken', 'spoken']);
  assert.equal(r.overlap(), false);
});

test('an urgent line preempts the voice prescription', async () => {
  const r = rig();
  let preempted = 0;
  const release = r.arbiter.acquire('voice-prescription', {
    onPreempt: () => {
      preempted += 1;
      release();
    },
  });
  const chat = r.say('chat', 'A chat line for later.');
  await r.clock.advance(500);
  assert.equal(r.played.length, 0);
  const u = r.say('urgent', 'Do not take that tablet.');
  await r.clock.advance(3000);
  assert.equal(preempted, 1);
  assert.equal(u.o, 'spoken');
  assert.equal(chat.o, 'spoken');
});

// ── failure ─────────────────────────────────────────────────────

test('A4: the cap silences the audio', async () => {
  const r = rig({}, { ms: () => 10 * 60_000 });
  const a = r.say('result', 'An endless audio file.');
  await r.clock.advance(21000);
  assert.equal(r.played[0].stopped, true);
  assert.equal(a.o, 'spoken');
  assert.equal(r.world.mic, 0);
});

test('A5: a hung TTS request is aborted and the queue moves on', async () => {
  const r = rig({}, { load: (t) => (t.startsWith('Hang') ? 'hang' : 0) });
  const a = r.say('result', 'Hang forever on this one.');
  const b = r.say('result', 'This one is fine, doctor.');
  await r.clock.advance(11000);
  assert.equal(b.o, null);
  await r.clock.advance(3000);
  assert.equal(a.o, 'failed');
  assert.equal(b.o, 'spoken');
  assert.equal(r.world.aborted, 1);
});

test('one failed sentence does not lose the rest; total failure reports it', async () => {
  const r = rig({}, { load: (t) => (t.includes('broken') ? 'fail' : 0) });
  const a = r.say('result', 'This sentence is broken in the engine. This sentence is heard by the doctor.');
  await r.clock.advance(4000);
  assert.equal(a.o, 'spoken');
  assert.equal(r.played.length, 1);
  const b = r.say('result', 'All broken.');
  await r.clock.advance(1000);
  assert.equal(b.o, 'failed');
  assert.equal(r.world.mic, 0);
});

test('every clip that was loaded is freed', async () => {
  const r = rig({}, { load: () => 50 });
  r.say('result', 'The first long sentence of this result. The second long sentence of this result. The third long sentence of this one.');
  await r.clock.advance(600);
  r.arbiter.cancelAll('end');
  await r.clock.advance(5000);
  assert.ok(r.world.released >= 1);
  const loaded = r.played.length + 1; // the one playing and the one prefetched
  assert.equal(r.world.released, loaded);
});

// ── pure helpers ────────────────────────────────────────────────

test('long text is cut on sentence ends, including the danda', () => {
  const hi = 'यह पहला वाक्य है जो काफी लंबा है। यह दूसरा वाक्य है जो भी लंबा है। तीसरा वाक्य यहाँ समाप्त होता है।';
  const parts = splitForTts(hi, 60);
  assert.ok(parts.length >= 2);
  assert.ok(parts.every((p) => p.length <= 60));
  assert.equal(parts.join(' '), hi);
  assert.deepEqual(splitForTts('Dr. Rao will see you at 5. Please wait outside the room.').join(' '), 'Dr. Rao will see you at 5. Please wait outside the room.');
  assert.ok(splitForTts('Dr. Rao will see you now please come in.').length === 1);
  const long = 'word '.repeat(300).trim();
  assert.ok(splitForTts(long, 200).every((p) => p.length <= 200));
  assert.equal(splitForTts('**Bold** text').join(''), 'Bold text');
  assert.deepEqual(splitForTts('   '), []);
});

test('language of a line: majority script, session decides Marathi and English', () => {
  assert.equal(majorityLang('पैरासिटामोल 500 mg दे दी है'), 'hi');
  assert.equal(majorityLang('Amoxicillin is on hold because of अलर्जी in the chart notes'), 'en');
  assert.equal(majorityLang('औषध दिले आहे', 'mr'), 'mr');
  assert.equal(majorityLang('ಔಷಧ ಕೊಟ್ಟಿದ್ದೇನೆ ECG'), 'kn');
  assert.equal(majorityLang('রক্ত পরীক্ষা হয়েছে।'), 'bn');
  // C7: one voice identity per session
  assert.equal(voiceLang('Amoxicillin is on hold.', undefined, 'hi'), 'hi');
  assert.equal(voiceLang('Amoxicillin is on hold.', 'en', 'ta'), 'ta');
  assert.equal(voiceLang('மாத்திரை கொடுத்தேன்', undefined, 'en'), 'ta');
  assert.equal(voiceLang('Done, doctor.', undefined, 'en'), 'en');
  assert.equal(voiceLang('theek hai doctor', 'hi', 'en'), 'hi');
});

test('staff speech coming back through the mic is recognised, the doctor is not', () => {
  const line = 'Amoxicillin is on hold because the patient is allergic to penicillin.';
  assert.ok(isEchoOf('amoxicillin is on hold because the patient', [line]));
  assert.ok(isEchoOf('is on hold because patient is allergic', [line]));
  assert.ok(!isEchoOf('stop', [line]));
  assert.ok(!isEchoOf('give azithromycin instead please', [line]));
  assert.ok(!isEchoOf('penicillin', [line]));
  assert.ok(isEchoOf('पेनिसिलिन से एलर्जी है', ['मरीज़ को पेनिसिलिन से एलर्जी है।']));
  noteStaffLine(line, 1000);
  endStaffLines(3000);
  assert.ok(isStaffEcho('on hold because the patient is allergic', 6000));
  assert.ok(!isStaffEcho('on hold because the patient is allergic', 20000));
});

test('A7: holds are counted and never touch the user mute', () => {
  const seen: boolean[] = [];
  const off = onMicHold((h) => seen.push(h));
  let userMuted = true;
  const live = () => !(userMuted || isMicHeld());
  const a = holdMic();
  const b = holdMic();
  a();
  a();
  assert.equal(isMicHeld(), true);
  b();
  assert.equal(isMicHeld(), false);
  assert.equal(live(), false, 'still muted by the user');
  userMuted = false;
  assert.equal(live(), true);
  assert.deepEqual(seen, [true, false]);
  off();
});

test('every fixed line exists in every language, in its own script', () => {
  const tables: Array<Record<string, string | string[]>> = [FAREWELL_LINES, ACK_ORDER, ACK_QUESTION, COACH_LOOKING, COACH_FAILED, DEPARTMENT_FAILED, RADIOLOGIST_HELLO, ...Object.values(OBSERVER_LINES)];
  for (const t of tables) {
    for (const l of LANGS) {
      const v = t[l];
      const list = Array.isArray(v) ? v : [v];
      assert.ok(list.length && list.every((x) => x.trim().length > 3), l);
      for (const x of list) {
        assert.equal(majorityLang(x, l), l, x);
        assert.ok(!/[—–]/.test(x), 'no dashes');
        assert.ok(splitForTts(x).length >= 1);
      }
    }
  }
  for (const l of LANGS) {
    assert.ok(observerLine('noContact', l, 'Darshan').includes('Darshan'));
    assert.ok(radiologistBack(l, 'Chest X-ray').includes('Chest X-ray'));
    assert.ok(farewellLine(l, 'F', 0.99).length > 3);
  }
  assert.match(farewellLine('mr', 'F', 0), /येते/);
  const rot = new Rotator();
  assert.notEqual(rot.pick('a', ACK_ORDER.en), rot.pick('a', ACK_ORDER.en));
});
