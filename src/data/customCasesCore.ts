// Cases created outside the static data files (the Telegram bot,
// backend/telegram_bot.py). Pure helpers shared by the browser client
// (customCases.ts) and the node tests: no DOM, no imports beyond types.
//
// The backend (backend/case_author.py) already validated every case; these
// checks only guard the merge against a malformed or hostile payload.

import type { AnamnesisQA, PatientCase, Severity, TestResult } from '../game/types';

/** What GET /agent/custom-cases returns per case. */
export interface CustomCaseWire extends Omit<PatientCase, 'source' | 'realCase'> {
  specialty: string;
  diagnosisLabels: Record<string, string>;
  source?: { title: string; url: string };
  synthetic?: boolean;
  createdVia?: string;
  createdAt?: string;
  /** Set only when the case went through a review (backend/agentroom/casereview.py). */
  reviewStatus?: string;
}

/** A custom case ready to register in the library. `patient` has no
 *  `source`, so the "Based on a published case" UI never fires for it. */
export interface CustomCase {
  patient: PatientCase;
  clinic: string;
  diagnosisLabels: Record<string, string>;
  /** e.g. "Created via Telegram by Darsh". */
  createdBy: string;
  /** What the library shows: Telegram, or that nobody has reviewed it. */
  badge: string;
  badgeTitle: string;
}

export const CUSTOM_BADGE = 'Created on Telegram';
export const UNREVIEWED_BADGE = 'Unreviewed';

/** The chip on the card. Only in_review and rejected are hidden, and those never leave the server. */
export function badgeFor(reviewStatus: unknown, createdBy: string): { badge: string; badgeTitle: string } {
  if (reviewStatus === 'unreviewed') return { badge: UNREVIEWED_BADGE, badgeTitle: `${createdBy}. Published without a doctor's review` };
  if (reviewStatus === 'approved') return { badge: CUSTOM_BADGE, badgeTitle: `${createdBy}. Reviewed and approved by a doctor` };
  return { badge: CUSTOM_BADGE, badgeTitle: createdBy };
}

const SEVERITIES: ReadonlySet<Severity> = new Set(['critical', 'urgent', 'stable']);
const isStr = (v: unknown): v is string => typeof v === 'string' && v.trim().length > 0;
const isNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);

function cleanAnamnesis(v: unknown): AnamnesisQA[] | null {
  if (!Array.isArray(v)) return null;
  const out: AnamnesisQA[] = [];
  for (const q of v) {
    if (!q || typeof q !== 'object') return null;
    const r = q as Record<string, unknown>;
    if (!isStr(r.id) || !isStr(r.question) || !isStr(r.answer) || typeof r.relevant !== 'boolean') return null;
    out.push({ id: r.id, question: r.question, answer: r.answer, relevant: r.relevant });
  }
  return out;
}

function cleanTests(v: unknown): TestResult[] | null {
  if (!Array.isArray(v)) return null;
  const out: TestResult[] = [];
  for (const t of v) {
    if (!t || typeof t !== 'object') return null;
    const r = t as Record<string, unknown>;
    if (!isStr(r.testId) || typeof r.result !== 'string' || typeof r.abnormal !== 'boolean') return null;
    out.push({ testId: r.testId, result: r.result, abnormal: r.abnormal });
  }
  return out;
}

const strList = (v: unknown): string[] | null => (Array.isArray(v) && v.every(isStr) ? (v as string[]) : null);

/** One wire case -> CustomCase, or null when anything load-bearing is off. */
export function parseCustomCase(raw: unknown, validClinics: ReadonlySet<string>): CustomCase | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  if (!isStr(r.id) || !/^tg-[a-z0-9]{3,16}$/.test(r.id)) return null;
  if (!isStr(r.specialty) || !validClinics.has(r.specialty) || r.specialty === 'all-specialties') return null;
  if (!isStr(r.name) || !isNum(r.age) || (r.gender !== 'M' && r.gender !== 'F')) return null;
  if (!SEVERITIES.has(r.severity as Severity) || !isStr(r.chiefComplaint) || !isStr(r.correctDiagnosisId)) return null;
  const v = r.vitals as Record<string, unknown> | undefined;
  if (!v || !isNum(v.hr) || !isStr(v.bp) || !isNum(v.spo2) || !isNum(v.temp) || !isNum(v.rr)) return null;
  const anamnesis = cleanAnamnesis(r.anamnesis);
  const testResults = cleanTests(r.testResults);
  const diagnosisOptions = strList(r.diagnosisOptions);
  const acceptable = strList(r.acceptableTreatmentIds);
  const critical = strList(r.criticalTreatmentIds);
  if (!anamnesis || !testResults || !diagnosisOptions || !acceptable || !critical) return null;
  if (!diagnosisOptions.includes(r.correctDiagnosisId)) return null;
  const labels: Record<string, string> = {};
  const rawLabels = (r.diagnosisLabels ?? {}) as Record<string, unknown>;
  for (const id of diagnosisOptions) labels[id] = isStr(rawLabels[id]) ? rawLabels[id] : id.replace(/-/g, ' ');
  const src = r.source as Record<string, unknown> | undefined;
  const createdBy = src && isStr(src.title) ? src.title : CUSTOM_BADGE;
  return {
    patient: {
      id: r.id,
      name: r.name,
      age: r.age,
      gender: r.gender,
      severity: r.severity as Severity,
      arrivalBlurb: isStr(r.arrivalBlurb) ? r.arrivalBlurb : r.chiefComplaint,
      chiefComplaint: r.chiefComplaint,
      vitals: { hr: v.hr, bp: v.bp, spo2: v.spo2, temp: v.temp, rr: v.rr },
      anamnesis,
      testResults,
      correctDiagnosisId: r.correctDiagnosisId,
      acceptableTreatmentIds: acceptable,
      criticalTreatmentIds: critical,
      diagnosisOptions,
    },
    clinic: r.specialty,
    diagnosisLabels: labels,
    createdBy,
    ...badgeFor(r.reviewStatus, createdBy),
  };
}

/** Valid incoming cases whose ids are not known yet (deduped, server order kept). */
export function mergeCustomCases(
  incoming: unknown,
  knownIds: ReadonlySet<string>,
  validClinics: ReadonlySet<string>,
): CustomCase[] {
  if (!Array.isArray(incoming)) return [];
  const seen = new Set(knownIds);
  const out: CustomCase[] = [];
  for (const raw of incoming) {
    const c = parseCustomCase(raw, validClinics);
    if (!c || seen.has(c.patient.id)) continue;
    seen.add(c.patient.id);
    out.push(c);
  }
  return out;
}

/** What changed among the cases already in the library: gone from the server (deleted, or
 *  rejected after all), or with another badge. An answer we do not understand changes nothing. */
export function reconcileCustomCases(
  incoming: unknown,
  shown: ReadonlyMap<string, string>,
  validClinics: ReadonlySet<string>,
): { removed: string[]; changed: CustomCase[] } {
  if (!Array.isArray(incoming)) return { removed: [], changed: [] };
  const now = new Map<string, CustomCase>();
  const ids = new Set<string>();
  for (const raw of incoming) {
    const id = (raw as { id?: unknown } | null)?.id;
    if (typeof id === 'string') ids.add(id);
    const c = parseCustomCase(raw, validClinics);
    if (c) now.set(c.patient.id, c);
  }
  return {
    removed: [...shown.keys()].filter((id) => !ids.has(id)),
    changed: [...shown].flatMap(([id, badge]) => {
      const c = now.get(id);
      return c && c.badge !== badge ? [c] : [];
    }),
  };
}

/** `?case=<id>` deep link (the Telegram bot's "open this patient" link). */
export function caseIdFromSearch(search: string): string | null {
  const id = new URLSearchParams(search).get('case')?.trim() ?? '';
  return /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null;
}
