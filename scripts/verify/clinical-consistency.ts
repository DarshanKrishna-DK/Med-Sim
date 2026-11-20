/**
 * Clinical consistency checks over every case (ER + all polyclinic clinics,
 * including real-case adaptations and any clinic wired into
 * POLYCLINIC_CASES later).
 *
 * Checks:
 * - correctDiagnosisId is in diagnosisOptions and every option has a label.
 * - testResults testIds, treatment ids and medication ids all resolve.
 * - abnormal flags agree with numeric values for common labs (reference
 *   table below), and with explicit "(low)" / "(high)" annotations.
 * - vitals are physiologically plausible for age.
 * - sex-specific diagnoses and tests match the patient's sex.
 * - paediatric cases (< 12 y): every systemic drug indicated for the
 *   diagnosis carries paediatric (mg/kg or child) dosing guidance.
 *
 * Intentional edge cases are whitelisted in WHITELIST with a reason.
 * Fix the DATA for real errors; only whitelist what is clinically intended.
 */

import { PATIENT_CASES, DIAGNOSIS_LABELS } from '../../src/data/patients.ts';
import { POLYCLINIC_CASES, POLYCLINIC_DIAGNOSIS_LABELS } from '../../src/data/polyclinicPatients.ts';
import { TESTS } from '../../src/data/tests.ts';
import { TREATMENTS } from '../../src/data/treatments.ts';
import { MEDICATIONS } from '../../src/data/medications.ts';
import { REAL_CASE_MED_LINKS } from '../../src/data/realCases.ts';
import type { PatientCase } from '../../src/game/types.ts';

type Violation = { case: string; rule: string; detail: string };

/**
 * Key: `${caseId}|${rule}` or `${caseId}|${rule}|${testId}`.
 * Value: why the apparent inconsistency is clinically intended.
 */
const WHITELIST: Record<string, string> = {
  // (entries added during the clinical audit, see src/data/CLINICAL_AUDIT.md)
  'derm-009|lab annotated high but in/below range':
    'TSH 4.2 is above the 4.0 mIU/L upper limit many Indian labs report; the script uses a lenient 4.5. Borderline-high TSH is the intended clue to thyroid autoimmunity alongside alopecia areata.',
  'rc-dermatology-1|lab annotated high but in/below range':
    'Real case report value (SGPT 30.9 U/L "borderline high"). Female ALT ULN is 25-33 U/L by ACG 2017; the script uses a unisex 40.',
};

// ── Reference ranges ─────────────────────────────────────────────────────
// Deliberately simple adult/paediatric ranges. A value is only reported
// when it is clearly outside the range (lo/hi) and flagged normal, or when
// an explicit "(low)/(high)" annotation contradicts the range.

type Range = { lo?: number; hi?: number };

function hbRange(age: number, sex: 'M' | 'F', dx: string): Range | null {
  if (age < 0.5) return null; // neonatal Hb not modelled
  // Pregnancy: NICE CG62 / WHO anaemia cut-off 10.5-11 g/dL. Postpartum cases beyond 6 weeks use the non-pregnant cut-off.
  if (sex === 'F' && /pregnan|gestational|preeclamp|hyperemesis/.test(dx)) return { lo: 10.5, hi: 15 };
  if (age < 5) return { lo: 11, hi: 14.5 };
  if (age < 12) return { lo: 11.5, hi: 15.5 };
  if (age < 15) return { lo: 12, hi: 16 };
  return sex === 'M' ? { lo: 13, hi: 17.5 } : { lo: 12, hi: 16 };
}
function wbcRange(age: number): Range {
  if (age < 1) return { lo: 6, hi: 17.5 };
  if (age < 6) return { lo: 5, hi: 15.5 };
  if (age < 12) return { lo: 4.5, hi: 13.5 };
  return { lo: 4, hi: 11 };
}
function creatRange(age: number, sex: 'M' | 'F'): Range {
  if (age < 12) return { hi: 0.8 };
  return sex === 'M' ? { hi: 1.3 } : { hi: 1.1 };
}

interface Analyte {
  key: string;
  tests: string[];
  /** Regex with the numeric value in group 1. */
  re: RegExp;
  range: (c: PatientCase) => Range | null;
  /** Normalise units (e.g. /mm3 to x10^3). */
  norm?: (v: number, tail: string) => number;
}

const NUM = '([0-9]+(?:,[0-9]{3})*(?:\\.[0-9]+)?)';

const ANALYTES: Analyte[] = [
  {
    key: 'Hb',
    tests: ['cbc'],
    re: new RegExp(`\\b(?:Hgb|Hb|Haemoglobin|Hemoglobin)\\s*(?:of|:|was)?\\s*${NUM}`, 'gi'),
    range: (c) => hbRange(c.age, c.gender, c.correctDiagnosisId),
    norm: (v) => (v > 30 ? v / 10 : v), // g/L to g/dL
  },
  {
    key: 'WBC',
    tests: ['cbc'],
    re: new RegExp(`\\b(?:WBC|TLC|white cell count|white cells)\\s*(?:of|:)?\\s*${NUM}`, 'gi'),
    range: (c) => wbcRange(c.age),
    norm: (v) => (v >= 500 ? v / 1000 : v),
  },
  {
    key: 'platelets',
    tests: ['cbc'],
    re: new RegExp(`\\b(?:platelets?|plt)\\s*(?:count)?\\s*(?:of|:)?\\s*${NUM}`, 'gi'),
    range: () => ({ lo: 150, hi: 450 }),
    norm: (v, tail) => {
      if (/^\s*lakh/i.test(tail)) return v * 100;
      return v >= 2000 ? v / 1000 : v;
    },
  },
  {
    key: 'Na',
    tests: ['bmp'],
    re: new RegExp(`\\b(?:Na|sodium)\\s*(?:of|:)?\\s*${NUM}`, 'gi'),
    range: () => ({ lo: 135, hi: 145 }),
  },
  {
    key: 'K',
    tests: ['bmp'],
    re: new RegExp(`\\b(?:K|potassium)\\s*(?:of|:)?\\s*${NUM}`, 'g'),
    range: () => ({ lo: 3.5, hi: 5.1 }),
  },
  {
    key: 'creatinine',
    tests: ['bmp'],
    re: new RegExp(`\\b(?:creatinine|Cr)\\s*(?:of|:)?\\s*${NUM}`, 'gi'),
    range: (c) => creatRange(c.age, c.gender),
    norm: (v) => (v > 20 ? v / 88.4 : v), // umol/L to mg/dL
  },
  {
    key: 'HbA1c',
    tests: ['hba1c'],
    re: new RegExp(`(?:HbA1c\\s*(?:of|:)?\\s*)?${NUM}\\s*%`, 'gi'),
    range: () => ({ hi: 5.6 }),
  },
  {
    key: 'TSH',
    tests: ['tsh'],
    re: new RegExp(`(?:TSH\\s*(?:of|:)?\\s*)?${NUM}\\s*(?:mIU|uIU|µIU|mU)`, 'gi'),
    range: () => ({ lo: 0.4, hi: 4.5 }),
  },
  {
    key: 'ALT',
    tests: ['lft'],
    re: new RegExp(`\\b(?:ALT|SGPT)\\s*(?:of|:)?\\s*${NUM}`, 'gi'),
    range: () => ({ hi: 40 }),
  },
  {
    key: 'AST',
    tests: ['lft'],
    re: new RegExp(`\\b(?:AST|SGOT)\\s*(?:of|:)?\\s*${NUM}`, 'gi'),
    range: () => ({ hi: 40 }),
  },
  {
    key: 'bilirubin',
    tests: ['lft'],
    re: new RegExp(`\\b(?:total\\s+)?bilirubin\\s*(?:of|:)?\\s*${NUM}`, 'gi'),
    range: () => ({ hi: 1.2 }),
    norm: (v, tail) => (/^\s*(?:umol|µmol)/i.test(tail) ? v / 17.1 : v),
  },
  {
    key: 'CRP',
    tests: ['crp'],
    re: new RegExp(`(?:CRP\\s*(?:of|:)?\\s*)?${NUM}\\s*mg\\/L`, 'gi'),
    range: () => ({ hi: 5 }),
  },
  {
    key: 'troponin',
    tests: ['troponin'],
    re: new RegExp(`${NUM}\\s*ng\\/(L|mL)`, 'gi'),
    range: () => ({ hi: 30 }),
  },
];

const LOW_WORDS = /\b(low|reduced|decreased|deficien|severely low|subnormal)\b/i;
const HIGH_WORDS = /\b(high|elevated|raised|increased|above)\b/i;

function parseNum(s: string): number {
  return Number(s.replace(/,/g, ''));
}

function checkLabs(c: PatientCase, out: Violation[]) {
  for (const tr of c.testResults) {
    const analytes = ANALYTES.filter((a) => a.tests.includes(tr.testId));
    if (!analytes.length) continue;
    // Glucose on the BMP / bedside glucose test.
    let anyOut = false;
    let parsed = 0;
    for (const a of analytes) {
      const rng = a.range(c);
      if (!rng) continue;
      a.re.lastIndex = 0;
      let m: RegExpExecArray | null;
      while ((m = a.re.exec(tr.result))) {
        let v = parseNum(m[1]);
        if (!Number.isFinite(v)) continue;
        const after = tr.result.slice(m.index + m[0].length, m.index + m[0].length + 40);
        if (a.key === 'troponin' && m[2] === 'mL') v = v * 1000;
        if (a.norm) v = a.norm(v, after);
        parsed += 1;
        const low = rng.lo !== undefined && v < rng.lo;
        const high = rng.hi !== undefined && v > rng.hi;
        if (low || high) anyOut = true;
        // Explicit annotation right after the value, e.g. "9.2 g/dL (low)".
        const ann = after.match(/^[^,;()]{0,14}\(([^)]*)\)/);
        if (ann) {
          const t = ann[1];
          if (/normal/i.test(t) && !/(low|high|elevated|upper|border)/i.test(t) && (low || high)) {
            out.push({ case: c.id, rule: 'lab annotated normal but out of range', detail: `${tr.testId}: ${a.key} ${v} (${t})` });
          } else if (LOW_WORDS.test(t) && !low && !/normal/i.test(t)) {
            out.push({ case: c.id, rule: 'lab annotated low but in/above range', detail: `${tr.testId}: ${a.key} ${v} (${t})` });
          } else if (HIGH_WORDS.test(t) && !high && !/normal/i.test(t)) {
            out.push({ case: c.id, rule: 'lab annotated high but in/below range', detail: `${tr.testId}: ${a.key} ${v} (${t})` });
          }
        }
      }
    }
    if (anyOut && !tr.abnormal) {
      out.push({ case: c.id, rule: 'out-of-range lab flagged normal', detail: `${tr.testId}: ${tr.result}` });
    }
    if (
      parsed > 0 &&
      !anyOut &&
      tr.abnormal &&
      /\bnormal\b/i.test(tr.result) &&
      !/\b(ab|not |sub)normal|low|high|elevat|raised|positive|reactive|border|mild|reduced|deficien|predomin|shift|atypical|smear|blast|elevation/i.test(tr.result)
    ) {
      out.push({ case: c.id, rule: 'in-range lab flagged abnormal', detail: `${tr.testId}: ${tr.result}` });
    }
  }
  checkGlucose(c, out);
}

function checkGlucose(c: PatientCase, out: Violation[]) {
  for (const tr of c.testResults) {
    if (tr.testId !== 'glucose' && tr.testId !== 'bmp') continue;
    const re = /\b(fasting|random|post-?prandial|2-?h(?:r|our)? (?:OGTT|post-?load)|glucose)\b[^0-9]{0,12}([0-9]+(?:\.[0-9]+)?)\s*(mg\/dL|mmol\/L)?/gi;
    let m: RegExpExecArray | null;
    while ((m = re.exec(tr.result))) {
      let v = Number(m[2]);
      if (m[3] && /mmol/i.test(m[3])) v *= 18;
      const kind = m[1].toLowerCase();
      const fasting = kind === 'fasting';
      const diabetic = fasting ? v >= 126 : v >= 200;
      const hypo = v < 60;
      if ((diabetic || hypo) && !tr.abnormal) {
        out.push({ case: c.id, rule: 'out-of-range glucose flagged normal', detail: `${tr.testId}: ${tr.result}` });
      }
    }
  }
}

// ── Vitals ───────────────────────────────────────────────────────────────

function vitalLimits(age: number) {
  if (age < 1) return { hr: [80, 220], rr: [20, 80], sbp: [50, 120] };
  if (age < 6) return { hr: [70, 200], rr: [15, 60], sbp: [60, 130] };
  if (age < 12) return { hr: [55, 180], rr: [12, 45], sbp: [70, 145] };
  return { hr: [35, 180], rr: [8, 45], sbp: [70, 230] };
}

function checkVitals(c: PatientCase, out: Violation[]) {
  const v = c.vitals;
  const lim = vitalLimits(c.age);
  const bp = /^(\d{2,3})\/(\d{2,3})$/.exec(v.bp.trim());
  if (!bp) {
    out.push({ case: c.id, rule: 'vitals: unparseable BP', detail: v.bp });
  } else {
    const sbp = Number(bp[1]);
    const dbp = Number(bp[2]);
    if (sbp < lim.sbp[0] || sbp > lim.sbp[1]) out.push({ case: c.id, rule: 'vitals: implausible SBP for age', detail: `${v.bp} at age ${c.age}` });
    if (dbp >= sbp || sbp - dbp < 15 || dbp < 25 || dbp > 140) out.push({ case: c.id, rule: 'vitals: implausible DBP / pulse pressure', detail: v.bp });
  }
  if (v.hr < lim.hr[0] || v.hr > lim.hr[1]) out.push({ case: c.id, rule: 'vitals: implausible HR for age', detail: `${v.hr} at age ${c.age}` });
  if (v.rr < lim.rr[0] || v.rr > lim.rr[1]) out.push({ case: c.id, rule: 'vitals: implausible RR for age', detail: `${v.rr} at age ${c.age}` });
  if (v.spo2 < 70 || v.spo2 > 100) out.push({ case: c.id, rule: 'vitals: implausible SpO2', detail: String(v.spo2) });
  if (v.temp < 34 || v.temp > 42) out.push({ case: c.id, rule: 'vitals: implausible temp (expects Celsius)', detail: String(v.temp) });
  if (c.age < 0 || c.age > 105) out.push({ case: c.id, rule: 'implausible age', detail: String(c.age) });
}

// ── Sex-specific diagnoses / tests ───────────────────────────────────────

const FEMALE_DX = /(pregnan|pcos|endometrio|menorrh|menopaus|ovari|cervical-(?:cancer|insufficiency|ectropion|intraepithelial)|cervicitis|cin-|vaginos|vulvovag|vaginitis|^pid|postpartum|gestational|pre-?eclamp|fibroid|ectopic|hyperemesis|amenorr|dysmenorr|postmenopausal|obgyn)/i;
const MALE_DX = /(bph|prostat|testic|erectile|varicocele|hydrocele|epididym|phimosis|hypospad|cryptorch)/i;
const FEMALE_TESTS = new Set(['pap-smear']);
const MALE_TESTS = new Set(['psa']);

function checkSex(c: PatientCase, out: Violation[], specialty: string | undefined) {
  if (c.gender === 'M' && (FEMALE_DX.test(c.correctDiagnosisId) || specialty === 'obgyn')) {
    out.push({ case: c.id, rule: 'female-only diagnosis in male patient', detail: c.correctDiagnosisId });
  }
  if (c.gender === 'F' && MALE_DX.test(c.correctDiagnosisId)) {
    out.push({ case: c.id, rule: 'male-only diagnosis in female patient', detail: c.correctDiagnosisId });
  }
  for (const tr of c.testResults) {
    if (c.gender === 'M' && FEMALE_TESTS.has(tr.testId)) out.push({ case: c.id, rule: 'female-only test result in male', detail: tr.testId });
    if (c.gender === 'F' && MALE_TESTS.has(tr.testId)) out.push({ case: c.id, rule: 'male-only test result in female', detail: tr.testId });
    if (c.gender === 'M' && (tr.testId === 'urine-hcg' || tr.testId === 'beta-hcg-q') && /positive/i.test(tr.result) && !/negative/i.test(tr.result)) {
      out.push({ case: c.id, rule: 'positive pregnancy test in male', detail: tr.result });
    }
  }
}

// ── Paediatric dosing ────────────────────────────────────────────────────

const PAEDS_DOSE = /(mg\/kg|mcg\/kg|IU\/kg|child|paed|pediatric|<\s*\d+\s*y|age\s*\d)/i;
const TOPICAL_FORMS = new Set(['cream']);

function checkPaedsDosing(c: PatientCase, out: Violation[]) {
  if (c.age >= 12) return;
  for (const m of MEDICATIONS) {
    if (!m.indications.includes(c.correctDiagnosisId)) continue;
    if (TOPICAL_FORMS.has(m.form)) continue;
    if (!PAEDS_DOSE.test(m.defaultDose)) {
      out.push({ case: c.id, rule: 'paediatric case: indicated drug has adult-only dose', detail: `${m.id} (${m.defaultDose})` });
    }
  }
}

// ── Runner ───────────────────────────────────────────────────────────────

export function verifyClinicalConsistency(): Violation[] {
  const raw: Violation[] = [];
  const testIds = new Set(TESTS.map((t) => t.id));
  const txIds = new Set(TREATMENTS.map((t) => t.id));
  const medIds = new Set(MEDICATIONS.map((m) => m.id));
  const labels: Record<string, string> = { ...DIAGNOSIS_LABELS, ...POLYCLINIC_DIAGNOSIS_LABELS };

  const cases: Array<{ c: PatientCase; specialty?: string }> = PATIENT_CASES.map((c) => ({ c }));
  for (const [specialty, list] of Object.entries(POLYCLINIC_CASES)) {
    if (specialty === 'all-specialties' || !list) continue;
    for (const c of list) cases.push({ c, specialty });
  }

  for (const { c, specialty } of cases) {
    if (!c.diagnosisOptions.includes(c.correctDiagnosisId)) {
      raw.push({ case: c.id, rule: 'correctDiagnosisId not in diagnosisOptions', detail: c.correctDiagnosisId });
    }
    for (const dx of new Set([c.correctDiagnosisId, ...c.diagnosisOptions])) {
      if (!labels[dx]) raw.push({ case: c.id, rule: 'diagnosis has no label', detail: dx });
    }
    if (new Set(c.diagnosisOptions).size !== c.diagnosisOptions.length) {
      raw.push({ case: c.id, rule: 'duplicate diagnosisOptions', detail: c.diagnosisOptions.join(',') });
    }
    for (const tr of c.testResults) {
      if (!testIds.has(tr.testId)) raw.push({ case: c.id, rule: 'unknown testId', detail: tr.testId });
    }
    const seenTests = new Set<string>();
    for (const tr of c.testResults) {
      if (seenTests.has(tr.testId)) raw.push({ case: c.id, rule: 'duplicate testResults testId', detail: tr.testId });
      seenTests.add(tr.testId);
    }
    for (const tx of [...c.acceptableTreatmentIds, ...c.criticalTreatmentIds]) {
      if (!txIds.has(tx)) raw.push({ case: c.id, rule: 'unknown treatment id', detail: tx });
    }
    checkLabs(c, raw);
    checkVitals(c, raw);
    checkSex(c, raw, specialty);
    checkPaedsDosing(c, raw);
  }

  // Medication catalogue integrity.
  const seenMed = new Set<string>();
  for (const m of MEDICATIONS) {
    if (seenMed.has(m.id)) raw.push({ case: `med:${m.id}`, rule: 'duplicate medication id', detail: m.id });
    seenMed.add(m.id);
    for (const dx of m.indications) {
      if (m.contraindications?.includes(dx)) raw.push({ case: `med:${m.id}`, rule: 'diagnosis both indicated and contraindicated', detail: dx });
    }
  }
  for (const id of Object.keys(REAL_CASE_MED_LINKS)) {
    if (!medIds.has(id)) raw.push({ case: `med:${id}`, rule: 'REAL_CASE_MED_LINKS references unknown medication', detail: id });
  }

  return raw.filter((v) => {
    const testId = v.detail.split(':')[0];
    return !(WHITELIST[`${v.case}|${v.rule}`] || WHITELIST[`${v.case}|${v.rule}|${testId}`]);
  });
}

// Allow `node scripts/verify/clinical-consistency.ts` on its own.
if (import.meta.url === `file://${process.argv[1]?.replace(/\\/g, '/')}` || process.argv[1]?.endsWith('clinical-consistency.ts')) {
  const v = verifyClinicalConsistency();
  for (const x of v) console.log(`[${x.case}] ${x.rule}: ${x.detail}`);
  console.log(`${v.length} violation(s)`);
}
