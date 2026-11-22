// The teamwork score and room timeline of past encounters, so a saved debrief
// still shows them after a reload. Small, capped, best effort.

import type { TimelineItem } from './reducer';
import type { RoomScore } from './types';

export interface SavedTeamwork {
  score: RoomScore;
  timeline: TimelineItem[];
  url: string;
}

const KEY = 'medsim:teamwork';
const MAX = 40;

type Entry = SavedTeamwork & { id: string };

function read(): Entry[] {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(KEY) ?? '[]');
    return Array.isArray(raw) ? (raw as Entry[]).filter((e) => e && typeof e.id === 'string' && !!e.score) : [];
  } catch {
    return [];
  }
}

export function saveTeamwork(encounterId: string, t: SavedTeamwork): void {
  try {
    const rest = read().filter((e) => e.id !== encounterId);
    localStorage.setItem(KEY, JSON.stringify([{ id: encounterId, ...t }, ...rest].slice(0, MAX)));
  } catch {
    /* private mode or quota: the live debrief still shows it */
  }
}

export function loadTeamwork(encounterId: string): SavedTeamwork | null {
  return read().find((e) => e.id === encounterId) ?? null;
}
