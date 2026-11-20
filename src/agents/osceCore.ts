// OSCE examiner marking: shared types and pure helpers (no runtime imports,
// so the unit tests can load this file directly under Node type-stripping).
//
// Contract with POST /agent/debrief/osce (backend/osce.py): the server
// returns an `OsceResult`; `normalizeOsceResult` re-validates it on the
// client so a partial or older payload still renders.

import type { CaseEvaluationInput, VerdictBand } from './customTools';

export type OsceGlobalRating = 'clear-fail' | 'borderline' | 'clear-pass' | 'excellent';
export type OsceItemVerdict = 'met' | 'partial' | 'not-met';
export type OsceDomainId = 'data_gathering' | 'clinical_management' | 'interpersonal';

/** The six skill areas the progress dashboard tracks across sessions. */
export type SkillKey = 'history' | 'reasoning' | 'tests' | 'treatment' | 'communication' | 'disposition';
export type SkillScores = Partial<Record<SkillKey, number>>;

export const SKILL_KEYS: SkillKey[] = ['history', 'reasoning', 'tests', 'treatment', 'communication', 'disposition'];

export const SKILL_LABELS: Record<SkillKey, string> = {
  history: 'History taking',
  reasoning: 'Diagnostic reasoning',
  tests: 'Test selection',
  treatment: 'Treatment and safety',
  communication: 'Communication',
  disposition: 'Disposition',
};

export interface OsceItem {
  id: string;
  domain: OsceDomainId;
  label: string;
  weight: number;
  verdict: OsceItemVerdict;
  /** Verbatim quote from the transcript or action log ('' when none). */
  evidence: string;
  /** Short examiner note. */
  note: string;
}

export interface OsceDomain {
  id: OsceDomainId;
  label: string;
  /** 0-100, weighted from the item verdicts (met 1, partial 0.5). */
  score: number;
  items: OsceItem[];
}

export interface OsceCriticalError {
  severity: 'info' | 'warning' | 'danger';
  title: string;
  detail: string;
}

export interface OsceResult {
  globalRating: OsceGlobalRating;
  /** Overall 0-100. */
  score: number;
  domains: OsceDomain[];
  criticalErrors: OsceCriticalError[];
  skills: SkillScores;
  strengths: string[];
  improvements: string[];
  examinerComment: string;
}

export const OSCE_RATING_LABEL: Record<OsceGlobalRating, string> = {
  'clear-fail': 'Clear fail',
  borderline: 'Borderline',
  'clear-pass': 'Clear pass',
  excellent: 'Excellent',
};

export const OSCE_DOMAIN_LABEL: Record<OsceDomainId, string> = {
  data_gathering: 'History and examination',
  clinical_management: 'Clinical management',
  interpersonal: 'Communication and professionalism',
};

const RATINGS: OsceGlobalRating[] = ['clear-fail', 'borderline', 'clear-pass', 'excellent'];
const VERDICTS: OsceItemVerdict[] = ['met', 'partial', 'not-met'];
const DOMAINS: OsceDomainId[] = ['data_gathering', 'clinical_management', 'interpersonal'];
const SEVERITIES: OsceCriticalError['severity'][] = ['danger', 'warning', 'info'];

/** Score band used when no holistic rating is available. */
export function ratingForScore(score: number): OsceGlobalRating {
  if (score < 40) return 'clear-fail';
  if (score < 55) return 'borderline';
  if (score < 80) return 'clear-pass';
  return 'excellent';
}

export function clamp100(n: unknown): number {
  const x = Number(n);
  if (!Number.isFinite(x)) return 0;
  return Math.max(0, Math.min(100, Math.round(x)));
}

const VERDICT_CREDIT: Record<OsceItemVerdict, number> = { met: 1, partial: 0.5, 'not-met': 0 };

/** Weighted 0-100 score over a set of checklist items. */
export function scoreItems(items: OsceItem[]): number {
  const total = items.reduce((s, i) => s + i.weight, 0);
  if (total <= 0) return 0;
  const got = items.reduce((s, i) => s + i.weight * VERDICT_CREDIT[i.verdict], 0);
  return Math.round((got / total) * 100);
}

function str(v: unknown): string {
  return typeof v === 'string' ? v.trim() : '';
}

function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str).filter(Boolean) : [];
}

/** Defensive re-validation of a server payload. */
export function normalizeOsceResult(raw: unknown): OsceResult {
  const r = (raw ?? {}) as Record<string, unknown>;
  const domains: OsceDomain[] = (Array.isArray(r.domains) ? r.domains : [])
    .map((d): OsceDomain | null => {
      const dd = (d ?? {}) as Record<string, unknown>;
      const id = DOMAINS.includes(dd.id as OsceDomainId) ? (dd.id as OsceDomainId) : null;
      if (!id) return null;
      const items: OsceItem[] = (Array.isArray(dd.items) ? dd.items : []).map((it, i) => {
        const x = (it ?? {}) as Record<string, unknown>;
        const verdict = VERDICTS.includes(x.verdict as OsceItemVerdict) ? (x.verdict as OsceItemVerdict) : 'not-met';
        const w = Number(x.weight);
        return {
          id: str(x.id) || `${id}-${i + 1}`,
          domain: id,
          label: str(x.label) || 'Checklist item',
          weight: Number.isFinite(w) && w > 0 ? w : 1,
          verdict,
          evidence: str(x.evidence),
          note: str(x.note),
        };
      });
      const score = typeof dd.score === 'number' ? clamp100(dd.score) : scoreItems(items);
      return { id, label: str(dd.label) || OSCE_DOMAIN_LABEL[id], score, items };
    })
    .filter((d): d is OsceDomain => d !== null);

  const allItems = domains.flatMap((d) => d.items);
  const score = typeof r.score === 'number' ? clamp100(r.score) : scoreItems(allItems);
  const globalRating = RATINGS.includes(r.globalRating as OsceGlobalRating)
    ? (r.globalRating as OsceGlobalRating)
    : ratingForScore(score);

  const criticalErrors: OsceCriticalError[] = (Array.isArray(r.criticalErrors) ? r.criticalErrors : [])
    .map((e) => {
      const x = (e ?? {}) as Record<string, unknown>;
      const severity = SEVERITIES.includes(x.severity as OsceCriticalError['severity'])
        ? (x.severity as OsceCriticalError['severity'])
        : 'warning';
      return { severity, title: str(x.title), detail: str(x.detail) };
    })
    .filter((e) => e.title);

  const skillsRaw = (r.skills ?? {}) as Record<string, unknown>;
  const skills: SkillScores = {};
  for (const k of SKILL_KEYS) {
    if (typeof skillsRaw[k] === 'number') skills[k] = clamp100(skillsRaw[k]);
  }

  return {
    globalRating,
    score,
    domains,
    criticalErrors,
    skills,
    strengths: strList(r.strengths),
    improvements: strList(r.improvements),
    examinerComment: str(r.examinerComment),
  };
}

const RATING_TO_BAND: Record<OsceGlobalRating, VerdictBand> = {
  'clear-fail': 'clear-fail',
  borderline: 'borderline',
  'clear-pass': 'good',
  excellent: 'excellent',
};

const ITEM_TO_CRITERION = { met: 'met', partial: 'partially-met', 'not-met': 'missed' } as const;

/** Map an OSCE marking onto the shared evaluation shape so saved OSCE rows
 *  still render anywhere the regular debrief renderer is used. */
export function osceToEvaluation(caseId: string, r: OsceResult): CaseEvaluationInput {
  const dom = (id: OsceDomainId) => {
    const d = r.domains.find((x) => x.id === id);
    const raw = d ? d.score : r.score;
    return { raw, max: 100, verdict: RATING_TO_BAND[ratingForScore(raw)] };
  };
  const danger = r.criticalErrors.find((e) => e.severity === 'danger');
  return {
    case_id: caseId,
    global_rating: RATING_TO_BAND[r.globalRating],
    domain_scores: {
      data_gathering: dom('data_gathering'),
      clinical_management: dom('clinical_management'),
      interpersonal: dom('interpersonal'),
    },
    criteria: r.domains.flatMap((d) =>
      d.items.map((i) => ({
        criterion_id: i.id,
        domain: d.id,
        verdict: ITEM_TO_CRITERION[i.verdict],
        evidence: [i.label, i.evidence ? `"${i.evidence}"` : '', i.note].filter(Boolean).join(': '),
      })),
    ),
    safety_breach: danger ? { what: `${danger.title}. ${danger.detail}`.trim() } : null,
    highlights: r.strengths,
    improvements: r.improvements,
    narrative: r.examinerComment || `OSCE station marked: ${OSCE_RATING_LABEL[r.globalRating]}.`,
  };
}
