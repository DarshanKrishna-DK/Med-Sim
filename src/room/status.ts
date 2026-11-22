// Is the hospital's BAND room configured? Kept apart from client.ts so the
// landing page does not load the voice layer for one chip.

import type { RoomRole } from './types';

export interface RoomStatus {
  enabled: boolean;
  reason?: string;
  departments: Partial<Record<RoomRole, boolean>>;
}

export async function fetchRoomStatus(signal?: AbortSignal): Promise<RoomStatus | null> {
  try {
    const r = await fetch('/agent/room/status', { signal });
    if (!r.ok) return null;
    const d = (await r.json()) as Partial<RoomStatus>;
    return { enabled: d.enabled === true, reason: d.reason, departments: d.departments ?? {} };
  } catch {
    return null;
  }
}
