/**
 * Live faculty observer: MedSim's own RTM message types. They travel on the
 * same Agora RTM channel as the ConvoAI transcript (or as USER messages to
 * one peer) and are told apart by `object` (also sent as RTM `customType`).
 *
 *   medsim.event     student link -> channel   chart events (orders, exams, alerts, diagnosis)
 *   medsim.hello     observer -> student link  "I joined, send me the story so far"
 *   medsim.snapshot  student link -> observer  case label, transcript so far, events so far
 *   medsim.whisper   observer -> student link  private faculty note, shown as a toast
 *   medsim.marks     observer -> student link  OSCE domain scores 1-5 + comment
 *   medsim.ack       student link -> observer  whisper/marks received
 *
 * Pure module (no SDK imports) so `node --test` can run it.
 */

export const MEDSIM_TYPES = [
  'medsim.event',
  'medsim.hello',
  'medsim.snapshot',
  'medsim.whisper',
  'medsim.marks',
  'medsim.ack',
] as const;
export type MedsimType = (typeof MEDSIM_TYPES)[number];

export const OSCE_DOMAINS = [
  { key: 'history', label: 'History taking' },
  { key: 'examination', label: 'Examination' },
  { key: 'diagnosis', label: 'Diagnosis' },
  { key: 'management', label: 'Management' },
  { key: 'communication', label: 'Communication' },
] as const;
export type MarkDomain = (typeof OSCE_DOMAINS)[number]['key'];

export type ChartEventKind = 'order' | 'prescription' | 'followup' | 'exam' | 'alert' | 'diagnosis' | 'nurse';

export interface ChartEvent {
  kind: ChartEventKind;
  /** One line, e.g. "Test ordered: ECG". */
  label: string;
  detail?: string;
  severity?: 'info' | 'warning' | 'danger';
  at: number;
}

export interface FacultyMarks {
  id: string;
  caseId: string;
  scores: Record<MarkDomain, number>;
  comment: string;
  examiner: string;
  sentAt: number;
  /** Set by the student on receipt: the encounter it belongs to. */
  encounterAt?: number;
  receivedAt?: number;
}

export interface TranscriptSnapshotLine {
  who: 'doctor' | 'patient';
  text: string;
}

export type MedsimMessage =
  | { object: 'medsim.event'; caseId: string; events: ChartEvent[] }
  | { object: 'medsim.hello'; examiner: string }
  | {
      object: 'medsim.snapshot';
      caseId: string;
      caseLabel: string;
      osce: boolean;
      startedAt: number;
      transcript: TranscriptSnapshotLine[];
      events: ChartEvent[];
    }
  | { object: 'medsim.whisper'; id: string; text: string; examiner: string; at: number; to?: string }
  | { object: 'medsim.marks'; marks: FacultyMarks; to?: string }
  | { object: 'medsim.ack'; id: string; what: 'whisper' | 'marks'; to?: string };

export const LIMITS = {
  whisper: 280,
  comment: 1500,
  examiner: 60,
  label: 160,
  detail: 400,
  eventsPerMessage: 20,
  /** RTM v2 caps a message at 32 KB; stay well under it. */
  maxBytes: 24_000,
} as const;

const str = (v: unknown, max: number): string | null =>
  typeof v === 'string' ? v.replace(/\s+/g, ' ').trim().slice(0, max) : null;

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);

const optTo = (v: unknown): { to?: string } => (typeof v === 'string' && v ? { to: v.slice(0, 32) } : {});

const KINDS: ReadonlyArray<ChartEventKind> = ['order', 'prescription', 'followup', 'exam', 'alert', 'diagnosis', 'nurse'];
const SEVERITIES = ['info', 'warning', 'danger'] as const;

export function parseChartEvent(v: unknown): ChartEvent | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const kind = KINDS.find((k) => k === o.kind);
  const label = str(o.label, LIMITS.label);
  const at = num(o.at);
  if (!kind || !label || at === null) return null;
  const ev: ChartEvent = { kind, label, at };
  const detail = str(o.detail, LIMITS.detail);
  if (detail) ev.detail = detail;
  const sev = SEVERITIES.find((s) => s === o.severity);
  if (sev) ev.severity = sev;
  return ev;
}

function parseEvents(v: unknown, max: number): ChartEvent[] {
  if (!Array.isArray(v)) return [];
  return v.slice(-max).map(parseChartEvent).filter((e): e is ChartEvent => e !== null);
}

/** Clamp a 1-5 OSCE score; anything else is invalid (null). */
export function clampScore(v: unknown): number | null {
  const n = num(v);
  if (n === null) return null;
  const r = Math.round(n);
  return r >= 1 && r <= 5 ? r : null;
}

export function parseMarks(v: unknown): FacultyMarks | null {
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  const id = str(o.id, 40);
  const caseId = str(o.caseId, 64) ?? '';
  const sentAt = num(o.sentAt);
  const raw = o.scores && typeof o.scores === 'object' ? (o.scores as Record<string, unknown>) : null;
  if (!id || sentAt === null || !raw) return null;
  const scores = {} as Record<MarkDomain, number>;
  for (const d of OSCE_DOMAINS) {
    const s = clampScore(raw[d.key]);
    if (s === null) return null;
    scores[d.key] = s;
  }
  return {
    id,
    caseId,
    scores,
    comment: typeof o.comment === 'string' ? o.comment.trim().slice(0, LIMITS.comment) : '',
    examiner: str(o.examiner, LIMITS.examiner) ?? '',
    sentAt,
  };
}

/** Parse a decoded RTM JSON object into a MedSim message, or null when it is
 *  not one (agent transcripts, malformed or oversized fields). */
export function parseMedsimMessage(msg: Record<string, unknown> | null): MedsimMessage | null {
  if (!msg || typeof msg.object !== 'string' || !msg.object.startsWith('medsim.')) return null;
  switch (msg.object) {
    case 'medsim.event': {
      const events = parseEvents(msg.events, LIMITS.eventsPerMessage);
      if (!events.length) return null;
      return { object: 'medsim.event', caseId: str(msg.caseId, 64) ?? '', events };
    }
    case 'medsim.hello':
      return { object: 'medsim.hello', examiner: str(msg.examiner, LIMITS.examiner) ?? '' };
    case 'medsim.snapshot': {
      const transcript = Array.isArray(msg.transcript)
        ? msg.transcript
            .map((l): TranscriptSnapshotLine | null => {
              const o = l as Record<string, unknown> | null;
              const who = o?.who === 'doctor' || o?.who === 'patient' ? o.who : null;
              const text = typeof o?.text === 'string' ? o.text.trim().slice(0, 2000) : '';
              return who && text ? { who, text } : null;
            })
            .filter((l): l is TranscriptSnapshotLine => l !== null)
        : [];
      return {
        object: 'medsim.snapshot',
        caseId: str(msg.caseId, 64) ?? '',
        caseLabel: str(msg.caseLabel, LIMITS.label) ?? '',
        osce: msg.osce === true,
        startedAt: num(msg.startedAt) ?? 0,
        transcript,
        events: parseEvents(msg.events, 200),
      };
    }
    case 'medsim.whisper': {
      const id = str(msg.id, 40);
      const text = str(msg.text, LIMITS.whisper);
      if (!id || !text) return null;
      return {
        object: 'medsim.whisper',
        id,
        text,
        examiner: str(msg.examiner, LIMITS.examiner) ?? '',
        at: num(msg.at) ?? 0,
        ...optTo(msg.to),
      };
    }
    case 'medsim.marks': {
      const marks = parseMarks(msg.marks);
      return marks ? { object: 'medsim.marks', marks, ...optTo(msg.to) } : null;
    }
    case 'medsim.ack': {
      const id = str(msg.id, 40);
      const what = msg.what === 'whisper' || msg.what === 'marks' ? msg.what : null;
      return id && what ? { object: 'medsim.ack', id, what, ...optTo(msg.to) } : null;
    }
    default:
      return null;
  }
}

/** True when a message is meant for `selfUid`: USER-channel messages always
 *  are; channel messages only when untargeted or targeted at `selfUid`. */
export function isForMe(m: MedsimMessage, selfUid: string, channelType: string): boolean {
  if (channelType === 'USER') return true;
  const to = 'to' in m ? m.to : undefined;
  return !to || to === selfUid;
}

function byteLength(s: string): number {
  return new TextEncoder().encode(s).length;
}

/** Serialise a message for RTM. Snapshots drop their oldest transcript lines
 *  and events until they fit under LIMITS.maxBytes. */
export function encodeMedsim(m: MedsimMessage): string {
  let out = JSON.stringify(m);
  if (m.object !== 'medsim.snapshot' || byteLength(out) <= LIMITS.maxBytes) return out;
  const copy = { ...m, transcript: [...m.transcript], events: [...m.events] };
  while (byteLength(out) > LIMITS.maxBytes && (copy.transcript.length || copy.events.length)) {
    if (copy.transcript.length >= copy.events.length) copy.transcript.shift();
    else copy.events.shift();
    out = JSON.stringify(copy);
  }
  return out;
}

export function newMessageId(): string {
  return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

/** Mean of the five domain scores, one decimal. */
export function marksAverage(m: Pick<FacultyMarks, 'scores'>): number {
  const vals = OSCE_DOMAINS.map((d) => m.scores[d.key]);
  return Math.round((vals.reduce((a, b) => a + b, 0) / vals.length) * 10) / 10;
}
