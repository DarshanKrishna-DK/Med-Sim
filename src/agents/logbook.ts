// NMC CBME clinical logbook: after a debrief is saved, POST /agent/logbook once per
// encounter. The backend appends a row to the student's "MedSim Clinical Logbook"
// Google Sheet and returns its link, which the debrief shows as a chip.
// Fire-and-forget: a missing or failing logbook never touches the debrief.

import { getProfile } from '../game/profile';
import { CLINIC_LABELS, type ClinicId } from '../game/clinic';
import type { ActivePatient } from '../game/types';
import { TESTS } from '../data/tests';
import { MEDICATIONS } from '../data/medications';
import { POLYCLINIC_DIAGNOSIS_LABELS } from '../data/polyclinicPatients';
import { facultyMarksFor } from '../observer/facultyMarks';

export interface LogbookPayload {
  caseId: string;
  caseName: string;
  specialty: string;
  patientName: string;
  diagnosis: string;
  skills: string[];
  tests: string[];
  prescriptions: string[];
  score?: number;
  student: string;
  university: string;
  facultyMarks?: Array<{ examiner: string; comment: string; scores: Record<string, number> }>;
}

const EXAM_LABEL = (s: string) => `${s.charAt(0).toUpperCase()}${s.slice(1)} examination`;

/** Skills the student actually performed in this encounter, as logbook wording. */
export function skillsPerformed(p: ActivePatient): string[] {
  const out: string[] = [];
  if (p.askedQuestionIds.length) out.push('History taking');
  for (const s of p.examsPerformed ?? []) out.push(EXAM_LABEL(s));
  if (p.orderedTestIds.length) out.push('Investigation ordering and interpretation');
  if (p.submittedDiagnosisId) out.push('Diagnosis');
  if (p.prescriptions?.length) out.push('Prescribing');
  if (p.givenTreatmentIds.length) out.push('Initial management');
  if (p.followUp) out.push('Follow-up planning');
  return out;
}

export function buildLogbookPayload(encounter: ActivePatient, specialty: ClinicId | string | undefined, score?: number): LogbookPayload {
  const c = encounter.case;
  const profile = getProfile();
  const dxId = encounter.submittedDiagnosisId ?? c.correctDiagnosisId;
  const testName = new Map(TESTS.map((t) => [t.id, t.name]));
  const medName = new Map(MEDICATIONS.map((m) => [m.id, m.name]));
  const marks = facultyMarksFor(c.id, encounter.arrivedAt).map((m) => ({
    examiner: m.examiner, comment: m.comment, scores: { ...m.scores },
  }));
  return {
    caseId: c.id,
    caseName: c.name,
    specialty: (specialty && CLINIC_LABELS[specialty as ClinicId]) || String(specialty ?? ''),
    patientName: c.name,
    diagnosis: POLYCLINIC_DIAGNOSIS_LABELS[dxId] ?? dxId.replace(/-/g, ' '),
    skills: skillsPerformed(encounter),
    tests: encounter.orderedTestIds.map((id) => testName.get(id) ?? id),
    prescriptions: (encounter.prescriptions ?? []).map((r) => `${medName.get(r.medicationId) ?? r.medicationId} ${r.dose}`.trim()),
    ...(typeof score === 'number' ? { score } : {}),
    student: profile?.name ?? '',
    university: profile?.university ?? '',
    ...(marks.length ? { facultyMarks: marks } : {}),
  };
}

// ── result store: one logbook link per encounter, observable by the debrief ──

const links = new Map<string, string>();
const posted = new Set<string>();
const listeners = new Set<() => void>();

const keyOf = (caseId: string, arrivedAt: number) => `${caseId}:${arrivedAt}`;

export function logbookLinkFor(caseId: string, arrivedAt: number): string | undefined {
  return links.get(keyOf(caseId, arrivedAt));
}

export function subscribeLogbook(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Post the logbook row once per encounter. Never throws. */
export async function logEncounterOnce(encounter: ActivePatient, specialty: ClinicId | string | undefined, score?: number): Promise<void> {
  const key = keyOf(encounter.case.id, encounter.arrivedAt);
  if (posted.has(key)) return;
  posted.add(key);
  try {
    const r = await fetch('/agent/logbook', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(buildLogbookPayload(encounter, specialty, score)),
    });
    if (!r.ok) return;
    const data = (await r.json()) as { ok?: boolean; sheetUrl?: string };
    if (data.ok && typeof data.sheetUrl === 'string' && /^https:\/\//.test(data.sheetUrl)) {
      links.set(key, data.sheetUrl);
      for (const l of listeners) l();
    }
  } catch {
    // Offline or not configured: the debrief is unaffected.
  }
}
