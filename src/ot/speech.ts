// Theatre call-outs through Murf (POST /voice/tts). Each team member gets a
// stable pooled voice via caseId + gender (backend/voice.py
// tts_voice_and_locale); the scrub nurse uses the nurse voice. Lines queue so
// call-outs never talk over each other; stale ones are dropped so the newest
// problem is always heard promptly.

import { LANG_LOCALE, type Lang } from '../game/lang';
import type { Speaker } from './scenarios';

const VOICE: Record<Speaker, Record<string, string>> = {
  surgeon: { voice: 'M', gender: 'M', caseId: 'ot-surgeon-mehta' },
  assistant: { voice: 'F', gender: 'F', caseId: 'ot-assistant-iyer' },
  anaesthetist: { voice: 'M', gender: 'M', caseId: 'ot-anaes-banerjee' },
  nurse: { voice: 'nurse' },
};

interface Item {
  text: string;
  speaker: Speaker;
  lang: Lang;
  at: number;
}

const queue: Item[] = [];
let busy = false;
let current: HTMLAudioElement | null = null;
let generation = 0;
let onSpeaking: ((s: Speaker | null) => void) | null = null;

/** Who is talking right now (drives the speaking indicator). */
export function setOTSpeakingListener(fn: ((s: Speaker | null) => void) | null) {
  onSpeaking = fn;
}

async function playOne(item: Item, gen: number): Promise<void> {
  let url: string | null = null;
  try {
    const r = await fetch('/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ text: item.text, locale: LANG_LOCALE[item.lang], ...VOICE[item.speaker] }),
    });
    if (!r.ok || gen !== generation) return;
    url = URL.createObjectURL(await r.blob());
    const audio = new Audio(url);
    current = audio;
    onSpeaking?.(item.speaker);
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      audio.addEventListener('ended', done, { once: true });
      audio.addEventListener('error', done, { once: true });
      audio.play().catch(done);
      window.setTimeout(done, 15000);
    });
  } catch {
    /* TTS unavailable: the bubble still shows the line */
  } finally {
    current = null;
    onSpeaking?.(null);
    if (url) URL.revokeObjectURL(url);
  }
}

async function pump() {
  if (busy) return;
  busy = true;
  const gen = generation;
  while (queue.length && gen === generation) {
    // Drop lines that went stale while something else was playing.
    while (queue.length > 1 && Date.now() - queue[0].at > 9000) queue.shift();
    const item = queue.shift()!;
    await playOne(item, gen);
  }
  busy = false;
}

export function speakOT(text: string, speaker: Speaker, lang: Lang) {
  const line = text.trim();
  if (!line) return;
  queue.push({ text: line.slice(0, 400), speaker, lang, at: Date.now() });
  if (queue.length > 4) queue.splice(0, queue.length - 4);
  void pump();
}

/** Stop talking now and forget queued lines (leaving the room, muting). */
export function cancelOTSpeech() {
  generation += 1;
  queue.length = 0;
  busy = false;
  try {
    current?.pause();
  } catch {
    /* ignore */
  }
  current = null;
  onSpeaking?.(null);
}
