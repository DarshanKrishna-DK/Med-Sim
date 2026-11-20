import { Conversation, type ConversationListeners } from './conversation';
import { buildPersona, buildInitialLine, isPediatric, parentGenderFor } from './patientPersona';
import type { PatientCase } from '../game/types';
import type { ChatMessage } from './claude';
import { LANG_LOCALE, type Lang } from '../game/lang';

const HISTORY_PREFIX = 'medsim:conv:';
/** Pre-rename (medkit) prefix, still swept by clearAllConversationStorage. */
const LEGACY_HISTORY_PREFIX = 'conv_history_';

/** Transcript snapshots taken when a conversation is disposed, keyed by
 *  caseId. The debrief runs after the patient has walked out (and the
 *  conversation is gone), so it reads the transcript from here. */
const lastTranscripts = new Map<string, ChatMessage[]>();

/** Transcript for a case: live conversation if one exists, else the
 *  snapshot captured at dispose time. Empty array if neither. */
export function getLastTranscript(caseId: string): ChatMessage[] {
  for (const entry of store.values()) {
    if (entry.caseId === caseId) return [...entry.conv.getMessages()];
  }
  return [...(lastTranscripts.get(caseId) ?? [])];
}

function snapshotAndDispose(entry: CachedConversation) {
  const msgs = entry.conv.getMessages();
  if (msgs.length > 1) lastTranscripts.set(entry.caseId, [...msgs]);
  entry.conv.dispose();
}

let sharedCtx: AudioContext | null = null;

export function ensureAudioContext(): AudioContext {
  if (!sharedCtx) {
    sharedCtx = new (window.AudioContext || (window as any).webkitAudioContext)();
  }
  if (sharedCtx.state === 'suspended') {
    // Best-effort resume. Must be called from a user gesture for this to
    // succeed, callers in the Walk-view panel are wired that way.
    sharedCtx.resume().catch(() => undefined);
  }
  return sharedCtx;
}

/** Cached conversation, keyed by bedIndex. `caseId` is carried alongside so
 *  we can detect when a bed (or the polyclinic sentinel -10) receives a
 *  different patient, in that case the old conversation is disposed and a
 *  fresh one is built for the new persona. Without this, the polyclinic's
 *  single sentinel bedIndex caused new patients to inherit the previous
 *  patient's name, history, and voice. */
interface CachedConversation {
  conv: Conversation;
  caseId: string;
}

const store = new Map<number, CachedConversation>();

/** Peek at an existing conversation without creating one. */
export function getExistingConversation(bedIndex: number): Conversation | null {
  return store.get(bedIndex)?.conv ?? null;
}

export function getOrCreatePatientConversation(
  bedIndex: number,
  patientCase: PatientCase,
  listeners: ConversationListeners,
  lang: Lang = 'en'
): Conversation {
  const existing = store.get(bedIndex);
  if (existing && existing.caseId === patientCase.id) {
    existing.conv.setListeners(listeners);
    return existing.conv;
  }
  if (existing) {
    // A different patient now occupies this slot, tear down the old
    // conversation so the new persona isn't poisoned by prior history.
    snapshotAndDispose(existing);
    store.delete(bedIndex);
  }
  // The polyclinic uses sentinel bedIndex -10; everything else is ER.
  const setting: 'polyclinic' | 'er' = bedIndex === -10 ? 'polyclinic' : 'er';
  const ctx = ensureAudioContext();
  // Speaker gender mirrors the rule in voiceForPatient (now retired):
  // pediatric → parent's gender, adult → patient's gender.
  const speakerGender: 'M' | 'F' = isPediatric(patientCase)
    ? parentGenderFor(patientCase)
    : patientCase.gender;
  const conv = new Conversation(ctx, listeners, {
    systemPrompt: buildPersona(patientCase, setting, lang),
    locale: LANG_LOCALE[lang],
    initialMessage: buildInitialLine(patientCase),
    voiceGender: speakerGender,
    caseId: patientCase.id,
    // Persist per-patient history so refreshing the page or walking away
    // and back doesn't wipe the conversation, the patient remembers you.
    storageKey: `${HISTORY_PREFIX}${patientCase.id}`,
  });
  store.set(bedIndex, { conv, caseId: patientCase.id });
  return conv;
}

export function disposePatientConversation(bedIndex: number) {
  const entry = store.get(bedIndex);
  if (entry) {
    snapshotAndDispose(entry);
    store.delete(bedIndex);
  }
}

export function clearAllPatientConversations() {
  for (const entry of store.values()) snapshotAndDispose(entry);
  store.clear();
  if (sharedCtx) {
    try { sharedCtx.close(); } catch { /* noop */ }
    sharedCtx = null;
  }
}

/** Wipe ALL persisted patient chat history from localStorage so that on the
 *  next shift, every patient starts a fresh conversation (no "the doctor
 *  asked me this last shift" memory). Pairs with `clearAllPatientConversations`
 *  to fully reset the voice layer between shifts. */
export function clearAllConversationStorage() {
  if (typeof window === 'undefined') return;
  try {
    const keys: string[] = [];
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (k && (k.startsWith(HISTORY_PREFIX) || k.startsWith(LEGACY_HISTORY_PREFIX))) keys.push(k);
    }
    keys.forEach((k) => localStorage.removeItem(k));
  } catch {
    // localStorage may be blocked, non-fatal
  }
}
