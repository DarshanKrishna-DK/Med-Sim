// What the doctor said or typed, sent to whoever it was for. The live wiring of
// router.ts: conversation.ts calls it for voice finals and chat messages, the
// nurse's command box for typed orders.

import { POLYCLINIC_BED_INDEX, store } from '../game/store';
import { getContacts } from '../observer/contacts';
import { encounterIdOf } from '../room/chart';
import { getExistingConversation } from './conversationStore';
import { ACK_ORDER, ACK_QUESTION, DEPARTMENT_FAILED, Rotator } from './lines';
import { cancelSpeech, say } from './speech';
import {
  routeUtterance,
  syncRouteContext,
  UtteranceDispatcher,
  type HandleOptions,
  type Handled,
  type RoomActions,
  type RouteContext,
  type Source,
} from './router';

export type { Handled, HandleOptions, Route, RouteTarget } from './router';

const LOG = '[medsim:router]';

/** src/room/client.ts plus its context selector. */
interface RoomModule extends RoomActions {
  getRoomContext?(): {
    encounterId: string;
    enabled: boolean;
    pendingQuestion?: { role: string; ref: string };
    awaitingFaculty: boolean;
    heldRefs: string[];
  };
}

interface Agents {
  nurse: typeof import('../agents/nurseAgent');
  exam: typeof import('../agents/examAgent');
  coach: typeof import('../agents/coach');
  observer: typeof import('../observer/observerCall');
  room: RoomModule | null;
}

// Loaded on first use: these modules import the conversation themselves.
let agents: Promise<Agents> | null = null;
let loaded: Agents | null = null;

function loadAgents(): Promise<Agents> {
  agents ??= Promise.all([
    import('../agents/nurseAgent'),
    import('../agents/examAgent'),
    import('../agents/coach'),
    import('../observer/observerCall'),
    import('../room/client').then(
      (m): RoomModule | null => m,
      (err): null => {
        console.warn(LOG, 'room client unavailable:', err);
        return null;
      },
    ),
  ]).then(([nurse, exam, coach, observer, room]) => (loaded = { nurse, exam, coach, observer, room }));
  agents.catch(() => {
    agents = null; // a chunk failed to load: try again next time
  });
  return agents;
}

const encounterId = (): string | null => {
  const p = store.getState().polyclinic.patient;
  return p ? encounterIdOf(p) : null;
};

function context(): RouteContext {
  const s = store.getState();
  const p = s.polyclinic.patient;
  const r = loaded?.room?.getRoomContext?.();
  const faculty = s.agentRoom?.participants.some((x) => x.human || x.role === 'faculty');
  return {
    encounterId: encounterId() ?? undefined,
    lang: s.lang,
    patientName: p?.case.name,
    gender: p?.case.gender,
    caseId: p?.case.id,
    pendingQuestion: r?.pendingQuestion,
    awaitingFaculty: r?.awaitingFaculty,
    observerNames: getContacts().map((c) => c.name.split(' ')[0]),
    channel: getExistingConversation(POLYCLINIC_BED_INDEX)?.getSessionInfo()?.channel,
    heldRef: r?.heldRefs[r.heldRefs.length - 1],
    facultyPresent: faculty,
  };
}

const rotate = new Rotator();

const dispatcher = new UtteranceDispatcher({
  route: (text, source, ctx) => routeUtterance(text, source, ctx),
  context,
  encounter: encounterId,
  runNurse: (text, source) => loaded!.nurse.runNurseAction(text, source),
  runExam: (text) => {
    if (loaded!.exam.maybeRunExamFromSpeech(text)) return true;
    // The router says "examination" but no body part was named.
    void loaded!.exam.runExam('general', 'voice', text);
    return true;
  },
  runObserver: (text) => loaded!.observer.maybeHandleObserverCommand(text),
  requestHint: () => loaded!.coach.requestHint(),
  room: () => loaded?.room ?? null,
  ack: (kind) => {
    const { lang } = store.getState();
    const list = (kind === 'question' ? ACK_QUESTION : ACK_ORDER)[lang];
    void say({ speaker: 'nurse', priority: 'ack', lang, dedupeMs: 1500, dropIfStale: 3500, text: rotate.pick(`${kind}:${lang}`, list) });
  },
  failed: () => {
    const { lang } = store.getState();
    void say({ speaker: 'nurse', priority: 'result', lang, text: DEPARTMENT_FAILED[lang], dropIfStale: 8000 });
  },
  silenceStaff: () => cancelSpeech('doctor asked for quiet'),
  setTimeout: (fn, ms) => window.setTimeout(fn, ms),
  clearTimeout: (h) => window.clearTimeout(h as number),
});

// A department asked something, or the faculty member did: tell the backend at
// once, so the patient's own LLM stays out of the doctor's reply.
let lastWaiting = '';
store.subscribe(() => {
  const r = loaded?.room?.getRoomContext?.();
  const waiting = r ? `${r.encounterId}|${r.pendingQuestion?.ref ?? ''}|${r.awaitingFaculty}` : '';
  if (waiting === lastWaiting) return;
  const before = lastWaiting;
  lastWaiting = waiting;
  // Nothing to say when a room merely opened with nobody waiting.
  if (r && (r.pendingQuestion || r.awaitingFaculty || before.startsWith(`${r.encounterId}|`))) void syncRouteContext(context());
});

/**
 * Route one thing the doctor said or typed and carry it out.
 *
 * Resolves as soon as it is ROUTED: `route.target` says who it was for (a chat
 * caller only passes it on to the patient when that is 'patient' or 'exam').
 * `done` settles when the action it started (nurse run, hint, department
 * question...) has finished; await it to keep a form busy. Never rejects.
 *
 * - Voice callers pass the transcript `turnId`: a later, longer final of the
 *   same turn runs only what is new in it.
 * - The nurse's command box passes `{ defaultTarget: 'nurse' }`, so a typed
 *   line that fits nobody in particular is still an order for Asha:
 *
 *     const { done } = await handleDoctorUtterance(text, 'typed', { defaultTarget: 'nurse' });
 *     await done;
 *
 * Nurse runs are queued one at a time across all callers.
 */
export async function handleDoctorUtterance(text: string, source: Source, opts: HandleOptions = {}): Promise<Handled> {
  try {
    await loadAgents();
  } catch (err) {
    console.warn(LOG, 'agents failed to load:', err);
    return { route: { target: 'patient', action: 'none', confidence: 0, via: 'offline', text }, text: '', done: Promise.resolve() };
  }
  return dispatcher.handle(text, source, opts);
}
