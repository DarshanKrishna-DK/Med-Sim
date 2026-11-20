/**
 * Triage drill vignettes. Pure data: baseline vitals, the correct ESI level,
 * the correct first action and a deterioration curve per case.
 *
 * ESI levels follow the 5-level Emergency Severity Index, shown with the
 * colour scheme used in Indian EDs: 1 red, 2 orange, 3 yellow, 4 green, 5 blue.
 * Cases are plausible but synthetic.
 */

export type EsiLevel = 1 | 2 | 3 | 4 | 5;

export type ActionId =
  | 'resus'
  | 'ecg'
  | 'stroke'
  | 'monitored'
  | 'obstetric'
  | 'treatment'
  | 'waiting'
  | 'fast';

export interface TriageVitals {
  hr: number;
  sbp: number;
  dbp: number;
  rr: number;
  spo2: number;
  temp: number;
  gcs: number;
}

export interface Deterioration {
  /** Seconds after arrival at which the decline begins (if not escalated). */
  onsetS: number;
  /** Seconds the decline takes to reach the full delta. */
  durationS: number;
  /** Change applied at full progress. */
  delta: Partial<TriageVitals>;
  /** Clinical milestones. Each one that fires before escalation is a missed event. */
  events: Array<{ atS: number; text: string }>;
}

export interface TriageCase {
  id: string;
  age: number;
  sex: 'M' | 'F';
  /** Spoken form for the nurse: "sixty-year-old man". */
  who: string;
  complaint: string;
  detail: string;
  esi: EsiLevel;
  action: ActionId;
  alsoOk: ActionId[];
  /** The rule taught on the end card. */
  rule: string;
  vitals: TriageVitals;
  det?: Deterioration;
}

export const ESI_META: Record<EsiLevel, { colour: string; name: string; hex: string }> = {
  1: { colour: 'Red', name: 'Resuscitation', hex: '#ff5a5f' },
  2: { colour: 'Orange', name: 'Emergent', hex: '#ff9a3c' },
  3: { colour: 'Yellow', name: 'Urgent', hex: '#f2d544' },
  4: { colour: 'Green', name: 'Less urgent', hex: '#6fcf6f' },
  5: { colour: 'Blue', name: 'Non-urgent', hex: '#5aa9ff' },
};

export const ACTIONS: Record<ActionId, { label: string; escalates: boolean }> = {
  resus: { label: 'Resus bay + oxygen + IV access', escalates: true },
  ecg: { label: '12-lead ECG within 10 min + monitor', escalates: true },
  stroke: { label: 'Stroke alert: CT brain now, note onset time', escalates: true },
  monitored: { label: 'Monitored bed + IV access + doctor now', escalates: true },
  obstetric: { label: 'Labour room: obstetric review now', escalates: true },
  treatment: { label: 'Treatment room: dressing or procedure', escalates: false },
  waiting: { label: 'Waiting area with re-check', escalates: false },
  fast: { label: 'Fast-track / OPD in turn', escalates: false },
};

export const ACTION_IDS = Object.keys(ACTIONS) as ActionId[];

const v = (
  hr: number, sbp: number, dbp: number, rr: number, spo2: number, temp: number, gcs: number,
): TriageVitals => ({ hr, sbp, dbp, rr, spo2, temp, gcs });

export const TRIAGE_CASES: TriageCase[] = [
  {
    id: 'op-poisoning', age: 35, sex: 'M', who: 'thirty-five-year-old man',
    complaint: 'Vomiting after spraying pesticide',
    detail: 'Farmer, drooling, tiny pupils, wet cough, sweating. Brought by relatives.',
    esi: 1, action: 'resus', alsoOk: [],
    rule: 'SpO2 < 90 and RR > 30 means ESI 1. Organophosphate toxicity needs airway, oxygen, IV access and atropine at once.',
    vitals: v(54, 98, 62, 32, 86, 36.8, 13),
    det: { onsetS: 15, durationS: 60, delta: { spo2: -8, hr: -10, gcs: -3, rr: 6 },
      events: [{ atS: 40, text: 'SpO2 below 80' }, { atS: 70, text: 'GCS falling, secretions blocking airway' }] },
  },
  {
    id: 'dengue-shock', age: 19, sex: 'F', who: 'nineteen-year-old woman',
    complaint: 'Fever for 5 days, now cold and dizzy',
    detail: 'Abdominal pain, vomiting, cold clammy hands, thready pulse.',
    esi: 1, action: 'resus', alsoOk: ['monitored'],
    rule: 'Tachycardia with hypotension and cold peripheries is shock: needs immediate IV access and fluid. ESI 1.',
    vitals: v(128, 82, 62, 26, 94, 37.4, 14),
    det: { onsetS: 20, durationS: 80, delta: { sbp: -20, hr: 14, gcs: -2, spo2: -3 },
      events: [{ atS: 50, text: 'Systolic BP below 70' }, { atS: 90, text: 'Drowsy, pulse barely palpable' }] },
  },
  {
    id: 'rta-head', age: 32, sex: 'M', who: 'thirty-two-year-old man',
    complaint: 'Road accident, no helmet, unrousable',
    detail: 'Motorbike vs lorry. Vomited once, blood from the right ear.',
    esi: 1, action: 'resus', alsoOk: [],
    rule: 'GCS 8 or less means the airway is not protected. Needs immediate lifesaving intervention: ESI 1.',
    vitals: v(58, 168, 96, 10, 91, 36.5, 8),
    det: { onsetS: 20, durationS: 70, delta: { spo2: -6, hr: -12, rr: -4, gcs: -2 },
      events: [{ atS: 45, text: 'Snoring respiration, SpO2 below 88' }, { atS: 80, text: 'Pupil blown, bradycardia' }] },
  },
  {
    id: 'child-rash', age: 4, sex: 'F', who: 'four-year-old girl',
    complaint: 'Fever and a rash that does not fade',
    detail: 'Two days of fever. Purple spots on legs that stay when pressed. Sleepy, limp.',
    esi: 1, action: 'resus', alsoOk: ['monitored'],
    rule: 'Fever with a non-blanching rash in a child is meningococcal septicaemia until proven otherwise: red.',
    vitals: v(156, 82, 50, 36, 94, 39.4, 13),
    det: { onsetS: 15, durationS: 60, delta: { sbp: -22, hr: 18, gcs: -2, spo2: -4 },
      events: [{ atS: 40, text: 'Rash spreading, capillary refill over 5 s' }, { atS: 75, text: 'Hypotensive and unresponsive' }] },
  },
  {
    id: 'heat-stroke', age: 45, sex: 'M', who: 'forty-five-year-old man',
    complaint: 'Collapsed at a brick kiln, confused',
    detail: 'Hot dry skin, rambling speech, no sweating. Works noon shifts in May.',
    esi: 1, action: 'resus', alsoOk: [],
    rule: 'Core temperature above 40 with altered sensorium is heat stroke. Rapid cooling and IV access cannot wait: ESI 1.',
    vitals: v(132, 104, 62, 30, 93, 41.2, 11),
    det: { onsetS: 25, durationS: 70, delta: { gcs: -4, sbp: -22, temp: 0.8, spo2: -3 },
      events: [{ atS: 55, text: 'Seizure' }, { atS: 85, text: 'GCS 6, BP falling' }] },
  },
  {
    id: 'snakebite', age: 28, sex: 'M', who: 'twenty-eight-year-old man',
    complaint: 'Snakebite on the foot 40 minutes ago',
    detail: 'Drooping eyelids, difficulty swallowing saliva. Local swelling is mild.',
    esi: 2, action: 'resus', alsoOk: ['monitored'],
    rule: 'Ptosis after a snakebite means neurotoxic envenomation and impending respiratory failure. High-risk: at least ESI 2 with ASV and airway ready.',
    vitals: v(112, 118, 74, 20, 96, 37.0, 15),
    det: { onsetS: 30, durationS: 90, delta: { spo2: -9, rr: 8, hr: 8, gcs: -2 },
      events: [{ atS: 60, text: 'Cannot open eyes or swallow' }, { atS: 100, text: 'SpO2 below 88, weak breathing' }] },
  },
  {
    id: 'dka', age: 22, sex: 'M', who: 'twenty-two-year-old man',
    complaint: 'Vomiting, deep fast breathing, known type 1 diabetes',
    detail: 'Missed insulin for 2 days. Fruity breath, abdominal pain, drowsy but answers.',
    esi: 2, action: 'monitored', alsoOk: ['resus'],
    rule: 'High-risk presentation with danger-zone vitals (HR over 100, RR over 20): ESI 2. Needs a monitored bed, IV fluids, glucose and ketones.',
    vitals: v(122, 100, 64, 34, 98, 37.1, 14),
    det: { onsetS: 30, durationS: 90, delta: { gcs: -3, sbp: -14, hr: 10 },
      events: [{ atS: 70, text: 'Now only responds to voice' }] },
  },
  {
    id: 'mi', age: 60, sex: 'M', who: 'sixty-year-old man',
    complaint: 'Chest pain for 40 minutes, sweating',
    detail: 'Heavy central pressure spreading to the left arm. Smoker, diabetic.',
    esi: 2, action: 'ecg', alsoOk: ['monitored', 'resus'],
    rule: 'Chest pain suggestive of ACS is high-risk: 12-lead ECG within 10 minutes of arrival, then monitor.',
    vitals: v(104, 100, 64, 22, 95, 36.9, 15),
    det: { onsetS: 35, durationS: 70, delta: { sbp: -22, hr: 16, spo2: -4 },
      events: [{ atS: 70, text: 'Ventricular tachycardia on the monitor' }, { atS: 105, text: 'Cardiogenic shock' }] },
  },
  {
    id: 'stroke', age: 68, sex: 'F', who: 'sixty-eight-year-old woman',
    complaint: 'Sudden weakness of the right side and slurred speech',
    detail: 'Last seen well 50 minutes ago. Face drooping on the right. Known hypertensive.',
    esi: 2, action: 'stroke', alsoOk: ['monitored', 'resus'],
    rule: 'Stroke inside the thrombolysis window: time is brain. Stroke alert, CT now, note the last-known-well time.',
    vitals: v(88, 184, 100, 18, 96, 36.8, 14),
    det: { onsetS: 40, durationS: 100, delta: { gcs: -3, sbp: 12 },
      events: [{ atS: 80, text: 'Window shrinking: 1 h 10 min since onset' }, { atS: 120, text: 'Drowsy, new vomiting' }] },
  },
  {
    id: 'asthma', age: 24, sex: 'F', who: 'twenty-four-year-old woman',
    complaint: 'Severe breathlessness, speaks in single words',
    detail: 'Known asthma, ran out of inhaler. Audible wheeze, using neck muscles.',
    esi: 2, action: 'resus', alsoOk: ['monitored'],
    rule: 'Severe asthma (single words, accessory muscles, SpO2 near 90) is high-risk: oxygen and nebulisers now, ESI 2.',
    vitals: v(124, 124, 78, 30, 91, 37.0, 15),
    det: { onsetS: 20, durationS: 70, delta: { spo2: -7, hr: 12, rr: -6, gcs: -2 },
      events: [{ atS: 45, text: 'SpO2 below 88' }, { atS: 80, text: 'Silent chest, tiring, drowsy' }] },
  },
  {
    id: 'pregnancy-bleed', age: 28, sex: 'F', who: 'twenty-eight-year-old pregnant woman',
    complaint: 'Heavy vaginal bleeding at 34 weeks',
    detail: 'Constant lower abdominal pain, hard abdomen, soaking cloth. Feels faint.',
    esi: 2, action: 'obstetric', alsoOk: ['resus', 'monitored'],
    rule: 'Third-trimester bleeding with pain is abruption or previa until proven otherwise. High-risk for mother and baby: ESI 2, IV access and obstetric review now.',
    vitals: v(118, 96, 60, 24, 97, 37.0, 15),
    det: { onsetS: 25, durationS: 80, delta: { sbp: -18, hr: 16, gcs: -1 },
      events: [{ atS: 60, text: 'Systolic BP below 80, fetal movements reduced' }] },
  },
  {
    id: 'fever-adult', age: 35, sex: 'M', who: 'thirty-five-year-old man',
    complaint: 'Fever for 3 days with cough',
    detail: 'Eating and drinking, walking in on his own. Needs bloods and a chest X-ray.',
    esi: 3, action: 'waiting', alsoOk: ['fast', 'monitored'],
    rule: 'Stable vitals but two or more resources (labs and imaging): ESI 3. Wait with a scheduled re-check.',
    vitals: v(96, 120, 78, 18, 97, 38.4, 15),
  },
  {
    id: 'ankle', age: 26, sex: 'M', who: 'twenty-six-year-old man',
    complaint: 'Twisted ankle playing football',
    detail: 'Swollen and tender over the outer ankle, can take a few steps. Normal vitals.',
    esi: 4, action: 'fast', alsoOk: ['waiting', 'treatment'],
    rule: 'Stable with a single resource (one X-ray): ESI 4. Fast-track, no resus space needed.',
    vitals: v(78, 124, 80, 16, 99, 36.8, 15),
  },
  {
    id: 'laceration', age: 19, sex: 'M', who: 'nineteen-year-old man',
    complaint: 'Cut on the forearm from broken glass',
    detail: 'Three centimetre clean wound, bleeding controlled with a cloth, fingers move normally.',
    esi: 4, action: 'treatment', alsoOk: ['fast', 'waiting'],
    rule: 'One resource (suturing), stable vitals, no tendon or vessel signs: ESI 4 to the treatment room.',
    vitals: v(82, 126, 78, 16, 99, 36.7, 15),
  },
  {
    id: 'dental', age: 40, sex: 'F', who: 'forty-year-old woman',
    complaint: 'Toothache for 2 days',
    detail: 'Mild cheek swelling, no fever, eating normally, no trouble opening the mouth.',
    esi: 5, action: 'fast', alsoOk: ['waiting'],
    rule: 'No resources beyond a prescription or a dental referral: ESI 5. Do not occupy an ED bay.',
    vitals: v(76, 122, 78, 16, 99, 36.8, 15),
  },
];
