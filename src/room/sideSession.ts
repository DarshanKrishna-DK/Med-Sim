// One side room (backend/agentroom/siderooms.py) as the browser follows it: opens
// it, streams its events, reconnects, and hands the newest `side` state out.
// Everything it touches is injected so scripts/test can drive it; `openSide` and
// `watchSide` below wire the real fetch and EventSource.

import { emptyRoom, roomReducer, type RoomState } from './reducer.ts';
import { parseRoomEvent, type RoomSource } from './session.ts';
import type { RoomEvent, RoomSpeak, SideState } from './types';

export interface SideOpen {
  kind: string;
  refId: string;
  title?: string;
  lang?: string;
  context?: Record<string, unknown>;
  /** A BAND room this browser saw earlier: taken up again after a server restart. */
  roomId?: string;
}

export interface SideHandlers {
  onState: (side: SideState) => void;
  /** The server has no BAND (or no identity for this kind): keep today's behaviour. */
  onDisabled?: (reason: string) => void;
  onSpeak?: (speak: RoomSpeak) => void;
  onRoom?: (room: RoomState) => void;
  onEvent?: (e: RoomEvent) => void;
  /** The server no longer knows a watched room and it cannot be opened again. */
  onGone?: () => void;
}

export interface SideDeps {
  post: (path: string, body: unknown) => Promise<Record<string, unknown>>;
  get: (path: string) => Promise<Record<string, unknown> | null>;
  connect: (url: string, on: { open: () => void; event: (data: string) => void; error: () => void }) => RoomSource;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

const RETRY_MIN = 1500;
const RETRY_MAX = 20_000;

/** The BAND room id at the end of its link, for `roomId`. */
export const roomIdOf = (url: string): string => /\/rooms\/([A-Za-z0-9-]{4,64})$/.exec(url ?? '')?.[1] ?? '';

export class SideSession {
  id = '';
  side: SideState | null = null;
  private room: RoomState;
  private source: RoomSource | null = null;
  private timer: unknown = null;
  private delay = RETRY_MIN;
  private generation = 0;
  private stopped = false;
  private failures = 0;
  private spoken = new Set<string>();
  private open: SideOpen | null;
  private on: SideHandlers;
  private deps: SideDeps;

  /** With `open` the room is opened; with `id` an existing one is only followed. */
  constructor(what: { open: SideOpen } | { id: string }, on: SideHandlers, deps: SideDeps) {
    this.open = 'open' in what ? what.open : null;
    if ('id' in what) this.id = what.id;
    this.on = on;
    this.deps = deps;
    this.room = emptyRoom(this.id);
  }

  async start(): Promise<void> {
    if (this.stopped) return;
    try {
      const r = this.open
        ? await this.deps.post('/agent/room/side/open', this.open)
        : await this.deps.get(`/agent/room/side/${encodeURIComponent(this.id)}`);
      if (this.stopped) return;
      if (r === null) {
        this.stop();
        this.on.onGone?.();
        return;
      }
      if (r.enabled !== true) {
        this.stop();
        this.on.onDisabled?.(String(r.reason ?? ''));
        return;
      }
      this.id = String(r.id ?? this.id);
      // Replay from the start: after a server restart the log has a new numbering.
      this.room = emptyRoom(this.id);
      this.take(r.side as SideState);
      this.failures = 0;
      this.stream();
    } catch {
      this.failures += 1;
      if (this.failures >= 5 && !this.side) {
        this.stop();
        this.on.onDisabled?.('not reachable');
        return;
      }
      this.later();
    }
  }

  private take(side: SideState | undefined): void {
    if (!side || typeof side !== 'object' || typeof side.status !== 'string') return;
    this.side = side;
    const roomId = roomIdOf(side.url);
    if (this.open && roomId) this.open = { ...this.open, roomId };
    this.on.onState(side);
  }

  private later(): void {
    if (this.stopped) return;
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = this.deps.setTimer(() => {
      this.timer = null;
      void this.start();
    }, this.delay);
    this.delay = Math.min(this.delay * 2, RETRY_MAX);
  }

  private stream(): void {
    this.close();
    const mine = ++this.generation;
    const live = () => !this.stopped && mine === this.generation;
    this.source = this.deps.connect(`/agent/room/${encodeURIComponent(this.id)}/stream?after=${this.room.lastSeq}`, {
      open: () => {
        if (live()) this.delay = RETRY_MIN;
      },
      event: (data) => {
        const e = live() ? parseRoomEvent(data) : null;
        if (e) this.handle(e);
      },
      error: () => {
        if (!live()) return;
        this.close();
        this.later(); // opening again is idempotent and covers a server restart
      },
    });
  }

  /** Exposed for the tests. */
  handle(e: RoomEvent): void {
    if (this.stopped) return;
    const next = roomReducer(this.room, e);
    if (next === this.room) return;
    this.room = next;
    if (e.type === 'side') {
      this.take(e.side);
    } else if (e.type === 'speak') {
      if (!this.spoken.has(e.speak.id)) {
        this.spoken.add(e.speak.id);
        this.on.onSpeak?.(e.speak);
      }
    }
    this.on.onEvent?.(e);
    this.on.onRoom?.(this.room);
  }

  async act(action: string, data: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    const r = await this.deps.post(`/agent/room/side/${encodeURIComponent(this.id)}/act`, { action, data });
    this.take(r.side as SideState);
    return r;
  }

  private close(): void {
    this.generation += 1;
    const s = this.source;
    this.source = null;
    s?.close();
  }

  stop(): void {
    if (this.stopped) return;
    this.close();
    if (this.timer !== null) this.deps.clearTimer(this.timer);
    this.timer = null;
    this.stopped = true;
  }
}

// ── the real thing ───────────────────────────────────────────────────────

async function readError(r: Response, path: string): Promise<Error> {
  let detail = '';
  try {
    detail = String(((await r.json()) as { detail?: unknown }).detail ?? '');
  } catch {
    /* not JSON */
  }
  return new Error(detail || `${path} ${r.status}`);
}

const realDeps: SideDeps = {
  post: async (path, body) => {
    const r = await fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    if (!r.ok) throw await readError(r, path);
    return (await r.json()) as Record<string, unknown>;
  },
  get: async (path) => {
    const r = await fetch(path);
    if (r.status === 404) return null;
    if (!r.ok) throw await readError(r, path);
    return (await r.json()) as Record<string, unknown>;
  },
  connect: (url, on) => {
    const es = new EventSource(url);
    es.onopen = on.open;
    es.onmessage = (e) => on.event(String(e.data ?? ''));
    es.onerror = on.error;
    return { close: () => es.close() };
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
};

/** Open a side room and follow it until `stop()`. */
export function openSide(open: SideOpen, on: SideHandlers): SideSession {
  const s = new SideSession({ open }, on, realDeps);
  void s.start();
  return s;
}

/** Follow a side room somebody else opened (Priya's desk). */
export function watchSide(id: string, on: SideHandlers): SideSession {
  const s = new SideSession({ id }, on, realDeps);
  void s.start();
  return s;
}
