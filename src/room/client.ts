// Browser wiring for the BAND agent room: one RoomSession per seated patient,
// chart changes into the store, spoken lines into the speech arbiter.
// The protocol, the reconnect and the exactly-once rules live in session.ts.

import { doctorName, getProfile } from '../game/profile';
import { store, isOsceLive, POLYCLINIC_BED_INDEX } from '../game/store';
import { normLang } from '../game/lang';
import type { ActivePatient } from '../game/types';
import { medicationById } from '../data/medications';
import { getExistingConversation } from '../voice/conversationStore';
import { say } from '../voice/speech';
import { encounterIdOf } from './chart';
import { closeSummary, roomContext, timeline, type RoomContext, type RoomState } from './reducer';
import { claimLine, RoomSession, type SessionDeps } from './session';
import { saveTeamwork } from './teamworkStore';
import type { RoomApply, RoomRole, RoomSpeak } from './types';

export type { RoomContext } from './reducer';
export type AskableRole = Extract<RoomRole, 'pharmacist' | 'lab' | 'radiology' | 'examiner'>;

const LOG = '[medsim:room]';

const demoRequested = (): boolean => {
  if (!import.meta.env.DEV) return false;
  try {
    return new URLSearchParams(window.location.search).get('roomdemo') === '1';
  } catch {
    return false;
  }
};

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  if (import.meta.env.DEV && demoRequested()) return { ok: true, ref: 'demo', url: 'https://app.band.ai/' };
  const r = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!r.ok) {
    let detail = '';
    try {
      detail = String(((await r.json()) as { detail?: unknown }).detail ?? '');
    } catch {
      /* not JSON */
    }
    throw new Error(detail || `${path} ${r.status}`);
  }
  return (await r.json().catch(() => ({}))) as Record<string, unknown>;
}

const EVENT_NAMES = ['status', 'room', 'delegation', 'apply', 'speak', 'faculty', 'question', 'score'];

const connect: SessionDeps['connect'] = (url, on) => {
  const es = new EventSource(url);
  const onMsg = (e: Event) => on.event(String((e as MessageEvent).data ?? ''));
  es.onopen = on.open;
  es.onmessage = onMsg;
  // Named or unnamed frames both work; the seq guard drops anything seen twice.
  for (const n of EVENT_NAMES) es.addEventListener(n, onMsg);
  es.onerror = on.error;
  return { close: () => es.close() };
};

// ── effects ──────────────────────────────────────────────────────────────

function tellPatient(encounterId: string, note: string) {
  const p = store.getState().polyclinic.patient;
  const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
  if (!p || !conv || encounterIdOf(p) !== encounterId || conv.getCaseId() !== p.case.id) return;
  void conv.appendContextNote(note);
}

function onApply(a: RoomApply, s: RoomState) {
  if (!store.applyRoom(s.encounterId, a)) return;
  const rx = a.addPrescription;
  if (rx) {
    const name = medicationById(rx.medicationId)?.name ?? rx.medicationId;
    tellPatient(s.encounterId, `The doctor has prescribed you: ${name} (${rx.dose}, ${rx.duration}).`);
  }
  if (a.removePrescription) {
    const name = medicationById(a.removePrescription.medicationId)?.name ?? a.removePrescription.medicationId;
    tellPatient(s.encounterId, `The doctor is no longer giving you ${name}; the pharmacy stopped it.`);
  }
}

function onSpeak(sp: RoomSpeak, s: RoomState) {
  const p = store.getState().polyclinic.patient;
  // The examiner may speak after the patient has left; nobody else does.
  const seated = !!p && encounterIdOf(p) === s.encounterId;
  if (!seated && sp.speaker !== 'examiner') return;
  if (!claimLine(sp.text)) return;
  void say({
    speaker: sp.speaker,
    text: sp.text,
    lang: normLang(sp.lang),
    priority: sp.priority,
    key: `room:${sp.id}`,
    ...(sp.ref ? { ref: sp.ref } : {}),
  });
}

const deps: SessionDeps = {
  post,
  connect,
  setTimer: (fn, ms) => window.setTimeout(fn, ms),
  clearTimer: (h) => window.clearTimeout(h as number),
  onState: (s) => {
    if (session?.encounterId === s.encounterId) store.setAgentRoom(s);
  },
  onEvent: (e, s) => {
    if (e.type === 'delegation') store.applyRoomDelegation(s.encounterId, e.delegation, s.stages[e.delegation.ref]?.length === 1);
    if (e.type === 'score') saveTeamwork(s.encounterId, { score: e.score, timeline: timeline(s), url: s.url });
  },
  onApply,
  onSpeak,
};

// ── session lifecycle ────────────────────────────────────────────────────

let session: RoomSession | null = null;

/** Open (or keep) the room for this encounter. Safe to call on every render
 *  pass: the same encounter never opens twice. */
export function openRoom(encounter: ActivePatient): void {
  const encounterId = encounterIdOf(encounter);
  if (session?.encounterId === encounterId && !session.isStopped()) return;
  releaseRoom();
  const st = store.getState();
  const c = encounter.case;
  const allergies = c.anamnesis.filter((q) => /allerg/i.test(q.question)).map((q) => q.answer);
  session = new RoomSession(
    {
      encounterId,
      caseId: c.id,
      lang: st.lang,
      osce: isOsceLive(st),
      patient: {
        name: c.name,
        age: c.age,
        gender: c.gender,
        chiefComplaint: c.chiefComplaint,
        ...(allergies.length ? { allergies: allergies.join('; ') } : {}),
        anamnesis: c.anamnesis.map((q) => ({ question: q.question, answer: q.answer })),
      },
      doctorName: doctorName(getProfile()) || undefined,
    },
    deps,
  );
  store.setAgentRoom(session.getState());
  if (import.meta.env.DEV && demoRequested()) {
    const mine = session;
    void import('./demo').then((m) => mine === session && m.playDemo(mine));
    return;
  }
  void session.start();
}

/** Stop streaming (the patient left without a debrief, or a new one sat down). */
export function releaseRoom(): void {
  if (!session) return;
  session.stop();
  session = null;
}

const current = (): RoomSession | null => {
  const p = store.getState().polyclinic.patient;
  return session && p && session.encounterId === encounterIdOf(p) ? session : null;
};

/** The room is on for the seated patient. */
export function roomActive(): boolean {
  return current()?.getState().enabled === true;
}

export function getRoomContext(): RoomContext {
  return roomContext(current()?.getState() ?? null);
}

async function attempt<T>(what: string, fn: (s: RoomSession) => Promise<T>): Promise<T | null> {
  const s = current();
  if (!s || !s.getState().enabled) return null;
  try {
    return await fn(s);
  } catch (err) {
    console.warn(LOG, `${what} failed:`, err instanceof Error ? err.message : err);
    throw err instanceof Error ? err : new Error(String(err));
  }
}

/** Ask one department directly. The answer comes back as a spoken line. */
export async function askDepartment(role: AskableRole, text: string): Promise<{ ref: string } | null> {
  const r = await attempt('ask', (s) => s.ask(role, text.trim(), store.getState().lang));
  return r ? { ref: String(r.ref ?? '') } : null;
}

/** Answer a department's safety question. Defaults to the open one. */
export async function answerQuestion(ref: string, text: string): Promise<void> {
  await attempt('answer', (s) => s.answer(ref, text.trim(), store.getState().lang));
}

/** Bring the human faculty member into the room. Returns the BAND room link. */
export async function inviteFaculty(reason?: string): Promise<{ url: string } | null> {
  const r = await attempt('faculty invite', (s) => s.inviteFaculty(reason?.trim() || undefined));
  return r ? { url: String(r.url ?? '') } : null;
}

export async function sayToFaculty(text: string): Promise<void> {
  await attempt('faculty say', (s) => s.sayToFaculty(text.trim()));
}

export async function requestOverride(ref: string, reason?: string): Promise<void> {
  await attempt('override', (s) => s.override(ref, reason?.trim() || undefined));
}

export async function cancelDelegation(ref: string): Promise<void> {
  await attempt('cancel', (s) => s.cancel(ref));
}

export async function retryDelegation(ref: string): Promise<void> {
  await attempt('retry', (s) => s.retryDelegation(ref));
}

/** End of the consultation: the examiner scores the teamwork; `score` events
 *  keep arriving on the stream while the debrief is open. */
export async function closeRoom(summary: Record<string, unknown> = {}): Promise<void> {
  const s = session;
  const st = s?.getState();
  // No BAND room was ever needed, so there is no teamwork to score.
  if (!s || !st?.enabled || (!st.roomId && st.delegations.length === 0)) return;
  try {
    await s.close(closeSummary(st, summary));
  } catch (err) {
    console.warn(LOG, 'close failed:', err instanceof Error ? err.message : err);
  }
}

// Leaving the consultation (corridor, library, home) ends the stream. The
// debrief and the OSCE result keep it: scores and sign-offs still arrive.
const KEEP = new Set(['encounter', 'endConfirm', 'debrief', 'osceResult']);
let lastScreen = store.getState().screen;
store.subscribe(() => {
  const { screen } = store.getState();
  if (screen === lastScreen) return;
  lastScreen = screen;
  if (!KEEP.has(screen)) releaseRoom();
});

export { fetchRoomStatus, type RoomStatus } from './status';
