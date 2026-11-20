/**
 * Faculty marks received from a live observer, persisted in localStorage
 * (`medsim:faculty-marks`) and attached to the matching debrief/OSCE row in
 * evalHistory. Marks are tagged with the encounter they belong to
 * (`encounterAt` = ActivePatient.arrivedAt) so a replayed case never
 * inherits another attempt's marks.
 */

import type { FacultyMarks } from './messages';

const KEY = 'medsim:faculty-marks';
const MAX = 60;

const listeners = new Set<() => void>();
let cache: FacultyMarks[] | null = null;

function read(): FacultyMarks[] {
  if (cache) return cache;
  try {
    const raw = localStorage.getItem(KEY);
    const parsed: unknown = raw ? JSON.parse(raw) : [];
    cache = Array.isArray(parsed) ? (parsed as FacultyMarks[]) : [];
  } catch {
    cache = [];
  }
  return cache;
}

function write(list: FacultyMarks[]) {
  cache = list.slice(-MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* storage blocked: marks still live in memory for this tab */
  }
  listeners.forEach((l) => l());
}

export function subscribeFacultyMarks(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Store a received sheet (same id replaces: a corrected resend). */
export function saveFacultyMarks(m: FacultyMarks): void {
  write([...read().filter((x) => x.id !== m.id), m]);
}

export function allFacultyMarks(): ReadonlyArray<FacultyMarks> {
  return read();
}

/** Marks for one encounter of a case (newest last). */
export function facultyMarksFor(caseId: string, encounterAt: number | undefined): FacultyMarks[] {
  return read().filter((m) => m.caseId === caseId && (encounterAt === undefined || m.encounterAt === encounterAt));
}
