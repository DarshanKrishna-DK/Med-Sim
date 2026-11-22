// The one queue every non-patient voice goes through. Pure: the clock, the
// audio player, the microphone and the "is the patient talking" signal are all
// injected, so the rules below are unit-tested with a fake clock
// (scripts/test/speech-arbiter.test.ts). Browser wiring is in speech.ts.
//
// Rules:
//  - never two staff voices at once, and never on top of the patient: a line
//    waits for a pause (6 s), an urgent one asks the patient to stop and goes
//    after at most 2.5 s with the patient's audio ducked;
//  - urgent > result > ack > chat, first in first out inside a priority;
//  - a key is spoken once per encounter; a pending ack disappears when the
//    result it was covering for arrives;
//  - lines from an encounter that is over, or that waited too long, are dropped;
//  - barge-in: chat and ack stop, a result ducks and finishes its sentence,
//    urgent carries on;
//  - the mic is held (reference counted, separate from the user's own mute)
//    while a line plays;
//  - playback caps stop the audio, they do not just stop waiting for it.

import { normWords, splitForTts } from './speechText.ts';

export type SpeechPriority = 'urgent' | 'result' | 'ack' | 'chat';

export type SpeechOutcome = 'spoken' | 'duplicate' | 'dropped' | 'interrupted' | 'cancelled' | 'failed';

export interface SpeechLine {
  speaker: string;
  text: string;
  lang?: string;
  priority: SpeechPriority;
  /** Spoken at most once per encounter. Without a key the text itself is the
   *  key, for a few seconds only. */
  key?: string;
  /** How long `key` blocks a repeat. Default: the whole encounter. */
  dedupeMs?: number;
  /** Groups an ack with the result it is covering for. */
  ref?: string;
  /** Drop if it has not started within this many ms. */
  dropIfStale?: number;
}

export interface Clock {
  now(): number;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface Playback {
  /** Settles when the audio ended, failed or was stopped. Never rejects. */
  done: Promise<'ended' | 'error'>;
  stop(): void;
  pause(): void;
  resume(): void;
  setVolume(v: number): void;
}

export interface Clip {
  play(): Playback;
  /** Free the audio (object URL). Called exactly once per clip. */
  release(): void;
}

export interface Player {
  load(req: { text: string; speaker: string; lang?: string; priority: SpeechPriority }, signal: AbortSignal): Promise<Clip>;
}

export interface SpeakingState {
  speaker: string;
  text: string;
  priority: SpeechPriority;
  lang?: string;
  key?: string;
}

export interface ArbiterDeps {
  clock: Clock;
  player: Player;
  /** Hold the doctor's mic; returns the release (called once). */
  holdMic(): () => void;
  patientSpeaking(): boolean;
  /** Local voice activity of the doctor, if available. */
  doctorSpeaking?(): boolean;
  /** Ask the patient agent to stop talking. */
  interruptPatient?(): void;
  /** Silence / restore the patient's audio while a staff line must overlap it. */
  duckPatient?(on: boolean): void;
  /** Identity of the running encounter. Lines belong to the one they were said in. */
  encounter?(): string | null;
  onSpeaking?(s: SpeakingState | null): void;
  onOutcome?(line: SpeechLine, outcome: SpeechOutcome, reason: string): void;
}

export interface ArbiterTiming {
  pollMs: number;
  ttsTimeoutMs: number;
  /** Hard cap on one sentence's audio. */
  chunkCapMs: number;
  patientWaitMs: number;
  urgentWaitMs: number;
  /** After patientWaitMs a result interrupts the patient; this is the last resort. */
  resultForceMs: number;
  settleMs: number;
  doctorQuietMs: number;
  doctorVadMs: number;
  patientVadMs: number;
  maxPauseMs: number;
  micTailMs: number;
  autoKeyMs: number;
  staleMs: Record<SpeechPriority, number>;
}

const TIMING: ArbiterTiming = {
  pollMs: 100,
  ttsTimeoutMs: 12_000,
  chunkCapMs: 20_000,
  patientWaitMs: 6_000,
  urgentWaitMs: 2_500,
  resultForceMs: 9_000,
  settleMs: 300,
  doctorQuietMs: 700,
  doctorVadMs: 350,
  patientVadMs: 250,
  maxPauseMs: 12_000,
  micTailMs: 250,
  autoKeyMs: 4_000,
  staleMs: { urgent: Infinity, result: 90_000, ack: 8_000, chat: 20_000 },
};

const RANK: Record<SpeechPriority, number> = { urgent: 0, result: 1, ack: 2, chat: 3 };

interface Item {
  line: SpeechLine;
  key: string;
  explicitKey: boolean;
  rank: number;
  seq: number;
  at: number;
  encounter: string | null;
  chunks: string[];
  next: number;
  started: boolean;
  resolve(o: SpeechOutcome): void;
}

type Ending = SpeechOutcome | 'requeue';

interface Run {
  item: Item;
  ending: Ending | null;
  reason: string;
  ctl: AbortController;
  stopped: Promise<void>;
  wake(): void;
  playback: Playback | null;
  audible: boolean;
  paused: boolean;
  /** The doctor spoke over a result: finish the sentence, then wait. */
  yielding: boolean;
  ducked: boolean;
  releaseMic: (() => void) | null;
}

export class SpeechArbiter {
  private deps: ArbiterDeps;
  private t: ArbiterTiming;
  private queue: Item[] = [];
  private run: Run | null = null;
  private pumping = false;
  private seq = 0;
  private seen = new Map<string, { until: number; encounter: string | null }>();
  private occupants = new Map<symbol, { owner: string; onPreempt?: () => void }>();
  private lastDoctorAt = -Infinity;
  private speaking: SpeakingState | null = null;

  constructor(deps: ArbiterDeps, timing: Partial<ArbiterTiming> = {}) {
    this.deps = deps;
    this.t = { ...TIMING, ...timing };
  }

  // ── public API ────────────────────────────────────────────────

  enqueue(line: SpeechLine): Promise<SpeechOutcome> {
    const text = line.text.trim();
    const chunks = splitForTts(text);
    if (!chunks.length) return Promise.resolve('dropped');
    const now = this.deps.clock.now();
    const encounter = this.encounter();
    const explicitKey = !!line.key;
    const key = line.key ?? `auto:${line.speaker}|${normWords(text)}`;

    const cur = this.run;
    if (cur && !cur.ending && cur.item.key === key && cur.item.encounter === encounter) return this.refuse(line, 'playing');
    if (this.queue.some((q) => q.key === key && q.encounter === encounter)) return this.refuse(line, 'pending');
    const was = this.seen.get(key);
    if (was && was.encounter === encounter && now < was.until) return this.refuse(line, 'already spoken');

    return new Promise<SpeechOutcome>((resolve) => {
      const item: Item = {
        line: { ...line, text },
        key,
        explicitKey,
        rank: RANK[line.priority] ?? RANK.chat,
        seq: ++this.seq,
        at: now,
        encounter,
        chunks,
        next: 0,
        started: false,
        resolve,
      };
      this.coalesce(item);
      this.queue.push(item);
      const r = this.run;
      if (r && !r.ending && item.rank < r.item.rank) {
        if (!r.audible) this.end(r, 'requeue', 'higher priority');
        else if (item.rank === RANK.urgent && r.item.rank >= RANK.ack) this.end(r, 'interrupted', 'urgent line');
        // An audible result finishes its sentence first (see speakItem).
      }
      void this.pump();
    });
  }

  /** Drop everything, stop the audio now and give the mic back. */
  cancelAll(reason: string): void {
    const q = this.queue;
    this.queue = [];
    for (const it of q) this.finish(it, 'cancelled', reason);
    if (this.run) this.end(this.run, 'cancelled', reason);
  }

  /** Drop pending or playing lines whose key matches. */
  cancelKey(match: (key: string) => boolean, reason = 'key cancelled'): void {
    const gone = this.queue.filter((it) => match(it.key));
    this.queue = this.queue.filter((it) => !match(it.key));
    for (const it of gone) this.finish(it, 'cancelled', reason);
    if (this.run && match(this.run.item.key)) this.end(this.run, 'cancelled', reason);
  }

  /** The doctor is talking (transcript or local voice activity). */
  doctorSpoke(): void {
    this.lastDoctorAt = this.deps.clock.now();
    const r = this.run;
    if (!r || !r.audible || r.ending) return;
    const p = r.item.line.priority;
    if (p === 'chat' || p === 'ack') this.end(r, 'interrupted', 'doctor barge-in');
    else if (p === 'result' && !r.yielding) {
      r.yielding = true;
      r.playback?.setVolume(0.25);
      // They are speaking to someone: let the microphone hear them.
      this.dropMic(r, 0);
    }
  }

  /** Something else owns the room's audio (stethoscope, voice prescription,
   *  the patient's farewell). Staff lines wait until it is released; an
   *  urgent line asks it to stop through `onPreempt`. */
  acquire(owner: string, opts: { onPreempt?: () => void } = {}): () => void {
    const id = Symbol(owner);
    this.occupants.set(id, { owner, onPreempt: opts.onPreempt });
    const r = this.run;
    if (r && r.audible && !r.ending) {
      if (r.item.rank >= RANK.ack) this.end(r, 'interrupted', owner);
      else this.pause(r);
    }
    return () => {
      if (!this.occupants.delete(id)) return;
      void this.pump();
    };
  }

  isSpeaking(): boolean {
    return this.speaking !== null;
  }

  current(): SpeakingState | null {
    return this.speaking;
  }

  pending(): number {
    return this.queue.length;
  }

  // ── queue ─────────────────────────────────────────────────────

  private encounter(): string | null {
    return this.deps.encounter?.() ?? null;
  }

  private refuse(line: SpeechLine, reason: string): Promise<SpeechOutcome> {
    this.deps.onOutcome?.(line, 'duplicate', reason);
    return Promise.resolve('duplicate');
  }

  private finish(it: Item, o: SpeechOutcome, reason: string) {
    this.deps.onOutcome?.(it.line, o, reason);
    it.resolve(o);
  }

  /** A result makes the ack that was covering for it pointless (same ref, or a
   *  plain "right away" from the same person); a newer ack replaces a plain one. */
  private coalesce(item: Item) {
    if (item.rank > RANK.ack) return;
    const { speaker, ref } = item.line;
    const covers = (a: Item) =>
      a.line.priority === 'ack' && !a.started && (a.line.ref ? a.line.ref === ref : a.line.speaker === speaker);
    const gone = this.queue.filter(covers);
    if (gone.length) {
      this.queue = this.queue.filter((a) => !covers(a));
      for (const a of gone) this.finish(a, 'dropped', 'superseded');
    }
    const r = this.run;
    if (r && !r.audible && !r.ending && covers(r.item)) this.end(r, 'dropped', 'superseded');
  }

  private take(): Item | null {
    const now = this.deps.clock.now();
    for (;;) {
      if (!this.queue.length) return null;
      let best = this.queue[0];
      for (const it of this.queue) if (it.rank < best.rank || (it.rank === best.rank && it.seq < best.seq)) best = it;
      const why = this.stale(best, now);
      if (!why && this.occupants.size && best.rank !== RANK.urgent) return null;
      this.queue.splice(this.queue.indexOf(best), 1);
      if (!why) return best;
      this.finish(best, 'dropped', why);
    }
  }

  private stale(it: Item, now: number): string | null {
    if (it.encounter !== this.encounter()) return 'encounter changed';
    if (!it.started && now - it.at > (it.line.dropIfStale ?? this.t.staleMs[it.line.priority])) return 'stale';
    return null;
  }

  private async pump(): Promise<void> {
    if (this.pumping) return;
    this.pumping = true;
    try {
      for (;;) {
        const it = this.take();
        if (!it) break;
        await this.speakItem(it);
      }
    } finally {
      this.pumping = false;
    }
  }

  // ── one line ──────────────────────────────────────────────────

  private end(r: Run, how: Ending, reason: string) {
    if (r.ending) return;
    r.ending = how;
    r.reason = reason;
    r.ctl.abort();
    r.playback?.stop();
    if (how === 'cancelled' || how === 'interrupted') this.dropMic(r, 0);
    if (r.audible) this.setSpeaking(null);
    this.setDuck(r, false);
    r.wake();
  }

  private dropMic(r: Run, tailMs: number) {
    const release = r.releaseMic;
    if (!release) return;
    r.releaseMic = null;
    if (tailMs > 0) this.deps.clock.setTimeout(release, tailMs);
    else release();
  }

  private setDuck(r: Run, on: boolean) {
    if (r.ducked === on) return;
    r.ducked = on;
    this.deps.duckPatient?.(on);
  }

  private setSpeaking(s: SpeakingState | null) {
    if (this.speaking === s) return;
    this.speaking = s;
    this.deps.onSpeaking?.(s);
  }

  private pause(r: Run) {
    if (r.paused || !r.playback) return;
    r.paused = true;
    r.playback.pause();
  }

  private sleep(ms: number, r: Run): Promise<void> {
    return new Promise((resolve) => {
      const h = this.deps.clock.setTimeout(resolve, ms);
      void r.stopped.then(() => {
        this.deps.clock.clearTimeout(h);
        resolve();
      });
    });
  }

  /** Fetch one sentence's audio. Null on failure, timeout or cancel. */
  private load(item: Item, i: number, r: Run): Promise<Clip | null> {
    // Own controller: a timeout on one sentence must not abort the whole run.
    const ctl = new AbortController();
    const onStop = () => ctl.abort();
    r.ctl.signal.addEventListener('abort', onStop, { once: true });
    return new Promise<Clip | null>((resolve) => {
      let settled = false;
      const settle = (c: Clip | null) => {
        if (settled) {
          c?.release(); // arrived after a timeout or a cancel: never played
          return;
        }
        settled = true;
        this.deps.clock.clearTimeout(timer);
        r.ctl.signal.removeEventListener('abort', onStop);
        resolve(c);
      };
      const timer = this.deps.clock.setTimeout(() => {
        ctl.abort();
        settle(null);
      }, this.t.ttsTimeoutMs);
      void r.stopped.then(() => settle(null));
      const { speaker, lang, priority } = item.line;
      this.deps.player
        .load({ text: item.chunks[i], speaker, lang, priority }, ctl.signal)
        .then(settle, () => settle(null));
    });
  }

  private async speakItem(item: Item): Promise<void> {
    let wake: () => void = () => undefined;
    const stopped = new Promise<void>((res) => {
      wake = res;
    });
    const r: Run = {
      item,
      ending: null,
      reason: '',
      ctl: new AbortController(),
      stopped,
      wake,
      playback: null,
      audible: false,
      paused: false,
      yielding: false,
      ducked: false,
      releaseMic: null,
    };
    this.run = r;
    let prefetched: Promise<Clip | null> | null = null;
    let heard = 0;
    try {
      while (item.next < item.chunks.length && !r.ending) {
        const clip: Clip | null = await (prefetched ?? this.load(item, item.next, r));
        prefetched = null;
        if (r.ending) {
          clip?.release();
          break;
        }
        if (!clip) {
          item.next += 1; // one bad sentence does not lose the rest
          continue;
        }
        if (!(await this.gate(r))) {
          clip.release();
          break;
        }
        if (item.next + 1 < item.chunks.length) prefetched = this.load(item, item.next + 1, r);
        await this.playClip(r, clip);
        heard += 1;
        if (r.ending) break;
        item.next += 1;
        if (item.next >= item.chunks.length) break;
        if (r.yielding || this.queue.some((q) => q.rank < item.rank)) {
          this.end(r, 'requeue', r.yielding ? 'doctor speaking' : 'higher priority');
        }
      }
    } finally {
      // `end` resolves `stopped`, so an unused prefetch settles and frees itself.
      if (prefetched) void prefetched.then((c) => c?.release());
      this.setDuck(r, false);
      if (r.audible) this.setSpeaking(null);
      this.dropMic(r, this.t.micTailMs);
      this.run = null;
    }
    const ending: Ending = r.ending ?? (heard || item.started ? 'spoken' : 'failed');
    r.wake();
    if (ending === 'requeue') this.queue.push(item);
    else this.finish(item, ending, r.reason || (ending === 'failed' ? 'tts unavailable' : ''));
  }

  /** Wait until it is this line's turn to be heard. False: do not play. */
  private async gate(r: Run): Promise<boolean> {
    const { item } = r;
    const { clock } = this.deps;
    const urgent = item.rank === RANK.urgent;
    let since: number | null = null; // first moment somebody else was talking
    let quietFrom: number | null = null;
    let interrupted = false;
    let preempted = false;
    for (;;) {
      if (r.ending) return false;
      const now = clock.now();
      const why = this.stale(item, now);
      if (why) {
        this.end(r, 'dropped', why);
        return false;
      }

      if (this.occupants.size) {
        if (urgent) {
          if (!preempted) {
            preempted = true;
            for (const o of [...this.occupants.values()]) o.onPreempt?.();
          }
          since ??= now;
        }
        // The stethoscope does not use up a non-urgent line's wait for the patient.
        if (this.occupants.size && !(urgent && now - (since ?? now) >= this.t.urgentWaitMs)) {
          await this.sleep(this.t.pollMs, r);
          continue;
        }
      }

      const patient = this.deps.patientSpeaking();
      const doctor = (this.deps.doctorSpeaking?.() ?? false) || now - this.lastDoctorAt < this.t.doctorQuietMs;
      if (!patient && !doctor) {
        if (since === null) return true;
        quietFrom ??= now;
        if (urgent || now - quietFrom >= this.t.settleMs) return true;
      } else {
        quietFrom = null;
        since ??= now;
        const waited = now - since;
        if (urgent) {
          if (patient && !interrupted) {
            interrupted = true;
            this.deps.interruptPatient?.();
          }
          if (waited >= this.t.urgentWaitMs) {
            if (patient) this.setDuck(r, true);
            return true;
          }
        } else if (item.rank === RANK.result) {
          if (waited >= this.t.patientWaitMs && patient && !interrupted) {
            interrupted = true;
            this.deps.interruptPatient?.();
          }
          if (waited >= this.t.resultForceMs) {
            if (patient) this.setDuck(r, true);
            return true;
          }
        } else if (waited >= this.t.patientWaitMs) {
          this.end(r, 'dropped', 'no pause');
          return false;
        }
      }
      await this.sleep(this.t.pollMs, r);
    }
  }

  private async playClip(r: Run, clip: Clip): Promise<void> {
    const { item } = r;
    const { clock } = this.deps;
    // Duplicate protection counts from the moment the line is actually heard.
    if (!item.started) {
      item.started = true;
      const forMs = item.line.dedupeMs ?? (item.explicitKey ? Infinity : this.t.autoKeyMs);
      this.seen.set(item.key, { until: clock.now() + forMs, encounter: item.encounter });
      if (this.seen.size > 400) this.seen.delete(this.seen.keys().next().value as string);
    }
    if (!r.releaseMic) r.releaseMic = this.deps.holdMic();
    const pb = clip.play();
    r.playback = pb;
    r.paused = false;
    if (!r.audible) {
      r.audible = true;
      const { speaker, text, priority, lang, key } = item.line;
      this.setSpeaking({ speaker, text, priority, lang, key });
    }
    let over = false;
    const done = pb.done.then(() => {
      over = true;
    });
    let played = 0;
    let last = clock.now();
    let patientFrom: number | null = null;
    let quietFrom: number | null = null;
    let doctorFrom: number | null = null;
    let pausedFrom: number | null = null;
    try {
      while (!over && !r.ending) {
        await Promise.race([done, this.sleep(this.t.pollMs, r)]);
        if (over || r.ending) break;
        const now = clock.now();
        if (item.encounter !== this.encounter()) {
          this.end(r, 'dropped', 'encounter changed');
          break;
        }
        const patient = this.deps.patientSpeaking();

        if (r.paused) {
          pausedFrom ??= now;
          const busy = this.occupants.size > 0;
          if (busy || patient) quietFrom = null;
          else quietFrom ??= now;
          const forced = !busy && now - pausedFrom >= this.t.maxPauseMs;
          if (forced || (quietFrom !== null && now - quietFrom >= this.t.settleMs)) {
            if (patient) this.setDuck(r, true);
            r.paused = false;
            pausedFrom = null;
            quietFrom = null;
            patientFrom = null;
            pb.resume();
          }
          last = now;
          continue;
        }

        played += now - last;
        last = now;
        if (played >= this.t.chunkCapMs) {
          pb.stop(); // the cap silences it, not just the wait
          break;
        }

        if (patient && !r.ducked) {
          patientFrom ??= now;
          if (now - patientFrom >= this.t.patientVadMs) {
            if (item.rank >= RANK.ack) {
              this.end(r, 'interrupted', 'patient speaking');
              break;
            }
            if (item.rank === RANK.urgent) {
              this.deps.interruptPatient?.();
              this.setDuck(r, true);
            } else this.pause(r);
          }
        } else patientFrom = null;

        if (this.deps.doctorSpeaking?.()) {
          doctorFrom ??= now;
          if (now - doctorFrom >= this.t.doctorVadMs) this.doctorSpoke();
        } else doctorFrom = null;
      }
    } finally {
      r.playback = null;
      r.paused = false;
      clip.release();
    }
  }
}
