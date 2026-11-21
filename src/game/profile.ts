// Local player profile: name, university and gender, kept in this browser only.
// Gender picks the player's doctor model (female or male). No backend, no account.
import { useSyncExternalStore } from 'react';

export type Gender = 'female' | 'male' | 'other';

export interface Profile {
  name: string;
  university: string;
  gender: Gender;
  /** Telegram destination for consultation results ('telegram', '@username', 'tg:<id>'); '' turns auto-send off. */
  resultsTo?: string;
}

/** Default Telegram destination: the latest chat that pressed Start on the bot. */
export const DEFAULT_RESULTS_TO = 'telegram';

const KEY = 'medsim.profile.v1';
const listeners = new Set<() => void>();
let current: Profile | null = read();
let dialog: { open: boolean; then?: () => void } = { open: false };

function read(): Profile | null {
  try {
    const raw = window.localStorage.getItem(KEY);
    if (!raw) return null;
    const p = JSON.parse(raw) as Partial<Profile>;
    if (!p.name || !p.gender) return null;
    return {
      name: String(p.name),
      university: String(p.university ?? ''),
      gender: p.gender as Gender,
      resultsTo: typeof p.resultsTo === 'string' ? p.resultsTo : DEFAULT_RESULTS_TO,
    };
  } catch {
    return null;
  }
}

function emit() {
  for (const l of listeners) l();
}

function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

export function getProfile(): Profile | null {
  return current;
}

export function saveProfile(p: Profile) {
  current = {
    name: p.name.trim(),
    university: p.university.trim(),
    gender: p.gender,
    resultsTo: (p.resultsTo ?? current?.resultsTo ?? DEFAULT_RESULTS_TO).trim().slice(0, 40),
  };
  try {
    window.localStorage.setItem(KEY, JSON.stringify(current));
  } catch {
    /* private mode: keep it for this session only */
  }
  emit();
}

export function useProfile(): Profile | null {
  return useSyncExternalStore(subscribe, getProfile, getProfile);
}

/** Open the profile dialog; `then` runs after the player presses Enter. */
export function openProfileDialog(then?: () => void) {
  dialog = { open: true, then };
  emit();
}

export function closeProfileDialog(done: boolean) {
  const then = dialog.then;
  dialog = { open: false };
  emit();
  if (done) then?.();
}

const getDialog = () => dialog;
export function useProfileDialog() {
  return useSyncExternalStore(subscribe, getDialog, getDialog);
}

/** "Dr. Ananya Rao" from "Ananya Rao" (keeps an existing "Dr" prefix). */
export function doctorName(p: Profile | null): string {
  if (!p) return 'Doctor';
  return /^dr\.?\s/i.test(p.name) ? p.name : `Dr. ${p.name}`;
}

export function initials(p: Profile | null): string {
  if (!p) return 'MD';
  const parts = p.name.replace(/^dr\.?\s+/i, '').split(/\s+/).filter(Boolean);
  return ((parts[0]?.[0] ?? '') + (parts.length > 1 ? parts[parts.length - 1][0] : '')).toUpperCase() || 'MD';
}
