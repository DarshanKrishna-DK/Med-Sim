// Nurse Asha's mistake coach (client side).
//
// After the doctor does something (a nurse run finishes, a diagnosis is
// submitted, a prescription or test is added by hand, or a clinical
// statement is spoken) we ask POST /agent/coach/check whether it was a real
// mistake. Calls are fire-and-forget: they never block the encounter and any
// failure just means "no alert". Nurse steps that were refused or flagged
// become alerts immediately, without the LLM (see coachRules.ts).

import { store, POLYCLINIC_BED_INDEX, isOsceLive } from '../game/store';
import type { ActivePatient, CoachAlert, NurseRun } from '../game/types';
import { TESTS } from '../data/tests';
import { MEDICATIONS } from '../data/medications';
import { POLYCLINIC_DIAGNOSIS_LABELS } from '../data/polyclinicPatients';
import { getExistingConversation } from '../voice/conversationStore';
import { alertsFromNurseRun } from './coachRules';
import { TREATMENTS } from '../data/treatments';

const LOG = '[medsim:coach]';
const TIMEOUT_MS = 10000;

export type CoachEventKind = 'order' | 'prescription' | 'diagnosis' | 'utterance';

interface ServerAlert {
  id: string;
  severity: CoachAlert['severity'];
  title: string;
  short: string;
  explanation: string;
  suggestion?: string;
}

const testName = (id: string) => TESTS.find((t) => t.id === id)?.name ?? id;
const medName = (id: string) => MEDICATIONS.find((m) => m.id === id)?.name ?? id;
export const dxLabel = (id: string) =>
  POLYCLINIC_DIAGNOSIS_LABELS[id] ?? id.replace(/-/g, ' ').replace(/^\w/, (m) => m.toUpperCase());

function patientPayload(p: ActivePatient) {
  const c = p.case;
  const allergies = c.anamnesis.filter((q) => /allerg/i.test(q.question)).map((q) => q.answer);
  return {
    name: c.name,
    age: c.age,
    gender: c.gender,
    chiefComplaint: c.chiefComplaint,
    ...(allergies.length ? { allergies: allergies.join('; ') } : {}),
    anamnesis: c.anamnesis.map((q) => ({ question: q.question, answer: q.answer })),
    vitals: c.vitals,
  };
}

function transcript(): Array<{ role: string; content: string }> {
  const conv = getExistingConversation(POLYCLINIC_BED_INDEX);
  return conv ? [...conv.getMessages()] : [];
}

function encounterSoFar(p: ActivePatient) {
  const msgs = transcript();
  const doctorTurns = msgs.filter((m) => m.role === 'user').length;
  return {
    orderedTests: p.orderedTestIds.map(testName),
    prescriptions: (p.prescriptions ?? []).map((rx) => `${medName(rx.medicationId)} ${rx.dose}`.trim()),
    // Voice history isn't tagged per question, so two doctor turns count.
    askedHistory: p.askedQuestionIds.length > 0 || doctorTurns >= 2,
    // Body systems examined, with any abnormal signs found.
    examsPerformed: (p.examsPerformed ?? []).map((sys) => {
      const abn = (p.examResults?.[sys]?.findings ?? []).filter((f) => f.abnormal).map((f) => `${f.label}: ${f.value}`);
      return abn.length ? `${sys} (${abn.join('; ')})` : sys;
    }),
    transcriptTail: msgs.slice(-10).map((m) => `${m.role === 'user' ? 'Doctor' : 'Patient'}: ${m.content}`),
  };
}

// Skip identical checks fired twice in quick succession (StrictMode, double
// submit, voice + typed echo of the same line).
const recent = new Map<string, number>();

/** Ask the coach about one event. Never throws; resolves to the alert that
 *  was added to the store, or null. */
export async function checkCoach(kind: CoachEventKind, detail: string): Promise<CoachAlert | null> {
  const p = store.getState().polyclinic.patient;
  const text = detail.trim();
  if (!p || !text) return null;
  const caseId = p.case.id;
  const key = `${caseId}|${kind}|${text.toLowerCase()}`;
  const now = Date.now();
  if ((recent.get(key) ?? 0) > now - 8000) return null;
  recent.set(key, now);

  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), TIMEOUT_MS);
  try {
    const r = await fetch('/agent/coach/check', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        caseId,
        lang: store.getState().lang,
        event: { kind, detail: text.slice(0, 600) },
        patient: patientPayload(p),
        correctDiagnosis: p.case.correctDiagnosisId ? dxLabel(p.case.correctDiagnosisId) : undefined,
        encounterSoFar: encounterSoFar(p),
      }),
    });
    if (!r.ok) throw new Error(`/agent/coach/check ${r.status}`);
    const data = (await r.json()) as { alert: ServerAlert | null };
    const a = data?.alert;
    const cur = store.getState().polyclinic.patient;
    if (!a || !a.title || !cur || cur.case.id !== caseId) return null;
    const alert: CoachAlert = {
      id: a.id || `ca-${now.toString(36)}`,
      caseId,
      severity: a.severity === 'danger' || a.severity === 'info' ? a.severity : 'warning',
      title: a.title,
      short: a.short || a.explanation,
      explanation: a.explanation || a.short,
      suggestion: a.suggestion ?? '',
      source: 'coach',
      createdAt: Date.now(),
    };
    store.pushCoachAlert(alert);
    return alert;
  } catch (err) {
    console.debug(LOG, 'check skipped:', err instanceof Error ? err.message : err);
    return null;
  } finally {
    window.clearTimeout(timer);
  }
}

/** Called by the nurse agent when a run finishes. Local alerts first; the
 *  LLM check only runs if the nurse didn't already flag a safety problem. */
export function afterNurseRun(run: NurseRun): void {
  if (run.status !== 'done' || run.intent !== 'order') return;
  const local = alertsFromNurseRun(run);
  for (const a of local) store.pushCoachAlert(a);
  if (local.some((a) => a.severity !== 'info')) return;

  const applied = run.applied;
  if (!applied) return;
  const rx = applied.prescriptions.map((r) => `${medName(r.medicationId)} ${r.dose} for ${r.duration}`);
  const tests = applied.orderedTestIds.map(testName);
  if (!rx.length && !tests.length) return;
  const parts = [rx.length ? `Prescribed: ${rx.join(', ')}` : '', tests.length ? `Ordered tests: ${tests.join(', ')}` : ''];
  void checkCoach(rx.length ? 'prescription' : 'order', parts.filter(Boolean).join('. '));
}

/** Manual chart actions (Results, Diagnosis and Plan tabs). */
export const coachAfterManualTest = (testId: string) => void checkCoach('order', `Ordered tests: ${testName(testId)}`);
export const coachAfterManualPrescription = (medicationId: string, dose: string, duration: string) =>
  void checkCoach('prescription', `Prescribed: ${medName(medicationId)} ${dose} for ${duration}`);
export const coachAfterDiagnosis = (dxId: string) => void checkCoach('diagnosis', dxLabel(dxId));
export const coachAfterUtterance = (text: string) => void checkCoach('utterance', text);

/** Follow-up question about an alert ("Why is that wrong?"). Falls back to
 *  the alert's own explanation if the backend can't answer. */
export async function explainAlert(alert: CoachAlert, question?: string): Promise<string> {
  const p = store.getState().polyclinic.patient;
  const fallback = [alert.explanation, alert.suggestion].filter(Boolean).join(' ');
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), TIMEOUT_MS + 2000);
  try {
    const r = await fetch('/agent/coach/explain', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        alert: {
          severity: alert.severity,
          title: alert.title,
          short: alert.short,
          explanation: alert.explanation,
          suggestion: alert.suggestion,
        },
        question: question?.trim() || undefined,
        lang: store.getState().lang,
        caseId: alert.caseId,
        patient: p ? patientPayload(p) : {},
      }),
    });
    if (!r.ok) throw new Error(`/agent/coach/explain ${r.status}`);
    const data = (await r.json()) as { answer?: string };
    return data.answer?.trim() || fallback;
  } catch (err) {
    console.debug(LOG, 'explain fell back:', err instanceof Error ? err.message : err);
    return fallback;
  } finally {
    window.clearTimeout(timer);
  }
}


// ── "How am I doing, Asha?" ──────────────────────────────────────────

const HINT_TITLE: Record<string, string> = {
  on_track: 'On track',
  partly: 'Getting there',
  off_track: 'Rethink the plan',
};

let hintBusy = false;

/** Socratic check-in from Asha: one thing done well plus a nudge, never the
 *  answer. Shown as a note in her panel and spoken in her Murf voice. */
export async function requestHint(): Promise<void> {
  const s = store.getState();
  const p = s.polyclinic.patient;
  if (!p || hintBusy || isOsceLive(s)) return;
  hintBusy = true;
  const caseId = p.case.id;
  const ctl = new AbortController();
  const timer = window.setTimeout(() => ctl.abort(), TIMEOUT_MS + 4000);
  let speak: typeof import('./nurseAgent').speakAsNurse | null = null;
  try {
    const speakAsNurse = (await import('./nurseAgent')).speakAsNurse;
    speak = speakAsNurse;
    void speakAsNurse('Let me have a look, doctor.');
    const r = await fetch('/agent/coach/hint', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      signal: ctl.signal,
      body: JSON.stringify({
        caseId,
        lang: s.lang,
        patient: patientPayload(p),
        correctDiagnosis: p.case.correctDiagnosisId ? dxLabel(p.case.correctDiagnosisId) : undefined,
        keyTests: p.case.testResults.filter((t) => t.abnormal).map((t) => testName(t.testId)),
        goodTreatments: [...p.case.criticalTreatmentIds, ...p.case.acceptableTreatmentIds].map(
          (id) => TREATMENTS.find((t) => t.id === id)?.name ?? medName(id),
        ),
        encounterSoFar: encounterSoFar(p),
      }),
    });
    if (!r.ok) throw new Error(`/agent/coach/hint ${r.status}`);
    const data = (await r.json()) as { verdict?: string; hint?: string };
    const cur = store.getState().polyclinic.patient;
    if (!data.hint || !cur || cur.case.id !== caseId) return;
    const verdict = data.verdict ?? 'partly';
    store.pushCoachAlert({
      id: `hint-${Date.now().toString(36)}`,
      caseId,
      severity: verdict === 'off_track' ? 'warning' : 'info',
      title: HINT_TITLE[verdict] ?? 'Check-in',
      short: data.hint,
      explanation: data.hint,
      suggestion: '',
      source: 'hint',
      createdAt: Date.now(),
    });
    void speakAsNurse(data.hint);
  } catch (err) {
    console.debug(LOG, 'hint skipped:', err instanceof Error ? err.message : err);
    if (speak) void speak("Sorry doctor, I couldn't check just now. Ask me again in a moment.");
  } finally {
    window.clearTimeout(timer);
    hintBusy = false;
  }
}

/** Check-in phrases: "how am I doing", "am I on the right track", "any hints". */
export function isHintRequest(text: string): boolean {
  return /\b(how am i doing|how'?m i doing|am i on (the )?(right )?track|am i doing (this |it )?right|on track|any (hints?|tips|suggestions?|ideas?|advice)|(give me|need) a (hint|tip|clue)|hint please|what am i missing|what(?:'s| is)? next|what (?:should|do|can) i do (?:next|now)|what now|next step|i'?m stuck|i am stuck|help me|i need help|suggest (?:something|what)|kya main sahi|kya karu+n?|ab kya karu+n?|aage kya)\b/i.test(
    text,
  );
}
