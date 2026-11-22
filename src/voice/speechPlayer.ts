// Browser audio for staff lines: fetch TTS with a timeout, play it, and be able
// to really stop it. Shared by speech.ts and the theatre call-outs (ot/speech.ts).

import type { Playback } from './speechArbiter';

export class TtsError extends Error {
  status: number;
  constructor(status: number) {
    super(`/voice/tts ${status}`);
    this.status = status;
  }
}

/** POST /voice/tts. Aborts after `timeoutMs` or when `signal` fires. */
export async function fetchTts(
  body: Record<string, unknown>,
  opts: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<Blob> {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  if (opts.signal?.aborted) ctl.abort();
  opts.signal?.addEventListener('abort', stop, { once: true });
  const timer = window.setTimeout(stop, opts.timeoutMs ?? 12_000);
  try {
    const r = await fetch('/voice/tts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl.signal,
    });
    if (!r.ok) throw new TtsError(r.status);
    return await r.blob(); // the timeout also covers a body that never finishes
  } finally {
    window.clearTimeout(timer);
    opts.signal?.removeEventListener('abort', stop);
  }
}

/** Play an element. `done` settles once, whatever ends it; `stop` silences it. */
export function playAudio(audio: HTMLAudioElement): Playback {
  let settle: (how: 'ended' | 'error') => void = () => undefined;
  const done = new Promise<'ended' | 'error'>((res) => {
    settle = res;
  });
  const silence = () => {
    try {
      audio.pause();
    } catch {
      /* already gone */
    }
  };
  let stopped = false;
  let held = false; // paused on purpose: an interrupted play() is not an error
  const start = () => {
    audio.play().catch(() => {
      if (!held) settle('error');
    });
  };
  audio.addEventListener('ended', () => settle('ended'), { once: true });
  audio.addEventListener('error', () => settle('error'), { once: true });
  start();
  return {
    done,
    stop: () => {
      stopped = true;
      silence();
      settle('ended');
    },
    pause: () => {
      held = true;
      silence();
    },
    resume: () => {
      if (stopped) return;
      held = false;
      start();
    },
    setVolume: (v) => {
      audio.volume = Math.max(0, Math.min(1, v));
    },
  };
}

/** Play to the end, or stop the audio after `capMs`. */
export async function playCapped(audio: HTMLAudioElement, capMs: number): Promise<void> {
  const pb = playAudio(audio);
  const timer = window.setTimeout(() => pb.stop(), capMs);
  try {
    await pb.done;
  } finally {
    window.clearTimeout(timer);
  }
}
