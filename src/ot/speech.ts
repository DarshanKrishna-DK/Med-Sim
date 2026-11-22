// Theatre call-outs through Murf (POST /voice/tts). Each team member gets a
// stable pooled voice via caseId + gender (backend/voice.py
// tts_voice_and_locale); the scrub nurse uses the nurse voice. Lines queue so
// call-outs never talk over each other; stale ones are dropped so the newest
// problem is always heard promptly. The theatre room speaks here too: Sister
// Leela for the room, the lab and the pharmacist in their own voices. While a
// line plays it owns the room's audio, so no staff line (voice/speech.ts) can
// overlap it; an urgent staff line stops it.

import { LANG_LOCALE, type Lang } from '../game/lang';
import { acquireAudio } from '../voice/speech';
import { endStaffLines, isStaffEcho, noteStaffLine } from '../voice/speechBus';
import { fetchTts, playAudio } from '../voice/speechPlayer';
import type { Speaker } from './scenarios';

/** Everyone who can be heard in theatre. */
export type TheatreVoice = Speaker | 'leela' | 'lab' | 'pharmacist';

const VOICE: Record<TheatreVoice, Record<string, string>> = {
  surgeon: { voice: 'M', gender: 'M', caseId: 'ot-surgeon-mehta' },
  assistant: { voice: 'F', gender: 'F', caseId: 'ot-assistant-iyer' },
  anaesthetist: { voice: 'M', gender: 'M', caseId: 'ot-anaes-banerjee' },
  nurse: { voice: 'nurse' },
  leela: { voice: 'theatre' },
  lab: { voice: 'lab' },
  pharmacist: { voice: 'pharmacist' },
};

const CAP_MS = 15_000;
const ROOM_CAP_MS = 25_000;
const STALE_MS = 9_000;
const ROOM_STALE_MS = 30_000;

interface Item {
  text: string;
  speaker: TheatreVoice;
  lang: Lang;
  at: number;
  /** From the theatre room: an answer somebody is waiting for, kept longer. */
  room: boolean;
}

const queue: Item[] = [];
let busy = false;
let current: { stop: () => void } | null = null;
let loading: AbortController | null = null;
let generation = 0;
let onSpeaking: ((s: TheatreVoice | null) => void) | null = null;

/** Who is talking right now (drives the speaking indicator). */
export function setOTSpeakingListener(fn: ((s: TheatreVoice | null) => void) | null) {
  onSpeaking = fn;
}

/** The theatre's own voice coming back through the microphone is not an order. */
export const isTheatreEcho = (heard: string): boolean => isStaffEcho(heard);

async function playOne(item: Item, gen: number): Promise<void> {
  let url: string | null = null;
  let mine: { stop: () => void } | null = null;
  let release: (() => void) | null = null;
  const ctl = new AbortController();
  loading = ctl;
  try {
    const blob = await fetchTts({ text: item.text, locale: LANG_LOCALE[item.lang], ...VOICE[item.speaker] }, { signal: ctl.signal, timeoutMs: 8000 });
    if (gen !== generation) return;
    url = URL.createObjectURL(blob);
    const audio = new Audio(url);
    let stopped = false;
    let halt: () => void = () => {
      stopped = true;
    };
    release = acquireAudio('theatre', { onPreempt: () => halt() });
    if (stopped) return;
    const pb = playAudio(audio);
    halt = () => pb.stop();
    mine = { stop: () => pb.stop() };
    current = mine;
    noteStaffLine(item.text);
    onSpeaking?.(item.speaker);
    const cap = window.setTimeout(() => pb.stop(), item.room ? ROOM_CAP_MS : CAP_MS); // the cap stops it, not just the wait
    try {
      await pb.done;
    } finally {
      window.clearTimeout(cap);
      endStaffLines();
    }
  } catch {
    /* TTS unavailable: the bubble still shows the line */
  } finally {
    release?.();
    if (loading === ctl) loading = null;
    // A cancelled line must not clear the one that replaced it.
    if (mine && current === mine) {
      current = null;
      onSpeaking?.(null);
    }
    if (url) URL.revokeObjectURL(url);
  }
}

const stale = (i: Item) => Date.now() - i.at > (i.room ? ROOM_STALE_MS : STALE_MS);

async function pump() {
  if (busy) return;
  busy = true;
  const gen = generation;
  while (queue.length && gen === generation) {
    // Drop lines that went stale while something else was playing.
    while (queue.length > 1 && stale(queue[0])) queue.shift();
    const item = queue.shift()!;
    await playOne(item, gen);
  }
  if (gen === generation) busy = false; // a newer pump owns the flag
}

function enqueue(text: string, speaker: TheatreVoice, lang: Lang, room: boolean) {
  const line = text.trim();
  if (!line) return;
  queue.push({ text: line.slice(0, 400), speaker, lang, at: Date.now(), room });
  // Call-outs repeat themselves; the room's answers do not, so those are dropped last.
  while (queue.length > 4) {
    const i = queue.findIndex((q) => !q.room);
    queue.splice(i < 0 ? 0 : i, 1);
  }
  void pump();
}

export function speakOT(text: string, speaker: Speaker, lang: Lang) {
  enqueue(text, speaker, lang, false);
}

/** A line from the theatre room, already in `lang`. */
export function speakTheatreRoom(text: string, speaker: string, lang: Lang) {
  enqueue(text, speaker === 'lab' || speaker === 'pharmacist' ? speaker : 'leela', lang, true);
}

/** Stop talking now and forget queued lines (leaving the room, muting). */
export function cancelOTSpeech() {
  generation += 1;
  queue.length = 0;
  busy = false;
  loading?.abort();
  loading = null;
  try {
    current?.stop();
  } catch {
    /* ignore */
  }
  current = null;
  onSpeaking?.(null);
}
