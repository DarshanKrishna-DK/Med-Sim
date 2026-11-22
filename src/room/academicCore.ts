// Results a human can sign: the pure half (types, the request body, what each
// state means). No runtime imports, so the Node tests can load it.

import type { ClinicId } from '../game/clinic';
import type { SideState } from './types';

export type SignStatus =
  | 'new'
  | 'drafting' // the examiner is reading the marks
  | 'draft' // nobody has signed
  | 'awaiting_signoff' // a faculty member has been asked
  | 'signed_off'
  | 'revised' // signed with another score
  | 'sent_back'
  | 'unavailable'; // the examiner did not answer: the marks stand, unsigned

export interface StudyPlan {
  status: 'planning' | 'ready' | 'failed';
  topic?: string;
  level?: 'student' | 'intern';
  caseId?: string;
  clinic?: string;
  clinicLabel?: string;
  reason?: string;
  updated?: boolean;
}

export interface AuditRow {
  at: string;
  who: string;
  what: string;
  human?: boolean;
  comment?: string;
  score?: number;
}

export interface AcademicSide extends SideState {
  status: SignStatus;
  total: number;
  verified?: boolean;
  adjustedScore?: number | null;
  examinerComment?: string;
  weak?: string[];
  signedBy?: string;
  decidedBy?: string;
  signedAt?: string;
  facultyComment?: string;
  facultyName?: string;
  inviting?: boolean;
  askFailed?: boolean;
  plan?: StudyPlan;
  audit?: AuditRow[];
}

export type ResultKind = 'osce' | 'viva' | 'debrief';

export interface AcademicInput {
  /** One per saved result; the browser's own key, never sent. */
  resultKey: string;
  what: ResultKind;
  total: number;
  domains: { name: string; score: number; max: number; note?: string }[];
  strengths: string[];
  improvements: string[];
  clinic?: string;
  specialty?: string;
  /** The diagnosis or viva topic the result was about. */
  about?: string;
  caseId?: string;
  /** What the server marked: lets it tell real marks from edited ones. */
  markKey: string;
  patientNames: string[];
  studentName?: string;
}

const STATUSES: readonly SignStatus[] = ['new', 'drafting', 'draft', 'awaiting_signoff', 'signed_off', 'revised', 'sent_back', 'unavailable'];

export function asAcademic(side: SideState | null | undefined): AcademicSide | null {
  if (!side || side.kind !== 'academic' || !STATUSES.includes(side.status as SignStatus)) return null;
  return side as AcademicSide;
}

/** The context of POST /agent/room/side/open. Names go along only so the server
 *  can keep them out of the room. */
export function academicContext(i: AcademicInput, resume = false): Record<string, unknown> {
  return {
    resume,
    what: i.what,
    total: Math.round(i.total),
    key: i.markKey,
    domains: i.domains.slice(0, 8).map((d) => ({ name: d.name, score: d.score, max: d.max, note: (d.note ?? '').slice(0, 200) })),
    strengths: i.strengths.slice(0, 4),
    improvements: i.improvements.slice(0, 4),
    clinic: i.clinic ?? '',
    specialty: i.specialty ?? '',
    about: i.about ?? '',
    caseId: i.caseId ?? '',
    patientNames: i.patientNames.filter((n) => n.trim().length > 2).slice(0, 2),
    studentName: i.studentName ?? '',
  };
}

export const isSigned = (s: AcademicSide | null | undefined): boolean => s?.status === 'signed_off' || s?.status === 'revised';

/** The score to show: the faculty's when they changed it, else the marking's. */
export const finalScore = (s: AcademicSide): number =>
  s.status === 'revised' && typeof s.adjustedScore === 'number' ? s.adjustedScore : s.total;

export interface Stamp {
  word: string;
  tone: 'draft' | 'signed' | 'back' | 'none';
}

export function stampOf(s: AcademicSide): Stamp {
  switch (s.status) {
    case 'signed_off':
    case 'revised':
      return { word: 'Signed', tone: 'signed' };
    case 'sent_back':
      return { word: 'Sent back', tone: 'back' };
    case 'unavailable':
      return { word: 'Not signed', tone: 'none' };
    default:
      return { word: 'Draft', tone: 'draft' };
  }
}

/** One line under the stamp: what is true now and who has to act. */
export function statusLine(s: AcademicSide): string {
  const who = s.facultyName || 'faculty';
  switch (s.status) {
    case 'new':
    case 'drafting':
      return 'Examiner Kulkarni is reading the marks.';
    case 'draft':
      return 'No faculty member has signed this result.';
    case 'awaiting_signoff':
      return `Waiting for ${who} to sign in the BAND room.`;
    case 'signed_off':
      return `Signed by ${s.signedBy || 'faculty'}.`;
    case 'revised':
      return `Signed by ${s.signedBy || 'faculty'} with ${finalScore(s)} instead of ${s.total}.`;
    case 'sent_back':
      return `${s.decidedBy || 'Faculty'} sent it back. It stays a draft.`;
    case 'unavailable':
      return 'The examiner did not answer, so nobody has been asked to sign.';
  }
}

export interface SignButton {
  action: 'invite' | 'retry';
  label: string;
}

/** The one thing the student can do next, or null when it is somebody else's move. */
export function nextStep(s: AcademicSide): SignButton | null {
  if (s.inviting) return null;
  switch (s.status) {
    case 'draft':
      return { action: 'invite', label: s.askFailed ? 'Ask faculty again' : 'Ask faculty to sign' };
    case 'sent_back':
      return { action: 'invite', label: 'Ask faculty to look again' };
    case 'unavailable':
      return { action: 'retry', label: 'Ask the examiner again' };
    default:
      return null;
  }
}

/** The viva has no clinic of its own: where its subject is practised. */
const SUBJECT_CLINIC: Record<string, ClinicId> = {
  surgery: 'general-surgery',
  anatomy: 'orthopedics',
  obg: 'obgyn',
  paediatrics: 'pediatrics',
  microbiology: 'infectious-disease',
  pathology: 'hematology',
  physiology: 'cardiology',
  biochemistry: 'endocrinology',
  'forensic-medicine': 'emergency-medicine',
};

export const clinicForSubject = (subjectId: string): ClinicId => SUBJECT_CLINIC[subjectId] ?? 'internal-medicine';

/** Viva questions as domains: recall against applied, only what was asked. */
export function vivaDomains(
  items: { difficulty: number; verdict: string; q: string }[],
): { name: string; score: number; max: number; note?: string }[] {
  const asked = items.filter((p) => p.verdict !== 'not asked');
  const credit = (v: string) => (v === 'correct' ? 10 : v === 'partial' ? 5 : 0);
  const row = (name: string, list: typeof asked) => {
    const missed = list.find((p) => p.verdict !== 'correct');
    return { name, score: list.reduce((n, p) => n + credit(p.verdict), 0), max: list.length * 10, note: missed ? `Missed: ${missed.q}` : '' };
  };
  return [row('Recall questions', asked.filter((p) => p.difficulty === 1)), row('Applied questions', asked.filter((p) => p.difficulty !== 1))].filter((d) => d.max > 0);
}
