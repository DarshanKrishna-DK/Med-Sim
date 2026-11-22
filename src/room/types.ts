// Shapes of the BAND agent room as the backend streams them (backend/agentroom/hub.py).
// Pure types, no imports, so tests and reducers can use them freely.

export type RoomRole =
  | 'nurse'
  | 'pharmacist'
  | 'lab'
  | 'radiology'
  | 'examiner'
  | 'faculty'
  | 'teacher'
  | 'reception'
  | 'theatre';

export interface RoomParticipant {
  id: string;
  role: RoomRole;
  name: string;
  title: string;
  human: boolean;
  online: boolean;
}

export type RoomMessageType = 'text' | 'thought' | 'tool_call' | 'tool_result' | 'error' | 'system';
export type RoomDelivery = 'sent' | 'delivered' | 'processing' | 'processed' | 'failed';

export interface RoomMessage {
  id: string; // BAND message id
  from: RoomRole;
  fromName: string;
  to: RoomRole[]; // who was mentioned; nobody else received it
  text: string; // human sentence, hand-off block removed
  type: RoomMessageType;
  human: boolean;
  at: string; // ISO
  kind?: string;
  action?: string;
  ref?: string;
  delivery?: RoomDelivery;
  payload?: Record<string, unknown>; // hand-off data, for the "what was shared" disclosure
}

export type DelegationStatus =
  | 'sent' // posted in the room, not picked up yet
  | 'working' // department marked it processing
  | 'waiting' // department asked someone else (waitingOn) first
  | 'done'
  | 'held' // pharmacist hold: the drug is NOT on the prescription
  | 'overridden' // human faculty approved a held drug
  | 'cancelled'
  | 'failed'
  | 'timeout';

export interface Delegation {
  ref: string;
  action:
    | 'verify_rx'
    | 'run_test'
    | 'run_imaging'
    | 'ask'
    | 'score_teamwork'
    // side rooms
    | 'sign_off'
    | 'study_plan'
    | 'crossmatch'
    | 'theatre_allergy'
    | 'second_read'
    | 'critical_finding'
    | 'case_review';
  target: RoomRole;
  status: DelegationStatus;
  label: string; // "Amoxicillin 500 mg" / "CBC, CRP"
  startedAt: string;
  finishedAt?: string;
  waitingOn?: RoomRole;
  summary?: string; // one line outcome
  medicationId?: string;
  dose?: string;
  duration?: string;
  testIds?: string[];
}

export interface RoomTestResult {
  testId: string;
  name: string;
  result: string;
  abnormal: boolean;
  critical: boolean;
}

/** Chart changes the browser must apply, exactly once per (ref, seq). */
export interface RoomApply {
  ref: string;
  results?: RoomTestResult[];
  addPrescription?: { medicationId: string; dose: string; duration: string };
  removePrescription?: { medicationId: string; reason: string };
  cancelTests?: string[];
}

export type SpeechPriority = 'urgent' | 'result' | 'ack' | 'chat';

export interface RoomSpeak {
  id: string;
  speaker: RoomRole; // whose voice; faculty messages are relayed by 'nurse'
  text: string;
  lang: string;
  priority: SpeechPriority;
  ref?: string;
}

export interface FacultyEvent {
  action: 'invited' | 'joined' | 'message' | 'question' | 'approve' | 'deny' | 'note' | 'left';
  name: string;
  text: string;
  ref?: string;
}

export interface RoomScore {
  status: 'draft' | 'awaiting_signoff' | 'signed_off' | 'revised';
  total: number; // 0-100
  domains: { name: string; score: number; max: number; note: string }[];
  strengths: string[];
  improvements: string[];
  signedBy?: string;
  facultyComment?: string;
}

/** A side room (backend/agentroom/siderooms.py): a BAND room that belongs to one
 *  result, desk question, drill, report or authored case instead of an encounter. */
export interface SideState {
  kind: string;
  refId: string;
  status: string; // the flow's own states
  final: boolean;
  url: string; // the room in BAND, '' until it exists
  [key: string]: unknown;
}

export type RoomEvent = { seq: number; at: string } & (
  | { type: 'status'; enabled: boolean; reason?: string; departments: Partial<Record<RoomRole, boolean>> }
  | { type: 'room'; roomId: string; url: string; title: string; participants: RoomParticipant[] }
  | { type: 'message'; message: RoomMessage } // upsert by message.id
  | { type: 'delegation'; delegation: Delegation } // upsert by delegation.ref
  | { type: 'apply'; apply: RoomApply }
  | { type: 'speak'; speak: RoomSpeak }
  | { type: 'faculty'; faculty: FacultyEvent }
  | { type: 'question'; ref: string; from: RoomRole; text: string } // a department awaits the doctor's answer
  | { type: 'score'; score: RoomScore }
  | { type: 'side'; side: SideState } // upsert: the whole state of a side room
);
