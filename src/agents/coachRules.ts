// Pure, dependency-free rules for Nurse Asha's mistake coach. Kept apart
// from `coach.ts` (which talks to the store and the backend) so they can be
// unit-tested under plain Node.

import type { CoachAlert, NurseRun, NurseStep } from '../game/types';

type Draft = Omit<CoachAlert, 'id' | 'caseId' | 'createdAt' | 'source'>;

let seq = 0;
function localId(): string {
  seq += 1;
  return `la-${Date.now().toString(36)}-${seq}`;
}

function words(text: string, limit: number): string {
  const parts = text.replace(/\s+/g, ' ').trim().split(' ').filter(Boolean);
  return parts.length <= limit ? parts.join(' ') : `${parts.slice(0, limit).join(' ').replace(/[,;:]$/, '')}...`;
}

const medName = (step: NurseStep): string =>
  String(step.args?.medicationId ?? 'that medicine').replace(/[-_]/g, ' ');

/** "Amoxicillin clashes with a documented penicillin allergy." */
function allergyShort(med: string, reason: string): string {
  const cls = /\((\w+) class\)/i.exec(reason)?.[1];
  const Med = med.charAt(0).toUpperCase() + med.slice(1);
  return cls ? `${Med} clashes with a documented ${cls} allergy. I held it.` : `${Med}: ${reason}.`;
}

/** Teaching explanation for an allergy-class conflict. */
function allergyExplanation(med: string, reason: string): string {
  const cls = /\((\w+) class\)/i.exec(reason)?.[1];
  const what = cls
    ? `${med.charAt(0).toUpperCase() + med.slice(1)} belongs to the ${cls} class, and this patient has a documented ${cls} allergy, so I held it.`
    : `I held ${med} because ${reason}.`;
  return `${what} Even a mild reaction like a rash counts: cross-reactivity within a drug class means the next exposure can be worse, up to anaphylaxis. Always check allergies before prescribing and pick a drug from a different class.`;
}

function result(step: NurseStep): Record<string, unknown> {
  return step.result && typeof step.result === 'object' ? (step.result as Record<string, unknown>) : {};
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean) : [];
}

function fromStep(step: NurseStep, runAppliedSomething: boolean): Draft | null {
  const res = result(step);
  const med = medName(step);

  if (step.tool === 'prescribe' && !step.ok && res.refused) {
    const reason = String(res.reason ?? step.summary ?? 'a safety conflict');
    const allergy = /allerg/i.test(reason);
    return {
      severity: 'danger',
      title: allergy ? 'Allergy conflict' : 'Prescription refused',
      short: words(allergy ? allergyShort(med, reason) : `I held ${med}: ${reason}.`, 18),
      explanation: allergy
        ? allergyExplanation(med, reason)
        : `I refused ${med} because ${reason}. Every prescription has to pass an allergy and interaction check before it reaches the patient. Choose an alternative from a different class.`,
      suggestion: String(res.suggestion ?? 'Pick a safe alternative from a different drug class.'),
    };
  }

  const hard = strings(res.hardConflicts);
  if (step.tool === 'check_allergies_and_interactions' && step.ok && hard.length) {
    return {
      severity: 'danger',
      title: 'Allergy conflict',
      short: words(allergyShort(med, hard[0]), 18),
      explanation: allergyExplanation(med, hard[0]),
      suggestion: 'Pick a safe alternative from a different drug class.',
    };
  }

  const soft = strings(res.warnings).filter((w) => !/already prescribed/i.test(w));
  if ((step.tool === 'check_allergies_and_interactions' || step.tool === 'prescribe') && step.ok && soft.length) {
    return {
      severity: 'warning',
      title: 'Interaction warning',
      short: words(`${med}: ${soft[0]}.`, 18),
      explanation:
        `The interaction check on ${med} flagged: ${soft.join('; ')}. Before adding a drug, look at what the patient already takes, because combinations can add up to harm even when each drug is fine alone. Weigh the benefit, pick a safer option, or plan monitoring.`,
      suggestion: 'Review current medicines and choose a safer combination or plan monitoring.',
    };
  }

  if (!step.ok) {
    // A failed catalog lookup is normal mid-run if the nurse retried and succeeded.
    if (step.tool === 'find_in_catalog' && runAppliedSomething) return null;
    // Delivery and record-keeping (WhatsApp/email, FHIR) failing is not a clinical mistake;
    // the step itself shows the reason in the nurse feed.
    if (step.tool === 'send_to_patient' || step.tool === 'record_to_ehr') return null;
    const what = step.tool === 'find_in_catalog' ? String(step.args?.query ?? 'that order') : step.tool.replace(/_/g, ' ');
    return {
      severity: 'info',
      title: 'Order not completed',
      short: words(`I could not complete ${what}: ${step.summary}`, 18),
      explanation: `The ${step.tool.replace(/_/g, ' ')} step did not go through (${step.summary}). Nothing was applied for that part of the order. Rephrase it with the exact test or medicine name, or order it yourself from the chart.`,
      suggestion: 'Say the order again with the exact name, or order it from the chart tabs.',
    };
  }
  return null;
}

/** Immediate, LLM-free alerts from a finished nurse run: refused
 *  prescriptions, allergy or interaction warnings, and failed steps. One
 *  alert per distinct title. */
export function alertsFromNurseRun(run: NurseRun, now = Date.now()): CoachAlert[] {
  if (run.status !== 'done' || run.intent === 'none') return [];
  const applied = run.applied;
  const appliedSomething = !!applied && (applied.orderedTestIds.length > 0 || applied.prescriptions.length > 0 || !!applied.followUp);
  const out: CoachAlert[] = [];
  for (const step of run.steps ?? []) {
    const d = fromStep(step, appliedSomething);
    if (!d || out.some((a) => a.title === d.title)) continue;
    out.push({ ...d, id: localId(), caseId: run.caseId, source: 'nurse', createdAt: now });
  }
  return out;
}

const CLINICAL_TALK =
  /\b(diagnos\w*|i think (?:it'?s|this is|she has|he has|you have)|probably|likely|rule out|no need|don'?t need|send (?:you|her|him|them) home|discharge|admit|prescrib\w*|antibiotic\w*|steroid\w*|painkiller\w*|mg\b|milligram\w*|dose|tablets?|injection|x-?ray|ct\b|mri|scan|blood test|ecg|ekg|it'?s (?:just|only) (?:a|an)|nothing serious|viral|anxiety)\b/i;

/** Does a doctor utterance carry a clinical decision worth a coach check?
 *  Questions to the patient are skipped. */
export function looksClinicalUtterance(text: string): boolean {
  const t = text.trim();
  if (t.length < 12) return false;
  if (/\?\s*$/.test(t)) return false;
  return CLINICAL_TALK.test(t);
}

/** The alert whose toast is showing: the newest one not yet dismissed. */
export function activeAlert(alerts: readonly CoachAlert[]): CoachAlert | null {
  for (let i = alerts.length - 1; i >= 0; i--) {
    const a = alerts[i];
    if (!a.dismissed) return a;
  }
  return null;
}
