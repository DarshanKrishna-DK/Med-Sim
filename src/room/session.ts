// One encounter's connection to the agent room hub: opens it, streams events,
// reconnects with `after`, and hands `apply` / `speak` out exactly once.
// Everything it touches is injected (see agentEvents.ts), so scripts/test can
// drive it without a browser. src/room/client.ts wires the real thing.

import { emptyRoom, markAnswered, markToldFaculty, rewind, roomReducer, type RoomConnection, type RoomState } from './reducer.ts';
import type { RoomApply, RoomEvent, RoomSpeak } from './types';

export interface RoomSource {
  close(): void;
}

export interface RoomOpenBody {
  encounterId: string;
  caseId: string;
  lang: string;
  osce: boolean;
  patient: Record<string, unknown>;
  doctorName?: string;
}

export interface SessionDeps {
  post: (path: string, body: unknown) => Promise<Record<string, unknown>>;
  /** Open an SSE stream. Every callback may fire after close(); they are ignored. */
  connect: (url: string, on: { open: () => void; event: (data: string) => void; error: () => void }) => RoomSource;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
  /** Called with every new state. */
  onState: (s: RoomState) => void;
  onEvent?: (e: RoomEvent, s: RoomState) => void;
  onApply: (a: RoomApply, s: RoomState) => void;
  onSpeak: (sp: RoomSpeak, s: RoomState) => void;
}

const BASE = '/agent/room';
const RETRY_MIN = 1000;
const RETRY_MAX = 15_000;

// Survives a session being rebuilt (StrictMode, hot reload, reconnect): a chart
// change or a spoken line happens once per browser session, whatever replays.
const applied = new Set<string>();
const spoken = new Set<string>();

/** Tests only. */
export function resetExactlyOnce(): void {
  applied.clear();
  spoken.clear();
}

export function parseRoomEvent(data: string): RoomEvent | null {
  try {
    const e = JSON.parse(data) as RoomEvent;
    return e && typeof e === 'object' && typeof e.type === 'string' ? e : null;
  } catch {
    return null;
  }
}

export class RoomSession {
  readonly encounterId: string;
  private deps: SessionDeps;
  private body: RoomOpenBody;
  private state: RoomState;
  private source: RoomSource | null = null;
  private generation = 0;
  private retry: unknown = null;
  private delay = RETRY_MIN;
  private started = false;
  private stopped = false;
  private failures = 0;

  constructor(body: RoomOpenBody, deps: SessionDeps) {
    this.encounterId = body.encounterId;
    this.body = body;
    this.deps = deps;
    this.state = emptyRoom(body.encounterId);
  }

  getState(): RoomState {
    return this.state;
  }

  isStopped(): boolean {
    return this.stopped;
  }

  private path(suffix: string): string {
    return `${BASE}/${encodeURIComponent(this.encounterId)}${suffix}`;
  }

  private update(next: RoomState): void {
    if (next === this.state) return;
    this.state = next;
    this.deps.onState(next);
  }

  private connection(c: RoomConnection): void {
    if (this.state.connection !== c) this.update({ ...this.state, connection: c });
  }

  /** Idempotent: opening the same encounter twice is one room, one stream. */
  async start(): Promise<void> {
    if (this.started || this.stopped) return;
    this.started = true;
    this.connection('connecting');
    await this.open();
  }

  private async open(): Promise<void> {
    if (this.stopped) return;
    try {
      const r = await this.deps.post(`${BASE}/open`, this.body);
      if (this.stopped) return;
      const enabled = r.enabled === true;
      this.update({ ...this.state, enabled, reason: typeof r.reason === 'string' ? r.reason : undefined, connection: enabled ? 'connecting' : 'idle' });
      if (enabled) this.stream();
    } catch {
      if (this.stopped) return;
      // No backend or no room API: the legacy flow keeps working. Keep trying
      // quietly for a while (the server may be restarting), then give up.
      this.failures += 1;
      if (!this.state.enabled && this.failures >= 4) {
        this.connection('idle');
        return;
      }
      this.connection(this.state.enabled ? 'offline' : 'connecting');
      this.later(() => void this.open());
    }
  }

  private later(fn: () => void): void {
    if (this.retry !== null) this.deps.clearTimer(this.retry);
    this.retry = this.deps.setTimer(() => {
      this.retry = null;
      fn();
    }, this.delay);
    this.delay = Math.min(this.delay * 2, RETRY_MAX);
  }

  private stream(): void {
    this.closeSource();
    if (this.stopped) return;
    const mine = ++this.generation;
    const live = () => !this.stopped && mine === this.generation;
    this.source = this.deps.connect(this.path(`/stream?after=${this.state.lastSeq}`), {
      open: () => {
        if (!live()) return;
        this.delay = RETRY_MIN;
        this.failures = 0;
        this.connection('live');
      },
      event: (data) => {
        if (!live()) return;
        const e = parseRoomEvent(data);
        if (e) this.handle(e);
      },
      error: () => {
        if (!live()) return;
        this.closeSource();
        this.connection('offline');
        // Re-open first: it is idempotent on the server and covers a restart.
        this.failures = 0;
        this.later(() => void this.open());
      },
    });
  }

  /** Apply one event (exposed for the demo player and the tests). */
  handle(e: RoomEvent): void {
    if (this.stopped) return;
    if (e.type === 'status' && Number.isFinite(e.seq) && e.seq < this.state.lastSeq) {
      // The snapshot is behind our cursor: the server's log started over.
      this.update(rewind(roomReducer(this.state, e)));
      if (this.source) this.stream();
      return;
    }
    const before = this.state;
    const next = roomReducer(before, e);
    if (next === before) return;
    this.update(this.state.connection === 'live' || e.type === 'status' ? next : { ...next, connection: 'live' });
    if (e.type === 'apply') {
      const key = `${this.encounterId}|${e.apply.ref}|${e.seq}`;
      if (!applied.has(key)) {
        applied.add(key);
        this.deps.onApply(e.apply, this.state);
      }
    } else if (e.type === 'speak') {
      const key = `${this.encounterId}|${e.speak.id}`;
      if (!spoken.has(key)) {
        spoken.add(key);
        this.deps.onSpeak(e.speak, this.state);
      }
    }
    this.deps.onEvent?.(e, this.state);
  }

  private closeSource(): void {
    this.generation += 1;
    const s = this.source;
    this.source = null;
    s?.close();
  }

  /** Stop for good. The state stays readable. */
  stop(): void {
    if (this.stopped) return;
    this.closeSource();
    if (this.retry !== null) this.deps.clearTimer(this.retry);
    this.retry = null;
    this.stopped = true;
  }

  // ── actions ────────────────────────────────────────────────────────────

  ask(target: string, utterance: string, lang: string): Promise<Record<string, unknown>> {
    return this.deps.post(this.path('/ask'), { target, utterance, lang });
  }

  async answer(ref: string, text: string, lang: string): Promise<void> {
    await this.deps.post(this.path('/answer'), { ref, text, lang });
    this.update(markAnswered(this.state, ref, text));
  }

  inviteFaculty(reason?: string): Promise<Record<string, unknown>> {
    return this.deps.post(this.path('/faculty/invite'), reason ? { reason } : {});
  }

  async sayToFaculty(text: string): Promise<void> {
    await this.deps.post(this.path('/faculty/say'), { text });
    this.update(markToldFaculty(this.state));
  }

  override(ref: string, reason?: string): Promise<Record<string, unknown>> {
    return this.deps.post(this.path('/override'), reason ? { ref, reason } : { ref });
  }

  cancel(ref: string): Promise<Record<string, unknown>> {
    return this.deps.post(this.path('/cancel'), { ref });
  }

  retryDelegation(ref: string): Promise<Record<string, unknown>> {
    return this.deps.post(this.path('/retry'), { ref });
  }

  close(summary: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.deps.post(this.path('/close'), { summary });
  }
}

// ── one line, one voice ──────────────────────────────────────────────────

const lines = new Map<string, number>();
const norm = (t: string) => t.toLowerCase().replace(/[\s.,!?;:"'“”‘’।-]+/g, ' ').trim();

/** True the first time a sentence is claimed within `windowMs`. Asha's reply to
 *  an order and the room's own `speak` event can carry the same sentence. */
export function claimLine(text: string, now = Date.now(), windowMs = 20_000): boolean {
  const key = norm(text);
  if (!key) return false;
  for (const [k, at] of lines) if (now - at > windowMs) lines.delete(k);
  if (lines.has(key)) return false;
  lines.set(key, now);
  return true;
}

export function resetClaimedLines(): void {
  lines.clear();
}
