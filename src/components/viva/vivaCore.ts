// Viva voce exam: pure data + logic (no React, no DOM, type-only imports) so
// scripts/test/viva.test.ts can load it directly under Node.
//
// Backend contracts (backend/viva.py):
//   POST /agent/viva/plan  {subject, topic, year, lang, count?, fresh?} -> {questions: VivaQuestion[], cached}
//   POST /agent/viva/grade {subject, topic, year, plan, transcript, lang} -> VivaGrade
//   POST /agent/viva/ask   {system, messages, lang} -> {reply}

import type { Lang } from '../../game/lang';

export type VivaVerdict = 'correct' | 'partial' | 'incorrect' | 'not asked';

export interface VivaQuestion {
  id: string;
  q: string;
  keyPoints: string[];
  difficulty: 1 | 2 | 3;
  followUps: string[];
}

export interface VivaSetup {
  subjectId: string;
  subject: string;
  topic: string;
  year: string;
  lang: Lang;
}

export interface VivaLine {
  who: 'examiner' | 'student';
  text: string;
  /** ms since the viva started. */
  at: number;
}

export interface VivaGradeItem {
  id: string;
  q: string;
  difficulty: 1 | 2 | 3;
  verdict: VivaVerdict;
  expected: string;
  said: string;
  note: string;
}

export interface VivaGrade {
  score: number;
  asked: number;
  total: number;
  perQuestion: VivaGradeItem[];
  strengths: string[];
  gaps: string[];
  recommendedReading: string[];
  examinerComment: string;
}

/** What a history row keeps for the result screen. */
export interface SavedViva extends VivaGrade {
  subjectId: string;
  subject: string;
  topic: string;
  year: string;
  lang: Lang;
  durationSec: number;
  transcript: VivaLine[];
}

/** About six minutes: calm, no alarm, the examiner closes when it runs out. */
export const VIVA_DURATION_MS = 6 * 60 * 1000;
export const VIVA_QUESTION_COUNT = 8;

/** Words the examiner persona is told to use (in English, in every language)
 *  so the question counter and the end of the viva can be detected. */
export const NEXT_MARKER = 'Next question';
export const CLOSING_LINE = 'That will be all.';

export const VIVA_YEARS = [
  { id: '1', label: '1st year MBBS' },
  { id: '2', label: '2nd year MBBS' },
  { id: '3', label: '3rd year MBBS (Part 1)' },
  { id: '4', label: 'Final year MBBS' },
  { id: 'intern', label: 'Intern / PG entrance' },
] as const;

export type VivaYearId = (typeof VIVA_YEARS)[number]['id'];

export interface VivaSubject {
  id: string;
  label: string;
  /** Professional year the subject is examined in (CBME). */
  year: VivaYearId;
  topics: string[];
}

export const VIVA_SUBJECTS: VivaSubject[] = [
  { id: 'anatomy', label: 'Anatomy', year: '1', topics: ['Brachial plexus', 'Femoral triangle', 'Inguinal canal', 'Knee joint', 'Facial nerve', 'Development of the heart', 'Thyroid gland'] },
  { id: 'physiology', label: 'Physiology', year: '1', topics: ['Cardiac cycle', 'Nerve action potential', 'Oxygen-haemoglobin dissociation curve', 'Regulation of blood pressure', 'Neuromuscular junction', 'Renal handling of sodium', 'Menstrual cycle'] },
  { id: 'biochemistry', label: 'Biochemistry', year: '1', topics: ['Glycolysis', 'Enzyme kinetics', 'Urea cycle', 'Lipoproteins', 'Vitamin B12 and folate', 'Acid-base balance', 'Haem synthesis and porphyrias'] },
  { id: 'pharmacology', label: 'Pharmacology', year: '2', topics: ['Autonomic drugs', 'Antihypertensives', 'Beta-lactam antibiotics', 'Antitubercular drugs', 'Insulin and oral hypoglycaemics', 'NSAIDs', 'Anticoagulants', 'Antiepileptics'] },
  { id: 'pathology', label: 'Pathology', year: '2', topics: ['Inflammation', 'Neoplasia', 'Cell injury and necrosis', 'Thrombosis and embolism', 'Anaemias', 'Leukaemias', 'Pathology of tuberculosis'] },
  { id: 'microbiology', label: 'Microbiology', year: '2', topics: ['Sterilisation and disinfection', 'Hypersensitivity reactions', 'Mycobacterium tuberculosis', 'Staphylococcus', 'HIV', 'Malaria parasites', 'Dengue virus'] },
  { id: 'forensic-medicine', label: 'Forensic Medicine', year: '3', topics: ['Postmortem changes', 'Identification', 'Mechanical injuries', 'Asphyxial deaths', 'Organophosphate poisoning', 'Snake bite', 'Medical negligence'] },
  { id: 'community-medicine', label: 'Community Medicine', year: '3', topics: ['Epidemiological study designs', 'Screening tests', 'National immunisation schedule', 'TB control (NTEP)', 'Nutrition programmes', 'Biomedical waste management', 'Malaria control'] },
  { id: 'medicine', label: 'Medicine', year: '4', topics: ['Heart failure', 'Diabetes mellitus', 'Acute coronary syndrome', 'Pulmonary tuberculosis', 'Chronic kidney disease', 'Stroke', 'Dengue fever'] },
  { id: 'surgery', label: 'Surgery', year: '4', topics: ['Acute appendicitis', 'Thyroid swellings', 'Breast lump', 'Inguinal hernia', 'Burns', 'Shock', 'Obstructive jaundice'] },
  { id: 'obg', label: 'Obstetrics and Gynaecology', year: '4', topics: ['Antenatal care', 'Normal labour', 'Pre-eclampsia', 'Postpartum haemorrhage', 'Anaemia in pregnancy', 'Ectopic pregnancy', 'Contraception'] },
  { id: 'paediatrics', label: 'Paediatrics', year: '4', topics: ['Developmental milestones', 'Severe acute malnutrition', 'Neonatal jaundice', 'Immunisation schedule', 'Acute diarrhoea and ORS', 'Nephrotic syndrome', 'Febrile seizures'] },
];

export function subjectById(id: string): VivaSubject {
  return VIVA_SUBJECTS.find((s) => s.id === id) ?? VIVA_SUBJECTS[3];
}

export function yearLabel(id: string): string {
  return VIVA_YEARS.find((y) => y.id === id)?.label ?? id;
}

// ── normalisers (the backend already validates; these keep the UI safe) ──

const str = (v: unknown, n = 400): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, n) : '');
const strList = (v: unknown, max: number, n = 240): string[] =>
  Array.isArray(v) ? v.map((x) => str(x, n)).filter(Boolean).slice(0, max) : [];
const diff = (v: unknown): 1 | 2 | 3 => (v === 1 || v === 3 ? v : 2);

export function normalizePlan(raw: unknown): VivaQuestion[] {
  const list = Array.isArray(raw) ? raw : (raw as { questions?: unknown })?.questions;
  if (!Array.isArray(list)) return [];
  const out: VivaQuestion[] = [];
  for (const item of list) {
    const r = item as Record<string, unknown>;
    const q = str(r?.q, 240);
    const keyPoints = strList(r?.keyPoints, 6, 140);
    if (!q || !keyPoints.length) continue;
    out.push({ id: str(r.id, 8) || `q${out.length + 1}`, q, keyPoints, difficulty: diff(r.difficulty), followUps: strList(r.followUps, 3, 160) });
    if (out.length >= 10) break;
  }
  return out;
}

const VERDICTS: VivaVerdict[] = ['correct', 'partial', 'incorrect', 'not asked'];

export function normalizeGrade(raw: unknown): VivaGrade | null {
  const r = raw as Record<string, unknown> | null;
  if (!r || typeof r !== 'object' || !Array.isArray(r.perQuestion)) return null;
  const perQuestion: VivaGradeItem[] = (r.perQuestion as Record<string, unknown>[]).map((p, i) => ({
    id: str(p?.id, 8) || `q${i + 1}`,
    q: str(p?.q, 240),
    difficulty: diff(p?.difficulty),
    verdict: VERDICTS.includes(p?.verdict as VivaVerdict) ? (p.verdict as VivaVerdict) : 'not asked',
    expected: str(p?.expected, 300),
    said: str(p?.said, 240),
    note: str(p?.note, 240),
  }));
  const score = typeof r.score === 'number' && Number.isFinite(r.score) ? Math.max(0, Math.min(100, Math.round(r.score))) : 0;
  return {
    score,
    asked: typeof r.asked === 'number' ? r.asked : perQuestion.filter((p) => p.verdict !== 'not asked').length,
    total: typeof r.total === 'number' ? r.total : perQuestion.length,
    perQuestion,
    strengths: strList(r.strengths, 5),
    gaps: strList(r.gaps, 5),
    recommendedReading: strList(r.recommendedReading, 4),
    examinerComment: str(r.examinerComment, 400),
  };
}

// ── question counter ─────────────────────────────────────────────

const STOP = new Set(
  'the and are what which with that this from for you your have has how why when name tell does give about into its was were can its any two three four one some more most also then than there their them they very good next question okay achha hmm'.split(' '),
);

export function contentTokens(text: string): string[] {
  return (text.toLowerCase().match(/[a-z0-9]+/g) ?? []).filter((t) => t.length > 2 && !STOP.has(t));
}

/** Index of the plan question this examiner line asks, looking ahead at
 *  most `lookahead` questions past `from`. -1 when nothing matches well. */
export function matchQuestion(text: string, plan: VivaQuestion[], from: number, lookahead = 3): number {
  const said = new Set(contentTokens(text));
  if (!said.size) return -1;
  let best = -1;
  let bestScore = 0;
  for (let i = Math.max(0, from); i < Math.min(plan.length, from + lookahead); i++) {
    const qt = [...new Set(contentTokens(plan[i].q))];
    if (!qt.length) continue;
    const shared = qt.filter((t) => said.has(t)).length;
    const score = shared / qt.length;
    if (shared >= 2 && score >= 0.4 && score > bestScore) {
      best = i;
      bestScore = score;
    }
  }
  return best;
}

export function hasNextMarker(text: string): boolean {
  return /\bnext question\b/i.test(text);
}

export function isClosingLine(text: string): boolean {
  return /\bthat will be all\b/i.test(text);
}

/** Question in progress after an examiner line (-1 = still greeting).
 *  Moves forward only: a matching plan question, or "Next question". */
export function advanceQuestion(cur: number, text: string, plan: VivaQuestion[]): number {
  if (!plan.length) return cur;
  const m = matchQuestion(text, plan, cur + 1);
  if (m > cur) return m;
  if (hasNextMarker(text)) return Math.min(plan.length - 1, cur + 1);
  if (cur < 0 && /\?\s*$/.test(text.trim()) && !/\b(ready|begin|start)\b/i.test(text)) return 0;
  return cur;
}

// ── formatting + history ─────────────────────────────────────────

export function formatClock(ms: number): string {
  const s = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export type ScoreBand = 'excellent' | 'good' | 'satisfactory' | 'borderline' | 'clear-fail';

export function scoreBand(score: number): ScoreBand {
  if (score >= 85) return 'excellent';
  if (score >= 70) return 'good';
  if (score >= 55) return 'satisfactory';
  if (score >= 40) return 'borderline';
  return 'clear-fail';
}

export const VERDICT_LABEL: Record<VivaVerdict, string> = {
  correct: 'Correct',
  partial: 'Partly correct',
  incorrect: 'Incorrect',
  'not asked': 'Not asked',
};

export function vivaCaseId(setup: Pick<VivaSetup, 'subjectId' | 'topic'>): string {
  return `viva:${setup.subjectId}:${setup.topic.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}`;
}

/** Transcript for /agent/viva/grade. */
export function gradeTranscript(lines: VivaLine[]): Array<{ role: 'examiner' | 'student'; text: string }> {
  return lines
    .filter((l) => l.text.trim())
    .slice(-160)
    .map((l) => ({ role: l.who, text: l.text.trim().slice(0, 1800) }));
}

/** Chat history for /agent/viva/ask: starts with the student, roles alternate. */
export function askHistory(lines: VivaLine[], max = 24): Array<{ role: 'user' | 'assistant'; content: string }> {
  const msgs = lines
    .filter((l) => l.text.trim())
    .slice(-max)
    .map((l) => ({ role: l.who === 'student' ? ('user' as const) : ('assistant' as const), content: l.text.trim().slice(0, 1800) }));
  while (msgs.length && msgs[0].role === 'assistant') msgs.shift();
  const merged: typeof msgs = [];
  for (const m of msgs) {
    const last = merged[merged.length - 1];
    if (last && last.role === m.role) last.content = `${last.content}\n${m.content}`.slice(0, 2000);
    else merged.push({ ...m });
  }
  return merged;
}
