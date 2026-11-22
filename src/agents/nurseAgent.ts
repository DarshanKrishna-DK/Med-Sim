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

import { getPatientContact } from '../game/patientContact';
import { CLINIC_LABELS } from '../game/clinic';
import { getCaseSpecialty, POLYCLINIC_DIAGNOSIS_LABELS } from '../data/polyclinicPatients';
import { skillsPerformed } from './logbook';
import { doctorName, getProfile } from '../game/profile';
import { store, isOsceLive, isRoomMode, POLYCLINIC_BED_INDEX } from '../game/store';
import type { ActivePatient, FollowUp, NursePending, NurseRun, NurseStep } from '../game/types';
import { encounterIdOf } from '../room/chart';
import { claimLine } from '../room/session';
import { TESTS } from '../data/tests';
import { MEDICATIONS } from '../data/medications';
import { getExistingConversation } from '../voice/conversationStore';
import { callUrlsFromSteps, rememberFollowupCall } from '../voice/followupCall';
import { getStaffSpeaking, say, subscribeSpeaking, type SayOptions } from '../voice/speech';

export type { NurseRun, NurseStep } from '../game/types';

const LOG = '[medsim:nurse]';

// ── prefilter ───────────────────────────────────────────────────

// Lives in a pure module so the Node test runner can load it.
export { looksLikeOrder, isAddressedToNurse } from './nurseIntent';

// ── backend contract ────────────────────────────────────────────

interface NurseActResponse {
  runId: string;
  intent: 'order' | 'none' | 'clarify';
  plan: string;
  steps: NurseStep[];
  applied: {
    orderedTestIds: string[];
    prescriptions: Array<{ medicationId: string; dose: string; duration: string }>;
    followUp?: FollowUp;
    cancelledTestIds?: string[];
    stoppedMedicationIds?: string[];
  };
  /** BAND room mode: work that a department now owns. */
  pending?: NursePending[];
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
    encounterId: encounterIdOf(p),
    osce: isOsceLive(store.getState()),
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
      testResults: [
        // Returned by a department, or (legacy mode) released at once from the case.
        ...Object.entries(p.testReports ?? {}).map(([testId, r]) => ({ testId, result: r.text, abnormal: r.abnormal })),
        ...c.testResults.filter((r) => completed.has(r.testId) && !p.testReports?.[r.testId]),
      ].map((r) => ({
        testId: r.testId,
        name: testName.get(r.testId) ?? r.testId,
        result: r.result,
        abnormal: r.abnormal,
      })),
    },
    catalog: { tests: TEST_CATALOG, medications: MED_CATALOG },
    alreadyOrdered: [...p.orderedTestIds],
    alreadyPrescribed: (p.prescriptions ?? []).map((rx) => rx.medicationId),
    // At the pharmacy: being checked or held, so NOT prescribed.
    inReview: (p.rxReview ?? []).map(({ ref, medicationId, dose, duration, status }) => ({ ref, medicationId, dose, duration, status })),
    pendingTests: p.orderedTestIds.filter((id) => !completed.has(id)),
    // Real-world delivery (send_to_patient) and everything already on the chart.
    contact: getPatientContact() || undefined,
    doctorName: doctorName(getProfile()),
    prescriptionsSoFar: (p.prescriptions ?? []).map(({ medicationId, dose, duration }) => ({ medicationId, dose, duration })),
    followUpSoFar: p.followUp ?? undefined,
    // Logbook (log_case) and referral (refer_patient) context.
    student: getProfile()?.name || undefined,
    university: getProfile()?.university || undefined,
    specialty: (() => { const sp = getCaseSpecialty(c.id); return sp ? CLINIC_LABELS[sp] : undefined; })(),
    caseName: c.name,
    diagnosis: p.submittedDiagnosisId ? POLYCLINIC_DIAGNOSIS_LABELS[p.submittedDiagnosisId] ?? p.submittedDiagnosisId : undefined,
    skills: skillsPerformed(p),
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

// ── nurse voice (thin wrapper over the one speech queue) ─────────

/** Asha or a message she relays is being heard right now (mascot mood). */
export const isNurseSpeaking = (): boolean => {
  const who = getStaffSpeaking()?.speaker;
  return who === 'nurse' || who === 'faculty';
};
export function subscribeNurseSpeaking(fn: () => void): () => void {
  return subscribeSpeaking(() => fn());
}

/** Say a line in Asha's voice. Prefer `say` from voice/speech when the line
 *  has a key, a ref or a priority of its own. */
export function speakAsNurse(text: string, opts: Omit<SayOptions, 'text' | 'speaker'> = {}): Promise<void> {
  return say({ priority: 'result', ...opts, speaker: 'nurse', text }).then(() => undefined);
}

// ── main entry ──────────────────────────────────────────────────

function newRunId(): string {
  return `nr-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function describeForPatient(applied: NurseRun['applied'], pendingTests: ReadonlySet<string>): string | null {
  if (!applied) return null;
  const parts: string[] = [];
  const names = (ids: string[]) => ids.map((id) => TESTS.find((t) => t.id === id)?.name ?? id).join(', ');
  const done = applied.orderedTestIds.filter((id) => !pendingTests.has(id));
  const sent = applied.orderedTestIds.filter((id) => pendingTests.has(id));
  if (done.length) parts.push(`The nurse has just done these tests on you: ${names(done)}.`);
  if (sent.length) parts.push(`The nurse has arranged these tests; nobody has the results yet: ${names(sent)}.`);
  if (applied.prescriptions.length) {
    const meds = applied.prescriptions.map((rx) => {
      const m = MED_BY_ID.get(rx.medicationId);
      return `${m?.name ?? rx.medicationId} (${rx.dose}, ${rx.duration})`;
    });
    parts.push(`The doctor has prescribed you: ${meds.join(', ')}.`);
  }
  if (applied.stoppedMedicationIds?.length) {
    parts.push(`The doctor has stopped: ${applied.stoppedMedicationIds.map((id) => MED_BY_ID.get(id)?.name ?? id).join(', ')}.`);
  }
  if (applied.followUp) {
    const n = applied.followUp.inDays;
    parts.push(`A follow-up visit was booked ${n === 0 ? 'for later today' : `in ${n} day${n === 1 ? '' : 's'}`} (${applied.followUp.reason}).`);
  }
  return parts.length ? parts.join(' ') : null;
}

/** The follow-up the backend booked, clamped. 0 days is later today. */
function cleanFollowUp(fu: FollowUp | undefined): FollowUp | undefined {
  const days = fu ? Number(fu.inDays) : NaN;
  if (!fu || !Number.isFinite(days) || days < 0) return undefined;
  return {
    inDays: Math.round(days),
    reason: String(fu.reason ?? '').trim() || 'Review',
    ...(fu.recurrence && typeof fu.recurrence === 'object' ? { recurrence: fu.recurrence } : {}),
    ...(fu.mode === 'call' || fu.mode === 'visit' ? { mode: fu.mode } : {}),
    ...(typeof fu.callUrl === 'string' && fu.callUrl ? { callUrl: fu.callUrl } : {}),
  };
}

/** Say Asha's reply once. The room may already have said the same sentence. */
function speakRun(res: NurseActResponse, pending: NursePending[]) {
  const text = res.spokenConfirmation?.trim();
  if (!text || !claimLine(text)) return;
  // Everything was handed over: just an acknowledgement, the department's own
  // line replaces it. Anything else in the reply is the result itself.
  const only = res.intent === 'order' && pending.length > 0 && !res.applied?.followUp && !res.applied?.prescriptions?.length;
  const ack = only && (res.steps ?? []).every((x) => x.ok);
  void say({
    speaker: 'nurse',
    text,
    priority: ack ? 'ack' : 'result',
    ...(ack ? { dropIfStale: 12_000 } : {}),
    key: `nurse-run:${res.runId}`,
    ...(pending.length === 1 ? { ref: pending[0].ref } : {}),
  });
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
  const encounterId = encounterIdOf(patient);

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
    // Same case seated again is a new encounter, so arrivedAt counts too.
    if (!cur || encounterIdOf(cur) !== encounterId) {
      const stale: Partial<NurseRun> = {
        status: 'error',
        error: 'Patient changed before the nurse finished, nothing applied.',
        finishedAt: Date.now(),
      };
      store.updateAgentRun(id, stale);
      return { ...placeholder, ...stale };
    }

    // Validate against the catalogs; apply only what's real and new. A result
    // can come back over the room before this response, so "new" is measured
    // against the chart the order was given on.
    const already = new Set(patient.orderedTestIds);
    const pending = (Array.isArray(res.pending) ? res.pending : []).filter((x) => x && typeof x.ref === 'string');
    const heldByDept = new Set(pending.flatMap((x) => x.testIds ?? []));
    const roomOn = isRoomMode(store.getState());
    const orderedTestIds = (res.applied?.orderedTestIds ?? []).filter((tid) => TEST_IDS.has(tid) && !already.has(tid));
    const cleanRx = (rx: { medicationId: string; dose?: string; duration?: string }) => {
      const m = MED_BY_ID.get(rx.medicationId)!;
      return {
        medicationId: rx.medicationId,
        dose: rx.dose?.trim() || m.defaultDose,
        duration: rx.duration?.trim() || m.defaultDuration,
      };
    };
    const prescriptions = (res.applied?.prescriptions ?? []).filter((rx) => rx && MED_BY_ID.has(rx.medicationId)).map(cleanRx);
    const cancelledTestIds = (res.applied?.cancelledTestIds ?? []).filter((tid) => TEST_IDS.has(tid));
    const stoppedMedicationIds = (res.applied?.stoppedMedicationIds ?? []).filter((mid) => MED_BY_ID.has(mid));
    const followUp = cleanFollowUp(res.applied?.followUp);

    for (const tid of cancelledTestIds) store.cancelPolyclinicTest(tid);
    for (const mid of stoppedMedicationIds) store.removePrescription(mid);
    const pendingTests = new Set(orderedTestIds.filter((tid) => roomOn || heldByDept.has(tid)));
    for (const tid of orderedTestIds) store.orderPolyclinicTest(tid, { pending: pendingTests.has(tid) });
    for (const rx of prescriptions) store.addPolyclinicPrescription(rx);
    // Fallback for a hand-off whose delegation event has not arrived yet; the
    // room's own events own the state from then on.
    for (const x of pending) {
      if (x.action !== 'verify_rx' || !x.medicationId || !MED_BY_ID.has(x.medicationId)) continue;
      if (store.getState().agentRoom?.delegations.some((d) => d.ref === x.ref)) continue;
      const rx = cleanRx({ medicationId: x.medicationId });
      store.reviewPrescription({ ref: x.ref, ...rx, status: 'verifying' });
    }
    if (followUp) store.setPolyclinicFollowUp(followUp);

    const applied: NonNullable<NurseRun['applied']> = {
      orderedTestIds,
      prescriptions,
      ...(followUp ? { followUp } : {}),
      ...(cancelledTestIds.length ? { cancelledTestIds } : {}),
      ...(stoppedMedicationIds.length ? { stoppedMedicationIds } : {}),
    };
    const done: Partial<NurseRun> = {
      runId: res.runId,
      status: 'done',
      intent: res.intent === 'order' || res.intent === 'clarify' ? res.intent : 'none',
      plan: res.plan,
      steps: Array.isArray(res.steps) ? res.steps : [],
      applied,
      ...(pending.length ? { pending } : {}),
      spokenConfirmation: res.spokenConfirmation,
      finishedAt: Date.now(),
    };
    store.updateAgentRun(id, done);
    // Asha follow-up call links (calendar event) -> Plan tab "Follow-up call reports".
    for (const url of callUrlsFromSteps(done.steps)) rememberFollowupCall(caseId, url);
    // Nurse Asha's mistake coach: local alerts from refused/flagged steps,
    // then a non-blocking LLM check. Never affects this run.
    void import('./coach')
      .then((m) => m.afterNurseRun({ ...placeholder, ...done }))
      .catch((err) => console.warn(LOG, 'coach load failed:', err));

    if (done.intent !== 'none') speakRun(res, pending);
    if (done.intent === 'order') {
      const sent = (res.steps ?? []).find((s) => s.tool === 'send_to_patient' && s.ok);
      const note = [
        describeForPatient(applied, pendingTests),
        // The live Agora patient reacts to the real message landing on their phone.
        sent
          ? 'Your phone just buzzed: the clinic sent you your prescription, a voice note explaining it in your language, and your follow-up date. You may mention it briefly if it fits.'
          : null,
      ]
        .filter(Boolean)
        .join(' ') || null;
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
