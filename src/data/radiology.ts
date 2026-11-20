// Radiology reading room: image-interpretation cases.
//
// The answer key lives in radiologyCases.json so the backend grader
// (backend/radiology.py) reads exactly what the browser shows. Images are
// local under public/assets/radiology/ (CC licensed or public domain, from
// Wikimedia Commons); every case carries its attribution, which is shown on
// screen under the film and listed in public/assets/CREDITS.md.

import raw from './radiologyCases.json' with { type: 'json' };

export type RadModality = 'cxr' | 'axr' | 'ecg' | 'ct-head' | 'us' | 'xr-limb';

export interface RadFinding {
  id: string;
  label: string;
  /** Lower-case phrases that count as naming this finding (offline grader). */
  keywords: string[];
  /** Must-not-miss finding: weighted double and highlighted when missed. */
  critical?: boolean;
  /** Consultant's probing question when the student has not mentioned it. */
  probe?: string;
}

export interface RadCredit {
  author: string;
  license: string;
  licenseUrl: string;
  /** Wikimedia Commons file page. */
  source: string;
  /** e.g. "cropped, resized". */
  changes?: string;
}

export interface RadCase {
  id: string;
  modality: RadModality;
  /** e.g. "Chest X-ray, PA view". */
  study: string;
  image: string;
  credit: RadCredit;
  patient: { name: string; age: number; sex: 'M' | 'F'; place: string };
  vignette: string;
  findings: RadFinding[];
  diagnosis: string;
  diagnosisKeywords: string[];
  diagnosisExclude?: string[];
  distractors: string[];
  teaching: string[];
}

export const RAD_CASES: RadCase[] = (raw as { cases: RadCase[] }).cases;

export function getRadCase(id: string): RadCase | undefined {
  return RAD_CASES.find((c) => c.id === id);
}

export const MODALITY_LABEL: Record<RadModality, string> = {
  cxr: 'Chest X-ray',
  axr: 'Abdominal X-ray',
  ecg: 'ECG',
  'ct-head': 'CT head',
  us: 'Ultrasound',
  'xr-limb': 'Fracture X-ray',
};

/** Systematic reading scheme shown on the results card for each modality. */
export const READING_TIP: Record<RadModality, { name: string; steps: string[] }> = {
  cxr: {
    name: 'ABCDE for a chest X-ray',
    steps: [
      'First: patient, date, PA or AP, rotation, inspiration, penetration',
      'A, airway: trachea central, carina, main bronchi',
      'B, breathing: both lungs zone by zone, pleura, costophrenic angles',
      'C, circulation: heart size (CTR), borders, mediastinum, hila',
      'D, disability: bones, ribs, clavicles; and the diaphragm, free gas under it',
      'E, everything else: soft tissues, lines, tubes, review areas (apices, behind the heart)',
    ],
  },
  axr: {
    name: 'Abdominal X-ray in order',
    steps: [
      'Projection: supine or erect',
      'Bowel gas: small bowel (central, valvulae) vs large bowel (peripheral, haustra); the 3-6-9 rule',
      'Air-fluid levels on an erect film; gas in the rectum',
      'Extraluminal gas: under the diaphragm, Rigler sign, biliary tree',
      'Solid organs, calcification, bones and soft tissues',
    ],
  },
  ecg: {
    name: 'ECG in a fixed order',
    steps: [
      'Rate: 300 divided by big squares between R waves',
      'Rhythm: regular or irregular; is there a P before every QRS and a QRS after every P?',
      'Axis: leads I and aVF',
      'Intervals: PR, QRS width, QT',
      'ST segments and T waves: territory and reciprocal change',
      'Put it together with the patient in front of you',
    ],
  },
  'ct-head': {
    name: 'CT head: Blood Can Be Very Bad',
    steps: [
      'Blood: hyperdense collections, their shape (biconvex vs crescent) and site',
      'Cisterns: open or effaced',
      'Brain: grey-white differentiation, hypodensity, midline shift, sulci',
      'Ventricles: size, compression, hydrocephalus',
      'Bone: fractures on bone windows; and soft-tissue swelling',
    ],
  },
  us: {
    name: 'Gallbladder ultrasound checklist',
    steps: [
      'Lumen: echogenic foci, posterior acoustic shadowing, mobility',
      'Wall: thickness (normal under 3 mm), oedema',
      'Around it: pericholecystic fluid; sonographic Murphy sign',
      'Ducts: CBD diameter, intrahepatic dilatation',
    ],
  },
  'xr-limb': {
    name: 'ABCS for a fracture film',
    steps: [
      'Adequacy: two views at right angles, joint above and below',
      'Alignment: displacement, angulation, rotation, shortening',
      'Bones: trace every cortex, name the bone and the part',
      'Cartilage and joints: intra-articular extension, dislocation',
      'Soft tissues: swelling, fat pads, gas',
    ],
  },
};

// ── answer options ──────────────────────────────────────────────

function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Diagnosis + distractors in a stable, case-specific order. */
export function diagnosisOptions(c: RadCase): string[] {
  const all = [c.diagnosis, ...c.distractors];
  return all
    .map((label) => ({ label, k: hash(`${c.id}:${label}`) }))
    .sort((a, b) => a.k - b.k)
    .map((x) => x.label);
}

// ── offline grader (mirrors backend/radiology.py rule grader) ───

export interface RadGrade {
  score: number;
  foundFindings: string[];
  missedFindings: string[];
  missedCritical: string[];
  diagnosisCorrect: boolean;
  correctDiagnosis: string;
  feedback: string;
  gradedBy: 'llm' | 'rules' | 'offline';
}

const NEG = new Set(['no', 'not', 'without', 'absent', 'nil', 'negative', 'none', 'nor', 'rule', 'exclude']);
const CLAUSE = '|';
/** Filler words dropped from text and keywords alike (mirrors backend _STOP). */
const STOP = new Set(['is', 'are', 'the', 'a', 'an', 'seen', 'there']);

export function normText(text: string): string {
  return (text || '')
    .toLowerCase()
    .replace(/\u2019/g, "'")
    .replace(/[,.;:!?\n]+|\bbut\b|\bhowever\b/g, ` ${CLAUSE} `)
    .replace(/[^a-z0-9'|ऀ-෿]+/g, ' ')
    .split(' ')
    .filter((w) => w && !STOP.has(w))
    .join(' ');
}

function escapeRe(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function keywordHit(textN: string, keyword: string): boolean {
  const kw = normText(keyword);
  if (!kw) return false;
  const kwNegative = kw.split(' ').some((w) => NEG.has(w));
  const re = new RegExp(`(?:^|\\s)${escapeRe(kw)}(?=\\s|$)`, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(textN))) {
    if (kwNegative) return true;
    const before = textN.slice(0, m.index).split(CLAUSE).pop()!.split(' ').filter(Boolean).slice(-3);
    if (!before.some((w) => NEG.has(w))) return true;
  }
  return false;
}

export function ruleFound(c: RadCase, text: string): string[] {
  const t = normText(text);
  return c.findings.filter((f) => f.keywords.some((k) => keywordHit(t, k))).map((f) => f.id);
}

export function ruleDiagnosis(c: RadCase, diagnosis: string): boolean {
  const d = normText(diagnosis);
  if (!d) return false;
  if (d === normText(c.diagnosis)) return true;
  if (c.distractors.some((x) => normText(x) === d)) return false;
  if ((c.diagnosisExclude ?? []).some((k) => keywordHit(d, k))) return false;
  return c.diagnosisKeywords.some((k) => keywordHit(d, k));
}

export function scoreFor(c: RadCase, found: string[], dxCorrect: boolean): number {
  const w = (f: RadFinding) => (f.critical ? 2 : 1);
  const total = c.findings.reduce((s, f) => s + w(f), 0) || 1;
  const got = c.findings.filter((f) => found.includes(f.id)).reduce((s, f) => s + w(f), 0);
  return Math.round((60 * got) / total + (dxCorrect ? 40 : 0));
}

/** Used only when the backend cannot be reached. */
export function gradeOffline(c: RadCase, text: string, diagnosis: string): RadGrade {
  const found = ruleFound(c, text);
  const dx = ruleDiagnosis(c, diagnosis);
  const missed = c.findings.filter((f) => !found.includes(f.id));
  const key = missed.find((f) => f.critical) ?? missed[0];
  const feedback = [
    dx ? `Good, the diagnosis is right: ${c.diagnosis}.` : `The diagnosis here is ${c.diagnosis}.`,
    key ? `The most important thing you did not mention: ${key.label.replace(/\.$/, '')}.` : 'You described every key finding.',
  ].join(' ');
  return {
    score: scoreFor(c, found, dx),
    foundFindings: c.findings.filter((f) => found.includes(f.id)).map((f) => f.label),
    missedFindings: missed.map((f) => f.label),
    missedCritical: missed.filter((f) => f.critical).map((f) => f.label),
    diagnosisCorrect: dx,
    correctDiagnosis: c.diagnosis,
    feedback,
    gradedBy: 'offline',
  };
}

/** Offline probing question: the first missed must-not-miss finding's probe. */
export function probeOffline(c: RadCase, text: string): string {
  const found = ruleFound(c, text);
  const missed = c.findings.filter((f) => !found.includes(f.id)).sort((a, b) => Number(!!b.critical) - Number(!!a.critical));
  return missed.find((f) => f.probe)?.probe ?? 'Good, that covers it. So, what is your diagnosis, and what would you do next?';
}
