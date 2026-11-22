// Operation theatre drill: data only.
//
// The student is the junior in the theatre: they never operate. Surgeons and
// the anaesthetist call out problems; the student walks to the right station
// (IV pump, drug cart, suction, diathermy, warmer, oxygen, patient) and sets it
// up correctly. Doses and settings are conservative textbook values for
// adults, for training only (not clinical advice):
//   phenylephrine 50 to 100 mcg IV bolus, ephedrine 5 to 10 mg (6 mg usual),
//   atropine 0.6 mg (0.5 to 1 mg), ondansetron 4 mg, paracetamol 1 g (>= 50 kg),
//   tranexamic acid 1 g slow IV, cefazolin 2 g within 60 min before incision,
//   crystalloid bolus 250 to 500 mL (RL / NS), maintenance about 1.5 mL/kg/h,
//   wall suction 100 to 200 mmHg, forced-air warmer at maximum (43 C) then
//   titrate, FiO2 100% for desaturation, WHO Surgical Safety Checklist.

export type StationId = 'iv' | 'drugs' | 'suction' | 'cautery' | 'warmer' | 'oxygen' | 'patient';
export type Speaker = 'surgeon' | 'assistant' | 'anaesthetist' | 'nurse';
export type DrugId = 'phenylephrine' | 'ephedrine' | 'atropine' | 'ondansetron' | 'paracetamol' | 'tranexamic' | 'cefazolin';
export type FluidId = 'RL' | 'NS' | 'blood';
export type CauteryMode = 'cut' | 'coag' | 'bipolar';

export interface Vitals {
  hr: number;
  sbp: number;
  dbp: number;
  spo2: number;
  /** End-tidal CO2 (mmHg); null under spinal (no capnography line). */
  etco2: number | null;
  temp: number;
}

/** Everything the student can do in the theatre. Doses are in the drug's unit. */
export type OTAction =
  /** `emergency`: O negative straight away, without a cross-match (theatre room only). */
  | { kind: 'fluid-bolus'; fluid: FluidId; volumeMl: number; emergency?: boolean }
  | { kind: 'fluid-rate'; fluid: FluidId; rateMlH: number }
  | { kind: 'fluid-stop' }
  | { kind: 'drug'; drug: DrugId; dose: number }
  | { kind: 'suction'; on: boolean; pressure?: number }
  | { kind: 'cautery'; on: boolean; mode?: CauteryMode; padChecked?: boolean }
  | { kind: 'warmer'; on: boolean; tempC?: number }
  | { kind: 'oxygen'; fio2: number }
  | { kind: 'pulse-check' }
  | { kind: 'cap-refill' }
  | { kind: 'allergy-check' }
  /** The labelled cross-match sample the laboratory asked for. */
  | { kind: 'send-sample' }
  /** Bring the human consultant into the theatre room. */
  | { kind: 'call-help' };

export type ActionKind = OTAction['kind'];

export const STATION_OF: Record<ActionKind, StationId> = {
  'fluid-bolus': 'iv',
  'fluid-rate': 'iv',
  'fluid-stop': 'iv',
  drug: 'drugs',
  suction: 'suction',
  cautery: 'cautery',
  warmer: 'warmer',
  oxygen: 'oxygen',
  'pulse-check': 'patient',
  'cap-refill': 'patient',
  'allergy-check': 'patient',
  'send-sample': 'iv',
  'call-help': 'patient',
};

export const STATION_LABEL: Record<StationId, string> = {
  iv: 'IV stand and infusion pump',
  drugs: 'Drug cart',
  suction: 'Suction machine',
  cautery: 'Diathermy unit',
  warmer: 'Patient warmer',
  oxygen: 'Ventilator / O2',
  patient: 'Patient: pulse and wrist band',
};

export const SPEAKER_NAME: Record<Speaker, string> = {
  surgeon: 'Dr. Mehta (surgeon)',
  assistant: 'Dr. Iyer (assistant)',
  anaesthetist: 'Dr. Banerjee (anaesthetist)',
  nurse: 'Sister Mary (scrub nurse)',
};

export const SPEAKER_SHORT: Record<Speaker, string> = {
  surgeon: 'Dr. Mehta',
  assistant: 'Dr. Iyer',
  anaesthetist: 'Dr. Banerjee',
  nurse: 'Sister Mary',
};

// ───────── drugs ─────────

export interface DrugInfo {
  label: string;
  unit: 'mcg' | 'mg' | 'g';
  /** How it is prepared on the cart (shown on the syringe label). */
  prep: string;
  /** Usual adult bolus range [min, max] in `unit`; `ideal` is the textbook dose. */
  range: [number, number];
  ideal: number;
  /** Dose buttons on the cart. One of them is a 10x error on purpose. */
  options: number[];
  /** Vitals effect when given without a matching problem (transient). */
  effect: Partial<Record<'hr' | 'sbp' | 'dbp', number>>;
  what: string;
}

export const DRUGS: Record<DrugId, DrugInfo> = {
  phenylephrine: {
    label: 'Phenylephrine',
    unit: 'mcg',
    prep: '10 mg/mL ampoule diluted to 100 mcg/mL',
    range: [50, 100],
    ideal: 100,
    options: [25, 50, 100, 1000],
    effect: { sbp: 30, dbp: 16, hr: -10 },
    what: 'pure alpha agonist: raises BP by vasoconstriction, may slow the heart',
  },
  ephedrine: {
    label: 'Ephedrine',
    unit: 'mg',
    prep: '30 mg/mL ampoule diluted to 3 mg/mL',
    range: [5, 10],
    ideal: 6,
    options: [3, 6, 10, 60],
    effect: { sbp: 20, dbp: 10, hr: 14 },
    what: 'mixed alpha and beta agonist: raises BP and heart rate',
  },
  atropine: {
    label: 'Atropine',
    unit: 'mg',
    prep: '0.6 mg/mL ampoule',
    range: [0.5, 1],
    ideal: 0.6,
    options: [0.2, 0.6, 1, 6],
    effect: { hr: 34 },
    what: 'anticholinergic: blocks vagal slowing and speeds the heart',
  },
  ondansetron: {
    label: 'Ondansetron',
    unit: 'mg',
    prep: '2 mg/mL, 2 mL ampoule',
    range: [4, 4],
    ideal: 4,
    options: [4, 8, 40],
    effect: {},
    what: '5-HT3 antagonist for PONV prophylaxis, given near the end of surgery',
  },
  paracetamol: {
    label: 'Paracetamol IV',
    unit: 'g',
    prep: '1 g in 100 mL, infuse over 15 minutes',
    range: [1, 1],
    ideal: 1,
    options: [0.5, 1, 10],
    effect: {},
    what: 'simple analgesic, 1 g IV for adults over 50 kg, maximum 4 g a day',
  },
  tranexamic: {
    label: 'Tranexamic acid',
    unit: 'g',
    prep: '100 mg/mL, 10 mL ampoule, slow IV over 10 minutes',
    range: [1, 1],
    ideal: 1,
    options: [0.5, 1, 10],
    effect: {},
    what: 'antifibrinolytic: reduces bleeding, 1 g slow IV',
  },
  cefazolin: {
    label: 'Cefazolin',
    unit: 'g',
    prep: '1 g vial reconstituted, slow IV',
    range: [2, 2],
    ideal: 2,
    options: [1, 2, 20],
    effect: {},
    what: 'first generation cephalosporin for surgical prophylaxis, 2 g IV within 60 minutes before incision (3 g if 120 kg or more)',
  },
};

export const DRUG_IDS = Object.keys(DRUGS) as DrugId[];

export const FLUID_LABEL: Record<FluidId, string> = {
  RL: 'Ringer lactate',
  NS: 'Normal saline 0.9%',
  blood: 'Packed red cells',
};

// ───────── problems ─────────

/** What the student must do. A spec can match several actions. */
export type ExpectSpec =
  | { kind: 'drug'; drug: DrugId }
  | { kind: 'fluid-bolus'; fluids: FluidId[]; range: [number, number] }
  | { kind: 'fluid-rate'; fluids: FluidId[]; range: [number, number] }
  | { kind: 'suction'; range: [number, number] }
  | { kind: 'cautery'; mode: CauteryMode }
  | { kind: 'warmer'; minTemp: number }
  | { kind: 'oxygen'; minFio2: number }
  | { kind: 'pulse-check' };

export type ProblemId =
  | 'antibiotic'
  | 'maintenance'
  | 'hypotension'
  | 'bradycardia'
  | 'hypoxia'
  | 'hypothermia'
  | 'bleeding-field'
  | 'cautery-fail'
  | 'lead-off'
  | 'fluid-loss'
  | 'ooze'
  | 'ponv'
  | 'analgesia';

export interface ProblemDef {
  label: string;
  station: StationId;
  /** Any one of these resolves the problem fully. */
  accept: ExpectSpec[];
  /** Resolves it, but with a note (half marks for the setting). */
  partial?: ExpectSpec[];
  /** The model answer, shown in the debrief and spoken when a senior takes over. */
  model: string;
  teaching: string;
  /** If the right setting is already in place when it starts, it is prevented. */
  preventable?: boolean;
}

export const PROBLEMS: Record<ProblemId, ProblemDef> = {
  antibiotic: {
    label: 'Antibiotic prophylaxis before incision',
    station: 'drugs',
    accept: [{ kind: 'drug', drug: 'cefazolin' }],
    model: 'Cefazolin 2 g IV before the skin incision',
    teaching:
      'Surgical prophylaxis must be in the blood before the knife: cefazolin 2 g IV within 60 minutes before incision (3 g if 120 kg or more), redosed after 4 hours or heavy blood loss. The WHO time-out asks this question for exactly this reason.',
    preventable: true,
  },
  maintenance: {
    label: 'Maintenance IV fluids',
    station: 'iv',
    accept: [{ kind: 'fluid-rate', fluids: ['RL', 'NS'], range: [80, 150] }],
    partial: [{ kind: 'fluid-rate', fluids: ['RL', 'NS'], range: [60, 250] }],
    model: 'Ringer lactate at about 100 mL/h',
    teaching:
      'Maintenance by the 4-2-1 rule is about 100 to 110 mL/h for a 60 to 70 kg adult. Balanced crystalloid (Ringer lactate) is the usual choice; free-running bags or 1000 mL/h risk fluid overload.',
    preventable: true,
  },
  hypotension: {
    label: 'Hypotension',
    station: 'drugs',
    accept: [
      { kind: 'drug', drug: 'phenylephrine' },
      { kind: 'drug', drug: 'ephedrine' },
      { kind: 'fluid-bolus', fluids: ['RL', 'NS'], range: [250, 500] },
    ],
    partial: [{ kind: 'fluid-bolus', fluids: ['RL', 'NS'], range: [100, 1000] }],
    model: 'Phenylephrine 100 mcg IV (or ephedrine 6 mg if the heart rate is low), plus a 250 to 500 mL crystalloid bolus',
    teaching:
      'Anaesthetic drugs and spinal block cause vasodilatation. Treat a fall of more than 20% from baseline (or SBP under 90) quickly: phenylephrine 50 to 100 mcg when the heart rate is normal or high, ephedrine 5 to 10 mg when it is low, and a crystalloid bolus. Then look for the cause: bleeding, deep anaesthesia, surgical compression.',
  },
  bradycardia: {
    label: 'Vagal bradycardia',
    station: 'drugs',
    accept: [{ kind: 'drug', drug: 'atropine' }],
    partial: [{ kind: 'drug', drug: 'ephedrine' }],
    model: 'Ask the surgeon to stop the stimulus (release traction, deflate), then atropine 0.6 mg IV',
    teaching:
      'Peritoneal stretch (pneumoperitoneum, traction on the mesentery or cervix) fires a vagal reflex. Stop the stimulus first, then give atropine 0.6 mg IV (0.5 to 1 mg). Doses under 0.5 mg can paradoxically slow the heart further.',
  },
  hypoxia: {
    label: 'Desaturation',
    station: 'oxygen',
    accept: [{ kind: 'oxygen', minFio2: 90 }],
    partial: [{ kind: 'oxygen', minFio2: 60 }],
    model: 'FiO2 100%, then check the patient, tube and circuit (DOPE)',
    teaching:
      'SpO2 falling: give 100% oxygen first, then work through it: tube position (auscultate, EtCO2 trace), obstruction or kinking, pneumothorax, equipment and circuit disconnection. Pneumoperitoneum and head-down position also reduce lung volume.',
  },
  hypothermia: {
    label: 'Hypothermia',
    station: 'warmer',
    accept: [{ kind: 'warmer', minTemp: 38 }],
    partial: [{ kind: 'warmer', minTemp: 32 }],
    model: 'Forced-air warmer on at 43 C, warm the IV fluids, cover exposed skin',
    teaching:
      'Core temperature under 36 C is inadvertent perioperative hypothermia: it increases bleeding, wound infection and cardiac events. NICE CG65: start forced-air warming, set it at maximum and titrate to keep the patient at 36.5 C or more, and warm IV fluids.',
    preventable: true,
  },
  'bleeding-field': {
    label: 'Blood in the field',
    station: 'suction',
    accept: [{ kind: 'suction', range: [100, 200] }],
    partial: [{ kind: 'suction', range: [60, 300] }],
    model: 'Suction on at about 150 mmHg',
    teaching:
      'The surgeon cannot control a bleeder they cannot see. Wall suction for the field runs at about 100 to 200 mmHg: too low and the Yankauer clogs, too high and it injures tissue and empties the canister fast. Watch the canister: it is your estimate of blood loss.',
    preventable: true,
  },
  'cautery-fail': {
    label: 'Diathermy not working',
    station: 'cautery',
    accept: [{ kind: 'cautery', mode: 'coag' }],
    model: 'Check the return electrode (patient plate) contact, then diathermy on in coag mode',
    teaching:
      'When monopolar diathermy "stops working", never just turn the power up. The usual cause is a loose or peeled return electrode (the patient plate): current then exits elsewhere and can burn the patient. Check the plate is fully stuck over a muscle mass, then restore coag at the usual setting.',
  },
  'lead-off': {
    label: 'Monitor alarm: is it real?',
    station: 'patient',
    accept: [{ kind: 'pulse-check' }],
    model: 'Feel a central or radial pulse and look at the patient before treating the monitor',
    teaching:
      'Treat the patient, not the monitor. A flat ECG with a normal SpO2 trace and EtCO2 is almost always a lead off. Feel for a pulse (carotid or radial, up to 10 seconds) and check the leads before giving any drug.',
  },
  'fluid-loss': {
    label: 'Hypovolaemia from blood loss',
    station: 'iv',
    accept: [{ kind: 'fluid-bolus', fluids: ['RL', 'NS'], range: [250, 500] }],
    partial: [{ kind: 'fluid-bolus', fluids: ['RL', 'NS', 'blood'], range: [100, 1000] }],
    model: 'Crystalloid bolus 500 mL (RL), reassess, send a cross-match if the loss continues',
    teaching:
      'Rising heart rate and falling BP after blood loss: give a 250 to 500 mL crystalloid bolus and reassess. Blood needs a measured loss or haemoglobin and a cross-match: send it early if the bleeding continues, but the first move is fluid.',
  },
  ooze: {
    label: 'Ongoing ooze',
    station: 'drugs',
    accept: [{ kind: 'drug', drug: 'tranexamic' }],
    model: 'Tranexamic acid 1 g IV slowly over 10 minutes',
    teaching:
      'Tranexamic acid 1 g IV over 10 minutes reduces bleeding; in postpartum haemorrhage (WOMAN trial) it saves lives when given within 3 hours. Uterotonics (oxytocin) remain first line for an atonic uterus.',
  },
  ponv: {
    label: 'PONV prophylaxis',
    station: 'drugs',
    accept: [{ kind: 'drug', drug: 'ondansetron' }],
    model: 'Ondansetron 4 mg IV near the end of surgery',
    teaching:
      'Female sex, non-smoker, history of PONV and post-op opioids are the Apfel risk factors. Ondansetron 4 mg IV towards the end of surgery is standard prophylaxis; add dexamethasone for higher risk.',
    preventable: true,
  },
  analgesia: {
    label: 'Post-op analgesia',
    station: 'drugs',
    accept: [{ kind: 'drug', drug: 'paracetamol' }],
    model: 'Paracetamol 1 g IV (adult over 50 kg) before the patient wakes',
    teaching:
      'Multimodal analgesia starts in theatre: paracetamol 1 g IV over 15 minutes for adults over 50 kg (15 mg/kg below that), maximum 4 g a day, plus local infiltration of the wound.',
    preventable: true,
  },
};

// ───────── WHO checklist ─────────

export type ChecklistStage = 'sign-in' | 'time-out' | 'sign-out';

export interface ChecklistItem {
  id: string;
  stage: ChecklistStage;
  speaker: Speaker;
  ask: string;
  options: Array<{ id: string; label: string }>;
  /** Correct option id. 'antibiotic' items are decided from the drug log. */
  correct: string;
  teaching: string;
}

// ───────── scenarios ─────────

export interface OTEventDef {
  id: string;
  problem: ProblemId;
  /** Seconds after skin incision when the speaker calls it. */
  atS: number;
  speaker: Speaker;
  line: string;
  /** Said if still unhandled halfway to the deadline. */
  remind: string;
  ack: string;
  /** Vitals at the moment of the call (absolute) and at the deadline if ignored. */
  onset?: Partial<Vitals>;
  worst?: Partial<Vitals>;
  /** Seconds the student has before a senior takes over. */
  deadlineS: number;
}

export interface OTPatient {
  name: string;
  age: number;
  sex: 'M' | 'F';
  weightKg: number;
  /** On the wrist band only: the student has to read it. */
  allergy: string;
  procedure: string;
  consent: string;
  fasting: string;
  notes: string;
}

export interface OTPhase {
  id: string;
  label: string;
  /** Seconds after incision. */
  atS: number;
}

export interface OTScenario {
  id: string;
  title: string;
  hindi: string;
  kind: 'open' | 'lap' | 'lscs';
  anaesthesia: 'GA' | 'spinal';
  summary: string;
  patient: OTPatient;
  baseline: Vitals;
  /** Starting FiO2 (%). */
  fio2: number;
  phases: OTPhase[];
  /** Seconds after incision when closure ends and the sign-out starts. */
  endS: number;
  /** Line when anaesthesia is established (after sign-in). */
  inductionLine: string;
  antibioticLine: string;
  events: OTEventDef[];
  checklist: ChecklistItem[];
}

const NA = { id: 'na', label: 'Not applicable' };

function checklist(p: {
  identity: { right: string; wrong: string };
  site: 'yes' | 'na';
  siteLabel: string;
  allergy: { options: Array<{ id: string; label: string }>; correct: string };
  airway: { yes: string; no: string; correct: 'yes' | 'no' };
  blood: { yes: string; no: string; correct: 'yes' | 'no' };
  confirm: { right: string; wrong: string };
  specimen: string;
}): ChecklistItem[] {
  return [
    {
      id: 'identity',
      stage: 'sign-in',
      speaker: 'anaesthetist',
      ask: 'Sign in. Confirm the patient: name, procedure and consent?',
      options: [
        { id: 'right', label: p.identity.right },
        { id: 'wrong', label: p.identity.wrong },
        { id: 'no-consent', label: 'Consent is not signed yet' },
      ],
      correct: 'right',
      teaching: 'Identity, procedure and consent are confirmed with the patient (or the chart if sedated) before induction: wrong patient and wrong procedure are never events.',
    },
    {
      id: 'site',
      stage: 'sign-in',
      speaker: 'anaesthetist',
      ask: 'Is the site marked?',
      options: [
        { id: 'yes', label: `Yes, ${p.siteLabel}` },
        NA,
        { id: 'no', label: 'No, not marked' },
      ],
      correct: p.site,
      teaching: 'Mark any operation with laterality or levels. Midline single-organ operations are "not applicable", but you still say so out loud.',
    },
    {
      id: 'allergy',
      stage: 'sign-in',
      speaker: 'anaesthetist',
      ask: 'Does the patient have a known allergy?',
      options: p.allergy.options,
      correct: p.allergy.correct,
      teaching: 'Read the allergy band and the chart, and ask the patient. Never assume "no known allergy" because nobody wrote one down.',
    },
    {
      id: 'airway',
      stage: 'sign-in',
      speaker: 'anaesthetist',
      ask: 'Difficult airway or aspiration risk?',
      options: [
        { id: 'yes', label: p.airway.yes },
        { id: 'no', label: p.airway.no },
      ],
      correct: p.airway.correct,
      teaching: 'Unfasted emergencies and term pregnancy are aspiration risks: plan rapid sequence induction or regional anaesthesia, with suction ready.',
    },
    {
      id: 'blood',
      stage: 'sign-in',
      speaker: 'anaesthetist',
      ask: 'Risk of more than 500 mL blood loss?',
      options: [
        { id: 'yes', label: p.blood.yes },
        { id: 'no', label: p.blood.no },
      ],
      correct: p.blood.correct,
      teaching: 'If the expected loss is over 500 mL (7 mL/kg in children), have two large-bore IV lines and cross-matched blood before you start.',
    },
    {
      id: 'confirm',
      stage: 'time-out',
      speaker: 'surgeon',
      ask: 'Time out. Everyone stop. Patient, procedure and incision site?',
      options: [
        { id: 'right', label: p.confirm.right },
        { id: 'wrong', label: p.confirm.wrong },
      ],
      correct: 'right',
      teaching: 'At time-out the whole team stops and confirms patient, procedure and site out loud, after introducing themselves by name and role.',
    },
    {
      id: 'antibiotic',
      stage: 'time-out',
      speaker: 'surgeon',
      ask: 'Has antibiotic prophylaxis been given within the last 60 minutes?',
      options: [
        { id: 'yes', label: 'Yes, given within 60 minutes' },
        { id: 'no', label: 'No, not yet' },
      ],
      correct: 'antibiotic',
      teaching: 'Answer from the drug chart, not from memory. If it has not been given, give it now and delay the incision.',
    },
    {
      id: 'counts',
      stage: 'sign-out',
      speaker: 'surgeon',
      ask: 'Sign out. Are the instrument, swab and needle counts correct?',
      options: [
        { id: 'yes', label: 'Yes, Sister Mary confirmed the counts are correct' },
        { id: 'no', label: 'Not checked' },
      ],
      correct: 'yes',
      teaching: 'Counts are confirmed out loud by the scrub nurse before the patient leaves: a retained swab is a never event.',
    },
    {
      id: 'specimen',
      stage: 'sign-out',
      speaker: 'surgeon',
      ask: 'Specimen labelled?',
      options: [
        { id: 'yes', label: `Yes: ${p.specimen}` },
        { id: 'no', label: 'No, not labelled yet' },
      ],
      correct: 'yes',
      teaching: 'Read the specimen label aloud, including the patient name and site, before it leaves the theatre.',
    },
  ];
}

export const OT_SCENARIOS: OTScenario[] = [
  {
    id: 'ot-appendix',
    title: 'Open appendicectomy',
    hindi: 'अपेंडिक्स का ऑपरेशन',
    kind: 'open',
    anaesthesia: 'GA',
    summary: 'Emergency open appendicectomy under general anaesthesia (rapid sequence induction).',
    patient: {
      name: 'Ramesh Kumar',
      age: 28,
      sex: 'M',
      weightKg: 68,
      allergy: 'No known allergy',
      procedure: 'Open appendicectomy (right iliac fossa)',
      consent: 'Signed by the patient',
      fasting: 'Last meal 3 hours ago (emergency)',
      notes: 'Metronidazole 500 mg IV already running from the ward.',
    },
    baseline: { hr: 88, sbp: 124, dbp: 76, spo2: 99, etco2: 36, temp: 36.7 },
    fio2: 50,
    phases: [
      { id: 'incision', label: 'Skin incision (Lanz)', atS: 0 },
      { id: 'access', label: 'Muscle split, peritoneum opened', atS: 30 },
      { id: 'appendix', label: 'Appendix delivered and ligated', atS: 90 },
      { id: 'washout', label: 'Washout and haemostasis', atS: 130 },
      { id: 'closure', label: 'Closure', atS: 165 },
    ],
    endS: 205,
    inductionLine: 'Rapid sequence done, tube is in, cuff up. He is asleep. Time out when you are ready.',
    antibioticLine: 'Hold on. Antibiotic not given? Give the antibiotic before I cut.',
    events: [
      {
        id: 'app-maint', problem: 'maintenance', atS: 8, speaker: 'anaesthetist',
        line: 'He has no maintenance running. Set up his IV fluids, he is 68 kilos.',
        remind: 'I still need the maintenance fluid set, please.',
        ack: 'Good, maintenance is running.', deadlineS: 45,
      },
      {
        id: 'app-bp', problem: 'hypotension', atS: 40, speaker: 'anaesthetist',
        line: 'BP is dropping, 78 over 40.',
        remind: 'BP is now 70 over 36. I need something now!',
        ack: 'Thanks, that is better. BP is coming up.',
        onset: { sbp: 78, dbp: 40, hr: 98 }, worst: { sbp: 64, dbp: 32, hr: 112 }, deadlineS: 40,
      },
      {
        id: 'app-suction', problem: 'bleeding-field', atS: 80, speaker: 'surgeon',
        line: 'Field is full of pus and blood, I cannot see anything.',
        remind: 'I still cannot see! Somebody sort this out.',
        ack: 'That is better, I can see the base now.',
        onset: { hr: 96 }, worst: { hr: 104, sbp: 108 }, deadlineS: 40,
      },
      {
        id: 'app-cautery', problem: 'cautery-fail', atS: 115, speaker: 'surgeon',
        line: 'Cautery is not working.',
        remind: 'Still no cautery. This is oozing.',
        ack: 'Cautery is working. Thanks.', deadlineS: 40,
      },
      {
        id: 'app-ponv', problem: 'ponv', atS: 150, speaker: 'anaesthetist',
        line: 'We are nearly done. PONV prophylaxis please.',
        remind: 'Has the anti-emetic gone in?',
        ack: 'Good, anti-emetic is in.', deadlineS: 40,
      },
      {
        id: 'app-pain', problem: 'analgesia', atS: 178, speaker: 'surgeon',
        line: 'Closing now. Let us sort out his post-op pain before he wakes up.',
        remind: 'Analgesia, please, he will wake in pain.',
        ack: 'Good. He will wake comfortable.', deadlineS: 40,
      },
    ],
    checklist: checklist({
      identity: { right: 'Ramesh Kumar, 28, open appendicectomy, consent signed', wrong: 'Ramesh Kumar, 28, laparoscopic cholecystectomy, consent signed' },
      site: 'yes',
      siteLabel: 'right iliac fossa marked',
      allergy: { options: [{ id: 'none', label: 'No known allergy' }, { id: 'pcn', label: 'Allergic to penicillin' }, { id: 'latex', label: 'Allergic to latex' }], correct: 'none' },
      airway: { yes: 'Yes: not fasted, rapid sequence induction planned', no: 'No risk', correct: 'yes' },
      blood: { yes: 'Yes: two IV lines and blood cross-matched', no: 'No, under 500 mL expected', correct: 'no' },
      confirm: { right: 'Ramesh Kumar, open appendicectomy, right iliac fossa', wrong: 'Ramesh Kumar, open appendicectomy, left iliac fossa' },
      specimen: 'appendix, labelled Ramesh Kumar',
    }),
  },
  {
    id: 'ot-lap-chole',
    title: 'Laparoscopic cholecystectomy',
    hindi: 'पित्ताशय की दूरबीन सर्जरी',
    kind: 'lap',
    anaesthesia: 'GA',
    summary: 'Laparoscopic cholecystectomy for acute calculous cholecystitis under general anaesthesia.',
    patient: {
      name: 'Sunita Sharma',
      age: 45,
      sex: 'F',
      weightKg: 72,
      allergy: 'Sulfa drugs (rash)',
      procedure: 'Laparoscopic cholecystectomy',
      consent: 'Signed by the patient, includes conversion to open',
      fasting: 'Fasted 8 hours',
      notes: 'Acute calculous cholecystitis. Mallampati 2. Non-smoker.',
    },
    baseline: { hr: 78, sbp: 128, dbp: 80, spo2: 99, etco2: 35, temp: 36.6 },
    fio2: 50,
    phases: [
      { id: 'incision', label: 'Umbilical port, pneumoperitoneum', atS: 0 },
      { id: 'ports', label: 'Working ports inserted', atS: 30 },
      { id: 'calot', label: "Calot's triangle dissection", atS: 70 },
      { id: 'clip', label: 'Critical view, cystic duct and artery clipped', atS: 120 },
      { id: 'closure', label: 'Gallbladder out, ports closed', atS: 170 },
    ],
    endS: 205,
    inductionLine: 'She is asleep, tube is in. Ready for time out.',
    antibioticLine: 'Wait, no antibiotic yet? She has acute cholecystitis. Give the antibiotic before I start.',
    events: [
      {
        id: 'lc-brady', problem: 'bradycardia', atS: 10, speaker: 'anaesthetist',
        line: 'Insufflating... heart rate is 42!',
        remind: 'Heart rate 36 now. Stop insufflating! I need a drug now!',
        ack: 'Heart rate is back up. Insufflate slowly, please.',
        onset: { hr: 42, sbp: 104, dbp: 62 }, worst: { hr: 34, sbp: 88, dbp: 52 }, deadlineS: 35,
      },
      {
        id: 'lc-spo2', problem: 'hypoxia', atS: 45, speaker: 'anaesthetist',
        line: 'SpO2 falling to 89.',
        remind: 'Saturation 84 now. Oxygen!',
        ack: 'Saturation is recovering. Thank you.',
        onset: { spo2: 89, hr: 92, etco2: 41 }, worst: { spo2: 80, hr: 108, etco2: 44 }, deadlineS: 35,
      },
      {
        id: 'lc-temp', problem: 'hypothermia', atS: 80, speaker: 'anaesthetist',
        line: 'Patient is getting cold, 35.2.',
        remind: 'Temperature is still dropping. Warm her up, please.',
        ack: 'Good, the warmer is on.',
        onset: { temp: 35.2 }, worst: { temp: 34.9 }, deadlineS: 45,
      },
      {
        id: 'lc-lead', problem: 'lead-off', atS: 115, speaker: 'anaesthetist',
        line: 'Monitor alarm! The ECG is flat!',
        remind: 'Is she in arrest? Someone check her!',
        ack: 'Pulse is fine, it was a lead off. Good, you checked the patient first.', deadlineS: 30,
      },
      {
        id: 'lc-ponv', problem: 'ponv', atS: 150, speaker: 'anaesthetist',
        line: 'Female, non-smoker, opioids after. She is high risk for vomiting. Prophylaxis please.',
        remind: 'Anti-emetic, please.',
        ack: 'Good, anti-emetic is in.', deadlineS: 40,
      },
      {
        id: 'lc-pain', problem: 'analgesia', atS: 178, speaker: 'surgeon',
        line: 'Gallbladder is out. Post-op analgesia, please.',
        remind: 'Analgesia, please, before she wakes.',
        ack: 'Thanks. She will wake comfortable.', deadlineS: 40,
      },
    ],
    checklist: checklist({
      identity: { right: 'Sunita Sharma, 45, laparoscopic cholecystectomy, consent signed', wrong: 'Sunita Sharma, 45, open appendicectomy, consent signed' },
      site: 'na',
      siteLabel: 'right upper quadrant marked',
      allergy: { options: [{ id: 'none', label: 'No known allergy' }, { id: 'sulfa', label: 'Allergic to sulfa drugs (rash)' }, { id: 'latex', label: 'Allergic to latex' }], correct: 'sulfa' },
      airway: { yes: 'Yes: difficult airway expected', no: 'No: fasted 8 hours, Mallampati 2', correct: 'no' },
      blood: { yes: 'Yes: two IV lines and blood cross-matched', no: 'No, under 500 mL expected', correct: 'no' },
      confirm: { right: 'Sunita Sharma, laparoscopic cholecystectomy, umbilical and right upper ports', wrong: 'Sunita Sharma, open cholecystectomy, Kocher incision' },
      specimen: 'gallbladder, labelled Sunita Sharma',
    }),
  },
  {
    id: 'ot-lscs',
    title: 'Caesarean section',
    hindi: 'सिज़ेरियन ऑपरेशन',
    kind: 'lscs',
    anaesthesia: 'spinal',
    summary: 'Emergency lower segment caesarean section (fetal distress) under spinal anaesthesia.',
    patient: {
      name: 'Lakshmi Devi',
      age: 27,
      sex: 'F',
      weightKg: 64,
      allergy: 'Metoclopramide (dystonia)',
      procedure: 'Emergency lower segment caesarean section',
      consent: 'Signed by the patient',
      fasting: 'Term pregnancy, last meal 4 hours ago',
      notes: 'G2P1, 39 weeks, fetal distress. Hb 10.8. Two units cross-matched. Oxytocin infusion ready.',
    },
    baseline: { hr: 92, sbp: 118, dbp: 72, spo2: 99, etco2: null, temp: 36.8 },
    fio2: 30,
    phases: [
      { id: 'incision', label: 'Pfannenstiel incision', atS: 0 },
      { id: 'uterus', label: 'Lower segment opened', atS: 30 },
      { id: 'delivery', label: 'Baby delivered, oxytocin given', atS: 65 },
      { id: 'repair', label: 'Uterine repair', atS: 100 },
      { id: 'closure', label: 'Closure', atS: 165 },
    ],
    endS: 205,
    inductionLine: 'Spinal is in, block to T4, she is comfortable. Ready for time out.',
    antibioticLine: 'No antibiotic yet? Give it now, before I cut. We have one minute.',
    events: [
      {
        id: 'cs-bp', problem: 'hypotension', atS: 8, speaker: 'anaesthetist',
        line: 'Spinal hypotension. BP is dropping, 82 over 44.',
        remind: 'BP 72 over 38 and she feels sick. Now, please!',
        ack: 'Thanks, that is better. She feels better too.',
        onset: { sbp: 82, dbp: 44, hr: 108 }, worst: { sbp: 70, dbp: 36, hr: 120 }, deadlineS: 35,
      },
      {
        id: 'cs-temp', problem: 'hypothermia', atS: 40, speaker: 'anaesthetist',
        line: 'She is shivering. Patient is getting cold, 35.4.',
        remind: 'Still cold. Warmer, please.',
        ack: 'Good, the warmer is on.',
        onset: { temp: 35.4 }, worst: { temp: 35.0 }, deadlineS: 45,
      },
      {
        id: 'cs-suction', problem: 'bleeding-field', atS: 72, speaker: 'surgeon',
        line: 'Baby is out. Field is full of blood and liquor, I cannot see the angles.',
        remind: 'I cannot see! Suction!',
        ack: 'Better. I can see the angles now.',
        onset: { hr: 112, sbp: 100 }, worst: { hr: 120, sbp: 94 }, deadlineS: 35,
      },
      {
        id: 'cs-txa', problem: 'ooze', atS: 108, speaker: 'surgeon',
        line: 'Uterus is contracting on oxytocin, but it is still oozing. About a litre lost. Give something to help her clot.',
        remind: 'Still oozing. Give the drug, please!',
        ack: 'Thanks. The ooze is settling.',
        onset: { hr: 112, sbp: 98 }, worst: { hr: 122, sbp: 90 }, deadlineS: 40,
      },
      {
        id: 'cs-fluid', problem: 'fluid-loss', atS: 140, speaker: 'anaesthetist',
        line: 'Heart rate 118, BP 90 over 56. We need a fluid bolus.',
        remind: 'Heart rate 126 now. Fluid, please!',
        ack: 'Thanks, she is filling up. Heart rate is settling.',
        onset: { hr: 118, sbp: 90, dbp: 56 }, worst: { hr: 128, sbp: 80, dbp: 48 }, deadlineS: 40,
      },
      {
        id: 'cs-ponv', problem: 'ponv', atS: 175, speaker: 'anaesthetist',
        line: 'She feels sick. Anti-emetic please, and remember her allergy.',
        remind: 'Anti-emetic, please.',
        ack: 'Good. Ondansetron, not metoclopramide. Well done.', deadlineS: 35,
      },
    ],
    checklist: checklist({
      identity: { right: 'Lakshmi Devi, 27, emergency caesarean section, consent signed', wrong: 'Lakshmi Devi, 27, elective hysterectomy, consent signed' },
      site: 'na',
      siteLabel: 'left side marked',
      allergy: { options: [{ id: 'none', label: 'No known allergy' }, { id: 'pcn', label: 'Allergic to penicillin' }, { id: 'metoclo', label: 'Allergic to metoclopramide (dystonia)' }], correct: 'metoclo' },
      airway: { yes: 'Yes: term pregnancy is an aspiration risk, spinal planned', no: 'No risk', correct: 'yes' },
      blood: { yes: 'Yes: two large-bore lines, two units cross-matched', no: 'No, under 500 mL expected', correct: 'yes' },
      confirm: { right: 'Lakshmi Devi, emergency lower segment caesarean section, Pfannenstiel', wrong: 'Lakshmi Devi, classical caesarean, midline incision' },
      specimen: 'placenta for histology, labelled Lakshmi Devi',
    }),
  },
];

export function scenarioById(id: string): OTScenario {
  return OT_SCENARIOS.find((s) => s.id === id) ?? OT_SCENARIOS[0];
}
