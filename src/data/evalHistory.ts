// Persist completed AI debrief evaluations to localStorage so the home
// screen can list past reviews and the user can revisit any of them.
//
// Storage shape:
//   gr_eval_history → JSON array of EvalHistoryEntry, newest first.
//   Bounded to 100 entries; oldest are dropped beyond that.

import type { CaseEvaluationInput } from '../agents/customTools';
import type { ActivePatient, CoachAlert } from '../game/types';
import type { ClinicId } from '../game/clinic';
import type { OsceResult, SkillScores } from '../agents/osceCore';
import type { FacultyMarks } from '../observer/messages';
import type { SavedViva } from '../components/viva/vivaCore';
import { facultyMarksFor } from '../observer/facultyMarks';

const STORAGE_KEY = 'gr_eval_history';
const MAX_ENTRIES = 100;

export interface EvalHistoryEntry {
  /** Unique id, random + timestamp so repeated runs of the same case
   *  produce distinct rows. */
  id: string;
  /** Wall-clock ms when the evaluation was saved. */
  savedAt: number;
  /** Snapshot of the case so the home screen can show name + chief complaint
   *  without resolving against the catalogue (which may change). */
  caseId: string;
  caseName: string;
  caseAge: number;
  caseGender: 'M' | 'F';
  diagnosisLabel: string;
  /** Single-word verdict band shown as a chip. */
  verdict: CaseEvaluationInput['global_rating'];
  /** Full evaluation payload for the detail view. */
  evaluation: CaseEvaluationInput;
  /** ActivePatient snapshot at debrief time, feeds EvaluationBody so the
   *  prescriptions / orders panels still render after a reload. */
  patientSnapshot: ActivePatient;
  // ── Progress-dashboard fields (optional: older rows predate them) ──
  /** 'practice' = regular consultation, 'osce' = timed exam station. */
  mode?: 'practice' | 'osce' | 'ot' | 'viva';
  /** Viva voce rows: the subject examined (e.g. "Pharmacology"). */
  subject?: string;
  /** Viva voce rows: the examiner's full marking (see components/viva/vivaCore.ts). */
  viva?: SavedViva;
  /** Specialty (clinic) of the case. */
  specialty?: ClinicId;
  /** Overall 0-100. */
  score?: number;
  /** Per-skill 0-100 scores (history, reasoning, tests, treatment, ...). */
  skillScores?: SkillScores;
  /** Coach alerts raised during the encounter (recurring-mistake stats). */
  alerts?: Array<{ severity: CoachAlert['severity']; title: string }>;
  /** Full examiner marking for OSCE rows. */
  osce?: OsceResult & { candidateName?: string; durationSec: number; elapsedSec: number };
  /** Marks sent by a live faculty observer during this encounter. */
  facultyMarks?: FacultyMarks[];
}

function read(): EvalHistoryEntry[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    return parsed as EvalHistoryEntry[];
  } catch {
    return [];
  }
}

function write(entries: EvalHistoryEntry[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(entries.slice(0, MAX_ENTRIES)));
  } catch {
    /* quota exceeded or storage blocked, non-fatal */
  }
}

/** Newest-first list of saved evaluations. */
export function listEvalHistory(): EvalHistoryEntry[] {
  return read();
}

/** Save a new entry. Returns the persisted entry (with assigned id). */
export function saveEvalHistory(
  payload: Omit<EvalHistoryEntry, 'id' | 'savedAt'>,
): EvalHistoryEntry {
  // Faculty marks that arrived during the encounter ride along with the row.
  const marks = payload.facultyMarks ?? facultyMarksFor(payload.caseId, payload.patientSnapshot?.arrivedAt);
  const entry: EvalHistoryEntry = {
    ...payload,
    ...(marks.length ? { facultyMarks: marks } : {}),
    id: `eh_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
    savedAt: Date.now(),
  };
  const list = [entry, ...read()];
  write(list);
  // Teacher assignment: every saved debrief / OSCE / viva counts as an attempt.
  if (typeof window !== 'undefined') {
    void import('../assignments/client').then((m) => m.reportAttempt(entry)).catch(() => undefined);
  }
  return entry;
}

/** Attach faculty marks that arrived after the row was saved: the newest
 *  row for that case and encounter gets them (same mark id replaces). */
export function attachFacultyMarks(m: FacultyMarks): boolean {
  const list = read();
  const row = list.find((e) => e.caseId === m.caseId && (m.encounterAt === undefined || e.patientSnapshot?.arrivedAt === m.encounterAt));
  if (!row) return false;
  row.facultyMarks = [...(row.facultyMarks ?? []).filter((x) => x.id !== m.id), m];
  write(list);
  return true;
}

/** Remove a single entry by id. */
export function deleteEvalHistory(id: string): void {
  write(read().filter((e) => e.id !== id));
}

/** Wipe all history. */
export function clearEvalHistory(): void {
  write([]);
}

/** Lookup by id, used by DebriefScreen review mode. */
export function getEvalHistory(id: string): EvalHistoryEntry | null {
  return read().find((e) => e.id === id) ?? null;
}
