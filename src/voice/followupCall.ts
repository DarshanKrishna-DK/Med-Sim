/**
 * Asha follow-up call: the /call/<token> route (patient's phone), the client
 * registry of call links per case (doctor side) and the small HTTP helpers.
 * Pure apart from fetch/localStorage, which are guarded.
 */

export const FOLLOWUP_STORAGE_KEY = 'medsim.followupCalls.v1';
const TOKEN = '[A-Za-z0-9_-]{8,64}';
const ROUTE_RE = new RegExp(`^/call/(${TOKEN})/?$`);
const ANY_LINK_RE = new RegExp(`/call/(${TOKEN})(?:[/?#]|$)`);

export interface CallMedicine { name: string; dose: string; duration: string }

export interface CallInfo {
  patientName: string;
  reason: string;
  prescriptions: CallMedicine[];
  lang: string;
  callsLeftToday: number;
  maxSeconds: number;
}

export interface CallSummary {
  adherence: 'good' | 'partial' | 'poor' | 'unknown';
  sideEffects: string[];
  redFlags: string[];
  patientMood: string;
  summary: string;
  followUpNeeded: boolean;
  at?: number;
  error?: string;
}

export interface CallRecord {
  callId: string;
  startedAt: number;
  endedAt: number | null;
  summary: CallSummary | null;
  transcript: Array<{ role: 'user' | 'assistant'; content: string }> | null;
}

export interface CallSummariesResponse {
  caseId: string | null;
  patientName: string | null;
  callsLeftToday: number;
  calls: CallRecord[];
}

export interface StoredCallLink { token: string; caseId: string; url: string; at: number }

/** Token from a /call/<token> pathname, else null. */
export function parseCallToken(pathname: string): string | null {
  const m = ROUTE_RE.exec(pathname || '');
  return m ? m[1] : null;
}

export function callTokenFromUrl(): string | null {
  return typeof window === 'undefined' ? null : parseCallToken(window.location.pathname);
}

/** Token from any call link (absolute or relative), else null. */
export function tokenFromCallUrl(url: unknown): string | null {
  if (typeof url !== 'string') return null;
  const m = ANY_LINK_RE.exec(url);
  return m ? m[1] : null;
}

/** Call links in a nurse run's steps (result.calendar.callUrl). */
export function callUrlsFromSteps(steps: ReadonlyArray<{ result?: unknown }> | undefined): string[] {
  const out: string[] = [];
  for (const s of steps ?? []) {
    const cal = (s?.result as { calendar?: { callUrl?: unknown } } | undefined)?.calendar;
    if (cal && typeof cal.callUrl === 'string' && tokenFromCallUrl(cal.callUrl)) out.push(cal.callUrl);
  }
  return out;
}

function readAll(): StoredCallLink[] {
  try {
    const raw = globalThis.localStorage?.getItem(FOLLOWUP_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter((x) => x && typeof x.token === 'string' && typeof x.caseId === 'string')
      : [];
  } catch {
    return [];
  }
}

const listeners = new Set<() => void>();

export function subscribeFollowupCalls(fn: () => void): () => void {
  listeners.add(fn);
  return () => { listeners.delete(fn); };
}

/** Remember a call link for a case (newest first, max 50 links). */
export function rememberFollowupCall(caseId: string, url: string, now = Date.now()): StoredCallLink | null {
  const token = tokenFromCallUrl(url);
  if (!token || !caseId) return null;
  const entry: StoredCallLink = { token, caseId, url, at: now };
  const next = [entry, ...readAll().filter((x) => x.token !== token)].slice(0, 50);
  try { globalThis.localStorage?.setItem(FOLLOWUP_STORAGE_KEY, JSON.stringify(next)); } catch { /* quota */ }
  for (const fn of listeners) fn();
  return entry;
}

export function followupCallsForCase(caseId: string): StoredCallLink[] {
  return readAll().filter((x) => x.caseId === caseId);
}

/** Link the patient's phone opens: absolute links stay, paths get this origin. */
export function absoluteCallUrl(link: StoredCallLink): string {
  if (/^https?:\/\//i.test(link.url)) return link.url;
  const origin = typeof window === 'undefined' ? '' : window.location.origin;
  return `${origin}/call/${link.token}`;
}

async function jsonOrThrow<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let detail = '';
    try { detail = String((await r.json())?.detail ?? ''); } catch { /* not JSON */ }
    throw new Error(detail || `Request failed (${r.status})`);
  }
  return (await r.json()) as T;
}

export const callApi = {
  info: (token: string) => fetch(`/call-api/${token}`).then((r) => jsonOrThrow<CallInfo>(r)),
  startUrl: (token: string) => `/call-api/${token}/start`,
  stopUrl: (token: string) => `/call-api/${token}/stop`,
  summary: (token: string, transcript: Array<{ role: string; content: string }>, callId?: string) =>
    fetch(`/call-api/${token}/summary`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ transcript, ...(callId ? { callId } : {}) }),
    }).then((r) => jsonOrThrow<{ ok: boolean; summary: CallSummary }>(r)),
  summaries: (token: string) =>
    fetch(`/agent/followup-call/${token}/summaries`).then((r) => jsonOrThrow<CallSummariesResponse>(r)),
};
