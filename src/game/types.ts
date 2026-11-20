import type { PaletteName } from '../styles/palettes';
import type { ClinicId } from './clinic';
import type { Lang } from './lang';

// ── MedSim cozy-cartoon UI state ──────────────────────────

export type Screen =
  | 'splash'
  | 'onboarding'
  | 'home'
  | 'mode'
  | 'gpRoom'
  | 'library'
  | 'brief'
  | 'encounter'
  | 'endConfirm'
  | 'debrief'
  | 'history'
  | 'agenticRounds'
  | 'agentTopology'
  /** Emergency triage drill (2D + HUD). */
  | 'triage'
  /** 3D hospital corridor hub: walk to a specialty door to enter its clinic. */
  | 'corridor'
  /** Teacher Portal lecture hall: whiteboard lessons with a voice teacher. */
  | 'classroom'
  /** Radiology reading room: describe films to a consultant radiologist. */
  | 'radiology'
  /** OSCE exam mode: station setup + candidate instructions. */
  | 'osce'
  /** OSCE examiner marking sheet (live or a saved one). */
  | 'osceResult'
  /** "My progress" dashboard built from saved debriefs. */
  | 'progress';

export type AvatarStyle = 'cute' | 'portrait' | 'animal' | 'initials';
export type RoomLayout = 'side' | 'front';

export interface Tweaks {
  palette: PaletteName;
  avatarStyle: AvatarStyle;
  intensity: number;
  roomLayout: RoomLayout;
}

export interface EndConfirmChecks {
  sum: boolean;
  safe: boolean;
  ice: boolean;
}

// ── MedSim types, load-bearing for the 3D scene + voice agent ──
//
// These are the shapes the imported `Polyclinic.tsx`, `FloatingVoicePanel.tsx`,
// and `voice/*` modules expect.

export type Severity = 'critical' | 'urgent' | 'stable';

export interface AnamnesisQA {
  id: string;
  question: string;
  answer: string;
  relevant: boolean;
}

export interface TestResult {
  testId: string;
  result: string;
  abnormal: boolean;
}

/** Provenance for a case adapted from a published, openly licensed report. */
export interface CaseSource {
  title: string;
  /** First author et al. */
  authors: string;
  journal: string;
  year: number;
  /** DOI or PMC link. */
  url: string;
  /** e.g. 'CC BY 4.0'. */
  license: string;
}

export interface PatientCase {
  id: string;
  name: string;
  age: number;
  gender: 'M' | 'F';
  severity: Severity;
  arrivalBlurb: string;
  chiefComplaint: string;
  vitals: {
    hr: number;
    bp: string;
    spo2: number;
    temp: number;
    rr: number;
  };
  anamnesis: AnamnesisQA[];
  testResults: TestResult[];
  correctDiagnosisId: string;
  acceptableTreatmentIds: string[];
  criticalTreatmentIds: string[];
  diagnosisOptions: string[];
  rubric?: CaseRubric;
  /** Set on cases adapted from a real published case report. */
  source?: CaseSource;
  /** True when `source` is set (published case adaptation). */
  realCase?: boolean;
}

// ── OSCE rubric, grades a completed encounter ────────────────────────
//
// The `medsim-attending` Managed Agent reads this rubric at debrief time and
// emits one `render_case_evaluation` tool call. Every clinical_management
// criterion's `guideline_ref` MUST resolve in `src/data/guidelines.ts`:
// the agent is instructed to drop a criterion rather than fabricate a
// citation. Cases without a `rubric` field fall back to an auto-derived
// rubric built from `correctDiagnosisId` + `criticalTreatmentIds`.

export type RubricFramework =
  | 'PLAB2'
  | 'RCGP'
  | 'NURSE'
  | 'SEGUE'
  | 'ICE'
  | 'SOCRATES'
  | 'OS-12';

export type RubricDomain =
  | 'data_gathering'
  | 'clinical_management'
  | 'interpersonal';

export interface RubricCriterion {
  /** Stable id, unique within the rubric. e.g. "dg-01", "cm-03". */
  criterion_id: string;
  /** Short label shown in the marking sheet UI. */
  label: string;
  /** Relative weight, 1–3. Drives the domain score. */
  weight: number;
  framework?: RubricFramework;
  /** Reference into the guideline registry. Format: "guideline_id:rec_id".
   *  REQUIRED for every clinical_management criterion. Optional elsewhere. */
  guideline_ref?: string;
  /** What counts as "met", specific enough that the agent can quote the
   *  transcript or name the action that did/didn't satisfy it. */
  evidence: string;
}

export interface SafetyNetCriterion {
  required_elements: string[];
  weight: number;
  guideline_ref?: string;
}

export interface CaseRubric {
  data_gathering: RubricCriterion[];
  clinical_management: RubricCriterion[];
  interpersonal: RubricCriterion[];
  safety_netting?: SafetyNetCriterion;
  /** "borderline-regression" = holistic global rating in addition to the
   *  weighted sum. Always set; reserved for future strict scoring modes. */
  global_rating: 'borderline-regression';
}

// ── Catalogue types (tests, treatments, diagnoses), used by data/* ──

export interface Test {
  id: string;
  name: string;
  category: 'lab' | 'imaging' | 'bedside';
  turnaroundSec: number;
}

export interface Treatment {
  id: string;
  name: string;
  category: 'medication' | 'procedure' | 'disposition';
}

export interface Diagnosis {
  id: string;
  name: string;
}

export type PatientStatus =
  | 'waiting'
  | 'in-bed'
  | 'examining'
  | 'awaiting-results'
  | 'ready-to-diagnose'
  | 'treating'
  | 'discharged'
  | 'deceased';

export interface ActivePatient {
  case: PatientCase;
  bedIndex: number;
  status: PatientStatus;
  askedQuestionIds: string[];
  orderedTestIds: string[];
  testOrderedAt: Record<string, number>;
  completedTestIds: string[];
  givenTreatmentIds: string[];
  submittedDiagnosisId: string | null;
  arrivedAt: number;
  deadlineMs: number;
  prescriptions?: Array<{
    medicationId: string;
    dose: string;
    duration: string;
    prescribedAt: number;
  }>;
  /** Follow-up booked for this patient (by the trainee or the nurse agent). */
  followUp?: { inDays: number; reason: string };
  /** Body systems the trainee examined, in order (by voice or click). */
  examsPerformed?: ExamSystem[];
  /** Findings per examined system, once /agent/exam/perform answered. */
  examResults?: Partial<Record<ExamSystem, ExamResult>>;
}

// ── Physical examination ──

export type ExamSystem =
  | 'general' | 'vitals' | 'cardio' | 'resp' | 'abdomen' | 'neuro'
  | 'msk' | 'skin' | 'ent' | 'eye' | 'obgyn' | 'paeds';

export type ExamSound =
  | 'normal-heart' | 'murmur-systolic' | 'murmur-diastolic' | 's3' | 'pericardial-rub'
  | 'normal-breath' | 'wheeze' | 'crackles' | 'bronchial' | 'absent';

export interface ExamFinding {
  label: string;
  value: string;
  abnormal: boolean;
}

export interface ExamResult {
  system: ExamSystem;
  findings: ExamFinding[];
  /** 1-2 sentences, as the examining doctor would note it. */
  summary: string;
  sound: ExamSound | null;
  performedAt: number;
}

// ── Nurse agent (agentic orders), run feed shown live in the UI ──

export interface NurseStep {
  tool: string;
  args: Record<string, unknown>;
  ok: boolean;
  summary: string;
  result?: unknown;
}

export interface NurseRun {
  /** Client-generated id (stable from the 'running' placeholder onward). */
  id: string;
  /** Backend run id, once /agent/nurse/act has answered. */
  runId?: string;
  caseId: string;
  utterance: string;
  source: 'voice' | 'typed';
  status: 'running' | 'done' | 'error';
  startedAt: number;
  finishedAt?: number;
  intent?: 'order' | 'none';
  plan?: string;
  steps: NurseStep[];
  /** What was actually applied to the store (validated against catalogs). */
  applied?: {
    orderedTestIds: string[];
    prescriptions: Array<{ medicationId: string; dose: string; duration: string }>;
    followUp?: { inDays: number; reason: string };
  };
  spokenConfirmation?: string;
  error?: string;
}

// ── Mistake coach (Nurse Asha) ──

export interface CoachAlert {
  id: string;
  caseId: string;
  severity: 'info' | 'warning' | 'danger';
  /** Max ~6 words. */
  title: string;
  /** Max ~18 words; shown in the toast and Asha's speech bubble. */
  short: string;
  /** 2-4 sentence teaching explanation, shown when "?" is clicked. */
  explanation: string;
  suggestion: string;
  /** 'nurse' = raised locally from a nurse tool step; 'coach' = LLM check. */
  source: 'nurse' | 'coach';
  createdAt: number;
  /** Toast closed by the doctor (stays in the alert history). */
  dismissed?: boolean;
}

export interface PolyclinicSlice {
  clinic: ClinicId;
  patient: ActivePatient | null;
}

// ── Combined game state ──
export interface GameState {
  screen: Screen;
  /** Session language for patient, nurse, coach and teacher voices. */
  lang: Lang;
  tweaks: Tweaks;
  onboardingStep: number;
  endConfirm: EndConfirmChecks;
  selectedCaseId: string;
  hasOnboarded: boolean;
  /** Polyclinic 3D scene needs this slice. Shape consumed by `Polyclinic`
   *  and `FloatingVoicePanel`. */
  polyclinic: PolyclinicSlice;
  /** Snapshot of the most recently completed encounter, taken at the moment
   *  the patient walks out (see `Store.finishPolyclinicCase`). DebriefScreen
   *  reads this so the grading agent still has the full action log even
   *  though `polyclinic.patient` has been cleared for the walk-out animation. */
  lastEncounter: ActivePatient | null;
  /** When set, DebriefScreen renders the saved evaluation with this id from
   *  `evalHistory` storage instead of running the agent against a live
   *  encounter. Cleared when the user navigates away. */
  viewedEvalHistoryId: string | null;
  /** Nurse-agent runs for the current polyclinic patient, oldest first.
   *  Cleared when a new patient is accepted. */
  agentRuns: NurseRun[];
  /** Mistake alerts raised by Nurse Asha for the current polyclinic patient,
   *  oldest first. Cleared when a new patient is accepted. */
  coachAlerts: CoachAlert[];
  /** Clinic whose corridor door the doctor last walked through. The
   *  corridor respawns the player in front of that door on return;
   *  null = spawn in the lobby. */
  corridorReturnClinic: ClinicId | null;
  /** True when the doctor walks back out of the Teacher Portal classroom:
   *  the corridor respawns them in front of the portal. */
  corridorReturnPortal: boolean;
  /** Non-clinic room (e.g. 'radiology') whose corridor door the doctor last
   *  walked out of; checked after the portal and clinic. */
  corridorReturnRoom?: 'radiology' | null;
  /** OSCE exam station (setup, running or just finished); null outside
   *  OSCE mode. See `isOsceLive` in store.ts. */
  osce: OsceSession | null;
}

// ── OSCE exam mode ──

export interface OsceSession {
  /** Pool the station was drawn from ('all-specialties' = mixed). */
  specialty: ClinicId;
  caseId: string;
  durationMs: number;
  /** Optional, printed on the report only (never sent to the backend). */
  candidateName: string;
  /** Set when the candidate presses "Start station" (timer origin). */
  startedAt: number | null;
  /** Set at the bell (time up or the candidate ends early). */
  endedAt: number | null;
  /** Encounter snapshot taken at the bell, kept even with no chart activity. */
  encounter: ActivePatient | null;
  /** Coach alerts collected silently during the station. */
  alerts: CoachAlert[];
  /** evalHistory id once the station is marked and saved. */
  savedId: string | null;
}
