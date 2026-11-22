// Browser wiring of the speech arbiter: every voice in the room that is not
// the patient's goes through `say`. See speechArbiter.ts for the rules.

import { useSyncExternalStore } from 'react';
import { store, POLYCLINIC_BED_INDEX } from '../game/store';
import { LANG_LOCALE, type Lang } from '../game/lang';
import { getExistingConversation } from './conversationStore';
import { isPediatric, parentGenderFor } from './patientPersona';
import { bindSpeech, endStaffLines, holdMic, noteStaffLine } from './speechBus';
import { fetchTts, playAudio, TtsError } from './speechPlayer';
import { voiceLang } from './speechText';
import {
  SpeechArbiter,
  type Clip,
  type Player,
  type SpeakingState,
  type SpeechOutcome,
  type SpeechPriority,
} from './speechArbiter';

const LOG = '[medsim:speech]';

export type { SpeakingState, SpeechOutcome, SpeechPriority } from './speechArbiter';

/** Whose voice. Faculty messages are relayed by the nurse. */
export type StaffSpeaker = 'nurse' | 'pharmacist' | 'lab' | 'radiology' | 'examiner' | 'faculty';

export interface SayOptions {
  speaker?: StaffSpeaker;
  text: string;
  /** Language of the line when known; otherwise decided by its script. */
  lang?: string;
  priority?: SpeechPriority;
  /** Spoken once per encounter (RoomSpeak.id, "hint:...", "explain:..."). */
  key?: string;
  /** How long `key` blocks a repeat (default: the whole encounter). */
  dedupeMs?: number;
  /** Order reference: the result with the same ref drops its pending ack. */
  ref?: string;
  /** Drop the line if it has not started within this many ms. True (the
   *  default) uses the priority's own limit, false never drops it for age. */
  dropIfStale?: boolean | number;
}

const VOICES = new Set(['nurse', 'pharmacist', 'lab', 'radiology', 'examiner']);
/** Set once the backend answered 422 for a department voice: use the nurse's. */
const unsupported = new Set<string>();

// Acks are a handful of fixed lines and must be instant: keep their audio.
const ackCache = new Map<string, Blob>();
const ACK_CACHE_MAX = 24;

/** Tells the backend which patient voice a department must not sound like. The
 *  nurse keeps one voice for the whole session, whoever is seated. */
function patientVoice(): { caseId?: string; gender?: 'M' | 'F' } {
  const c = store.getState().polyclinic.patient?.case;
  if (!c) return {};
  return { caseId: c.id, gender: isPediatric(c) ? parentGenderFor(c) : c.gender };
}

async function tts(
  text: string,
  speaker: string,
  lang: string | undefined,
  keep: boolean,
  signal: AbortSignal,
): Promise<Blob> {
  const wanted = VOICES.has(speaker) ? speaker : 'nurse';
  const voice = unsupported.has(wanted) ? 'nurse' : wanted;
  const session = store.getState().lang;
  const locale = LANG_LOCALE[voiceLang(text, lang as Lang | undefined, session)] ?? LANG_LOCALE[session];
  const cacheKey = `${voice}|${locale}|${text}`;
  const hit = ackCache.get(cacheKey);
  if (hit) return hit;
  let blob: Blob;
  try {
    blob = await fetchTts({ text, voice, locale, ...(voice === 'nurse' ? {} : patientVoice()) }, { signal });
  } catch (err) {
    if (!(err instanceof TtsError) || err.status !== 422 || voice === 'nurse') throw err;
    unsupported.add(wanted);
    blob = await fetchTts({ text, voice: 'nurse', locale }, { signal });
  }
  if (keep) {
    ackCache.set(cacheKey, blob);
    if (ackCache.size > ACK_CACHE_MAX) ackCache.delete(ackCache.keys().next().value as string);
  }
  return blob;
}

const player: Player = {
  async load({ text, speaker, lang, priority }, signal): Promise<Clip> {
    const blob = await tts(text, speaker, lang, priority === 'ack', signal);
    const url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    audio.preload = 'auto';
    return {
      play: () => playAudio(audio),
      release: () => {
        audio.pause();
        URL.revokeObjectURL(url);
      },
    };
  },
};

const patient = () => getExistingConversation(POLYCLINIC_BED_INDEX);

/** One seated patient on one screen. Lines never outlive it. */
function encounterKey(): string {
  const s = store.getState();
  const p = s.polyclinic.patient;
  return `${s.screen}|${p ? `${p.case.id}-${p.arrivedAt}` : ''}`;
}

const speakingListeners = new Set<(s: SpeakingState | null) => void>();

const arbiter = new SpeechArbiter({
  clock: {
    now: () => Date.now(),
    setTimeout: (fn, ms) => window.setTimeout(fn, ms),
    clearTimeout: (h) => window.clearTimeout(h as number),
  },
  player,
  holdMic,
  patientSpeaking: () => patient()?.isPatientSpeaking() ?? false,
  doctorSpeaking: () => patient()?.isDoctorTalking() ?? false,
  interruptPatient: () => patient()?.interruptPatient(),
  duckPatient: (on) => patient()?.duckPatient(on),
  encounter: encounterKey,
  onSpeaking: (s) => {
    if (s) noteStaffLine(s.text);
    else endStaffLines();
    for (const l of [...speakingListeners]) l(s);
  },
  onOutcome: (line, outcome, reason) => {
    if (outcome !== 'spoken' && outcome !== 'duplicate') {
      console.debug(LOG, outcome, reason, line.key ?? line.text.slice(0, 40));
    }
  },
});

bindSpeech({
  cancel: (reason) => arbiter.cancelAll(reason),
  doctorSpoke: () => arbiter.doctorSpoke(),
  acquire: (owner) => arbiter.acquire(owner),
});

// Next patient, debrief, leaving the room or a language switch: nothing said
// for the old situation may be heard in the new one.
let lastEncounter = encounterKey();
let lastLang = store.getState().lang;
store.subscribe(() => {
  const enc = encounterKey();
  const lang = store.getState().lang;
  if (enc === lastEncounter && lang === lastLang) return;
  const reason = enc !== lastEncounter ? 'encounter changed' : 'language switched';
  lastEncounter = enc;
  lastLang = lang;
  arbiter.cancelAll(reason);
});

/** Say one line as a member of staff. Resolves when it was spoken, or with why
 *  it was not. Never rejects, never overlaps another voice. */
export function say(o: SayOptions): Promise<SpeechOutcome> {
  return arbiter.enqueue({
    speaker: o.speaker ?? 'nurse',
    text: o.text,
    lang: o.lang,
    priority: o.priority ?? 'chat',
    key: o.key,
    dedupeMs: o.dedupeMs,
    ref: o.ref,
    dropIfStale: o.dropIfStale === false ? Infinity : o.dropIfStale === true ? undefined : o.dropIfStale,
  });
}

/** Stop and forget every staff line (hang-up, End, next patient, debrief). */
export function cancelSpeech(reason = 'cancelled'): void {
  arbiter.cancelAll(reason);
}

/** Stop lines whose key starts with `prefix` (an explanation card was closed). */
export function cancelSpeechKey(prefix: string): void {
  arbiter.cancelKey((k) => k.startsWith(prefix));
}

/** Take the room's audio for a stethoscope clip or the voice prescription:
 *  staff stay quiet and the doctor's mic is held until the release is called.
 *  `onPreempt` is called when an urgent line needs the room: stop and release. */
export function acquireAudio(
  owner: string,
  opts: { onPreempt?: () => void; interruptPatient?: boolean } = {},
): () => void {
  if (opts.interruptPatient) patient()?.interruptPatient();
  const releaseRoom = arbiter.acquire(owner, { onPreempt: opts.onPreempt });
  const releaseMic = holdMic();
  let released = false;
  return () => {
    if (released) return;
    released = true;
    releaseMic();
    releaseRoom();
  };
}

/** Called with the line now playing, or null when the room goes quiet. */
export function subscribeSpeaking(cb: (s: SpeakingState | null) => void): () => void {
  speakingListeners.add(cb);
  return () => {
    speakingListeners.delete(cb);
  };
}

export const isSpeaking = (): boolean => arbiter.isSpeaking();
export const getStaffSpeaking = (): SpeakingState | null => arbiter.current();

/** React: who of the staff is talking right now, and what they are saying. */
export function useStaffSpeaking(): SpeakingState | null {
  return useSyncExternalStore(subscribeSpeaking, getStaffSpeaking);
}
