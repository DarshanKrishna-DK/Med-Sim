// What this browser remembers about the signature of its results, so a reload
// keeps the same room and History can show who signed. Small, capped, best effort.

import { useSyncExternalStore } from 'react';
import type { EvalHistoryEntry } from '../data/evalHistory';
import { asAcademic, isSigned, type AcademicSide } from './academicCore';

const KEY = 'medsim:signoff';
const MAX = 60;

export interface SavedSignOff {
  key: string;
  refId: string; // random: the room's id on the server
  side: AcademicSide | null;
}

let cache: SavedSignOff[] | null = null;
const listeners = new Set<() => void>();

function read(): SavedSignOff[] {
  if (cache) return cache;
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    cache = Array.isArray(raw)
      ? (raw as SavedSignOff[]).filter((e) => e && typeof e.key === 'string' && typeof e.refId === 'string').map((e) => ({ ...e, side: asAcademic(e.side) }))
      : [];
  } catch {
    cache = [];
  }
  return cache;
}

export function loadSignOff(key: string): SavedSignOff | null {
  return read().find((e) => e.key === key) ?? null;
}

export function saveSignOff(entry: SavedSignOff): void {
  cache = [entry, ...read().filter((e) => e.key !== entry.key)].slice(0, MAX);
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {
    /* private mode or quota: the open page still shows it */
  }
  for (const l of listeners) l();
}

export function newRefId(): string {
  const b = new Uint8Array(12);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export const resultKeyOf = (e: Pick<EvalHistoryEntry, 'id' | 'caseId' | 'osce' | 'viva' | 'patientSnapshot'>): string =>
  e.osce ? `osce:${e.id}` : e.viva ? `viva:${e.id}` : `debrief:${e.caseId}:${e.patientSnapshot?.arrivedAt ?? 0}`;

/** The saved signature of one result, live. */
export function useSignOff(key: string): AcademicSide | null {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => loadSignOff(key)?.side ?? null,
  );
}

export const signedByOf = (side: AcademicSide | null): string => (side && isSigned(side) ? side.signedBy || 'faculty' : '');
