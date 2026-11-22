// Stethoscope playback for exam findings.
//
// Recorded clips (freely licensed, see public/assets/CREDITS.md) are used
// where we have one; every other sound is synthesised with the Web Audio API
// from a short procedurally generated buffer (lub-dub with or without murmur
// noise, vesicular vs bronchial breath noise, wheeze tone, crackle clicks).
// While a clip plays it owns the room's audio (staff lines wait) and the
// doctor's mic is held, without touching the doctor's own mute.

import { useSyncExternalStore } from 'react';
import type { ExamSound } from '../game/types';
import { store } from '../game/store';
import { ensureAudioContext } from './conversationStore';
import { acquireAudio } from './speech';

/** Recorded clips under public/assets/sounds/. Anything missing is synthesised. */
const CLIP_FILES: Partial<Record<ExamSound, string>> = {
  'normal-heart': '/assets/sounds/normal-heart.mp3',
  'murmur-systolic': '/assets/sounds/murmur-systolic.mp3',
  wheeze: '/assets/sounds/wheeze.mp3',
  crackles: '/assets/sounds/crackles.mp3',
};

export const SOUND_LABELS: Record<ExamSound, string> = {
  'normal-heart': 'Normal heart sounds',
  'murmur-systolic': 'Systolic murmur',
  'murmur-diastolic': 'Diastolic murmur',
  s3: 'S3 gallop',
  'pericardial-rub': 'Pericardial rub',
  'normal-breath': 'Vesicular breath sounds',
  wheeze: 'Wheeze',
  crackles: 'Crackles',
  bronchial: 'Bronchial breathing',
  absent: 'Absent breath sounds',
};

/** True when the sound is a real recording (vs synthesised). */
export const isRecordedSound = (s: ExamSound) => s in CLIP_FILES;

// ── playing-state signal ─────────────────────────────────────────

let playing: ExamSound | null = null;
let stopCurrent: (() => void) | null = null;
const listeners = new Set<() => void>();

function setPlaying(s: ExamSound | null) {
  playing = s;
  for (const l of listeners) l();
}

export function useAuscultationPlaying(): ExamSound | null {
  return useSyncExternalStore(
    (fn) => {
      listeners.add(fn);
      return () => listeners.delete(fn);
    },
    () => playing,
  );
}

export function stopAuscultation() {
  stopCurrent?.();
}

// Leaving the patient or the room stops the clip.
let seated = store.getState().polyclinic.patient?.case.id ?? null;
let onScreen = store.getState().screen;
store.subscribe(() => {
  const s = store.getState();
  const id = s.polyclinic.patient?.case.id ?? null;
  if (id === seated && s.screen === onScreen) return;
  seated = id;
  onScreen = s.screen;
  stopAuscultation();
});

/** Play (or, if it is already playing, stop) one auscultation sound. Must be
 *  called from a click so the browser allows audio. Never throws. */
export async function toggleAuscultation(sound: ExamSound): Promise<void> {
  const same = playing === sound;
  stopAuscultation();
  if (same) return;

  const release = acquireAudio('stethoscope', { onPreempt: () => stopAuscultation() });
  setPlaying(sound);

  let finished = false;
  const finish = () => {
    if (finished) return;
    finished = true;
    if (stopCurrent === stopEarly || stopCurrent === stopActive) stopCurrent = null;
    release();
    if (playing === sound) setPlaying(null);
  };
  // Stopping while the file is still loading must end it too.
  let stopActive: (() => void) | null = null;
  const stopEarly = () => finish();
  stopCurrent = stopEarly;
  const setStop = (fn: () => void) => {
    stopActive = fn;
    stopCurrent = fn;
  };

  const url = CLIP_FILES[sound];
  if (url && (await playFile(url, finish, setStop, () => finished))) return;
  if (finished) return;
  try {
    playSynth(sound, finish, setStop);
  } catch (err) {
    console.warn('[medsim:stethoscope] synth failed:', err);
    finish();
  }
}

function playFile(
  url: string,
  finish: () => void,
  setStop: (fn: () => void) => void,
  isOver: () => boolean,
): Promise<boolean> {
  return new Promise((resolve) => {
    const audio = new Audio(url);
    audio.volume = 0.9;
    let started = false;
    const cap = window.setTimeout(() => stop(), 12000);
    const stop = () => {
      window.clearTimeout(cap);
      audio.pause();
      finish();
    };
    setStop(stop);
    audio.addEventListener('ended', stop, { once: true });
    audio.addEventListener('error', () => {
      window.clearTimeout(cap);
      if (!started) resolve(false); // fall back to the synth
      else finish();
    }, { once: true });
    audio.play().then(
      () => {
        started = true;
        if (isOver()) audio.pause(); // stopped before the first sample
        resolve(true);
      },
      () => { window.clearTimeout(cap); resolve(false); },
    );
  });
}

// ── synthesis ────────────────────────────────────────────────────

const DURATION_S = 6;

function playSynth(sound: ExamSound, finish: () => void, setStop: (fn: () => void) => void) {
  const ctx = ensureAudioContext();
  const buffer = ctx.createBuffer(1, Math.floor(ctx.sampleRate * DURATION_S), ctx.sampleRate);
  renderSound(sound, buffer.getChannelData(0), ctx.sampleRate);
  const src = ctx.createBufferSource();
  src.buffer = buffer;
  const gain = ctx.createGain();
  gain.gain.value = 0.9;
  src.connect(gain).connect(ctx.destination);
  const stop = () => {
    try { src.stop(); } catch { /* already stopped */ }
    src.disconnect();
    finish();
  };
  setStop(stop);
  src.onended = stop;
  src.start();
}

/** Seeded PRNG so every playback of a sound is identical. */
function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** RBJ biquad band-pass over a buffer (in place). */
function bandpass(x: Float32Array, sr: number, f0: number, q: number) {
  const w = (2 * Math.PI * f0) / sr;
  const alpha = Math.sin(w) / (2 * q);
  const a0 = 1 + alpha;
  const b0 = alpha / a0, b2 = -alpha / a0, a1 = (-2 * Math.cos(w)) / a0, a2 = (1 - alpha) / a0;
  let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
  for (let i = 0; i < x.length; i++) {
    const y = b0 * x[i] + b2 * x2 - a1 * y1 - a2 * y2;
    x2 = x1; x1 = x[i]; y2 = y1; y1 = y;
    x[i] = y;
  }
}

function noise(n: number, seed: number): Float32Array {
  const r = rng(seed);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = r() * 2 - 1;
  return out;
}

function normalise(x: Float32Array, peak = 0.8) {
  let m = 0;
  for (let i = 0; i < x.length; i++) m = Math.max(m, Math.abs(x[i]));
  if (m > 0) for (let i = 0; i < x.length; i++) x[i] *= peak / m;
}

/** A heart sound "thud": a decaying low sine with a little pitch drop. */
function thud(out: Float32Array, sr: number, at: number, freq: number, amp: number, len = 0.09) {
  const start = Math.floor(at * sr);
  const n = Math.floor(len * sr);
  for (let i = 0; i < n && start + i < out.length; i++) {
    const t = i / sr;
    const env = Math.sin(Math.min(1, t / 0.008) * Math.PI / 2) * Math.exp(-t / (len / 3.5));
    out[start + i] += amp * env * Math.sin(2 * Math.PI * freq * (1 - 0.25 * t / len) * t);
  }
}

/** Add band-passed noise between two times with an envelope function. */
function addNoise(
  out: Float32Array, src: Float32Array, sr: number, from: number, to: number, amp: number,
  env: (u: number) => number,
) {
  const a = Math.max(0, Math.floor(from * sr));
  const b = Math.min(out.length, Math.floor(to * sr));
  for (let i = a; i < b; i++) out[i] += amp * env((i - a) / Math.max(1, b - a)) * src[i];
}

function renderHeart(sound: ExamSound, out: Float32Array, sr: number) {
  const period = 60 / 72;
  const sys = 0.3; // S1 -> S2
  const murmurSrc = noise(out.length, 7);
  bandpass(murmurSrc, sr, sound === 'murmur-diastolic' ? 420 : 260, 1.4);
  const rubSrc = noise(out.length, 11);
  bandpass(rubSrc, sr, 700, 0.9);
  const r = rng(3);
  for (let t0 = 0.15; t0 < DURATION_S - 0.1; t0 += period) {
    const quiet = sound === 'pericardial-rub' ? 0.6 : 1;
    thud(out, sr, t0, 48, 1.0 * quiet, 0.1);
    thud(out, sr, t0 + sys, 66, 0.75 * quiet, 0.075);
    if (sound === 'murmur-systolic') {
      // Pansystolic plateau between S1 and S2.
      addNoise(out, murmurSrc, sr, t0 + 0.05, t0 + sys - 0.01, 0.55, (u) => Math.min(1, u * 8, (1 - u) * 8));
    } else if (sound === 'murmur-diastolic') {
      // Early diastolic, high-pitched, decrescendo.
      addNoise(out, murmurSrc, sr, t0 + sys + 0.03, t0 + sys + 0.38, 0.5, (u) => Math.min(1, u * 12) * (1 - u));
    } else if (sound === 's3') {
      thud(out, sr, t0 + sys + 0.15, 32, 0.45, 0.07);
    } else if (sound === 'pericardial-rub') {
      // Scratchy, leathery bursts in systole and diastole.
      const am = (u: number) => (0.6 + 0.4 * Math.sin(u * 40 + r() * 2)) * Math.sin(u * Math.PI);
      addNoise(out, rubSrc, sr, t0 + 0.06, t0 + 0.24, 0.6, am);
      addNoise(out, rubSrc, sr, t0 + sys + 0.12, t0 + sys + 0.3, 0.45, am);
      addNoise(out, rubSrc, sr, t0 + period - 0.14, t0 + period - 0.03, 0.4, am);
    }
  }
}

function renderBreath(sound: ExamSound, out: Float32Array, sr: number) {
  const cycle = 3.0;
  const insp = 1.2;
  const src = noise(out.length, 5);
  const bronchial = sound === 'bronchial';
  bandpass(src, sr, bronchial ? 900 : 320, bronchial ? 1.1 : 0.8);
  const r = rng(9);
  const absent = sound === 'absent';
  for (let t0 = 0.2; t0 < DURATION_S; t0 += cycle) {
    if (absent) {
      // Near silence: only a faint, distant heartbeat through the chest wall.
      continue;
    }
    // Inspiration: rises and falls smoothly.
    addNoise(out, src, sr, t0, t0 + insp, bronchial ? 0.7 : 0.8, (u) => Math.sin(Math.PI * Math.min(1, u * 1.1)) ** 1.5);
    if (bronchial) {
      // Gap, then a loud expiration as long as inspiration.
      addNoise(out, src, sr, t0 + insp + 0.2, t0 + insp + 0.2 + insp * 1.1, 0.75, (u) => Math.sin(Math.PI * u) ** 1.2);
    } else {
      // Vesicular: expiration soft and only its first third audible.
      addNoise(out, src, sr, t0 + insp, t0 + insp + 0.6, 0.25, (u) => 1 - u);
    }
    if (sound === 'wheeze') {
      // Musical expiratory wheeze with slight vibrato.
      const a = Math.floor((t0 + insp) * sr);
      const n = Math.floor(1.4 * sr);
      for (let i = 0; i < n && a + i < out.length; i++) {
        const u = i / n;
        const t = i / sr;
        const env = Math.sin(Math.PI * u) ** 0.8;
        out[a + i] += 0.35 * env * (Math.sin(2 * Math.PI * (430 + 12 * Math.sin(2 * Math.PI * 5 * t)) * t) + 0.3 * Math.sin(2 * Math.PI * 860 * t));
      }
    }
    if (sound === 'crackles') {
      // Coarse crackles: short pops clustered in late inspiration.
      for (let k = 0; k < 14; k++) {
        const at = t0 + insp * (0.45 + 0.55 * r());
        const s = Math.floor(at * sr);
        const len = Math.floor((0.004 + 0.006 * r()) * sr);
        const amp = 0.5 + 0.5 * r();
        for (let i = 0; i < len && s + i < out.length; i++) {
          const e = Math.exp(-i / (len / 3));
          out[s + i] += amp * e * Math.sin(2 * Math.PI * (300 + 500 * r()) * (i / sr)) * (i % 2 ? 1 : -0.6);
        }
      }
    }
  }
  if (absent) {
    const hiss = noise(out.length, 13);
    bandpass(hiss, sr, 200, 0.7);
    for (let i = 0; i < out.length; i++) out[i] += 0.04 * hiss[i];
    for (let t0 = 0.3; t0 < DURATION_S - 0.1; t0 += 60 / 80) {
      thud(out, sr, t0, 45, 0.18, 0.08);
      thud(out, sr, t0 + 0.3, 60, 0.12, 0.06);
    }
  }
}

function renderSound(sound: ExamSound, out: Float32Array, sr: number) {
  if (sound === 'normal-heart' || sound === 'murmur-systolic' || sound === 'murmur-diastolic' || sound === 's3' || sound === 'pericardial-rub') {
    renderHeart(sound, out, sr);
  } else {
    renderBreath(sound, out, sr);
  }
  // Short fades so playback never clicks.
  const f = Math.floor(0.05 * sr);
  for (let i = 0; i < f; i++) {
    out[i] *= i / f;
    out[out.length - 1 - i] *= i / f;
  }
  normalise(out, sound === 'absent' ? 0.25 : 0.8);
}
