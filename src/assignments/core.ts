// Teacher assignments: pure helpers shared by the browser client and the
// node tests (no DOM, no imports beyond types). The backend
// (backend/assignments.py) is the source of truth for reports; these mirror
// its item matching so the chip and the case library can show progress
// instantly from this browser's own attempts.

export type AssignmentItemKind = 'case' | 'osce' | 'viva';

export interface AssignmentItem {
  id: string;
  kind: AssignmentItemKind;
  caseId: string | null;
  subject: string | null;
  label: string;
  specialty: string | null;
}

export interface Assignment {
  code: string;
  title: string;
  items: AssignmentItem[];
  dueDate: string | null;
  teacherName: string;
  teacherEmailMasked?: string;
  passMark: number;
  createdAt: number;
}

export interface LocalAttemptRecord {
  /** evalHistory id, used as the backend clientId (dedupe). */
  clientId: string;
  caseId: string;
  kind: AssignmentItemKind;
  subject: string | null;
  score: number;
  at: number;
}

export interface AssignmentProgress {
  done: number;
  total: number;
  /** Item ids completed by this browser. */
  doneIds: string[];
  pending: AssignmentItem[];
  average: number | null;
  /** True once every item is done and the average reaches the pass mark. */
  passed: boolean;
  overdue: boolean;
}

const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const CODE_RE = new RegExp(`^[${CODE_ALPHABET}]{6}$`);

/** `?assignment=ab3k9q` -> "AB3K9Q"; null for anything else. */
export function parseAssignmentCode(search: string): string | null {
  try {
    const raw = new URLSearchParams(search).get('assignment')?.trim().toUpperCase() ?? '';
    return CODE_RE.test(raw) ? raw : null;
  } catch {
    return null;
  }
}

export function isAssignmentCode(code: string): boolean {
  return CODE_RE.test((code ?? '').trim().toUpperCase());
}

export function itemMatches(item: AssignmentItem, a: Pick<LocalAttemptRecord, 'caseId' | 'kind' | 'subject'>): boolean {
  if (item.kind === 'case') return (a.kind === 'case' || a.kind === 'osce') && a.caseId === item.caseId;
  if (item.kind === 'osce') return a.kind === 'osce' && (!item.caseId || a.caseId === item.caseId);
  const want = (item.subject ?? '').trim().toLowerCase();
  return a.kind === 'viva' && (!want || (a.subject ?? '').trim().toLowerCase() === want);
}

/** Today as YYYY-MM-DD in local time. */
export function todayKey(now = Date.now()): string {
  const d = new Date(now);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** Progress from this browser's attempts: best score per item, average of best scores. */
export function computeAssignmentProgress(a: Assignment, attempts: LocalAttemptRecord[], now = Date.now()): AssignmentProgress {
  const best = new Map<string, number>();
  for (const item of a.items) {
    for (const at of attempts) {
      if (!itemMatches(item, at)) continue;
      best.set(item.id, Math.max(best.get(item.id) ?? -1, at.score));
    }
  }
  const doneIds = a.items.filter((i) => best.has(i.id)).map((i) => i.id);
  const scores = doneIds.map((id) => best.get(id) ?? 0);
  const average = scores.length ? Math.round((scores.reduce((s, x) => s + x, 0) / scores.length) * 10) / 10 : null;
  const total = a.items.length;
  return {
    done: doneIds.length,
    total,
    doneIds,
    pending: a.items.filter((i) => !best.has(i.id)),
    average,
    passed: doneIds.length === total && total > 0 && (average ?? 0) >= a.passMark,
    overdue: !!a.dueDate && a.dueDate < todayKey(now) && doneIds.length < total,
  };
}

/** Case ids the assignment asks for (case items and case-pinned OSCE stations). */
export function assignedCaseIds(a: Assignment | null): Set<string> {
  const out = new Set<string>();
  for (const i of a?.items ?? []) if (i.caseId && i.kind !== 'viva') out.add(i.caseId);
  return out;
}

/** "30 Nov" from "2026-11-30". */
export function formatDue(due: string | null): string {
  if (!due) return 'no due date';
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(due);
  if (!m) return due;
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  return `${Number(m[3])} ${months[Number(m[2]) - 1] ?? ''}`.trim();
}

/** "Assignment: Week 3 (2/4 done, due 30 Nov)". */
export function chipLabel(a: Assignment, p: AssignmentProgress): string {
  return `Assignment: ${a.title} (${p.done}/${p.total} done, due ${formatDue(a.dueDate)})`;
}

/** Is this receptionist utterance worth running the action agent on? */
export function looksLikeReceptionRequest(text: string): boolean {
  const t = text.toLowerCase();
  return /\b(e-?mail|mail|send|submit|forward|report|score|scores|marks|grade|result|results|progress|pending|status|assignment|assignments|homework|due|deadline|teacher|how am i doing|average|left to do|remaining|faculty|professor|hod|revise|revision|study plan|dr iyer|ask (?:sir|ma'?am|madam))\b/.test(t);
}
