// Browser client for cases created on Telegram (@medsim_asha_bot /newpatient).
// Loads GET /agent/custom-cases at startup and every 20 s, registers new ones
// in the case library (data/cases.ts) and handles the bot's ?case=<id> link.

import { useSyncExternalStore } from 'react';
import { CLINIC_IDS, type ClinicId } from '../game/clinic';
import { store } from '../game/store';
import { CASES, getPatientCase, registerRuntimeCase } from './cases';
import { CUSTOM_BADGE, caseIdFromSearch, mergeCustomCases } from './customCasesCore';

const POLL_MS = 20_000;
const LOG = '[medsim:custom-cases]';
const VALID = new Set<string>(CLINIC_IDS);

let version = 0;
const listeners = new Set<() => void>();
let timer: ReturnType<typeof setInterval> | null = null;
/** ?case=<id> from the page URL, until it is opened (or found not to exist). */
let pendingOpen: string | null = typeof window !== 'undefined' ? caseIdFromSearch(window.location.search) : null;
let polls = 0;

function emit() {
  version += 1;
  for (const l of listeners) l();
}

/** Re-render hook: bumps whenever new custom cases join the library. */
export function useCustomCasesVersion(): number {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => version,
  );
}

function openPending() {
  if (!pendingOpen) return;
  if (getPatientCase(pendingOpen)) {
    store.selectCase(pendingOpen); // library + brief drawer; "Start consultation" is the user gesture voice needs
    pendingOpen = null;
  } else if (polls >= 3) {
    console.warn(LOG, 'case from the link not found:', pendingOpen);
    pendingOpen = null;
  } else {
    return;
  }
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete('case');
    window.history.replaceState(null, '', url.pathname + url.search + url.hash);
  } catch {
    /* no history API */
  }
}

export async function refreshCustomCases(): Promise<number> {
  polls += 1;
  let added = 0;
  try {
    const r = await fetch('/agent/custom-cases');
    if (r.ok) {
      const body = (await r.json()) as { cases?: unknown };
      const fresh = mergeCustomCases(body.cases, new Set(CASES.map((c) => c.id)), VALID);
      // Server order is newest first; register oldest first so the newest ends up at the front.
      for (const c of [...fresh].reverse()) {
        if (registerRuntimeCase(c.patient, c.clinic as ClinicId, c.diagnosisLabels, { label: CUSTOM_BADGE, title: c.createdBy })) added += 1;
      }
      if (added) emit();
    }
  } catch {
    /* backend offline: static cases still work */
  }
  openPending();
  return added;
}

/** Start loading + polling. Returns a stop function (React effect cleanup). */
export function startCustomCaseSync(): () => void {
  // A static case id in the link opens straight away.
  openPending();
  void refreshCustomCases();
  if (timer === null) timer = setInterval(() => void refreshCustomCases(), POLL_MS);
  return () => {
    if (timer !== null) clearInterval(timer);
    timer = null;
  };
}
