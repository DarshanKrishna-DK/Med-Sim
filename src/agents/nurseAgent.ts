// Agentic orders, the "nurse" agent.
//
// The doctor says (or types) something like "Let's get a CBC and start her
// on amoxicillin 500 three times a day for a week, and book a follow-up in
// two weeks". A cheap regex prefilter (`looksLikeOrder`) decides whether
// it's worth a round-trip; if so `runNurseAction` sends the utterance plus
// a compact chart + catalog to POST /agent/nurse/act. The backend agent
// plans, calls its tools, and returns what it did. We then:
//   1. validate + APPLY the results to the store (tests, prescriptions,
//      follow-up), the backend never mutates client state directly,
//   2. update the live run in the store's `agentRuns` feed (the UI shows a
//      'running' placeholder immediately, then steps/result),
//   3. speak the nurse's confirmation via POST /voice/tts (nurse voice),
//   4. tell the patient persona what happened via /voice/context so the
//      patient can react naturally ("a blood test? okay...").

import { store, POLYCLINIC_BED_INDEX } from '../game/store';
import { LANG_LOCALE, langOfText } from '../game/lang';
import type { ActivePatient, NurseRun, NurseStep } from '../game/types';
import { TESTS } from '../data/tests';
import { MEDICATIONS } from '../data/medications';
import { getExistingConversation } from '../voice/conversationStore';

export type { NurseRun, NurseStep } from '../game/types';

const LOG = '[medsim:nurse]';

// ── prefilter ───────────────────────────────────────────────────

const ORDER_VERB =
  /\b(order(?:ing)?|prescrib(?:e|ing)|start (?:him|her|them|you|the patient)?\s*on|put (?:him|her|them|you) on|give (?:him|her|them|you|the patient)?|send (?:off|for|a|an|the|him|her|them)|run (?:a|an|the|some)|get (?:a|an|me|us|some|the)|check (?:a|an|the|her|his|their|your)|book|schedule|follow[- ]?up|nurse|draw (?:some|a|the)?\s*bloods?|let'?s (?:do|get|run|send|start|check|book)|i'?d like (?:a|an|to order)|we(?:'ll| will) need (?:a|an|some))\b/i;

const CLINICAL_NOUN =
  /\b(cbc|fbc|bmp|cmp|lfts?|tsh|hba1c|a1c|ecg|ekg|x-?ray|cxr|ultrasound|scan|mri|ct|labs?|bloods?|urinalysis|urine|swab|culture|troponin|lipid|panel|mg|milligrams?|tablets?|twice a day|three times|once daily|bd|tds|od|prn)\b/i;

const POLITE_REQUEST = /\b(please|can we|could we|let'?s|i want|i need|we need|go ahead)\b/i;

/** Cheap client-side check: does this utterance look like a clinical
 *  instruction worth sending to the nurse agent? False positives just cost
 *  one backend call that returns intent 'none'. */
export function looksLikeOrder(text: string): boolean {
  const t = text.trim();
  if (t.length < 4) return false;
  // Questions to the patient ("do you take any medication?") aren't orders.
  if (/^(do|does|did|have|has|are|is|were|was|when|how|what|where|why|any)\b[^.!]*\?\s*$/i.test(t)) {
    return false;
  }
  if (ORDER_VERB.test(t)) return true;
  return CLINICAL_NOUN.test(t) && POLITE_REQUEST.test(t);
}

// ── backend contract ────────────────────────────────────────────

interface NurseActResponse {
  runId: string;
  intent: 'order' | 'none';
  plan: string;
  steps: NurseStep[];
  applied: {
    orderedTestIds: string[];
    prescriptions: Array<{ medicationId: string; dose: string; duration: string }>;
    followUp?: { inDays: number; reason: string };
  };
  spokenConfirmation: string;
}

const TEST_CATALOG = TESTS.map((t) => ({ id: t.id, name: t.name, category: t.category }));
const MED_CATALOG = MEDICATIONS.map((m) => ({
  id: m.id,
  name: m.name,
  dosing: `${m.defaultDose}; ${m.defaultDuration}`,
}));
const TEST_IDS = new Set(TESTS.map((t) => t.id));
const MED_BY_ID = new Map(MEDICATIONS.map((m) => [m.id, m]));

function buildPayload(p: ActivePatient, utterance: string) {
  const c = p.case;
  const allergyAnswers = c.anamnesis
    .filter((q) => /allerg/i.test(q.question))
    .map((q) => q.answer);
  const testName = new Map(TESTS.map((t) => [t.id, t.name]));
  const completed = new Set(p.completedTestIds);
  return {
    caseId: c.id,
    utterance,
    lang: store.getState().lang,
    patient: {
      name: c.name,
      age: c.age,
      gender: c.gender,
      chiefComplaint: c.chiefComplaint,
      ...(allergyAnswers.length ? { allergies: allergyAnswers.join('; ') } : {}),
      anamnesis: c.anamnesis.map((q) => ({ question: q.question, answer: q.answer })),
      vitals: c.vitals,
      // Only results the doctor has actually seen.
      testResults: c.testResults
        .filter((r) => completed.has(r.testId))
        .map((r) => ({
          testId: r.testId,
          name: testName.get(r.testId) ?? r.testId,
          result: r.result,
          abnormal: r.abnormal,
        })),
    },
    catalog: { tests: TEST_CATALOG, medications: MED_CATALOG },
    alreadyOrdered: [...p.orderedTestIds],
    alreadyPrescribed: (p.prescriptions ?? []).map((rx) => rx.medicationId),
  };
}

async function postJson<T>(path: string, body: unknown): Promise<T> {
  let r: Response;
  try {
    r = await fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Backend unreachable, start backend/server.py on :8787.');
  }
  if (!r.ok) {
    const text = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 200);
    throw new Error(`${path} ${r.status}${text ? `: ${text}` : ''}`);
  }
  return (await r.json()) as T;
}

// ── nurse voice playback (serialised so lines never overlap) ────

let speechChain: Promise<void> = Promise.resolve();

// Tiny "is the nurse talking right now" signal for Nurse Asha's mascot.
let nurseSpeaking = false;
const speakingListeners = new Set<() => void>();
function setNurseSpeaking(v: boolean) {
  if (nurseSpeaking === v) return;
  nurseSpeaking = v;
  for (const l of speakingListeners) l();
}
export const isNurseSpeaking = (): boolean => nurseSpeaking;
export function subscribeNurseSpeaking(fn: () => void): () => void {
  speakingListeners.add(fn);
  return () => speakingListeners.delete(fn);
}

export function speakAsNurse(text: string): Promise<void> {
  const line = text.trim();
  if (!line) return Promise.resolve();
  speechChain = speechChain.then(async () => {
    let url: string | null = null;
    const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
    const wasMuted = conv?.isMicMuted() ?? false;
    try {
      const r = await fetch('/voice/tts', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ text: line, voice: 'nurse', locale: LANG_LOCALE[langOfText(line)] }),
      });
      if (!r.ok) throw new Error(`/voice/tts ${r.status}`);
      url = URL.createObjectURL(await r.blob());
      const audio = new Audio(url);
      // Keep the nurse's voice out of the doctor's mic → patient ASR.
      conv?.setMicMuted(true);
      setNurseSpeaking(true);
      await new Promise<void>((resolve) => {
        const done = () => resolve();
        audio.addEventListener('ended', done, { once: true });
        audio.addEventListener('error', done, { once: true });
        audio.play().catch(done);
        window.setTimeout(done, 20000); // hard cap
      });
    } catch (err) {
      console.warn(LOG, 'nurse TTS failed:', err);
    } finally {
      setNurseSpeaking(false);
      if (!wasMuted) conv?.setMicMuted(false);
      if (url) URL.revokeObjectURL(url);
    }
  });
  return speechChain;
}

// ── main entry ──────────────────────────────────────────────────

function newRunId(): string {
  return `nr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function describeForPatient(applied: NurseRun['applied']): string | null {
  if (!applied) return null;
  const parts: string[] = [];
  if (applied.orderedTestIds.length) {
    const names = applied.orderedTestIds.map((id) => TESTS.find((t) => t.id === id)?.name ?? id);
    parts.push(`The nurse has just done these tests on you: ${names.join(', ')}.`);
  }
  if (applied.prescriptions.length) {
    const meds = applied.prescriptions.map((rx) => {
      const m = MED_BY_ID.get(rx.medicationId);
      return `${m?.name ?? rx.medicationId} (${rx.dose}, ${rx.duration})`;
    });
    parts.push(`The doctor has prescribed you: ${meds.join(', ')}.`);
  }
  if (applied.followUp) {
    parts.push(
      `A follow-up visit was booked in ${applied.followUp.inDays} days (${applied.followUp.reason}).`,
    );
  }
  return parts.length ? parts.join(' ') : null;
}

/**
 * Run the nurse agent on one doctor utterance. Pushes a 'running' run into
 * the store immediately, then fills it in. Returns the final run, or null
 * when there's no polyclinic patient. Never throws.
 */
export async function runNurseAction(
  utterance: string,
  source: 'voice' | 'typed',
): Promise<NurseRun | null> {
  const patient = store.getState().polyclinic.patient;
  const text = utterance.trim();
  if (!patient || !text) return null;
  const caseId = patient.case.id;

  const id = newRunId();
  const placeholder: NurseRun = {
    id,
    caseId,
    utterance: text,
    source,
    status: 'running',
    startedAt: Date.now(),
    steps: [],
  };
  store.pushAgentRun(placeholder);

  try {
    const res = await postJson<NurseActResponse>('/agent/nurse/act', buildPayload(patient, text));

    // Patient may have changed while we waited, don't apply to the wrong chart.
    const cur = store.getState().polyclinic.patient;
    if (!cur || cur.case.id !== caseId) {
      const stale: Partial<NurseRun> = {
        status: 'error',
        error: 'Patient changed before the nurse finished, nothing applied.',
        finishedAt: Date.now(),
      };
      store.updateAgentRun(id, stale);
      return { ...placeholder, ...stale };
    }

    // Validate against the catalogs; apply only what's real and new.
    const already = new Set(cur.orderedTestIds);
    const orderedTestIds = (res.applied?.orderedTestIds ?? []).filter(
      (tid) => TEST_IDS.has(tid) && !already.has(tid),
    );
    const prescriptions = (res.applied?.prescriptions ?? [])
      .filter((rx) => rx && MED_BY_ID.has(rx.medicationId))
      .map((rx) => {
        const m = MED_BY_ID.get(rx.medicationId)!;
        return {
          medicationId: rx.medicationId,
          dose: rx.dose?.trim() || m.defaultDose,
          duration: rx.duration?.trim() || m.defaultDuration,
        };
      });
    const fu = res.applied?.followUp;
    const followUp =
      fu && Number.isFinite(Number(fu.inDays)) && Number(fu.inDays) > 0
        ? { inDays: Math.round(Number(fu.inDays)), reason: String(fu.reason ?? '').trim() || 'Review' }
        : undefined;

    for (const tid of orderedTestIds) store.orderPolyclinicTest(tid);
    for (const rx of prescriptions) store.addPolyclinicPrescription(rx);
    if (followUp) store.setPolyclinicFollowUp(followUp);

    const applied = { orderedTestIds, prescriptions, ...(followUp ? { followUp } : {}) };
    const done: Partial<NurseRun> = {
      runId: res.runId,
      status: 'done',
      intent: res.intent === 'order' ? 'order' : 'none',
      plan: res.plan,
      steps: Array.isArray(res.steps) ? res.steps : [],
      applied,
      spokenConfirmation: res.spokenConfirmation,
      finishedAt: Date.now(),
    };
    store.updateAgentRun(id, done);
    // Nurse Asha's mistake coach: local alerts from refused/flagged steps,
    // then a non-blocking LLM check. Never affects this run.
    void import('./coach')
      .then((m) => m.afterNurseRun({ ...placeholder, ...done }))
      .catch((err) => console.warn(LOG, 'coach load failed:', err));

    if (done.intent === 'order') {
      if (res.spokenConfirmation) void speakAsNurse(res.spokenConfirmation);
      const note = describeForPatient(applied);
      const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
      if (note && conv && conv.getCaseId() === caseId) void conv.appendContextNote(note);
    }
    return { ...placeholder, ...done };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.warn(LOG, 'run failed:', msg);
    const failed: Partial<NurseRun> = { status: 'error', error: msg, finishedAt: Date.now() };
    store.updateAgentRun(id, failed);
    return { ...placeholder, ...failed };
  }
}
