/**
 * Triage drill engine. Pure and deterministic: given a seed it builds the same
 * shift every time, vitals are a function of time, and scoring is a function of
 * the assignments. No React, no timers, no network (unit tested).
 */

import {
  ACTIONS,
  TRIAGE_CASES,
  type ActionId,
  type EsiLevel,
  type TriageCase,
  type TriageVitals,
} from './cases.ts';

export const SHIFT_PATIENTS = 5;
/** Hard cap on the shift in seconds; the shift also ends once every patient is triaged. */
export const SHIFT_CAP_S = 300;

// ── seeded random ───────────────────────────────────────────────

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Stateless hash noise in [-1, 1]. */
function noise(...parts: number[]): number {
  let h = 2166136261;
  for (const p of parts) {
    h ^= p | 0;
    h = Math.imul(h, 16777619);
  }
  return mulberry32(h)() * 2 - 1;
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── shift construction ──────────────────────────────────────────

export interface ShiftPatient {
  /** 1-based bed number, in arrival order. */
  bed: number;
  caseId: string;
  /** Absolute shift time (s) the patient arrives. */
  arrivalS: number;
  /** Seconds between vitals refreshes (10 to 15). */
  sampleS: number;
}

export const caseById = (id: string): TriageCase => {
  const c = TRIAGE_CASES.find((x) => x.id === id);
  if (!c) throw new Error(`Unknown triage case ${id}`);
  return c;
};

const ARRIVAL_BASE = [4, 40, 82, 124, 166];

/** Five patients over about three minutes with a guaranteed mix of acuity. */
export function buildShift(seed: number): ShiftPatient[] {
  const rnd = mulberry32(seed * 7919 + 13);
  const pool = (levels: EsiLevel[]) => TRIAGE_CASES.filter((c) => levels.includes(c.esi));
  const picked: TriageCase[] = [];
  const take = (levels: EsiLevel[]) => {
    const options = pool(levels).filter((c) => !picked.includes(c));
    picked.push(shuffle(options, rnd)[0]);
  };
  take([1]);
  take([2]);
  take([3, 4]);
  take([4, 5]);
  take([1, 2, 3, 4, 5]);
  const order = shuffle(picked, rnd);
  return order.map((c, i) => ({
    bed: i + 1,
    caseId: c.id,
    arrivalS: Math.max(2, ARRIVAL_BASE[i] + Math.round((rnd() * 2 - 1) * 6)),
    sampleS: 10 + Math.floor(rnd() * 6),
  }));
}

// ── vitals ──────────────────────────────────────────────────────

export interface Assignment {
  level: EsiLevel;
  action: ActionId;
  /** Absolute shift time (s) the student committed. */
  atS: number;
}

/** True when this assignment gets the patient into a higher-acuity pathway and stops the decline. */
export function isEscalation(a: Assignment | undefined): boolean {
  return !!a && a.level <= 2 && ACTIONS[a.action].escalates;
}

export function escalatedRel(p: ShiftPatient, a: Assignment | undefined): number | null {
  return a && isEscalation(a) ? Math.max(0, a.atS - p.arrivalS) : null;
}

const clamp = (x: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, x));

/** Seconds into the visit at which the displayed vitals were last sampled. */
export function sampleTime(tRel: number, sampleS: number): number {
  return Math.floor(Math.max(0, tRel) / sampleS) * sampleS;
}

/** Underlying (noise-free) vitals at `tRel` seconds after arrival. */
export function trueVitals(c: TriageCase, tRel: number, escRel: number | null): TriageVitals {
  const out = { ...c.vitals };
  const d = c.det;
  if (!d) return out;
  const t = escRel === null ? tRel : Math.min(tRel, escRel);
  const p = clamp((t - d.onsetS) / d.durationS, 0, 1);
  for (const k of Object.keys(d.delta) as Array<keyof TriageVitals>) {
    out[k] = c.vitals[k] + (d.delta[k] ?? 0) * p;
  }
  return out;
}

/** Vitals as shown on the card at `tRel`: quantised to the sample time with deterministic jitter. */
export function vitalsAt(
  c: TriageCase,
  p: ShiftPatient,
  tRel: number,
  escRel: number | null,
  seed: number,
): TriageVitals {
  const ts = sampleTime(tRel, p.sampleS);
  const base = trueVitals(c, ts, escRel);
  const n = (key: number) => noise(seed, p.bed, Math.floor(ts / p.sampleS), key);
  return {
    hr: Math.round(clamp(base.hr + n(1) * 2, 20, 220)),
    sbp: Math.round(clamp(base.sbp + n(2) * 3, 40, 260)),
    dbp: Math.round(clamp(base.dbp + n(3) * 2, 20, 160)),
    rr: Math.round(clamp(base.rr + n(4) * 1, 4, 60)),
    spo2: Math.round(clamp(base.spo2 + n(5) * 1, 50, 100)),
    temp: Math.round(clamp(base.temp + n(6) * 0.1, 33, 43) * 10) / 10,
    gcs: Math.round(clamp(base.gcs, 3, 15)),
  };
}

/** Events that have already fired by `tRel` and were not prevented by escalation. */
export function firedEvents(c: TriageCase, tRel: number, escRel: number | null): string[] {
  const d = c.det;
  if (!d) return [];
  return d.events.filter((e) => e.atS <= tRel && (escRel === null || e.atS < escRel)).map((e) => e.text);
}

// ── scoring ─────────────────────────────────────────────────────

export interface PatientResult {
  bed: number;
  caseId: string;
  assigned: Assignment | null;
  timeToTriageS: number | null;
  missedEvents: string[];
  levelPts: number;
  actionPts: number;
  speedPts: number;
  penalty: number;
  total: number;
  dangerousUndertriage: boolean;
  feedback: string[];
}

export function levelPoints(correct: EsiLevel, given: EsiLevel | null): number {
  if (given === null) return 0;
  const diff = given - correct; // positive = under-triaged (less urgent than needed)
  if (diff === 0) return 55;
  if (diff === -1) return 35;
  if (diff < -1) return 15;
  if (diff === 1) return 20;
  return 0;
}

export function actionPoints(c: TriageCase, given: ActionId | null): number {
  if (given === null) return 0;
  if (given === c.action) return 25;
  return c.alsoOk.includes(given) ? 12 : 0;
}

/** Speed points: critical patients must be triaged within 30 s, others within 60 s. */
export function speedPoints(correct: EsiLevel, timeS: number | null): number {
  if (timeS === null) return 0;
  const fast = correct <= 2 ? 30 : 60;
  const slow = correct <= 2 ? 90 : 180;
  if (timeS <= fast) return 20;
  if (timeS >= slow) return 0;
  return Math.round((20 * (slow - timeS)) / (slow - fast));
}

export const MISSED_EVENT_PENALTY = 10;

export function scorePatient(p: ShiftPatient, a: Assignment | undefined, endS: number): PatientResult {
  const c = caseById(p.caseId);
  const esc = escalatedRel(p, a);
  const horizon = Math.max(0, endS - p.arrivalS);
  const missedEvents = c.det
    ? c.det.events.filter((e) => e.atS <= horizon && (esc === null || e.atS < esc)).map((e) => e.text)
    : [];
  const timeToTriageS = a ? Math.max(0, a.atS - p.arrivalS) : null;
  const levelPts = levelPoints(c.esi, a?.level ?? null);
  const actionPts = actionPoints(c, a?.action ?? null);
  const speedPts = speedPoints(c.esi, timeToTriageS);
  const penalty = missedEvents.length * MISSED_EVENT_PENALTY;
  const total = Math.max(0, levelPts + actionPts + speedPts - penalty);
  const dangerousUndertriage = !!a && c.esi <= 2 && a.level >= 3;

  const feedback: string[] = [];
  if (!a) {
    feedback.push('Not triaged before the shift ended.');
  } else {
    if (a.level === c.esi) feedback.push(`Level correct: ESI ${c.esi}.`);
    else if (a.level < c.esi) feedback.push(`Over-triaged: you said ESI ${a.level}, correct is ESI ${c.esi}. Safe but it uses a resus bay.`);
    else feedback.push(`Under-triaged: you said ESI ${a.level}, correct is ESI ${c.esi}.`);
    if (a.action === c.action) feedback.push('First action correct.');
    else if (c.alsoOk.includes(a.action)) feedback.push(`Acceptable action. Best first action: ${ACTIONS[c.action].label}.`);
    else feedback.push(`Wrong first action. Best: ${ACTIONS[c.action].label}.`);
    if (c.esi <= 2) feedback.push(`Time to triage ${Math.round(timeToTriageS ?? 0)} s${(timeToTriageS ?? 0) <= 30 ? ' (on target)' : ' (target 30 s)'}.`);
  }
  if (missedEvents.length) feedback.push(`Deterioration missed: ${missedEvents.join('; ')}.`);

  return {
    bed: p.bed, caseId: p.caseId, assigned: a ?? null, timeToTriageS, missedEvents,
    levelPts, actionPts, speedPts, penalty, total, dangerousUndertriage, feedback,
  };
}

export interface ShiftSummary {
  score: number;
  grade: string;
  results: PatientResult[];
  missedEvents: number;
  dangerousUndertriage: number;
  avgCriticalTimeS: number | null;
}

export function gradeFor(score: number): string {
  if (score >= 90) return 'Charge nurse material';
  if (score >= 75) return 'Safe triage';
  if (score >= 55) return 'Needs practice';
  return 'Unsafe: review the rules below';
}

export function scoreShift(
  shift: ShiftPatient[],
  assignments: Record<number, Assignment | undefined>,
  endS: number,
): ShiftSummary {
  const results = shift.map((p) => scorePatient(p, assignments[p.bed], endS));
  const score = results.length ? Math.round(results.reduce((s, r) => s + r.total, 0) / results.length) : 0;
  const critTimes = results
    .filter((r) => caseById(r.caseId).esi <= 2 && r.timeToTriageS !== null)
    .map((r) => r.timeToTriageS as number);
  return {
    score,
    grade: gradeFor(score),
    results,
    missedEvents: results.reduce((s, r) => s + r.missedEvents.length, 0),
    dangerousUndertriage: results.filter((r) => r.dangerousUndertriage).length,
    avgCriticalTimeS: critTimes.length ? Math.round(critTimes.reduce((a, b) => a + b, 0) / critTimes.length) : null,
  };
}

/** Line the nurse speaks when a patient arrives. */
export function arrivalAnnouncement(p: ShiftPatient): string {
  const c = caseById(p.caseId);
  return `Doctor, new arrival at bed ${p.bed}: ${c.who} with ${c.complaint.charAt(0).toLowerCase()}${c.complaint.slice(1)}.`;
}
