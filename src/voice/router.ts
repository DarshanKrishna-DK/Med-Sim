// Who is the doctor talking to? One authority for that: POST /voice/route (the
// same function decides on the backend whether the patient stays silent), with
// an offline classifier for when it is slow or down. Then one dispatch table.
//
// Everything that touches the app is injected, so scripts/test can drive it;
// doctorUtterance.ts wires the real agents.

import { classifyOffline } from './offlineRoute.ts';
import { normWords } from './speechText.ts';

export type RouteTarget =
  | 'patient'
  | 'nurse'
  | 'pharmacist'
  | 'lab'
  | 'radiology'
  | 'faculty'
  | 'coach'
  | 'exam'
  | 'observer';
export type RouteAction = 'order' | 'question' | 'stop' | 'hint' | 'invite' | 'answer' | 'override' | 'none';
export type Source = 'voice' | 'typed';

export interface Route {
  target: RouteTarget;
  action: RouteAction;
  confidence: number;
  via: 'rule' | 'llm' | 'context' | 'offline';
  text: string;
  /** The patient stays silent for this turn. False on a mixed turn ("we'll do an
   *  ECG now"), which the patient hears as well. */
  silent?: boolean;
}

export interface RouteContext {
  encounterId?: string;
  lang?: string;
  patientName?: string;
  gender?: string;
  caseId?: string;
  pendingQuestion?: { role: string; ref: string };
  awaitingFaculty?: boolean;
  /** Contacts who may be invited to observe ("Darshan should watch this"). */
  observerNames?: string[];
  /** Agora channel of the live call, so the patient's LLM sees the same context. */
  channel?: string;
  /** A drug is on hold (client side only, never sent). */
  heldRef?: string;
  /** A human faculty member is in the room (client side only). */
  facultyPresent?: boolean;
}

const TARGETS = new Set<RouteTarget>(['patient', 'nurse', 'pharmacist', 'lab', 'radiology', 'faculty', 'coach', 'exam', 'observer']);
const ACTIONS = new Set<RouteAction>(['order', 'question', 'stop', 'hint', 'invite', 'answer', 'override', 'none']);

export const ROUTE_TIMEOUT_MS = 1600;

const contextBody = (ctx: RouteContext) => ({
  patientName: ctx.patientName ?? '',
  gender: ctx.gender ?? '',
  caseId: ctx.caseId ?? '',
  ...(ctx.channel ? { channel: ctx.channel } : {}),
  ...(ctx.observerNames?.length ? { observerNames: ctx.observerNames.slice(0, 40) } : {}),
  ...(ctx.pendingQuestion ? { pendingQuestion: ctx.pendingQuestion } : {}),
  ...(ctx.awaitingFaculty ? { awaitingFaculty: true } : {}),
});

/** Tell the backend what is being waited for before the doctor speaks (an empty
 *  utterance only syncs), so the patient does not answer a department's question. */
export async function syncRouteContext(ctx: RouteContext, deps: { fetch?: typeof fetch } = {}): Promise<void> {
  try {
    await (deps.fetch ?? fetch)('/voice/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ utterance: '', encounterId: ctx.encounterId, lang: ctx.lang, context: contextBody(ctx) }),
    });
  } catch {
    /* the next utterance carries it */
  }
}

/** Does the patient hear this turn too? */
export const patientHears = (r: Route): boolean => r.target === 'patient' || r.target === 'exam' || r.silent === false;

/** Ask the backend who this is for. Never throws: any failure, timeout or
 *  malformed answer falls back to the offline classifier. */
export async function routeUtterance(
  text: string,
  source: Source,
  ctx: RouteContext,
  deps: { fetch?: typeof fetch; timeoutMs?: number } = {},
): Promise<Route> {
  const clean = text.trim();
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), deps.timeoutMs ?? ROUTE_TIMEOUT_MS);
  try {
    const r = await (deps.fetch ?? fetch)('/voice/route', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        utterance: clean,
        source,
        ...(ctx.encounterId ? { encounterId: ctx.encounterId } : {}),
        ...(ctx.lang ? { lang: ctx.lang } : {}),
        context: contextBody(ctx),
      }),
    });
    if (!r.ok) throw new Error(`/voice/route ${r.status}`);
    const d = (await r.json()) as Partial<Route>;
    if (!TARGETS.has(d.target as RouteTarget)) throw new Error('bad route');
    return {
      target: d.target as RouteTarget,
      action: ACTIONS.has(d.action as RouteAction) ? (d.action as RouteAction) : 'none',
      confidence: Number.isFinite(d.confidence) ? Number(d.confidence) : 0.5,
      via: d.via === 'llm' || d.via === 'context' ? d.via : 'rule',
      text: typeof d.text === 'string' && d.text.trim() ? d.text.trim() : clean,
      ...(typeof d.silent === 'boolean' ? { silent: d.silent } : {}),
    };
  } catch {
    const o = classifyOffline(clean, {
      patientName: ctx.patientName,
      pendingQuestion: ctx.pendingQuestion,
      awaitingFaculty: ctx.awaitingFaculty,
    });
    return { ...o, via: 'offline', text: clean };
  } finally {
    clearTimeout(timer);
  }
}

// ── segmented turns ─────────────────────────────────────────────

/** What is new in `full` compared with `done`, both from the same turn.
 *  '' when nothing is. Speech-to-text sends the turn again and again, longer
 *  each time, sometimes with earlier words respelt. */
export function newSuffix(done: string, full: string): string {
  const was = normWords(done).split(' ').filter(Boolean);
  if (!was.length) return full.trim();
  // Raw tokens with the normalised words and letters used up by their end.
  const raw = full.trim().split(/\s+/);
  const words: string[] = [];
  const wordEnd: number[] = [];
  const charEnd: number[] = [];
  let chars = 0;
  for (const t of raw) {
    const n = normWords(t).split(' ').filter(Boolean);
    words.push(...n);
    chars += n.join('').length;
    wordEnd.push(words.length);
    charEnd.push(chars);
  }
  const rest = (i: number) => (i < 0 ? '' : raw.slice(i).join(' ').replace(/^[\s,.;:।]+/, '').trim());
  const from = (count: number): string => rest(wordEnd.findIndex((e) => e > count));
  // Letters only, so "c b c" becoming "CBC" is the same text.
  const oldChars = was.join('');
  const newChars = words.join('');
  if (oldChars.startsWith(newChars)) return ''; // a shorter or equal restatement
  if (newChars.startsWith(oldChars)) return rest(charEnd.findIndex((e) => e > oldChars.length));
  // Earlier words were respelt: walk the old words through the new ones.
  let at = 0;
  let hit = 0;
  for (const w of was) {
    const j = words.indexOf(w, at);
    if (j >= 0 && j - at <= 4) {
      hit += 1;
      at = j + 1;
    }
  }
  if (hit / was.length < 0.6) return full.trim(); // a different sentence
  // Respelt words at the end of the old text are not new either.
  const tail = was.length - (was.lastIndexOf(words[at - 1]) + 1);
  return from(Math.max(at, Math.min(words.length, at + tail)));
}

const CONTINUES =
  /^(?:and|also|plus|with|then|as well|oh and|or|aur|bhi|saath|mattu|matte|और|साथ|फिर|ಮತ್ತು|ಜೊತೆಗೆ|மற்றும்|கூட|మరియు|కూడా|आणि|পাশাপাশি|আর|এবং)\b|^(?:and|aur|और|ಮತ್ತು|மற்றும்|మరియు|आणि|এবং|আর)\s|^\d+\s*(?:mg|ml|mcg|units?|days?|times?)\b/iu;

// ── dispatch ────────────────────────────────────────────────────

/** The slice of src/room/client.ts the router uses (all optional: the room may
 *  be off, or not built yet). */
export interface RoomActions {
  roomActive?(): boolean;
  askDepartment?(role: 'pharmacist' | 'lab' | 'radiology', text: string): Promise<unknown>;
  answerQuestion?(ref: string, text: string): Promise<unknown>;
  inviteFaculty?(reason?: string): Promise<unknown>;
  sayToFaculty?(text: string): Promise<unknown>;
  requestOverride?(ref: string, reason?: string): Promise<unknown>;
}

export interface DispatchDeps {
  route(text: string, source: Source, ctx: RouteContext): Promise<Route>;
  context(): RouteContext;
  /** Identity of the seated patient; queued work for another one is dropped. */
  encounter(): string | null;
  runNurse(text: string, source: Source): Promise<unknown>;
  /** True when it was an examination that started. */
  runExam(text: string): boolean;
  /** True when it was an observer invite that has been handled. */
  runObserver(text: string): boolean;
  requestHint(): Promise<unknown> | void;
  room(): RoomActions | null;
  /** "Right away, doctor": called when a nurse run takes longer than ackMs. */
  ack(kind: 'order' | 'question'): void;
  /** A department or faculty request failed. */
  failed(): void;
  silenceStaff(): void;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
  ackMs?: number;
}

export interface Handled {
  route: Route;
  /** The part that was routed: '' when the utterance held nothing new. */
  text: string;
  /** Settles when the action it started has finished. Never rejects. */
  done: Promise<void>;
}

export interface HandleOptions {
  /** Transcript turn id: later finals of the same turn route only what is new. */
  turnId?: string | null;
  /** Where an utterance that is for nobody in particular goes (the nurse's own
   *  command box passes 'nurse'). */
  defaultTarget?: RouteTarget;
}

const QUIET = /^\W*(?:(?:nurse|sister|a+sha|please)\W+)*(?:stop talking|be quiet|quiet please|shush|shut up|silence|chup|chup raho|चुप|चुप रहो|ಸುಮ್ಮನಿರಿ)\W*$/i;

const nothing = (text: string): Handled => ({
  route: { target: 'patient', action: 'none', confidence: 1, via: 'rule', text },
  text: '',
  done: Promise.resolve(),
});

export class UtteranceDispatcher {
  private d: DispatchDeps;
  private turns = new Map<string, { text: string; target: RouteTarget }>();
  private routing: Promise<unknown> = Promise.resolve();
  private nurse: Promise<unknown> = Promise.resolve();

  constructor(deps: DispatchDeps) {
    this.d = deps;
  }

  /** Forget segments and stop anything not started yet (next patient). */
  reset(): void {
    this.turns.clear();
  }

  /** Route one doctor utterance and start what it asks for. Resolves once it
   *  is routed (so a caller can keep it from the patient); `done` follows the
   *  action. Utterances are routed in the order they were said. */
  handle(utterance: string, source: Source, opts: HandleOptions = {}): Promise<Handled> {
    const full = utterance.trim();
    const enc = this.d.encounter();
    const key = opts.turnId ? `${enc}|${opts.turnId}` : null;
    const before = key ? this.turns.get(key) : undefined;
    const text = before ? newSuffix(before.text, full) : full;
    if (key) {
      this.turns.set(key, { text: full, target: before?.target ?? 'patient' });
      if (this.turns.size > 40) this.turns.delete(this.turns.keys().next().value as string);
    }
    if (!normWords(text)) return Promise.resolve(nothing(full));

    const job = this.routing.then(async (): Promise<Handled> => {
      if (this.d.encounter() !== enc) return nothing(full);
      if (QUIET.test(text)) {
        this.d.silenceStaff();
        return nothing(full);
      }
      const ctx = this.d.context();
      let route = await this.d.route(text, source, ctx);
      if (this.d.encounter() !== enc) return nothing(full);
      const turn = key ? this.turns.get(key) : undefined;
      // "order a CBC" ... "and an ECG": the rest of the same order.
      if (before && turn && route.target === 'patient' && route.confidence < 0.9 && turn.target !== 'patient' && turn.target !== 'exam' && CONTINUES.test(text)) {
        route = { ...route, target: turn.target, action: 'order', silent: true };
      }
      if (route.target === 'patient' && opts.defaultTarget) {
        route = { ...route, target: opts.defaultTarget, action: route.action === 'none' ? 'order' : route.action, silent: true };
      }
      const started = this.start(route, text, source, ctx, enc);
      if (turn) turn.target = started.target;
      return { route: { ...route, target: started.target }, text, done: started.done };
    });
    this.routing = job.catch(() => undefined);
    return job.catch(() => nothing(full));
  }

  private start(
    route: Route,
    text: string,
    source: Source,
    ctx: RouteContext,
    enc: string | null,
  ): { target: RouteTarget; done: Promise<void> } {
    const { d } = this;
    const none = Promise.resolve();
    const nurse = (action: RouteAction = route.action) => ({
      target: 'nurse' as const,
      done: this.queueNurse(text, source, action, enc),
    });
    const room = d.room();
    const roomOn = !!room && (room.roomActive?.() ?? true);
    /** Run a room action; the nurse takes over when the room cannot. */
    const viaRoom = (target: RouteTarget, fn: (() => Promise<unknown>) | undefined) => {
      if (!roomOn || !fn) return nurse();
      const done = Promise.resolve()
        .then(fn)
        .then(
          () => undefined,
          () => d.failed(),
        );
      return { target, done };
    };

    // A department is waiting for exactly this answer.
    if (route.action === 'answer' && ctx.pendingQuestion && route.target !== 'faculty') {
      const { ref } = ctx.pendingQuestion;
      const r = viaRoom(route.target === 'patient' || route.target === 'exam' ? 'nurse' : route.target, room?.answerQuestion && (() => room.answerQuestion!(ref, text)));
      return r;
    }
    if (route.action === 'override') {
      const ref = ctx.heldRef;
      return ref ? viaRoom('faculty', room?.requestOverride && (() => room.requestOverride!(ref, text))) : nurse();
    }

    switch (route.target) {
      case 'patient':
        // "Darshan should watch this" can only be told by the contact book.
        return d.runObserver(text) ? { target: 'observer', done: none } : { target: 'patient', done: none };
      case 'observer':
        return d.runObserver(text) ? { target: 'observer', done: none } : nurse();
      case 'nurse':
        return d.runObserver(text) ? { target: 'observer', done: none } : nurse();
      case 'pharmacist':
      case 'lab':
      case 'radiology': {
        const role = route.target;
        // An order ("send a CBC to the lab") is the nurse's to place and hand
        // over; a question goes straight to the department.
        if (route.action === 'order' || route.action === 'stop') return nurse();
        return viaRoom(role, room?.askDepartment && (() => room.askDepartment!(role, text)));
      }
      case 'faculty':
        if (route.action === 'invite' || ctx.facultyPresent === false) {
          return viaRoom('faculty', room?.inviteFaculty && (() => room.inviteFaculty!(text)));
        }
        return viaRoom('faculty', room?.sayToFaculty && (() => room.sayToFaculty!(text)));
      case 'coach':
        return { target: 'coach', done: Promise.resolve(d.requestHint()).then(() => undefined, () => undefined) };
      case 'exam':
        return { target: d.runExam(text) ? 'exam' : 'patient', done: none };
    }
  }

  /** One nurse run at a time, in order; "Right away" if she is slow to answer. */
  private queueNurse(text: string, source: Source, action: RouteAction, enc: string | null): Promise<void> {
    const { d } = this;
    let finished = false;
    const timer =
      action === 'order' || action === 'stop' || action === 'question'
        ? d.setTimeout(() => {
            if (!finished && d.encounter() === enc) d.ack(action === 'question' ? 'question' : 'order');
          }, d.ackMs ?? 1200)
        : null;
    const run = this.nurse.then(async () => {
      try {
        if (d.encounter() === enc) await d.runNurse(text, source);
      } catch {
        /* runNurse reports its own failures */
      } finally {
        finished = true;
        if (timer !== null) d.clearTimeout(timer);
      }
    });
    this.nurse = run;
    return run;
  }
}
