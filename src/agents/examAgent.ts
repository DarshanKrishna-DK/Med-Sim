// Physical examination (voice + click).
//
// The doctor says "let me listen to your chest" / "छाती की जाँच" / "ಎದೆ
// ಪರೀಕ್ಷೆ", or clicks a body-system button in the chart's Exam tab. We:
//   1. record the exam in the store (examsPerformed) so debrief + coach see it,
//   2. tell the voice patient what is happening (/voice/context) so they can
//      react ("Aah, that hurts there, doctor"),
//   3. fetch findings from POST /agent/exam/perform (cached per case+system on
//      the backend and here), and store them for the chart.
// The classifier is regex only: cheap, deterministic, no LLM.

import { useSyncExternalStore } from 'react';
import { store, POLYCLINIC_BED_INDEX } from '../game/store';
import type { ActivePatient, ExamResult, ExamSound, ExamSystem } from '../game/types';
import { TESTS } from '../data/tests';
import { POLYCLINIC_DIAGNOSIS_LABELS } from '../data/polyclinicPatients';
import { getExistingConversation } from '../voice/conversationStore';
import { EXAM_SYSTEMS, classifyExam } from './examClassifier';

const LOG = '[medsim:exam]';
const TIMEOUT_MS = 20000;

export { EXAM_SYSTEMS, classifyExam, examLabel } from './examClassifier';

// ── UI signal (pending / errors / "open the Exam tab") ───────────

export interface ExamUiState {
  pending: ReadonlyArray<ExamSystem>;
  errors: Partial<Record<ExamSystem, string>>;
  /** Last exam started, so the chart can jump to it. */
  focus: { system: ExamSystem; at: number } | null;
}

let ui: ExamUiState = { pending: [], errors: {}, focus: null };
let uiCaseId: string | null = null;
const uiListeners = new Set<() => void>();

function setUi(caseId: string, patch: Partial<ExamUiState>) {
  if (uiCaseId !== caseId) {
    uiCaseId = caseId;
    ui = { pending: [], errors: {}, focus: null };
  }
  ui = { ...ui, ...patch };
  for (const l of uiListeners) l();
}

function subscribeUi(fn: () => void): () => void {
  uiListeners.add(fn);
  return () => uiListeners.delete(fn);
}

/** Exam UI state for the seated patient. */
export function useExamUi(caseId: string): ExamUiState {
  const snap = useSyncExternalStore(subscribeUi, () => ui);
  return uiCaseId === caseId ? snap : EMPTY_UI;
}
const EMPTY_UI: ExamUiState = { pending: [], errors: {}, focus: null };

// ── backend ──────────────────────────────────────────────────────

const dxLabel = (id: string) =>
  POLYCLINIC_DIAGNOSIS_LABELS[id] ?? id.replace(/-/g, ' ').replace(/^\w/, (m) => m.toUpperCase());

function buildPayload(p: ActivePatient, system: ExamSystem, maneuver?: string) {
  const c = p.case;
  const testName = new Map(TESTS.map((t) => [t.id, t.name]));
  return {
    caseId: c.id,
    system,
    ...(maneuver ? { maneuver: maneuver.slice(0, 200) } : {}),
    lang: store.getState().lang,
    patient: {
      name: c.name,
      age: c.age,
      gender: c.gender,
      chiefComplaint: c.chiefComplaint,
      anamnesis: c.anamnesis.map((q) => ({ question: q.question, answer: q.answer })),
      vitals: c.vitals,
      // All documented results: findings must agree with them even if the
      // trainee has not ordered the test yet. Never shown to the trainee.
      testResults: c.testResults.map((r) => ({
        testId: r.testId,
        name: testName.get(r.testId) ?? r.testId,
        result: r.result,
        abnormal: r.abnormal,
      })),
    },
    correctDiagnosis: c.correctDiagnosisId ? dxLabel(c.correctDiagnosisId) : '',
  };
}

const SOUNDS: ReadonlyArray<ExamSound> = [
  'normal-heart', 'murmur-systolic', 'murmur-diastolic', 's3', 'pericardial-rub',
  'normal-breath', 'wheeze', 'crackles', 'bronchial', 'absent',
];

function toResult(system: ExamSystem, raw: unknown): ExamResult | null {
  const r = raw as Partial<ExamResult> | null;
  if (!r || !Array.isArray(r.findings)) return null;
  const findings = r.findings
    .filter((f) => f && typeof f.label === 'string' && typeof f.value === 'string')
    .map((f) => ({ label: f.label, value: f.value, abnormal: f.abnormal === true }));
  if (!findings.length) return null;
  const sound = SOUNDS.includes(r.sound as ExamSound) ? (r.sound as ExamSound) : null;
  return { system, findings, summary: typeof r.summary === 'string' ? r.summary : '', sound, performedAt: Date.now() };
}

// ── patient reaction ─────────────────────────────────────────────

const noted = new Set<string>();

function patientNote(system: ExamSystem): string {
  const part = EXAM_SYSTEMS.find((s) => s.id === system)?.part ?? system;
  const base = `The doctor is now examining your ${part}.`;
  if (system === 'abdomen' || system === 'msk' || system === 'obgyn') {
    return `${base} If that area is tender or painful because of your illness, react the next time you speak with a short pained word, like "Aah, that hurts there, doctor". If it is not sore, do not invent pain.`;
  }
  if (system === 'cardio' || system === 'resp') {
    return `${base} Cooperate briefly if asked to breathe in deeply or hold your breath (for example "Okay, doctor"). The stethoscope may feel a little cold.`;
  }
  return `${base} React naturally and briefly; mention pain only if your illness would make that area hurt.`;
}

function tellPatient(caseId: string, system: ExamSystem) {
  const key = `${caseId}:${system}`;
  if (noted.has(key)) return;
  const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
  if (!conv || conv.getCaseId() !== caseId) return;
  noted.add(key);
  void conv.appendContextNote(patientNote(system));
}

// ── main entry ───────────────────────────────────────────────────

/** Examine one body system of the seated patient. Never throws; resolves to
 *  the findings (from cache when already examined) or null. */
export async function runExam(
  system: ExamSystem,
  source: 'voice' | 'click',
  utterance?: string,
): Promise<ExamResult | null> {
  const p = store.getState().polyclinic.patient;
  if (!p) return null;
  const caseId = p.case.id;

  store.recordPolyclinicExam(system);
  setUi(caseId, { focus: { system, at: Date.now() } });
  tellPatient(caseId, system);

  const cached = p.examResults?.[system];
  if (cached) return cached;
  if (ui.pending.includes(system)) return null;

  const errors = { ...ui.errors };
  delete errors[system];
  setUi(caseId, { pending: [...ui.pending, system], errors });

  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch('/agent/exam/perform', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify(buildPayload(p, system, source === 'voice' ? utterance : undefined)),
    });
    if (!r.ok) {
      const text = (await r.text().catch(() => '')).replace(/\s+/g, ' ').slice(0, 160);
      throw new Error(r.status >= 500 ? 'Findings unavailable, try again.' : `Exam failed (${r.status}) ${text}`.trim());
    }
    const result = toResult(system, await r.json());
    if (!result) throw new Error('Findings unavailable, try again.');
    const cur = store.getState().polyclinic.patient;
    if (!cur || cur.case.id !== caseId) return null; // patient changed meanwhile
    store.recordPolyclinicExam(system, result);
    return result;
  } catch (err) {
    const msg = (err as { name?: string })?.name === 'AbortError'
      ? 'The exam timed out, try again.'
      : err instanceof Error && err.message !== 'Failed to fetch'
        ? err.message
        : 'Backend unreachable, start backend/server.py on :8787.';
    console.warn(LOG, 'exam failed:', msg);
    if (uiCaseId === caseId) setUi(caseId, { errors: { ...ui.errors, [system]: msg } });
    return null;
  } finally {
    window.clearTimeout(timer);
    if (uiCaseId === caseId) setUi(caseId, { pending: ui.pending.filter((s) => s !== system) });
  }
}

/** Voice hook: called with every final doctor utterance. Returns true when
 *  it was an examination request (so the nurse agent can skip it). */
export function maybeRunExamFromSpeech(utterance: string): boolean {
  const sys = classifyExam(utterance);
  if (!sys) return false;
  void runExam(sys, 'voice', utterance);
  return true;
}
