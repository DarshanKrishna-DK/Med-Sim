// Operation theatre drill engine. Pure and deterministic: every function takes
// the state and returns a new one; time only moves through `tick(state, dt)`,
// so the same seed and inputs always give the same run (unit-tested in
// scripts/test/ot-engine.test.ts). The React screen owns the clock.
//
// With a theatre room connected (`room`), packed cells wait for the laboratory
// and sign-in waits for the pharmacist. What they answer is fed in as an event
// (`theatreEvent`); what has to be asked comes out in `outbox`. Every wait has
// its own fallback on the sim clock, so a drill never stalls.

import {
  DRUGS,
  FLUID_LABEL,
  PROBLEMS,
  SPEAKER_SHORT,
  STATION_OF,
  scenarioById,
  type ChecklistItem,
  type ChecklistStage,
  type CauteryMode,
  type DrugId,
  type ExpectSpec,
  type FluidId,
  type OTAction,
  type OTEventDef,
  type OTScenario,
  type ProblemId,
  type Speaker,
  type StationId,
  type Vitals,
} from './scenarios.ts';

// ───────── types ─────────

export type Stage = 'sign-in' | 'induction' | 'time-out' | 'pre-incision' | 'operating' | 'sign-out' | 'done';
export type EventStatus = 'pending' | 'onset' | 'active' | 'resolved' | 'missed' | 'prevented';
export type Outcome = 'correct' | 'partial' | 'missed' | 'prevented';
export type Verdict = 'correct' | 'partial' | 'wrong' | 'irrelevant';
export type Tone = 'call' | 'ack' | 'info' | 'warn' | 'bad' | 'good';

export interface EventRun {
  id: string;
  problem: ProblemId;
  status: EventStatus;
  /** Absolute sim seconds (null until scheduled). */
  onsetAt: number | null;
  callAt: number | null;
  resolvedAt: number | null;
  outcome: Outcome | null;
  atStation: boolean;
  reminded: boolean;
  attempts: Array<{ t: number; text: string; verdict: Verdict }>;
  /** When the student acted, if the effect had to wait for somebody (blood): what the response time counts from. */
  actedAt?: number;
  /** Vitals offset frozen at the moment of resolution (decays afterwards). */
  frozen: Partial<Record<keyof Vitals, number>> | null;
}

export interface LogLine {
  id: number;
  t: number;
  /** 'leela': Theatre Sister Leela, for the room. She speaks for herself, so these lines are only shown. */
  who: Speaker | 'you' | 'system' | 'leela';
  text: string;
  tone: Tone;
}

export type SafetyCode =
  | 'tenfold'
  | 'no-allergy-check'
  | 'no-indication'
  | 'false-checklist'
  | 'incision-no-abx'
  | 'monitor-not-patient'
  | 'repeat-dose';

export interface SafetyError {
  code: SafetyCode;
  text: string;
  t: number;
}

export interface Equipment {
  ivFluid: FluidId;
  ivRate: number;
  ivRunning: boolean;
  bolusMl: number;
  infusedMl: number;
  suctionOn: boolean;
  suctionPressure: number;
  cauteryOn: boolean;
  cauteryMode: CauteryMode;
  padOk: boolean;
  warmerOn: boolean;
  warmerTemp: number;
  fio2: number;
  leadOff: boolean;
}

export interface GivenDrug {
  drug: DrugId;
  dose: number;
  t: number;
  inRange: boolean;
}

export interface Transient {
  t: number;
  d: Partial<Record<'hr' | 'sbp' | 'dbp', number>>;
}

export type BloodStatus = 'waiting' | 'sample' | 'matching' | 'released' | 'refused' | 'unconfirmed' | 'emergency';

export interface BloodRequest {
  n: number;
  action: Extract<OTAction, { kind: 'fluid-bolus' | 'fluid-rate' }>;
  station: StationId | null;
  askedAt: number;
  /** The current wait started here (a sample request starts a new one). */
  waitFrom: number;
  status: BloodStatus;
  group: string;
  units: string[];
  note: string;
}

/** How blood really went up: told in the report, never part of the marks. */
export interface BloodNote {
  how: 'crossmatched' | 'unconfirmed' | 'emergency' | 'refused';
  t: number;
  text: string;
}

export type RxStatus = 'none' | 'waiting' | 'release' | 'hold' | 'clarify' | 'unconfirmed';

/** Something the theatre room has to be asked. The screen posts each one once. */
export interface OutItem {
  id: number;
  kind: 'blood' | 'sample' | 'unconfirmed' | 'allergy' | 'help';
  n?: number;
  units?: number;
  emergency?: boolean;
  sbar?: string;
}

/** What came back from the theatre room. */
export type TheatreEvent =
  | { kind: 'blood'; n: number; status: 'sample' | 'matching' | 'released' | 'refused' | 'recorded'; group?: string; units?: string[]; text?: string }
  | { kind: 'rx'; verdict: 'release' | 'hold' | 'clarify' | 'no_reply'; text?: string }
  | { kind: 'help'; status: 'called' | 'unreachable' | 'replied'; name?: string; text?: string };

export interface OTState {
  scenarioId: string;
  seed: number;
  t: number;
  stage: Stage;
  stageAt: number;
  incisionAt: number | null;
  checklistIdx: number;
  checklist: Record<string, { answer: string; ok: boolean; t: number }>;
  equipment: Equipment;
  events: EventRun[];
  drugs: GivenDrug[];
  transients: Transient[];
  safety: SafetyError[];
  log: LogLine[];
  nextLogId: number;
  allergyChecked: boolean;
  /** A theatre room (BAND) is connected. Off: everything below stays unused. */
  room: boolean;
  blood: BloodRequest | null;
  bloodNotes: BloodNote[];
  rx: { status: RxStatus; askedAt: number; text: string };
  help: { status: 'calling' | 'called' | 'unreachable' | 'replied'; askedAt: number; name: string; text: string } | null;
  outbox: OutItem[];
  nextOutId: number;
}

export interface ActContext {
  /** Station the student was at when acting (null = from anywhere by voice). */
  station: StationId | null;
}

export interface Feedback {
  tone: Tone;
  text: string;
}

// ───────── constants ─────────

/** Seconds the vitals start drifting before the call-out. */
export const LEAD_S = 6;
/** Pause between the end of sign-in and the time-out (induction). */
export const INDUCTION_S = 4;
/** Packed cells go up without confirmation when the lab has not answered by then. */
export const BLOOD_WAIT_S = 12;
/** Sign-in goes on without the pharmacist's word after this long. */
export const RX_WAIT_S = 12;
const HELP_AGAIN_S = 20;
const RECOVER_TAU = 7;
const TEMP_TAU = 30;
const TRANSIENT_TAU = 45;

export const ABX_EVENT_ID = 'abx';

// ───────── helpers ─────────

function mulberry32(a: number) {
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function hashStr(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const clone = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;
const round1 = (v: number) => Math.round(v * 10) / 10;

export function scenarioOf(s: OTState): OTScenario {
  return scenarioById(s.scenarioId);
}

function abxDef(sc: OTScenario): OTEventDef {
  return {
    id: ABX_EVENT_ID,
    problem: 'antibiotic',
    atS: 0,
    speaker: 'surgeon',
    line: sc.antibioticLine,
    remind: 'Antibiotic, please. I am waiting to cut.',
    ack: 'Thank you. Knife, please.',
    deadlineS: 45,
  };
}

export function eventDef(s: OTState, id: string): OTEventDef {
  const sc = scenarioOf(s);
  if (id === ABX_EVENT_ID) return abxDef(sc);
  return sc.events.find((e) => e.id === id)!;
}

export function checklistItems(sc: OTScenario, stage?: ChecklistStage): ChecklistItem[] {
  return stage ? sc.checklist.filter((c) => c.stage === stage) : sc.checklist;
}

/** The checklist prompt waiting for an answer, if any. */
export function currentChecklistItem(s: OTState): ChecklistItem | null {
  const stage = s.stage === 'sign-in' || s.stage === 'time-out' || s.stage === 'sign-out' ? s.stage : null;
  if (!stage) return null;
  return checklistItems(scenarioOf(s), stage)[s.checklistIdx] ?? null;
}

function say(s: OTState, who: LogLine['who'], text: string, tone: Tone) {
  s.log.push({ id: s.nextLogId++, t: round1(s.t), who, text, tone });
  if (s.log.length > 80) s.log.splice(0, s.log.length - 80);
}

function addSafety(s: OTState, code: SafetyCode, text: string) {
  if (code !== 'tenfold' && s.safety.some((x) => x.code === code)) return;
  s.safety.push({ code, text, t: round1(s.t) });
  say(s, 'system', `Safety: ${text}`, 'bad');
}

/** True if the patient's allergy status has been confirmed (band read, or
 *  the sign-in allergy question answered correctly). */
export function allergyConfirmed(s: OTState): boolean {
  return s.allergyChecked || !!s.checklist.allergy?.ok;
}

export function antibioticGiven(s: OTState): boolean {
  return s.drugs.some((d) => d.drug === 'cefazolin' && d.inRange && s.t - d.t <= 3600);
}

// ───────── creation ─────────

export function createOT(scenarioId: string, seed = 1, opts: { room?: boolean } = {}): OTState {
  const sc = scenarioById(scenarioId);
  const hasMaint = sc.events.some((e) => e.problem === 'maintenance');
  const s: OTState = {
    scenarioId: sc.id,
    seed,
    t: 0,
    stage: 'sign-in',
    stageAt: 0,
    incisionAt: null,
    checklistIdx: 0,
    checklist: {},
    equipment: {
      ivFluid: 'RL',
      ivRate: hasMaint ? 0 : 100,
      ivRunning: !hasMaint,
      bolusMl: 0,
      infusedMl: 0,
      suctionOn: false,
      suctionPressure: 0,
      cauteryOn: true,
      cauteryMode: 'coag',
      padOk: true,
      warmerOn: false,
      warmerTemp: 32,
      fio2: sc.fio2,
      leadOff: false,
    },
    events: sc.events.map((e) => ({
      id: e.id,
      problem: e.problem,
      status: 'pending',
      onsetAt: null,
      callAt: null,
      resolvedAt: null,
      outcome: null,
      atStation: false,
      reminded: false,
      attempts: [],
      frozen: null,
    })),
    drugs: [],
    transients: [],
    safety: [],
    log: [],
    nextLogId: 1,
    allergyChecked: false,
    room: !!opts.room,
    blood: null,
    bloodNotes: [],
    rx: { status: 'none', askedAt: 0, text: '' },
    help: null,
    outbox: [],
    nextOutId: 1,
  };
  say(s, 'nurse', `${sc.patient.name} is on the table. ${sc.patient.procedure}.`, 'info');
  const first = checklistItems(sc, 'sign-in')[0];
  say(s, first.speaker, first.ask, 'call');
  return s;
}

// ───────── vitals ─────────

function offsetsOf(s: OTState, ev: EventRun): Partial<Record<keyof Vitals, number>> {
  const def = eventDef(s, ev.id);
  const out: Partial<Record<keyof Vitals, number>> = {};
  if (!def.onset || ev.onsetAt === null || ev.callAt === null || ev.status === 'prevented') return out;
  const base = scenarioOf(s).baseline;
  const keys = Object.keys(def.onset) as Array<keyof Vitals>;
  const endT = ev.resolvedAt ?? s.t;
  const num = (x: number | null | undefined, fb: number) => (typeof x === 'number' ? x : fb);
  for (const k of keys) {
    const b = num(base[k], 0);
    const on = num(def.onset[k], b) - b;
    const worst = num(def.worst?.[k], b + on) - b;
    let v: number;
    if (endT < ev.callAt) {
      const span = Math.max(0.1, ev.callAt - ev.onsetAt);
      v = on * clamp((endT - ev.onsetAt) / span, 0, 1);
    } else {
      v = on + (worst - on) * clamp((endT - ev.callAt) / def.deadlineS, 0, 1);
    }
    if (ev.resolvedAt !== null) {
      const tau = k === 'temp' ? TEMP_TAU : RECOVER_TAU;
      v *= Math.exp(-(s.t - ev.resolvedAt) / tau);
    }
    out[k] = v;
  }
  return out;
}

/** True vitals now (what a hand on the pulse would find). */
export function vitalsAt(s: OTState): Vitals {
  const sc = scenarioOf(s);
  const b = sc.baseline;
  const v = { hr: b.hr, sbp: b.sbp, dbp: b.dbp, spo2: b.spo2, etco2: b.etco2 ?? 0, temp: b.temp };
  for (const ev of s.events) {
    const o = offsetsOf(s, ev);
    for (const k of Object.keys(o) as Array<keyof Vitals>) (v as Record<string, number>)[k] += o[k] ?? 0;
  }
  for (const tr of s.transients) {
    const dt = s.t - tr.t;
    if (dt < 0) continue;
    const shape = (1 - Math.exp(-dt / 4)) * Math.exp(-dt / TRANSIENT_TAU);
    v.hr += (tr.d.hr ?? 0) * shape;
    v.sbp += (tr.d.sbp ?? 0) * shape;
    v.dbp += (tr.d.dbp ?? 0) * shape;
  }
  // Small seeded jitter so the monitor looks alive (2 s buckets, deterministic).
  const r = mulberry32((s.seed * 7919 + Math.floor(s.t / 2)) >>> 0);
  v.hr += Math.round((r() - 0.5) * 2.4);
  v.sbp += Math.round((r() - 0.5) * 3);
  v.dbp += Math.round((r() - 0.5) * 2);
  return {
    hr: Math.round(clamp(v.hr, 20, 220)),
    sbp: Math.round(clamp(v.sbp, 40, 260)),
    dbp: Math.round(clamp(v.dbp, 20, 160)),
    spo2: Math.round(clamp(v.spo2, 50, 100)),
    etco2: b.etco2 === null ? null : Math.round(clamp(v.etco2, 10, 80)),
    temp: round1(clamp(v.temp, 30, 42)),
  };
}

export type AlarmLevel = 'ok' | 'warn' | 'crit';

export function alarmOf(v: Vitals, leadOff: boolean): { level: AlarmLevel; reasons: string[] } {
  const reasons: string[] = [];
  let level: AlarmLevel = 'ok';
  const bump = (l: AlarmLevel, why: string) => {
    reasons.push(why);
    if (l === 'crit' || level === 'ok') level = l;
  };
  if (leadOff) bump('crit', 'ECG: check leads');
  if (v.sbp < 90) bump('crit', `Low BP ${v.sbp}/${v.dbp}`);
  else if (v.sbp < 100) bump('warn', `BP ${v.sbp}/${v.dbp}`);
  if (v.sbp > 170) bump('crit', `High BP ${v.sbp}/${v.dbp}`);
  if (!leadOff && v.hr < 50) bump('crit', `Brady ${v.hr}`);
  else if (!leadOff && v.hr > 120) bump('crit', `Tachy ${v.hr}`);
  else if (!leadOff && v.hr > 110) bump('warn', `HR ${v.hr}`);
  if (v.spo2 < 92) bump('crit', `SpO2 ${v.spo2}`);
  else if (v.spo2 < 95) bump('warn', `SpO2 ${v.spo2}`);
  if (v.temp < 36) bump('warn', `Temp ${v.temp}`);
  return { level, reasons };
}

// ───────── judging ─────────

function inRange(v: number, r: [number, number]) {
  return v >= r[0] - 1e-9 && v <= r[1] + 1e-9;
}

function specMatches(spec: ExpectSpec, a: OTAction, eq: Equipment): boolean {
  switch (spec.kind) {
    case 'drug':
      return a.kind === 'drug' && a.drug === spec.drug;
    case 'fluid-bolus':
      return a.kind === 'fluid-bolus' && spec.fluids.includes(a.fluid) && inRange(a.volumeMl, spec.range);
    case 'fluid-rate':
      return a.kind === 'fluid-rate' && spec.fluids.includes(a.fluid) && inRange(a.rateMlH, spec.range);
    case 'suction':
      return a.kind === 'suction' && a.on && inRange(a.pressure ?? eq.suctionPressure, spec.range);
    case 'cautery':
      return a.kind === 'cautery' && a.on && (a.mode ?? eq.cauteryMode) === spec.mode && eq.padOk;
    case 'warmer':
      return a.kind === 'warmer' && a.on && (a.tempC ?? eq.warmerTemp) >= spec.minTemp;
    case 'oxygen':
      return a.kind === 'oxygen' && a.fio2 >= spec.minFio2;
    case 'pulse-check':
      return a.kind === 'pulse-check';
  }
}

/** Does the current equipment / drug chart already satisfy the problem? */
function alreadySatisfied(s: OTState, problem: ProblemId): boolean {
  const eq = s.equipment;
  const p = PROBLEMS[problem];
  return p.accept.some((spec) => {
    switch (spec.kind) {
      case 'drug':
        return s.drugs.some((d) => d.drug === spec.drug && d.inRange);
      case 'fluid-rate':
        return eq.ivRunning && spec.fluids.includes(eq.ivFluid) && inRange(eq.ivRate, spec.range);
      case 'suction':
        return eq.suctionOn && inRange(eq.suctionPressure, spec.range);
      case 'warmer':
        return eq.warmerOn && eq.warmerTemp >= spec.minTemp;
      default:
        return false;
    }
  });
}

interface Judged {
  verdict: Verdict;
  note: string;
}

function doseNote(drug: DrugId, dose: number): { ok: boolean; close: boolean; tenfold: boolean; text: string } {
  const info = DRUGS[drug];
  const [lo, hi] = info.range;
  const ok = inRange(dose, [lo, hi]);
  const tenfold = dose >= hi * 5;
  const close = !ok && !tenfold && dose >= lo * 0.5 && dose <= hi * 2;
  const usual = `${fmtDose(drug, info.ideal)}${lo !== hi ? ` (${fmtNum(lo)} to ${fmtNum(hi)} ${info.unit})` : ''}`;
  let text = '';
  if (tenfold) text = `${fmtDose(drug, dose)} is a tenfold overdose. The usual dose is ${usual}.`;
  else if (!ok) text = `The usual dose is ${usual}, not ${fmtDose(drug, dose)}.`;
  if (drug === 'atropine' && dose < 0.5) text += ' Under 0.5 mg atropine can paradoxically slow the heart.';
  return { ok, close, tenfold, text: text.trim() };
}

function judge(s: OTState, ev: EventRun, a: OTAction): Judged {
  const p = PROBLEMS[ev.problem];
  const eq = s.equipment;
  if (a.kind === 'drug') {
    const accepts = p.accept.some((sp) => specMatches(sp, a, eq));
    const partial = (p.partial ?? []).some((sp) => specMatches(sp, a, eq));
    if (accepts || partial) {
      const d = doseNote(a.drug, a.dose);
      if (d.ok) return accepts ? { verdict: 'correct', note: '' } : { verdict: 'partial', note: partialNote(ev.problem, a) };
      if (d.close && !(a.drug === 'atropine' && a.dose < 0.5)) return { verdict: 'partial', note: d.text };
      return { verdict: 'wrong', note: d.text };
    }
    if (ev.problem === 'lead-off') {
      return { verdict: 'wrong', note: 'You treated the monitor. Check the patient first: feel for a pulse.' };
    }
    return { verdict: 'wrong', note: `${DRUGS[a.drug].label} does not treat ${p.label.toLowerCase()}. ${DRUGS[a.drug].label} is a ${DRUGS[a.drug].what}.` };
  }
  if (p.accept.some((sp) => specMatches(sp, a, eq))) return { verdict: 'correct', note: '' };
  if ((p.partial ?? []).some((sp) => specMatches(sp, a, eq))) return { verdict: 'partial', note: partialNote(ev.problem, a) };
  // Same kind of action as the fix, but the wrong setting.
  const sameKind = [...p.accept, ...(p.partial ?? [])].some((sp) => sp.kind === a.kind);
  if (sameKind) return { verdict: 'wrong', note: wrongSettingNote(ev.problem, a, eq) };
  if (ev.problem === 'cautery-fail' && a.kind === 'cautery') return { verdict: 'wrong', note: wrongSettingNote(ev.problem, a, eq) };
  return { verdict: 'irrelevant', note: '' };
}

function partialNote(problem: ProblemId, a: OTAction): string {
  switch (problem) {
    case 'maintenance':
      return a.kind === 'fluid-rate' ? `${a.rateMlH} mL/h works, but maintenance for this weight is about 100 mL/h.` : '';
    case 'hypotension':
    case 'fluid-loss':
      if (a.kind === 'fluid-bolus' && a.fluid === 'blood') return 'Blood needs a measured loss or Hb and a cross-match. Start with crystalloid.';
      return a.kind === 'fluid-bolus' ? `A ${a.volumeMl} mL bolus helps, but give 250 to 500 mL and reassess.` : '';
    case 'bradycardia':
      return 'Ephedrine lifts the rate a little, but vagal bradycardia needs atropine 0.6 mg.';
    case 'hypoxia':
      return a.kind === 'oxygen' ? `FiO2 ${a.fio2}% helps, but desaturation gets 100% first.` : '';
    case 'hypothermia':
      return a.kind === 'warmer' ? `${a.tempC} C barely rewarms. Start at maximum (43 C) and titrate down.` : '';
    case 'bleeding-field':
      return a.kind === 'suction' ? `${a.pressure} mmHg works, but the usual field setting is 100 to 200 mmHg.` : '';
    default:
      return '';
  }
}

function wrongSettingNote(problem: ProblemId, a: OTAction, eq: Equipment): string {
  switch (a.kind) {
    case 'suction':
      if (!a.on) return 'Suction is off. The surgeon needs it on.';
      return `${a.pressure ?? eq.suctionPressure} mmHg is ${(a.pressure ?? eq.suctionPressure) > 200 ? 'too high: it injures tissue and drains the canister' : 'too weak to clear the field'}. Use 100 to 200 mmHg.`;
    case 'cautery':
      if (!eq.padOk) return 'Still not working. Turning it up is dangerous: check the return electrode (patient plate) first.';
      if (!a.on) return 'The diathermy is off.';
      return `${a.mode ?? eq.cauteryMode} mode is not what the surgeon needs for haemostasis. Use coag.`;
    case 'warmer':
      return a.on ? 'That setting is too low to rewarm. Set the forced-air warmer to 43 C.' : 'The warmer is off. She needs active warming.';
    case 'oxygen':
      return `FiO2 ${a.fio2}% will not reverse a falling saturation. Go to 100%.`;
    case 'fluid-bolus':
      if (a.fluid === 'blood') return 'Blood needs a measured loss or Hb and a cross-match. Start with a crystalloid bolus.';
      return `${a.volumeMl} mL is not the right bolus here. Give 250 to 500 mL and reassess.`;
    case 'fluid-rate':
      if (problem === 'maintenance' && a.fluid === 'blood') return 'Blood is not a maintenance fluid. Use Ringer lactate.';
      return `${a.rateMlH} mL/h is ${a.rateMlH > 150 ? 'far too fast: fluid overload' : 'too slow'}. Maintenance is about 100 mL/h for this patient.`;
    case 'fluid-stop':
      return 'Stopping the drip makes it worse.';
    default:
      return PROBLEMS[problem].model;
  }
}

// ───────── describing actions ─────────

export function fmtNum(n: number): string {
  return Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100);
}

export function fmtDose(drug: DrugId, dose: number): string {
  return `${fmtNum(dose)} ${DRUGS[drug].unit}`;
}

export function describeAction(a: OTAction): string {
  switch (a.kind) {
    case 'fluid-bolus':
      return a.emergency ? `${a.volumeMl} mL emergency O negative running` : `${a.volumeMl} mL ${a.fluid} bolus running`;
    case 'fluid-rate':
      return `${FLUID_LABEL[a.fluid]} at ${a.rateMlH} mL/h`;
    case 'fluid-stop':
      return 'Drip stopped';
    case 'drug':
      return `Giving ${DRUGS[a.drug].label} ${fmtDose(a.drug, a.dose)} IV`;
    case 'suction':
      return a.on ? `Suction on${a.pressure !== undefined ? ` at ${a.pressure} mmHg` : ''}` : 'Suction off';
    case 'cautery':
      return a.on ? `${a.padChecked ? 'Return pad checked, d' : 'D'}iathermy on${a.mode ? `, ${a.mode}` : ''}` : 'Diathermy off';
    case 'warmer':
      return a.on ? `Warmer on${a.tempC !== undefined ? ` at ${a.tempC} C` : ''}` : 'Warmer off';
    case 'oxygen':
      return `FiO2 ${a.fio2}%`;
    case 'pulse-check':
      return 'Checking the pulse';
    case 'cap-refill':
      return 'Checking capillary refill';
    case 'allergy-check':
      return 'Reading the ID and allergy band';
    case 'send-sample':
      return 'Sending the labelled cross-match sample';
    case 'call-help':
      return 'Calling for help';
  }
}

// ───────── actions ─────────

function applyEquipment(s: OTState, a: OTAction): string | null {
  const eq = s.equipment;
  const v = vitalsAt(s);
  const sc = scenarioOf(s);
  switch (a.kind) {
    case 'fluid-bolus':
      eq.ivFluid = a.fluid;
      eq.bolusMl += Math.max(0, a.volumeMl);
      return null;
    case 'fluid-rate':
      eq.ivFluid = a.fluid;
      eq.ivRate = Math.max(0, a.rateMlH);
      eq.ivRunning = eq.ivRate > 0;
      return null;
    case 'fluid-stop':
      eq.ivRunning = false;
      eq.bolusMl = 0;
      return null;
    case 'suction':
      eq.suctionOn = a.on;
      if (a.pressure !== undefined) eq.suctionPressure = clamp(a.pressure, 0, 600);
      else if (a.on && eq.suctionPressure === 0) eq.suctionPressure = 150;
      return null;
    case 'cautery':
      if (a.padChecked && !eq.padOk) {
        eq.padOk = true;
        say(s, 'you', 'The return pad had peeled off the thigh. Re-applied it, good contact.', 'info');
      }
      eq.cauteryOn = a.on;
      if (a.mode) eq.cauteryMode = a.mode;
      return null;
    case 'warmer':
      eq.warmerOn = a.on;
      if (a.tempC !== undefined) eq.warmerTemp = a.tempC;
      return null;
    case 'oxygen':
      eq.fio2 = clamp(Math.round(a.fio2), 21, 100);
      return null;
    case 'pulse-check':
      return `Radial pulse ${v.hr}, ${v.hr < 50 ? 'slow' : v.hr > 110 ? 'fast and thready' : 'regular, good volume'}. The patient is ${v.sbp < 90 ? 'pale and clammy' : 'pink and warm'}.`;
    case 'cap-refill':
      return `Capillary refill ${v.sbp < 90 || v.hr > 115 ? '3 to 4 seconds: poorly perfused' : 'under 2 seconds'}.`;
    case 'allergy-check':
      s.allergyChecked = true;
      return `Wrist band: ${sc.patient.name}, ${sc.patient.age}${sc.patient.sex}. Allergy: ${sc.patient.allergy}.`;
    case 'drug':
    case 'send-sample':
    case 'call-help':
      return null;
  }
}

function resolve(s: OTState, ev: EventRun, outcome: Outcome, ctx: ActContext | null) {
  ev.frozen = offsetsOf(s, ev);
  ev.status = outcome === 'missed' ? 'missed' : outcome === 'prevented' ? 'prevented' : 'resolved';
  ev.outcome = outcome;
  ev.resolvedAt = s.t;
  ev.atStation = !!ctx && ctx.station === PROBLEMS[ev.problem].station;
  if (ev.problem === 'lead-off') s.equipment.leadOff = false;
  if (ev.problem === 'cautery-fail') s.equipment.padOk = true;
}

/** Student action from a station panel or a voice / typed command. */
export function act(state: OTState, action: OTAction, ctx: ActContext = { station: null }): { state: OTState; feedback: Feedback } {
  const s = clone(state);
  if (s.stage === 'done') return { state: s, feedback: { tone: 'info', text: 'The case is over.' } };
  if (action.kind === 'send-sample') return { state: s, feedback: sendSample(s) };
  if (action.kind === 'call-help') return { state: s, feedback: callHelp(s) };
  if (s.room && isBlood(action)) return askForBlood(s, action, ctx);
  return perform(s, action, ctx);
}

/** The action takes effect now. `s` is already a copy. `askedAt`: it was ordered earlier and had to wait. */
function perform(s: OTState, action: OTAction, ctx: ActContext, askedAt?: number): { state: OTState; feedback: Feedback } {
  const result = applyEquipment(s, action);
  if (askedAt === undefined) say(s, 'you', describeAction(action) + '.', 'info');
  if (result) say(s, 'system', result, 'info');

  let drugRec: GivenDrug | null = null;
  const notes: string[] = [];
  if (action.kind === 'drug') {
    const d = doseNote(action.drug, action.dose);
    drugRec = { drug: action.drug, dose: action.dose, t: round1(s.t), inRange: d.ok };
    if (!allergyConfirmed(s)) {
      addSafety(s, 'no-allergy-check', `${DRUGS[action.drug].label} was given before the allergy status was confirmed (read the wrist band or answer the sign-in).`);
    }
    if (d.tenfold) addSafety(s, 'tenfold', `${DRUGS[action.drug].label} ${fmtDose(action.drug, action.dose)}: tenfold dose error.`);
    const earlier = s.drugs.filter((x) => x.drug === action.drug && s.t - x.t < 120);
    if (earlier.length && !DRUGS[action.drug].effect.sbp && !DRUGS[action.drug].effect.hr) {
      addSafety(s, 'repeat-dose', `${DRUGS[action.drug].label} was given again within minutes of the last dose. Check the chart before you give.`);
    }
    s.drugs.push(drugRec);
  }

  const live = s.events.filter((e) => e.status === 'onset' || e.status === 'active');
  let feedback: Feedback | null = null;
  const judged = live.map((ev) => ({ ev, j: judge(s, ev, action) }));
  const hit = judged.find((x) => x.j.verdict === 'correct') ?? judged.find((x) => x.j.verdict === 'partial');
  if (hit) {
    const def = eventDef(s, hit.ev.id);
    hit.ev.attempts.push({ t: round1(s.t), text: describeAction(action), verdict: hit.j.verdict });
    resolve(s, hit.ev, hit.j.verdict === 'correct' ? 'correct' : 'partial', ctx);
    if (askedAt !== undefined) hit.ev.actedAt = askedAt;
    say(s, def.speaker, def.ack, 'good');
    if (hit.j.note) notes.push(hit.j.note);
    feedback = { tone: hit.j.verdict === 'correct' ? 'good' : 'warn', text: hit.j.verdict === 'correct' ? `Correct: ${PROBLEMS[hit.ev.problem].label.toLowerCase()} fixed.` : `Partly right. ${hit.j.note}` };
  } else {
    const wrongs = judged.filter((x) => x.j.verdict === 'wrong');
    const station = STATION_OF[action.kind];
    const wrong =
      wrongs.find((x) => action.kind === 'drug' && x.ev.problem === 'lead-off') ??
      wrongs.find((x) => PROBLEMS[x.ev.problem].station === station) ??
      wrongs[0];
    if (wrong) {
      wrong.ev.attempts.push({ t: round1(s.t), text: describeAction(action), verdict: 'wrong' });
      notes.push(wrong.j.note);
      if (wrong.ev.problem === 'lead-off' && action.kind === 'drug') {
        addSafety(s, 'monitor-not-patient', `${DRUGS[action.drug].label} given for a monitor alarm without checking the patient.`);
      }
      feedback = { tone: 'bad', text: wrong.j.note };
    } else if (action.kind === 'drug') {
      const vaso = !!(DRUGS[action.drug].effect.sbp || DRUGS[action.drug].effect.hr);
      const future = s.events.some((e) => e.status === 'pending' && PROBLEMS[e.problem].accept.some((sp) => sp.kind === 'drug' && sp.drug === action.drug));
      if (live.length) {
        const ev = live[0];
        ev.attempts.push({ t: round1(s.t), text: describeAction(action), verdict: 'wrong' });
        feedback = { tone: 'bad', text: `${DRUGS[action.drug].label} does not treat ${PROBLEMS[ev.problem].label.toLowerCase()}.` };
      } else if (vaso) {
        addSafety(s, 'no-indication', `${DRUGS[action.drug].label} given with no problem to treat.`);
        feedback = { tone: 'bad', text: `Nobody asked for ${DRUGS[action.drug].label}. Vasoactive drugs only for a problem you can name.` };
      } else {
        feedback = { tone: 'info', text: future || action.drug === 'cefazolin' ? `${DRUGS[action.drug].label} given and charted.` : `${DRUGS[action.drug].label} given. Was it needed now?` };
      }
    }
  }
  // Drugs that did not fix a problem still act on the body.
  if (drugRec && !hit) {
    const info = DRUGS[drugRec.drug];
    const k = doseNote(drugRec.drug, drugRec.dose).tenfold ? 3.5 : 1;
    if (info.effect.hr || info.effect.sbp) {
      s.transients.push({ t: round1(s.t), d: { hr: (info.effect.hr ?? 0) * k, sbp: (info.effect.sbp ?? 0) * k, dbp: (info.effect.dbp ?? 0) * k } });
    }
  } else if (drugRec && hit && doseNote(drugRec.drug, drugRec.dose).tenfold) {
    const info = DRUGS[drugRec.drug];
    s.transients.push({ t: round1(s.t), d: { hr: (info.effect.hr ?? 0) * 2.5, sbp: (info.effect.sbp ?? 0) * 2.5, dbp: (info.effect.dbp ?? 0) * 2.5 } });
  }
  if (notes.length) say(s, 'system', notes.filter(Boolean).join(' '), feedback?.tone === 'bad' ? 'bad' : 'warn');
  // The time-out antibiotic resolves the pre-incision wait.
  if (s.stage === 'pre-incision' && s.events.find((e) => e.id === ABX_EVENT_ID)?.status === 'resolved') startIncision(s);
  return { state: s, feedback: feedback ?? { tone: 'info', text: result ?? `${describeAction(action)}.` } };
}

// ───────── checklist ─────────

export function checklistCorrect(s: OTState, item: ChecklistItem): string {
  if (item.correct === 'antibiotic') return antibioticGiven(s) ? 'yes' : 'no';
  return item.correct;
}

/** Answer the current WHO checklist prompt with one of its option ids. */
export function answerChecklist(state: OTState, optionId: string): { state: OTState; feedback: Feedback } {
  const s = clone(state);
  const item = currentChecklistItem(s);
  if (!item) return { state: s, feedback: { tone: 'info', text: 'No checklist question is waiting.' } };
  const opt = item.options.find((o) => o.id === optionId);
  if (!opt) return { state: s, feedback: { tone: 'warn', text: 'Pick one of the answers.' } };
  const right = checklistCorrect(s, item);
  const ok = optionId === right;
  s.checklist[item.id] = { answer: optionId, ok, t: round1(s.t) };
  say(s, 'you', opt.label + '.', 'info');
  if (s.room && item.id === 'allergy' && s.rx.status === 'none') {
    s.rx = { status: 'waiting', askedAt: s.t, text: '' };
    post(s, { kind: 'allergy' });
    say(s, 'leela', 'Asking pharmacy to check the antibiotic against the recorded allergy.', 'info');
  }
  let feedback: Feedback;
  if (ok) {
    feedback = { tone: 'good', text: 'Confirmed.' };
  } else {
    const rightLabel = item.options.find((o) => o.id === right)?.label ?? right;
    feedback = { tone: 'bad', text: `Not quite: ${rightLabel}. ${item.teaching}` };
    say(s, item.speaker, `No, check again: ${rightLabel}.`, 'warn');
    if (item.id === 'antibiotic' && optionId === 'yes') {
      addSafety(s, 'false-checklist', 'Said the antibiotic was given when the drug chart shows it was not.');
    }
  }
  s.checklistIdx += 1;
  const sc = scenarioOf(s);
  const stage = item.stage;
  const next = checklistItems(sc, stage)[s.checklistIdx];
  if (next) {
    say(s, next.speaker, next.ask, 'call');
  } else if (stage === 'sign-in') {
    s.stage = 'induction';
    s.stageAt = s.t;
    s.checklistIdx = 0;
    say(s, 'anaesthetist', sc.anaesthesia === 'spinal' ? 'Sign in complete. Putting in the spinal now.' : 'Sign in complete. Inducing now.', 'info');
  } else if (stage === 'time-out') {
    s.checklistIdx = 0;
    if (antibioticGiven(s)) startIncision(s);
    else startAntibioticWait(s);
  } else {
    s.stage = 'done';
    s.stageAt = s.t;
    s.checklistIdx = 0;
    say(s, 'surgeon', 'Sign out complete. Thank you, everyone. Well done.', 'good');
  }
  return { state: s, feedback };
}

function startAntibioticWait(s: OTState) {
  s.stage = 'pre-incision';
  s.stageAt = s.t;
  const ev: EventRun = {
    id: ABX_EVENT_ID,
    problem: 'antibiotic',
    status: 'active',
    onsetAt: s.t,
    callAt: s.t,
    resolvedAt: null,
    outcome: null,
    atStation: false,
    reminded: false,
    attempts: [],
    frozen: null,
  };
  s.events.unshift(ev);
  say(s, 'surgeon', abxDef(scenarioOf(s)).line, 'call');
}

function startIncision(s: OTState) {
  const sc = scenarioOf(s);
  s.stage = 'operating';
  s.stageAt = s.t;
  s.incisionAt = s.t;
  const rnd = mulberry32((s.seed ^ hashStr(sc.id)) >>> 0);
  for (const ev of s.events) {
    if (ev.id === ABX_EVENT_ID) continue;
    const def = eventDef(s, ev.id);
    const jitter = Math.round((rnd() - 0.5) * 4);
    const call = s.t + Math.max(4, def.atS + jitter);
    ev.callAt = round1(call);
    ev.onsetAt = round1(Math.max(s.t, call - (def.onset ? LEAD_S : 0)));
  }
  say(s, 'surgeon', `Knife, please. ${sc.phases[0]?.label ?? 'Starting'}.`, 'info');
}

// ───────── clock ─────────

/** Advance the simulation by `dt` seconds. */
export function tick(state: OTState, dt: number): OTState {
  if (state.stage === 'done' || dt <= 0) return state;
  const s = clone(state);
  const sc = scenarioOf(s);
  const step = Math.min(dt, 5);
  s.t = round1(s.t + step);
  const eq = s.equipment;
  if (eq.ivRunning) eq.infusedMl += (eq.ivRate * step) / 3600;
  if (eq.bolusMl > 0) {
    const d = Math.min(eq.bolusMl, 25 * step);
    eq.bolusMl -= d;
    eq.infusedMl += d;
  }

  if (bloodOpen(s) && s.t - s.blood!.waitFrom >= BLOOD_WAIT_S) issueUnconfirmed(s);
  if (s.rx.status === 'waiting' && s.t - s.rx.askedAt >= RX_WAIT_S) {
    s.rx = { ...s.rx, status: 'unconfirmed', text: 'Pharmacy has not answered. The allergy check is not confirmed.' };
    say(s, 'leela', s.rx.text, 'warn');
  }

  if (s.stage === 'induction' && s.t - s.stageAt >= INDUCTION_S && s.rx.status !== 'waiting') {
    say(s, 'anaesthetist', sc.inductionLine, 'info');
    s.stage = 'time-out';
    s.stageAt = s.t;
    s.checklistIdx = 0;
    const first = checklistItems(sc, 'time-out')[0];
    say(s, first.speaker, first.ask, 'call');
  }

  for (const ev of s.events) {
    const def = eventDef(s, ev.id);
    if (ev.status === 'pending' && ev.onsetAt !== null && s.t >= ev.onsetAt) {
      if (PROBLEMS[ev.problem].preventable && alreadySatisfied(s, ev.problem)) {
        resolve(s, ev, 'prevented', null);
        say(s, def.speaker, `${preventedLine(ev.problem)} Good anticipation.`, 'good');
        continue;
      }
      ev.status = 'onset';
      if (ev.problem === 'cautery-fail') eq.padOk = false;
      if (ev.problem === 'lead-off') eq.leadOff = true;
    }
    if (ev.status === 'onset' && ev.callAt !== null && s.t >= ev.callAt) {
      ev.status = 'active';
      say(s, def.speaker, def.line, 'call');
    }
    if (ev.status === 'active' && ev.callAt !== null) {
      const since = s.t - ev.callAt;
      if (!ev.reminded && since >= def.deadlineS / 2) {
        ev.reminded = true;
        say(s, def.speaker, def.remind, 'warn');
      }
      if (since >= def.deadlineS && !waitingBloodTreats(s, ev)) {
        resolve(s, ev, 'missed', null);
        takeOver(s, ev);
      }
    }
  }

  if (s.stage === 'pre-incision') {
    const abx = s.events.find((e) => e.id === ABX_EVENT_ID);
    if (abx && (abx.status === 'resolved' || abx.status === 'missed')) startIncision(s);
  }

  if (s.stage === 'operating' && s.incisionAt !== null && s.t - s.incisionAt >= sc.endS) {
    const busy = s.events.some((e) => e.status === 'pending' || e.status === 'onset' || e.status === 'active');
    if (!busy) {
      s.stage = 'sign-out';
      s.stageAt = s.t;
      s.checklistIdx = 0;
      say(s, 'nurse', 'Counts are correct: instruments, swabs and needles.', 'info');
      const first = checklistItems(sc, 'sign-out')[0];
      say(s, first.speaker, first.ask, 'call');
    }
  }
  return s;
}

function preventedLine(problem: ProblemId): string {
  switch (problem) {
    case 'hypothermia':
      return 'Temperature is holding, the warmer was already on.';
    case 'bleeding-field':
      return 'Bit of bleeding, but suction is ready. Good.';
    case 'maintenance':
      return 'Maintenance fluids are already running.';
    case 'ponv':
      return 'Anti-emetic is already in.';
    case 'analgesia':
      return 'Paracetamol is already in.';
    default:
      return 'Already done.';
  }
}

/** A senior steps in when the deadline passes: equipment gets fixed so the
 *  room stays consistent, and the miss is recorded. */
function takeOver(s: OTState, ev: EventRun) {
  const p = PROBLEMS[ev.problem];
  const who: Speaker = ev.problem === 'bleeding-field' || ev.problem === 'cautery-fail' ? 'nurse' : 'anaesthetist';
  const eq = s.equipment;
  switch (ev.problem) {
    case 'bleeding-field':
      eq.suctionOn = true;
      eq.suctionPressure = 150;
      break;
    case 'hypothermia':
      eq.warmerOn = true;
      eq.warmerTemp = 43;
      break;
    case 'hypoxia':
      eq.fio2 = 100;
      break;
    case 'maintenance':
      eq.ivFluid = 'RL';
      eq.ivRate = 100;
      eq.ivRunning = true;
      break;
    case 'antibiotic':
      addSafety(s, 'incision-no-abx', 'Antibiotic prophylaxis was not given before the incision.');
      break;
    default:
      break;
  }
  say(s, who, `I will do it myself: ${p.model.charAt(0).toLowerCase()}${p.model.slice(1)}.`, 'bad');
}

// ───────── theatre room ─────────

const isBlood = (a: OTAction): a is BloodRequest['action'] =>
  (a.kind === 'fluid-bolus' && a.fluid === 'blood' && a.volumeMl > 0) || (a.kind === 'fluid-rate' && a.fluid === 'blood' && a.rateMlH > 0);

/** The laboratory still has to answer. */
export function bloodOpen(s: OTState): boolean {
  return !!s.blood && (s.blood.status === 'waiting' || s.blood.status === 'sample' || s.blood.status === 'matching');
}

/** Cells asked for in time keep their problem open until they run or the wait runs out. */
function waitingBloodTreats(s: OTState, ev: EventRun): boolean {
  if (!bloodOpen(s) || !s.blood || ev.callAt === null) return false;
  if (s.blood.askedAt > ev.callAt + eventDef(s, ev.id).deadlineS) return false;
  const v = judge(s, ev, s.blood.action).verdict;
  return v === 'correct' || v === 'partial';
}

function post(s: OTState, item: Omit<OutItem, 'id'>) {
  s.outbox.push({ id: s.nextOutId++, ...item });
  if (s.outbox.length > 20) s.outbox.splice(0, s.outbox.length - 20);
}

/** Switch the theatre room on or off (it connects a moment after the drill starts). */
export function connectRoom(state: OTState, on: boolean): OTState {
  if (state.room === on) return state;
  const s = clone(state);
  s.room = on;
  return s;
}

function askForBlood(s: OTState, action: BloodRequest['action'], ctx: ActContext): { state: OTState; feedback: Feedback } {
  const emergency = action.kind === 'fluid-bolus' && !!action.emergency;
  const cur = s.blood;
  if (!emergency && cur && bloodOpen(s)) {
    return { state: s, feedback: { tone: 'info', text: cur.status === 'sample' ? 'The lab is waiting for a labelled sample.' : 'Already waiting for the lab cross-match.' } };
  }
  // Compatible cells for this patient are already in theatre.
  if (!emergency && cur?.status === 'released') return perform(s, action, ctx);
  const n = (cur?.n ?? 0) + 1;
  s.blood = {
    n, action, station: ctx.station, askedAt: round1(s.t), waitFrom: s.t, status: emergency ? 'emergency' : 'waiting',
    group: emergency ? 'O negative' : '', units: [], note: '',
  };
  post(s, { kind: 'blood', n, units: action.kind === 'fluid-bolus' && action.volumeMl > 350 ? 2 : 1, emergency });
  if (emergency) {
    s.bloodNotes.push({ how: 'emergency', t: round1(s.t), text: 'Emergency O negative was given without a cross-match and recorded with the lab.' });
    say(s, 'leela', 'Emergency O negative is going up without cross-match. Recording it with the lab.', 'warn');
    return perform(s, action, ctx);
  }
  say(s, 'you', 'Send packed red cells.', 'info');
  say(s, 'leela', 'Waiting for Lab cross-match.', 'info');
  return { state: s, feedback: { tone: 'info', text: 'Waiting for Lab cross-match. The cells run when the lab releases them.' } };
}

function runBlood(s: OTState) {
  const b = s.blood!;
  perform(s, b.action, { station: b.station }, b.askedAt);
}

function issueUnconfirmed(s: OTState) {
  const b = s.blood!;
  b.note = b.status === 'sample' ? 'no sample was sent' : 'the lab had not answered';
  b.status = 'unconfirmed';
  s.bloodNotes.push({ how: 'unconfirmed', t: round1(s.t), text: `Packed cells were issued without cross-match confirmation: ${b.note}.` });
  say(s, 'leela', `Packed cells issued without cross-match confirmation: ${b.note}.`, 'warn');
  post(s, { kind: 'unconfirmed', n: b.n });
  runBlood(s);
}

function sendSample(s: OTState): Feedback {
  if (!s.blood || s.blood.status !== 'sample') return { tone: 'info', text: 'The lab has not asked for a sample.' };
  s.blood.status = 'matching';
  s.blood.waitFrom = s.t;
  post(s, { kind: 'sample', n: s.blood.n });
  say(s, 'you', 'Labelled cross-match sample sent.', 'info');
  return { tone: 'good', text: 'Sample labelled at the bedside and sent.' };
}

/** One line for the consultant: no name, only what they need. */
export function sbarLine(s: OTState): string {
  const sc = scenarioOf(s);
  const v = vitalsAt(s);
  const open = activeCalls(s)[0];
  const problem = open ? PROBLEMS[open.run.problem].label : 'Help needed';
  const blood = s.blood && s.blood.status !== 'refused' ? ` Blood: ${s.blood.status}.` : '';
  return (
    `S: ${problem}. HR ${v.hr}, BP ${v.sbp}/${v.dbp}, SpO2 ${v.spo2}. ` +
    `B: ${sc.patient.age}${sc.patient.sex}, ${sc.patient.procedure}, ${sc.anaesthesia === 'GA' ? 'general anaesthesia' : 'spinal'}. ` +
    `A: ${phaseLabel(s)}${open ? `, problem open ${Math.round(open.sinceS)} s` : ''}.${blood} R: please advise now or come to theatre.`
  );
}

function callHelp(s: OTState): Feedback {
  if (!s.room) return { tone: 'info', text: 'No consultant can be reached from this theatre. Use the team here.' };
  if (s.help && (s.help.status === 'calling' || s.t - s.help.askedAt < HELP_AGAIN_S)) return { tone: 'info', text: 'Help has already been called.' };
  s.help = { status: 'calling', askedAt: s.t, name: s.help?.name ?? '', text: '' };
  const sbar = sbarLine(s);
  post(s, { kind: 'help', sbar });
  say(s, 'you', `Call for help. ${sbar}`, 'call');
  return { tone: 'good', text: 'Calling the consultant with this: ' + sbar };
}

/** Feed one answer from the theatre room into the drill. */
export function theatreEvent(state: OTState, ev: TheatreEvent): OTState {
  if (state.stage === 'done') return state;
  const s = clone(state);
  if (ev.kind === 'rx') {
    if (s.rx.status === 'none') return state;
    const text = ev.text?.trim() ?? '';
    if (ev.verdict === 'no_reply') {
      if (s.rx.status !== 'waiting') return state;
      s.rx = { ...s.rx, status: 'unconfirmed', text: 'Pharmacy has not answered. The allergy check is not confirmed.' };
      say(s, 'leela', s.rx.text, 'warn');
    } else {
      if (s.rx.status === ev.verdict) return state;
      s.rx = { ...s.rx, status: ev.verdict, text };
      say(s, 'leela', `Pharmacist Meera: ${text || (ev.verdict === 'release' ? 'the antibiotic can be given.' : 'do not give it before it is settled.')}`, ev.verdict === 'release' ? 'good' : 'warn');
    }
    return s;
  }
  if (ev.kind === 'help') {
    if (!s.help) return state;
    s.help = { ...s.help, status: ev.status, name: ev.name ?? s.help.name, text: ev.status === 'replied' ? ev.text ?? '' : s.help.text };
    const who = s.help.name || 'The consultant';
    if (ev.status === 'called') say(s, 'leela', `${who} has been called and has your SBAR.`, 'info');
    else if (ev.status === 'unreachable') say(s, 'leela', 'The consultant could not be reached. Carry on with the team here.', 'warn');
    else say(s, 'leela', `${who}: ${ev.text ?? ''}`, 'call');
    return s;
  }
  const b = s.blood;
  if (!b || b.n !== ev.n) return state;
  if (ev.status === 'recorded') {
    if (b.status !== 'emergency' || b.units.length) return state;
    b.units = ev.units ?? [];
    say(s, 'leela', `Lab has recorded the emergency issue${b.units.length ? ` (${b.units.join(', ')})` : ''}. Send a sample for a retrospective cross-match.`, 'info');
    return s;
  }
  if (b.status === 'unconfirmed' && ev.status === 'released') {
    if (b.group) return state;
    b.group = ev.group ?? '';
    b.units = ev.units ?? [];
    say(s, 'leela', `Lab confirms afterwards: compatible, ${b.group || 'group checked'}.`, 'info');
    return s;
  }
  if (!bloodOpen(s)) return state;
  switch (ev.status) {
    case 'sample':
      if (b.status !== 'waiting') return state;
      b.status = 'sample';
      b.waitFrom = s.t;
      say(s, 'leela', 'Lab has no valid sample. Send a labelled cross-match sample.', 'call');
      return s;
    case 'matching':
      if (b.status !== 'sample') return state;
      b.status = 'matching';
      b.waitFrom = s.t;
      return s;
    case 'released':
      b.status = 'released';
      b.group = ev.group ?? '';
      b.units = ev.units ?? [];
      s.bloodNotes.push({ how: 'crossmatched', t: round1(s.t), text: `Cross-matched cells released by the lab${b.group ? ` (${b.group})` : ''} after ${Math.round(s.t - b.askedAt)} s.` });
      say(s, 'leela', `Cross-match released${b.units.length ? `: ${b.units.join(', ')}` : ''}${b.group ? `, patient ${b.group}` : ''}. Cells running.`, 'good');
      runBlood(s);
      return s;
    case 'refused':
      b.status = 'refused';
      b.note = ev.text ?? '';
      s.bloodNotes.push({ how: 'refused', t: round1(s.t), text: `The lab did not release blood${b.note ? `: ${b.note}` : '.'}` });
      say(s, 'leela', b.note || 'The lab did not release any blood.', 'bad');
      return s;
  }
  return state;
}

// ───────── report ─────────

export interface EventScore {
  id: string;
  problem: ProblemId;
  label: string;
  speaker: Speaker;
  line: string;
  outcome: Outcome;
  points: number;
  max: number;
  responseS: number | null;
  atStation: boolean;
  wrongAttempts: number;
  attempts: string[];
  model: string;
  teaching: string;
}

export interface ChecklistScore {
  id: string;
  stage: ChecklistStage;
  ask: string;
  answer: string | null;
  correctLabel: string;
  ok: boolean;
  teaching: string;
}

export type OTGrade = 'excellent' | 'good' | 'satisfactory' | 'borderline' | 'clear-fail';

export interface OTReport {
  scenarioId: string;
  title: string;
  patient: string;
  score: number;
  grade: OTGrade;
  eventPct: number;
  checklistPct: number;
  events: EventScore[];
  checklist: ChecklistScore[];
  safety: SafetyError[];
  avgResponseS: number | null;
  durationS: number;
  /** How blood went up, for the narrative only. */
  blood: BloodNote[];
}

export function scoreEvent(ev: EventRun, def: OTEventDef): EventScore {
  const p = PROBLEMS[ev.problem];
  const wrong = ev.attempts.filter((a) => a.verdict === 'wrong').length;
  const responseS = ev.resolvedAt !== null && ev.callAt !== null && ev.outcome !== 'missed' && ev.outcome !== 'prevented'
    ? round1(Math.max(0, (ev.actedAt ?? ev.resolvedAt) - ev.callAt))
    : null;
  let points = 0;
  const outcome: Outcome = ev.outcome ?? 'missed';
  if (outcome === 'prevented') points = 10;
  else if (outcome === 'correct' || outcome === 'partial') {
    const base = outcome === 'correct' ? 6 : 3;
    const station = ev.atStation ? 2 : 0;
    const time = responseS === null ? 0 : responseS <= 15 ? 2 : responseS <= 30 ? 1 : 0;
    points = Math.max(1, base + station + time - Math.min(3, wrong));
  }
  return {
    id: ev.id,
    problem: ev.problem,
    label: p.label,
    speaker: def.speaker,
    line: def.line,
    outcome,
    points,
    max: 10,
    responseS,
    atStation: ev.atStation,
    wrongAttempts: wrong,
    attempts: ev.attempts.map((a) => `${a.text} (${a.verdict})`),
    model: p.model,
    teaching: p.teaching,
  };
}

export function gradeOf(score: number): OTGrade {
  return score >= 85 ? 'excellent' : score >= 70 ? 'good' : score >= 55 ? 'satisfactory' : score >= 40 ? 'borderline' : 'clear-fail';
}

export function buildReport(s: OTState): OTReport {
  const sc = scenarioOf(s);
  const events = s.events.filter((e) => e.status !== 'pending' || e.outcome !== null).map((e) => scoreEvent(e, eventDef(s, e.id)));
  const checklist: ChecklistScore[] = sc.checklist.map((item) => {
    const a = s.checklist[item.id];
    const right = checklistCorrect(s, item);
    return {
      id: item.id,
      stage: item.stage,
      ask: item.ask,
      answer: a ? item.options.find((o) => o.id === a.answer)?.label ?? a.answer : null,
      correctLabel: item.options.find((o) => o.id === (a && item.correct === 'antibiotic' ? (a.ok ? a.answer : a.answer === 'yes' ? 'no' : 'yes') : right))?.label ?? right,
      ok: !!a?.ok,
      teaching: item.teaching,
    };
  });
  const eventPct = events.length ? events.reduce((n, e) => n + e.points, 0) / (events.length * 10) : 0;
  const checklistPct = checklist.length ? checklist.filter((c) => c.ok).length / checklist.length : 0;
  const penalty = s.safety.reduce((n, x) => n + (x.code === 'tenfold' ? 20 : 10), 0);
  const score = Math.round(clamp(70 * eventPct + 30 * checklistPct - penalty, 0, 100));
  const times = events.map((e) => e.responseS).filter((x): x is number => x !== null);
  return {
    scenarioId: sc.id,
    title: sc.title,
    patient: `${sc.patient.name}, ${sc.patient.age}${sc.patient.sex}`,
    score,
    grade: gradeOf(score),
    eventPct: Math.round(eventPct * 100),
    checklistPct: Math.round(checklistPct * 100),
    events,
    checklist,
    safety: s.safety,
    avgResponseS: times.length ? round1(times.reduce((a, b) => a + b, 0) / times.length) : null,
    durationS: Math.round(s.t),
    blood: s.bloodNotes,
  };
}

// ───────── UI helpers ─────────

/** The phase label for the HUD. */
export function phaseLabel(s: OTState): string {
  const sc = scenarioOf(s);
  switch (s.stage) {
    case 'sign-in':
      return 'WHO sign in';
    case 'induction':
      return sc.anaesthesia === 'spinal' ? 'Spinal anaesthesia' : 'Induction';
    case 'time-out':
      return 'WHO time out';
    case 'pre-incision':
      return 'Waiting to incise';
    case 'sign-out':
      return 'WHO sign out';
    case 'done':
      return 'Case complete';
    case 'operating': {
      const since = s.t - (s.incisionAt ?? s.t);
      let label = sc.phases[0]?.label ?? 'Operating';
      for (const p of sc.phases) if (since >= p.atS) label = p.label;
      return label;
    }
  }
}

/** Called-out problems still waiting for the student, oldest first. */
export function activeCalls(s: OTState): Array<{ run: EventRun; def: OTEventDef; sinceS: number }> {
  return s.events
    .filter((e) => e.status === 'active' && e.callAt !== null)
    .map((run) => ({ run, def: eventDef(s, run.id), sinceS: Math.max(0, s.t - (run.callAt ?? s.t)) }))
    .sort((a, b) => (a.run.callAt ?? 0) - (b.run.callAt ?? 0));
}

export { STATION_OF, SPEAKER_SHORT };
