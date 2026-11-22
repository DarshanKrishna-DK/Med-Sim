// Small shared signals between the speech layer (speech.ts) and the patient
// conversation (conversation.ts), kept apart so neither imports the other.
// Pure: no store, SDK or DOM imports.
//
//  - mic hold: a reference count of everything that needs the doctor's mic
//    closed for a moment (staff voice, stethoscope, voice prescription,
//    farewell). It is NOT the user's mute: a conversation sends audio only
//    when the user has not muted AND nothing holds the mic, so releasing a
//    hold can never unmute somebody who muted themselves.
//  - staff lines: what staff said recently, to recognise their voice when it
//    comes back as a "doctor" transcript.
//  - doctor speech and cancel notices, wired to the arbiter by speech.ts.

import { isEchoOf } from './speechText.ts';

// ── mic hold ────────────────────────────────────────────────────

let holds = 0;
const holdListeners = new Set<(held: boolean) => void>();

export const isMicHeld = (): boolean => holds > 0;

/** Close the doctor's mic until the returned function is called (idempotent). */
export function holdMic(): () => void {
  holds += 1;
  if (holds === 1) for (const l of [...holdListeners]) l(true);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    holds -= 1;
    if (holds === 0) for (const l of [...holdListeners]) l(false);
  };
}

export function onMicHold(fn: (held: boolean) => void): () => void {
  holdListeners.add(fn);
  return () => {
    holdListeners.delete(fn);
  };
}

// ── staff lines (echo guard) ────────────────────────────────────

const ECHO_MS = 8_000;
let staff: Array<{ text: string; until: number }> = [];

/** A staff line started playing. */
export function noteStaffLine(text: string, now = Date.now()): void {
  staff = [...staff.filter((s) => s.until > now), { text, until: now + 30_000 }].slice(-6);
}

/** The line ended: transcripts of it may still trickle in for a few seconds. */
export function endStaffLines(now = Date.now()): void {
  staff = staff.map((s) => ({ ...s, until: Math.min(s.until, now + ECHO_MS) }));
}

export function isStaffEcho(heard: string, now = Date.now()): boolean {
  return isEchoOf(heard, staff.filter((s) => s.until > now).map((s) => s.text));
}

// ── notices ─────────────────────────────────────────────────────

type CancelFn = (reason: string) => void;
let onCancel: CancelFn | null = null;
let onDoctor: (() => void) | null = null;
let acquireFn: ((owner: string) => () => void) | null = null;

/** speech.ts registers the live arbiter here. */
export function bindSpeech(h: { cancel: CancelFn; doctorSpoke: () => void; acquire: (owner: string) => () => void }): void {
  onCancel = h.cancel;
  onDoctor = h.doctorSpoke;
  acquireFn = h.acquire;
}

/** Stop and forget every staff line (hang-up, End, next patient, language). */
export const requestSpeechCancel: CancelFn = (reason) => onCancel?.(reason);
export const noteDoctorSpeech = (): void => onDoctor?.();
/** Keep staff quiet until released (no-op when speech is not loaded). */
export const acquireRoomAudio = (owner: string): (() => void) => acquireFn?.(owner) ?? (() => undefined);
