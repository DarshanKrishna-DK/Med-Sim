// Active assignment for this browser: opened from a teacher's link
// (/?assignment=<code>), kept in localStorage, and fed by every saved
// debrief / OSCE / viva (see reportAttempt, called from saveEvalHistory).

import { useSyncExternalStore } from 'react';
import type { EvalHistoryEntry } from '../data/evalHistory';
import { listEvalHistory } from '../data/evalHistory';
import { entryScore } from '../data/progress';
import { SKILL_LABELS, type SkillKey } from '../agents/osceCore';
import { getProfile } from '../game/profile';
import {
  computeAssignmentProgress,
  isAssignmentCode,
  itemMatches,
  parseAssignmentCode,
  type Assignment,
  type AssignmentItemKind,
  type AssignmentProgress,
  type LocalAttemptRecord,
} from './core';

const KEY = 'medsim.assignment.v1';
const LOG = '[medsim:assignment]';

interface Persisted {
  code: string | null;
  assignment: Assignment | null;
  attempts: LocalAttemptRecord[];
  /** clientIds not yet accepted by the backend. */
  unsynced: string[];
  known: string[];
}

export interface AssignmentView {
  code: string | null;
  assignment: Assignment | null;
  progress: AssignmentProgress | null;
  known: string[];
  loading: boolean;
  error: string;
}

const EMPTY: Persisted = { code: null, assignment: null, attempts: [], unsynced: [], known: [] };
let data: Persisted = read();
let loading = false;
let error = '';
let view: AssignmentView = makeView();
const listeners = new Set<() => void>();
/** Full EvalHistory rows awaiting upload, by clientId (this page load only). */
const pendingRows = new Map<string, EvalHistoryEntry>();

function read(): Persisted {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return { ...EMPTY };
    const p = JSON.parse(raw) as Partial<Persisted>;
    return {
      code: typeof p.code === 'string' ? p.code : null,
      assignment: p.assignment ?? null,
      attempts: Array.isArray(p.attempts) ? p.attempts : [],
      unsynced: Array.isArray(p.unsynced) ? p.unsynced : [],
      known: Array.isArray(p.known) ? p.known.filter(isAssignmentCode) : [],
    };
  } catch {
    return { ...EMPTY };
  }
}

function makeView(): AssignmentView {
  const a = data.assignment;
  return {
    code: data.code,
    assignment: a,
    progress: a ? computeAssignmentProgress(a, data.attempts) : null,
    known: data.known,
    loading,
    error,
  };
}

function commit(next: Partial<Persisted>) {
  data = { ...data, ...next };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* private mode: memory only */
  }
  emit();
}

function emit() {
  view = makeView();
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getAssignmentView(): AssignmentView {
  return view;
}

export function useAssignment(): AssignmentView {
  return useSyncExternalStore(subscribe, getAssignmentView, getAssignmentView);
}

async function api<T>(path: string, init?: RequestInit): Promise<T> {
  const r = await fetch(path, { ...init, headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) } });
  if (!r.ok) {
    let detail = '';
    try {
      const j = (await r.json()) as { detail?: unknown };
      detail = typeof j.detail === 'string' ? j.detail : '';
    } catch {
      /* not json */
    }
    throw new Error(detail || `${path} failed (${r.status})`);
  }
  return (await r.json()) as T;
}

/** Load (or refresh) an assignment by code and make it the active one. */
export async function openAssignment(code: string): Promise<Assignment | null> {
  const c = code.trim().toUpperCase();
  if (!isAssignmentCode(c)) {
    error = 'That is not a valid assignment code.';
    emit();
    return null;
  }
  const switching = c !== data.code;
  if (switching) commit({ code: c, assignment: null, attempts: [], unsynced: [] });
  loading = true;
  error = '';
  emit();
  try {
    const a = await api<Assignment>(`/agent/assignments/${c}`);
    loading = false;
    commit({ assignment: a, known: [c, ...data.known.filter((k) => k !== c)].slice(0, 12) });
    void syncPending();
    return a;
  } catch (e) {
    loading = false;
    error = e instanceof Error ? e.message : String(e);
    emit();
    return null;
  }
}

/** On page load: `?assignment=<code>` opens it; otherwise refresh the stored one. */
export function captureAssignmentFromUrl(): void {
  if (typeof window === 'undefined') return;
  const code = parseAssignmentCode(window.location.search);
  if (code) void openAssignment(code);
  else if (data.code) void openAssignment(data.code);
}

export function leaveAssignment(): void {
  commit({ code: null, assignment: null, attempts: [], unsynced: [] });
}

function kindFor(e: EvalHistoryEntry): AssignmentItemKind | null {
  if (e.mode === 'ot') return null;
  if (e.mode === 'viva') return 'viva';
  if (e.mode === 'osce') return 'osce';
  return 'case';
}

function attemptBody(e: EvalHistoryEntry, kind: AssignmentItemKind) {
  const p = getProfile();
  const domains: Record<string, number> = {};
  for (const [k, v] of Object.entries(e.skillScores ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) domains[SKILL_LABELS[k as SkillKey] ?? k] = Math.round(v);
  }
  const ev = e.evaluation;
  return {
    student: p?.name || 'Student',
    university: p?.university ?? '',
    caseId: e.caseId,
    kind,
    subject: e.subject ?? null,
    label: e.caseName,
    score: Math.round(entryScore(e)),
    domains,
    strengths: (ev?.highlights ?? []).slice(0, 4),
    improvements: (ev?.improvements ?? []).slice(0, 4),
    feedback: ev?.narrative ? [ev.narrative.slice(0, 240)] : [],
    timestamp: e.savedAt,
    clientId: e.id,
  };
}

/** Called for every saved evaluation. Records it locally when it matches an
 *  assigned item and posts it to the backend (retried on the next load). */
export function reportAttempt(e: EvalHistoryEntry): void {
  const a = data.assignment;
  const kind = kindFor(e);
  if (!a || !data.code || !kind) return;
  const rec: LocalAttemptRecord = { clientId: e.id, caseId: e.caseId, kind, subject: e.subject ?? null, score: Math.round(entryScore(e)), at: e.savedAt };
  if (!a.items.some((i) => itemMatches(i, rec))) return;
  if (data.attempts.some((x) => x.clientId === e.id)) return;
  pendingRows.set(e.id, e);
  commit({ attempts: [...data.attempts, rec], unsynced: [...data.unsynced, e.id] });
  void syncPending();
}

let syncing: Promise<void> | null = null;

/** Upload attempts the backend has not acknowledged yet. */
export function syncPending(): Promise<void> {
  if (syncing) return syncing;
  syncing = (async () => {
    const code = data.code;
    if (!code || !data.unsynced.length) return;
    const rows = data.unsynced.map((id) => pendingRows.get(id) ?? listEvalHistory().find((x) => x.id === id) ?? null);
    const done: string[] = [];
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const id = data.unsynced[i];
      if (!row) {
        done.push(id); // evaluation row is gone, nothing to send
        continue;
      }
      const kind = kindFor(row);
      if (!kind) {
        done.push(id);
        continue;
      }
      try {
        await api(`/agent/assignments/${code}/attempts`, { method: 'POST', body: JSON.stringify(attemptBody(row, kind)) });
        done.push(id);
      } catch (err) {
        console.warn(LOG, 'attempt upload failed, will retry:', err);
        break;
      }
    }
    if (done.length) commit({ unsynced: data.unsynced.filter((id) => !done.includes(id)) });
  })().finally(() => {
    syncing = null;
  });
  return syncing;
}

export interface EmailResult {
  ok: boolean;
  via?: string;
  to?: string;
  teacherName?: string;
  reason?: string;
}

/** One-click "Submit to teacher": emails the report to the assignment's teacher. */
export async function submitToTeacher(note?: string): Promise<EmailResult> {
  const code = data.code;
  if (!code) return { ok: false, reason: 'No active assignment.' };
  const p = getProfile();
  if (!p) return { ok: false, reason: 'Fill in your profile first.' };
  await syncPending();
  try {
    return await api<EmailResult>(`/agent/assignments/${code}/email`, {
      method: 'POST',
      body: JSON.stringify({ student: p.name, university: p.university, note: note || undefined }),
    });
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : String(e) };
  }
}

export interface LocalProgressSummary {
  sessions: number;
  average: number | null;
  recent: Array<{ label: string; kind: string; specialty?: string; score: number; at: number }>;
  skills: Record<string, number>;
}

/** Compact summary of this browser's saved evaluations, for the receptionist. */
export function localProgressSummary(): LocalProgressSummary {
  const rows = listEvalHistory();
  const scores = rows.map((r) => entryScore(r));
  const skills: Record<string, number[]> = {};
  for (const r of rows) {
    for (const [k, v] of Object.entries(r.skillScores ?? {})) {
      if (typeof v === 'number') (skills[SKILL_LABELS[k as SkillKey] ?? k] ??= []).push(v);
    }
  }
  return {
    sessions: rows.length,
    average: scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null,
    recent: rows.slice(0, 8).map((r) => ({
      label: r.caseName,
      kind: r.mode ?? 'practice',
      specialty: r.specialty,
      score: Math.round(entryScore(r)),
      at: r.savedAt,
    })),
    skills: Object.fromEntries(Object.entries(skills).map(([k, v]) => [k, Math.round(v.reduce((a, b) => a + b, 0) / v.length)])),
  };
}
