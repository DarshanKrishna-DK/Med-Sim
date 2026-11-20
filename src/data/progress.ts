// "My progress" aggregation over saved debriefs (gr_eval_history).
//
// Pure functions only (type imports, no runtime imports) so the unit tests
// in scripts/test/progress.test.ts can load this file directly. Older rows
// that predate the mode/score/skill fields are handled by deriving those
// values from the stored evaluation.

import type { EvalHistoryEntry } from './evalHistory';
import type { ClinicId } from '../game/clinic';
import type { CaseEvaluationInput } from '../agents/customTools';
import { SKILL_KEYS, SKILL_LABELS, type SkillKey, type SkillScores } from '../agents/osceCore.ts';

/** Minimal case-catalogue row (pass `CASES` from data/cases.ts). */
export interface CatalogCase {
  id: string;
  clinic: ClinicId;
  name: string;
  complaint: string;
}

export interface TrendPoint {
  savedAt: number;
  score: number;
  mode: 'practice' | 'osce';
}

export interface SpecialtyStat {
  clinic: ClinicId;
  sessions: number;
  avg: number;
}

export interface SkillStat {
  key: SkillKey;
  label: string;
  avg: number;
  n: number;
}

export interface MistakeStat {
  title: string;
  count: number;
  severity: 'info' | 'warning' | 'danger';
  lastAt: number;
}

export interface ProgressSummary {
  sessions: number;
  osceSessions: number;
  avgScore: number | null;
  /** Average of the last 5 sessions minus the 5 before them (null if < 2 windows). */
  recentDelta: number | null;
  /** Chronological, last `TREND_POINTS` sessions. */
  trend: TrendPoint[];
  bySpecialty: SpecialtyStat[];
  /** Weakest first; only skills with at least one score. */
  skills: SkillStat[];
  /** Most frequent first. */
  mistakes: MistakeStat[];
  streak: { current: number; best: number };
  /** Up to 3 unattempted cases from the weakest specialty. */
  suggestions: CatalogCase[];
  weakestSpecialty: ClinicId | null;
}

export const TREND_POINTS = 20;

const SEV_RANK = { info: 0, warning: 1, danger: 2 } as const;

/** Overall 0-100 for a row: saved score, else the mean of the domain scores. */
export function entryScore(e: EvalHistoryEntry): number {
  if (typeof e.score === 'number' && Number.isFinite(e.score)) return clamp(e.score);
  const ds = e.evaluation?.domain_scores;
  if (!ds) return 0;
  const parts = [ds.data_gathering, ds.clinical_management, ds.interpersonal]
    .filter((d) => d && d.max > 0)
    .map((d) => (d.raw / d.max) * 100);
  return parts.length ? clamp(parts.reduce((a, b) => a + b, 0) / parts.length) : 0;
}

/** Map a simple-debrief domain list (names like "Test selection") onto skill keys. */
export function skillsFromDomainNames(domains: Array<{ name: string; score: number }>): SkillScores {
  const out: SkillScores = {};
  const rules: Array<[SkillKey, RegExp]> = [
    ['history', /history|data|gather/],
    ['reasoning', /reason|diagnos/],
    ['tests', /test|investigat/],
    ['treatment', /treat|safety|manage|prescri/],
    ['communication', /communic|interpersonal|rapport|empath/],
    ['disposition', /dispos|follow|plan/],
  ];
  for (const d of domains) {
    const n = d.name.toLowerCase();
    const hit = rules.find(([k, re]) => out[k] === undefined && re.test(n));
    if (hit) out[hit[0]] = clamp(d.score);
  }
  return out;
}

/** Skill scores from the 3-domain evaluation (Managed Agent path). Only the
 *  areas that map one-to-one are filled; the rest stay unknown. */
export function skillsFromEvaluation(ev: CaseEvaluationInput): SkillScores {
  const pct = (d: { raw: number; max: number } | undefined) =>
    d && d.max > 0 ? clamp((d.raw / d.max) * 100) : undefined;
  const out: SkillScores = {};
  const h = pct(ev.domain_scores?.data_gathering);
  const t = pct(ev.domain_scores?.clinical_management);
  const c = pct(ev.domain_scores?.interpersonal);
  if (h !== undefined) out.history = h;
  if (t !== undefined) out.treatment = t;
  if (c !== undefined) out.communication = c;
  return out;
}

export function entrySkills(e: EvalHistoryEntry): SkillScores {
  if (e.skillScores && Object.keys(e.skillScores).length) return e.skillScores;
  return e.evaluation ? skillsFromEvaluation(e.evaluation) : {};
}

export function entrySpecialty(e: EvalHistoryEntry, byId: Map<string, CatalogCase>): ClinicId | null {
  return e.specialty ?? byId.get(e.caseId)?.clinic ?? null;
}

/** Local-calendar day key, e.g. "2026-11-21". */
export function dayKey(ts: number): string {
  const d = new Date(ts);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

function prevDay(key: string): string {
  const [y, m, d] = key.split('-').map(Number);
  return dayKey(new Date(y, m - 1, d - 1, 12).getTime());
}

/** Consecutive practice days. `current` counts back from today, or from
 *  yesterday when today has no session yet (the streak is still alive). */
export function computeStreak(timestamps: number[], now: number): { current: number; best: number } {
  const days = new Set(timestamps.map(dayKey));
  if (days.size === 0) return { current: 0, best: 0 };
  let best = 0;
  for (const k of days) {
    if (days.has(prevDay(k))) continue; // not the start of a run
    let len = 0;
    let cur = k;
    while (days.has(cur)) {
      len += 1;
      const [y, m, d] = cur.split('-').map(Number);
      cur = dayKey(new Date(y, m - 1, d + 1, 12).getTime());
    }
    best = Math.max(best, len);
  }
  const today = dayKey(now);
  let start = days.has(today) ? today : prevDay(today);
  let current = 0;
  while (days.has(start)) {
    current += 1;
    start = prevDay(start);
  }
  return { current, best };
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function mean(xs: number[]): number {
  return xs.reduce((a, b) => a + b, 0) / xs.length;
}

export function computeProgress(entries: EvalHistoryEntry[], catalog: CatalogCase[], now = Date.now()): ProgressSummary {
  const byId = new Map(catalog.map((c) => [c.id, c]));
  const chrono = [...entries].sort((a, b) => a.savedAt - b.savedAt);
  const scores = chrono.map(entryScore);

  const trend: TrendPoint[] = chrono.slice(-TREND_POINTS).map((e, i, arr) => ({
    savedAt: e.savedAt,
    score: scores[chrono.length - arr.length + i],
    mode: e.mode === 'osce' ? 'osce' : 'practice',
  }));

  let recentDelta: number | null = null;
  if (scores.length >= 2) {
    const last = scores.slice(-5);
    const prev = scores.slice(-10, -5);
    if (prev.length) recentDelta = Math.round(mean(last) - mean(prev));
  }

  // Specialty bars.
  const spec = new Map<ClinicId, number[]>();
  chrono.forEach((e, i) => {
    const c = entrySpecialty(e, byId);
    if (!c) return;
    spec.set(c, [...(spec.get(c) ?? []), scores[i]]);
  });
  const bySpecialty: SpecialtyStat[] = [...spec.entries()]
    .map(([clinic, xs]) => ({ clinic, sessions: xs.length, avg: Math.round(mean(xs)) }))
    .sort((a, b) => b.sessions - a.sessions || a.avg - b.avg);

  // Skills, weakest first.
  const skillVals = new Map<SkillKey, number[]>();
  for (const e of chrono) {
    const s = entrySkills(e);
    for (const k of SKILL_KEYS) {
      const v = s[k];
      if (typeof v === 'number') skillVals.set(k, [...(skillVals.get(k) ?? []), v]);
    }
  }
  const skills: SkillStat[] = [...skillVals.entries()]
    .map(([key, xs]) => ({ key, label: SKILL_LABELS[key], avg: Math.round(mean(xs)), n: xs.length }))
    .sort((a, b) => a.avg - b.avg || b.n - a.n);

  // Recurring mistakes from saved coach alerts (case-insensitive by title).
  const mist = new Map<string, MistakeStat>();
  for (const e of chrono) {
    for (const a of e.alerts ?? []) {
      const title = (a.title ?? '').trim();
      if (!title) continue;
      const k = title.toLowerCase();
      const cur = mist.get(k);
      if (cur) {
        cur.count += 1;
        cur.lastAt = Math.max(cur.lastAt, e.savedAt);
        if (SEV_RANK[a.severity] > SEV_RANK[cur.severity]) cur.severity = a.severity;
      } else {
        mist.set(k, { title, count: 1, severity: a.severity, lastAt: e.savedAt });
      }
    }
  }
  const mistakes = [...mist.values()].sort(
    (a, b) => b.count - a.count || SEV_RANK[b.severity] - SEV_RANK[a.severity] || b.lastAt - a.lastAt,
  );

  // Practise next: weakest specialty that still has unattempted cases.
  const attempted = new Set(entries.map((e) => e.caseId));
  const weakestFirst = [...bySpecialty].sort((a, b) => a.avg - b.avg || b.sessions - a.sessions);
  let suggestions: CatalogCase[] = [];
  let weakestSpecialty: ClinicId | null = null;
  for (const s of weakestFirst) {
    const fresh = catalog.filter((c) => c.clinic === s.clinic && !attempted.has(c.id));
    if (fresh.length) {
      weakestSpecialty = s.clinic;
      suggestions = fresh.slice(0, 3);
      break;
    }
  }
  if (!suggestions.length && entries.length) {
    suggestions = catalog.filter((c) => !attempted.has(c.id)).slice(0, 3);
  }

  return {
    sessions: entries.length,
    osceSessions: entries.filter((e) => e.mode === 'osce').length,
    avgScore: scores.length ? Math.round(mean(scores)) : null,
    recentDelta,
    trend,
    bySpecialty,
    skills,
    mistakes,
    streak: computeStreak(entries.map((e) => e.savedAt), now),
    suggestions,
    weakestSpecialty,
  };
}
