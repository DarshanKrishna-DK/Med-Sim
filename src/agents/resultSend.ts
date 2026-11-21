// Consultation result delivery to Telegram: POST /agent/results/send.
// The backend sends a Telegram summary, a one-page PDF report card and a short Murf
// voice summary. Pure helpers (payload, destination) plus a once-per-encounter sender
// with a tiny status store the UI chip subscribes to. Never throws.

export interface ResultDomain {
  name: string;
  score: number;
  max: number;
}

export interface ResultPayload {
  to?: string;
  profile: { name: string; university: string };
  case: { id: string; title: string; patientName: string; specialty: string; chiefComplaint: string };
  evaluation: {
    score?: number;
    verdict: string;
    domain_scores: ResultDomain[];
    strengths: string[];
    improvements: string[];
    narrative: string;
    diagnosis?: { chosen: string | null; correct: string | null; isCorrect: boolean | null };
    prescriptions: string[];
    tests: string[];
  };
  lang: string;
}

export type ResultStatus =
  | { state: 'idle' }
  | { state: 'sending' }
  | { state: 'sent'; partial: string | null }
  | { state: 'error'; error: string };

/** 'telegram', '@username' or 'tg:<chat id>' (same forms the backend accepts). */
export function isTelegramDest(raw: string | null | undefined): boolean {
  const d = (raw ?? '').trim().toLowerCase();
  return d === 'telegram' || d === 'tg' || /^tg:-?\d{1,20}$/.test(d) || /^@[a-z0-9_]{4,32}$/.test(d);
}

/** Where results go: the profile's Telegram field first, else a Telegram-style
 *  Plan-tab patient contact. '' means not set (no auto-send). */
export function resultDestination(profileTo: string | null | undefined, patientContact: string | null | undefined): string {
  const p = (profileTo ?? '').trim();
  if (p && isTelegramDest(p)) return p;
  const c = (patientContact ?? '').trim();
  return isTelegramDest(c) ? c : '';
}

const clean = (s: unknown, n = 300) =>
  String(s ?? '').replace(/—|–/g, '-').replace(/\s+/g, ' ').trim().slice(0, n);

export function buildResultPayload(input: {
  to?: string;
  profile: { name?: string; university?: string } | null;
  caseId: string;
  caseTitle: string;
  patientName: string;
  specialty?: string;
  chiefComplaint?: string;
  score?: number | null;
  verdict: string;
  domains: ResultDomain[];
  strengths: string[];
  improvements: string[];
  narrative?: string;
  diagnosisChosen?: string | null;
  diagnosisCorrect?: string | null;
  diagnosisIsCorrect?: boolean | null;
  prescriptions?: string[];
  tests?: string[];
  lang?: string;
}): ResultPayload {
  const list = (xs: string[] | undefined, k: number, n = 300) => (xs ?? []).map((x) => clean(x, n)).filter(Boolean).slice(0, k);
  const out: ResultPayload = {
    profile: { name: clean(input.profile?.name, 80), university: clean(input.profile?.university, 120) },
    case: {
      id: clean(input.caseId, 80),
      title: clean(input.caseTitle, 160),
      patientName: clean(input.patientName, 80),
      specialty: clean(input.specialty, 80),
      chiefComplaint: clean(input.chiefComplaint, 300),
    },
    evaluation: {
      verdict: clean(input.verdict, 40),
      domain_scores: input.domains
        .filter((d) => Number.isFinite(d.score) && Number.isFinite(d.max))
        .slice(0, 8)
        .map((d) => ({ name: clean(d.name, 80), score: d.score, max: d.max })),
      strengths: list(input.strengths, 20),
      improvements: list(input.improvements, 20),
      narrative: clean(input.narrative, 3000),
      prescriptions: list(input.prescriptions, 20, 160),
      tests: list(input.tests, 40, 160),
    },
    lang: input.lang || 'en',
  };
  if (typeof input.score === 'number' && Number.isFinite(input.score)) out.evaluation.score = input.score;
  if (input.diagnosisChosen || input.diagnosisCorrect) {
    out.evaluation.diagnosis = {
      chosen: input.diagnosisChosen ? clean(input.diagnosisChosen, 160) : null,
      correct: input.diagnosisCorrect ? clean(input.diagnosisCorrect, 160) : null,
      isCorrect: input.diagnosisIsCorrect ?? null,
    };
  }
  if (input.to && input.to.trim()) out.to = input.to.trim();
  return out;
}

// ---------------------------------------------------------------- sender + status

const statuses = new Map<string, ResultStatus>();
const autoSent = new Set<string>();
const listeners = new Set<() => void>();
const IDLE: ResultStatus = { state: 'idle' };

function set(key: string, s: ResultStatus) {
  statuses.set(key, s);
  for (const l of listeners) l();
}

export function resultStatus(key: string): ResultStatus {
  return statuses.get(key) ?? IDLE;
}

export function subscribeResultStatus(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

interface SendResponse {
  ok?: boolean;
  error?: string;
  detail?: unknown;
  parts?: Record<string, { ok?: boolean; skipped?: boolean; error?: string }>;
}

/** Summarise a successful response: which optional parts did not arrive. */
export function partialNote(parts: SendResponse['parts']): string | null {
  if (!parts) return null;
  const missing: string[] = [];
  if (parts.document && !parts.document.ok) missing.push('PDF');
  if (parts.audio && !parts.audio.ok && !parts.audio.skipped) missing.push('voice');
  return missing.length ? `${missing.join(' and ')} not sent` : null;
}

export async function sendResult(key: string, payload: ResultPayload): Promise<ResultStatus> {
  if (resultStatus(key).state === 'sending') return resultStatus(key);
  set(key, { state: 'sending' });
  let s: ResultStatus;
  try {
    const r = await fetch('/agent/results/send', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = (await r.json().catch(() => ({}))) as SendResponse;
    if (!r.ok) {
      const detail = typeof data.detail === 'string' ? data.detail : `Server error ${r.status}`;
      s = { state: 'error', error: detail };
    } else if (!data.ok) {
      s = { state: 'error', error: data.error || 'Send failed' };
    } else {
      s = { state: 'sent', partial: partialNote(data.parts) };
    }
  } catch {
    s = { state: 'error', error: 'Backend unreachable' };
  }
  set(key, s);
  return s;
}

/** Fire-and-forget auto-send, at most once per encounter key in this tab. */
export function autoSendResultOnce(key: string, payload: ResultPayload): boolean {
  const SKEY = 'medsim.resultsAutoSent.v1';
  let seen: string[] = [];
  try {
    seen = JSON.parse(globalThis.sessionStorage?.getItem(SKEY) ?? '[]') as string[];
  } catch {
    seen = [];
  }
  if (autoSent.has(key) || seen.includes(key)) return false;
  autoSent.add(key);
  try {
    globalThis.sessionStorage?.setItem(SKEY, JSON.stringify([...seen, key].slice(-50)));
  } catch {
    /* private mode: in-memory guard only */
  }
  void sendResult(key, payload);
  return true;
}
