// Events from the autonomous voice agents (backend/agent_events.py).
//
// Priya, Dr. Iyer and the viva examiner run their own tools inside our custom
// LLM endpoint, mid-call. Tools that change the page (whiteboard, quiz,
// assignment created, viva mark...) publish an event on the session's channel;
// the Conversation polls GET /agent/agent-events/{channel}?after=n every 1.5 s
// while a tool-enabled session is live and hands new events to the screen.
//
// Pure module (no React / DOM imports) so scripts/test can import it.

export interface AgentEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
  at: number;
}

export interface EventPage {
  events: AgentEvent[];
  next: number;
}

export const POLL_MS = 1500;

const str = (v: unknown, n = 200): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');

function isEvent(e: unknown): e is AgentEvent {
  const x = e as AgentEvent;
  return !!x && typeof x === 'object' && Number.isFinite(x.seq) && typeof x.type === 'string' && !!x.data && typeof x.data === 'object';
}

/** New events after `cursor`, oldest first, deduped by seq; plus the new cursor. */
export function mergeEvents(cursor: number, page: unknown): { fresh: AgentEvent[]; cursor: number } {
  const raw = (page as EventPage | null)?.events;
  const list = Array.isArray(raw) ? raw.filter(isEvent) : [];
  const seen = new Set<number>();
  const fresh = list
    .filter((e) => e.seq > cursor && !seen.has(e.seq) && seen.add(e.seq))
    .sort((a, b) => a.seq - b.seq);
  const last = fresh.length ? fresh[fresh.length - 1].seq : cursor;
  const next = Number((page as EventPage | null)?.next);
  // A server restart resets seq: follow its cursor down so new events still arrive.
  if (!fresh.length && Number.isFinite(next) && next < cursor) return { fresh, cursor: next };
  return { fresh, cursor: last };
}

// ── per-screen interpretation ──────────────────────────────────────────

/** A tool the agent ran: one line for the desk / class log. */
export function toolLine(e: AgentEvent): { summary: string; ok: boolean } | null {
  if (e.type !== 'tool') return null;
  const summary = str(e.data.summary, 240) || str(e.data.tool, 60);
  return summary ? { summary, ok: e.data.ok === true } : null;
}

export interface QuizCard {
  question: string;
  options: string[];
  answerIndex: number;
  why: string;
}

export type TeacherAction =
  | { kind: 'board'; topic: string }
  | { kind: 'quiz'; quiz: QuizCard }
  | { kind: 'toast'; text: string; code?: string; link?: string };

export function teacherAction(e: AgentEvent): TeacherAction | null {
  const d = e.data;
  if (e.type === 'whiteboard') {
    const topic = str(d.topic, 80);
    if (topic.length < 2) return null;
    const preset = str(d.preset, 40);
    return { kind: 'board', topic: preset ? `${topic} (${preset.replace(/-/g, ' ')})` : topic };
  }
  if (e.type === 'quiz') {
    const options = (Array.isArray(d.options) ? d.options : []).map((o) => str(o, 80)).filter(Boolean).slice(0, 4);
    const answerIndex = Number(d.answerIndex);
    const question = str(d.question, 200);
    if (!question || options.length < 2 || !Number.isInteger(answerIndex) || answerIndex < 0 || answerIndex >= options.length) return null;
    return { kind: 'quiz', quiz: { question, options, answerIndex, why: str(d.why, 200) } };
  }
  if (e.type === 'assignment') {
    const code = str(d.code, 12);
    if (!code) return null;
    return { kind: 'toast', text: `Assignment created: ${code}`, code, link: str(d.link, 80) || `/?assignment=${code}` };
  }
  if (e.type === 'calendar') {
    const when = str(d.startText, 60);
    return { kind: 'toast', text: d.booked ? `Booked in Google Calendar: ${str(d.title, 80)}, ${when}` : `Calendar not connected (${when})` };
  }
  return null;
}

export interface LiveGrade {
  question: string;
  score: number;
  hit: string[];
  missed: string[];
}

export type VivaAction =
  | { kind: 'grade'; grade: LiveGrade }
  | { kind: 'question'; index: number }
  | { kind: 'end'; summary: string };

export function vivaAction(e: AgentEvent): VivaAction | null {
  const d = e.data;
  const list = (v: unknown) => (Array.isArray(v) ? v.map((x) => str(x, 120)).filter(Boolean).slice(0, 6) : []);
  if (e.type === 'viva_grade') {
    const score = Number(d.score);
    const question = str(d.question, 240);
    if (!question || !Number.isFinite(score)) return null;
    return { kind: 'grade', grade: { question, score: Math.max(0, Math.min(10, Math.round(score))), hit: list(d.hit), missed: list(d.missed) } };
  }
  if (e.type === 'viva_question') {
    const index = Number(d.index);
    return Number.isInteger(index) && index >= 0 && index < 50 ? { kind: 'question', index } : null;
  }
  if (e.type === 'viva_end') return { kind: 'end', summary: str(d.summary, 400) };
  return null;
}

/** Live marks keyed by question: a re-mark replaces the earlier one. */
export function upsertGrade(grades: LiveGrade[], g: LiveGrade): LiveGrade[] {
  const key = (q: string) => q.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  const i = grades.findIndex((x) => key(x.question) === key(g.question));
  if (i < 0) return [...grades, g].slice(-20);
  const out = grades.slice();
  out[i] = g;
  return out;
}

// ── poller ─────────────────────────────────────────────────────────────

export interface PollerDeps {
  fetchPage: (channel: string, after: number) => Promise<unknown>;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (h: unknown) => void;
}

const defaultDeps = (): PollerDeps => ({
  fetchPage: async (channel, after) => {
    const r = await fetch(`/agent/agent-events/${encodeURIComponent(channel)}?after=${after}`);
    if (!r.ok) throw new Error(`agent events ${r.status}`);
    return r.json();
  },
  setTimer: (fn, ms) => setTimeout(fn, ms),
  clearTimer: (h) => clearTimeout(h as ReturnType<typeof setTimeout>),
});

/** Poll a channel until stopped. Errors back off (x2, max 12 s) and never throw. */
export function startAgentEventPoller(
  channel: string,
  onEvents: (events: AgentEvent[]) => void,
  opts: { intervalMs?: number; deps?: Partial<PollerDeps> } = {},
): () => void {
  const deps = { ...defaultDeps(), ...opts.deps };
  const base = opts.intervalMs ?? POLL_MS;
  let cursor = 0;
  let stopped = false;
  let timer: unknown = null;
  let delay = base;
  const tick = async () => {
    timer = null;
    if (stopped) return;
    try {
      const page = await deps.fetchPage(channel, cursor);
      if (stopped) return;
      const { fresh, cursor: next } = mergeEvents(cursor, page);
      cursor = next;
      delay = base;
      if (fresh.length) onEvents(fresh);
    } catch {
      delay = Math.min(delay * 2, 12_000);
    }
    if (!stopped) timer = deps.setTimer(() => void tick(), delay);
  };
  timer = deps.setTimer(() => void tick(), base);
  return () => {
    stopped = true;
    if (timer !== null) deps.clearTimer(timer);
  };
}
