// The BAND agent room as the browser sees it: a pure reducer over the hub's
// RoomEvent stream plus derived helpers. No imports at runtime, so the Node
// test runner and the store can both load it.

import type {
  Delegation,
  DelegationStatus,
  FacultyEvent,
  RoomEvent,
  RoomMessage,
  RoomParticipant,
  RoomRole,
  RoomScore,
} from './types';

export type RoomConnection = 'idle' | 'connecting' | 'live' | 'offline';

export interface RoomStage {
  status: DelegationStatus;
  waitingOn?: RoomRole;
  at: string;
  /** The outcome as it read at that stage (a later override replaces it). */
  summary?: string;
}

export interface RoomQuestion {
  ref: string;
  from: RoomRole;
  text: string;
  at: string;
  seq: number;
  /** The doctor's answer, once sent from this browser or seen in the room. */
  answer?: string;
}

export interface RoomFacultyEntry extends FacultyEvent {
  seq: number;
  at: string;
}

export interface RoomState {
  encounterId: string;
  connection: RoomConnection;
  /** The backend has BAND keys and opened this encounter. */
  enabled: boolean;
  reason?: string;
  departments: Partial<Record<RoomRole, boolean>>;
  lastSeq: number;
  roomId: string;
  url: string;
  title: string;
  participants: RoomParticipant[];
  /** Why a participant was brought in, by participant id. */
  joinedFor: Record<string, string>;
  messages: RoomMessage[];
  delegations: Delegation[];
  /** Status history per ref: the live stage tracker. */
  stages: Record<string, RoomStage[]>;
  questions: RoomQuestion[];
  faculty: RoomFacultyEntry[];
  /** seq at which the doctor last wrote to the faculty member. */
  toldFacultySeq: number;
  score: RoomScore | null;
}

export function emptyRoom(encounterId: string): RoomState {
  return {
    encounterId,
    connection: 'idle',
    enabled: false,
    departments: {},
    lastSeq: 0,
    roomId: '',
    url: '',
    title: '',
    participants: [],
    joinedFor: {},
    messages: [],
    delegations: [],
    stages: {},
    questions: [],
    faculty: [],
    toldFacultySeq: 0,
    score: null,
  };
}

const upsert = <T>(list: T[], item: T, same: (a: T) => boolean): T[] => {
  const i = list.findIndex(same);
  if (i < 0) return [...list, item];
  const out = list.slice();
  out[i] = item;
  return out;
};

export const ROLE_LABEL: Record<RoomRole, string> = {
  nurse: 'Asha',
  pharmacist: 'Pharmacy',
  lab: 'Lab',
  radiology: 'Radiology',
  examiner: 'Examiner',
  faculty: 'Faculty',
  teacher: 'Dr Iyer',
  reception: 'Priya',
  theatre: 'Theatre',
};

const OPEN: ReadonlySet<DelegationStatus> = new Set(['sent', 'working', 'waiting']);
/** Stages that close a department's question to the doctor. */
const ANSWERED: ReadonlySet<DelegationStatus> = new Set(['done', 'held', 'overridden', 'cancelled']);

export const isOpen = (d: Delegation): boolean => OPEN.has(d.status);

function why(state: RoomState, p: RoomParticipant): string {
  if (p.role === 'nurse') return '';
  if (p.role === 'faculty' || p.human) {
    const inv = [...state.faculty].reverse().find((f) => f.action === 'invited');
    return inv?.text || 'asked for by the doctor';
  }
  const d = state.delegations.find((x) => x.target === p.role);
  if (d) {
    const what: Partial<Record<Delegation['action'], string>> = {
      verify_rx: 'check',
      run_test: 'run',
      run_imaging: 'image',
      ask: 'answer',
    };
    return d.action === 'score_teamwork' ? 'mark the teamwork' : `${what[d.action] ?? 'answer'} ${d.label}`;
  }
  const m = state.messages.find((x) => x.to.includes(p.role) && x.from !== p.role);
  if (m) return `answer ${ROLE_LABEL[m.from] ?? m.fromName}`;
  return '';
}

/** Fill in reasons once the delegation that explains a join has arrived. */
function withReasons(state: RoomState): RoomState {
  let joinedFor = state.joinedFor;
  for (const p of state.participants) {
    if (joinedFor[p.id]) continue;
    const r = why(state, p);
    if (r) joinedFor = { ...joinedFor, [p.id]: r };
  }
  return joinedFor === state.joinedFor ? state : { ...state, joinedFor };
}

const closeQuestion = (state: RoomState, ref: string, answer: string): RoomState =>
  state.questions.some((q) => q.ref === ref && q.answer === undefined)
    ? { ...state, questions: state.questions.map((q) => (q.ref === ref && q.answer === undefined ? { ...q, answer } : q)) }
    : state;

/** Apply one event. Idempotent: an event whose seq was already seen is a
 *  no-op (same object back). `status` is a snapshot: it always applies and
 *  never moves the cursor, so a head-of-log status cannot hide a replay. */
export function roomReducer(state: RoomState, ev: RoomEvent): RoomState {
  if (ev.type === 'status') {
    return {
      ...state,
      enabled: ev.enabled,
      reason: ev.reason,
      departments: ev.departments ?? {},
    };
  }
  if (!Number.isFinite(ev.seq) || ev.seq <= state.lastSeq) return state;
  const s: RoomState = { ...state, lastSeq: ev.seq };
  switch (ev.type) {
    case 'room':
      return withReasons({
        ...s,
        enabled: true,
        roomId: ev.roomId,
        url: ev.url,
        title: ev.title,
        participants: ev.participants ?? [],
      });
    case 'message': {
      const m = ev.message;
      let next: RoomState = { ...s, messages: upsert(s.messages, m, (x) => x.id === m.id).slice(-300) };
      if (m.from === 'nurse' && m.to.includes('faculty')) next = { ...next, toldFacultySeq: ev.seq };
      if (m.kind === 'answer' && m.action === 'safety_question' && m.ref) {
        next = closeQuestion(next, m.ref, String((m.payload?.answer as string | undefined) ?? m.text));
      }
      return withReasons(next);
    }
    case 'delegation': {
      const d = ev.delegation;
      const hist = s.stages[d.ref] ?? [];
      const last = hist[hist.length - 1];
      const moved = !last || last.status !== d.status || last.waitingOn !== d.waitingOn;
      const stage: RoomStage = { status: d.status, at: ev.at, ...(d.waitingOn ? { waitingOn: d.waitingOn } : {}), ...(d.summary ? { summary: d.summary } : {}) };
      let next: RoomState = {
        ...s,
        delegations: upsert(s.delegations, d, (x) => x.ref === d.ref),
        stages: moved ? { ...s.stages, [d.ref]: [...hist, stage] } : s.stages,
      };
      if (ANSWERED.has(d.status)) next = closeQuestion(next, d.ref, '');
      return withReasons(next);
    }
    case 'question': {
      if (s.questions.some((x) => x.ref === ev.ref && x.text === ev.text && x.at === ev.at)) return s;
      const q: RoomQuestion = { ref: ev.ref, from: ev.from, text: ev.text, at: ev.at, seq: ev.seq };
      return { ...s, questions: [...s.questions.filter((x) => !(x.ref === q.ref && x.answer === undefined)), q] };
    }
    case 'faculty':
      if (s.faculty.some((f) => f.at === ev.at && f.action === ev.faculty.action && f.text === ev.faculty.text)) return s;
      return withReasons({ ...s, faculty: [...s.faculty, { ...ev.faculty, seq: ev.seq, at: ev.at }] });
    case 'score':
      return { ...s, score: ev.score };
    case 'apply': // chart change, applied by the client
    case 'speak': // voice, played by the client
      return s;
    default:
      return s;
  }
}

/** The hub restarted: read its log again from the start. Upserts, the question
 *  and faculty guards and the exactly-once keys make the replay harmless. */
export const rewind = (s: RoomState): RoomState => ({ ...s, lastSeq: 0 });

// ── local marks (what this browser just did) ─────────────────────────────

export const markAnswered = (s: RoomState, ref: string, text: string): RoomState => closeQuestion(s, ref, text);
export const markToldFaculty = (s: RoomState): RoomState => ({ ...s, toldFacultySeq: s.lastSeq });

// ── derived ──────────────────────────────────────────────────────────────

export const pendingFor = (s: RoomState, role: RoomRole): Delegation[] =>
  s.delegations.filter((d) => d.target === role && isOpen(d));

export const openDelegations = (s: RoomState): Delegation[] => s.delegations.filter(isOpen);

export function openQuestion(s: RoomState): RoomQuestion | null {
  for (let i = s.questions.length - 1; i >= 0; i--) if (s.questions[i].answer === undefined) return s.questions[i];
  return null;
}

/** Held drugs that nobody has released. */
export const heldDelegations = (s: RoomState): Delegation[] =>
  s.delegations.filter((d) => d.action === 'verify_rx' && d.status === 'held');

export const facultyMember = (s: RoomState): RoomParticipant | null =>
  s.participants.find((p) => p.human || p.role === 'faculty') ?? null;

/** A human is here: they arrived or wrote, and have not left. An invitation
 *  alone puts them on the roster but not in the room. */
export function facultyPresent(s: RoomState): boolean {
  const last = s.faculty[s.faculty.length - 1];
  if (last) return last.action !== 'left' && last.action !== 'invited';
  return !!facultyMember(s);
}

/** Name of the human: the roster entry, else whoever last acted. */
export function facultyName(s: RoomState): string {
  const p = facultyMember(s);
  if (p?.name) return p.name;
  for (let i = s.faculty.length - 1; i >= 0; i--) if (s.faculty[i].name) return s.faculty[i].name;
  return 'the faculty member';
}

/** The human asked the doctor something and has had no reply yet. */
export function awaitingFaculty(s: RoomState): boolean {
  for (let i = s.faculty.length - 1; i >= 0; i--) {
    const f = s.faculty[i];
    if (f.seq <= s.toldFacultySeq) return false;
    if (f.action === 'question') return true;
    if (f.action === 'left' || f.action === 'approve' || f.action === 'deny') return false;
  }
  return false;
}

export interface RoomContext {
  encounterId: string;
  enabled: boolean;
  pendingQuestion?: { role: RoomRole; ref: string };
  awaitingFaculty: boolean;
  heldRefs: string[];
}

export function roomContext(s: RoomState | null): RoomContext {
  if (!s) return { encounterId: '', enabled: false, awaitingFaculty: false, heldRefs: [] };
  const q = openQuestion(s);
  return {
    encounterId: s.encounterId,
    enabled: s.enabled,
    ...(q ? { pendingQuestion: { role: q.from, ref: q.ref } } : {}),
    awaitingFaculty: awaitingFaculty(s),
    heldRefs: heldDelegations(s).map((d) => d.ref),
  };
}

/** Department to department, without Asha: she never received it. */
export const isSideConversation = (m: RoomMessage): boolean =>
  m.from !== 'nurse' && m.from !== 'faculty' && m.type === 'text' && m.to.length > 0 && !m.to.includes('nurse') && !m.to.includes('faculty');

/** A message from the person in the room. */
export const isHumanMessage = (m: RoomMessage): boolean => m.human || m.from === 'faculty';

/** Slim line rather than a bubble. */
export const isSlim = (m: RoomMessage): boolean => m.type !== 'text';

// ── who knows what ───────────────────────────────────────────────────────

/** The facts a hand-off can carry, in the order the panel lists them. */
export const FACTS = [
  'name', 'age and sex', 'complaint', 'allergies', 'history', 'pregnancy', 'medicines', 'tests ordered', 'lab results', 'imaging', 'kidney function', 'teamwork log',
] as const;
export type Fact = (typeof FACTS)[number];

/** Facts worth naming as withheld. */
const SENSITIVE: readonly Fact[] = ['name', 'allergies', 'history', 'medicines', 'lab results', 'imaging'];

const filled = (v: unknown): boolean =>
  v !== undefined && v !== null && v !== '' && v !== 'unknown' && !(Array.isArray(v) && v.length === 0) && !(typeof v === 'object' && !Array.isArray(v) && Object.keys(v as object).length === 0);

/** Which facts a payload discloses. Reads keys only, never the prose. */
export function factsIn(payload: Record<string, unknown> | undefined, action?: string): Fact[] {
  const out = new Set<Fact>();
  if (!payload) return [];
  const imaging = action === 'run_imaging';
  const walk = (o: Record<string, unknown>, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (!filled(v)) continue;
      const key = k.toLowerCase();
      if (key === 'patient' || key === 'context') {
        if (typeof v === 'object' && !Array.isArray(v) && depth < 3) walk(v as Record<string, unknown>, depth + 1);
      } else if (key === 'name' && depth > 0) out.add('name');
      else if (key === 'patientname') out.add('name');
      else if (key === 'age' || key === 'gender' || key === 'sex') out.add('age and sex');
      else if (key === 'chiefcomplaint' || key === 'indication') out.add('complaint');
      else if (key === 'allergies') out.add('allergies');
      else if (key === 'history' || key === 'anamnesis') out.add('history');
      else if (key === 'pregnancy' || key === 'pregnant') out.add('pregnancy');
      else if (key === 'current' || key === 'medication' || key === 'medicationid' || key === 'medications' || key === 'prescriptions') out.add('medicines');
      else if (key === 'tests') out.add('tests ordered');
      else if (key === 'results' || key === 'testresults') out.add(imaging ? 'imaging' : 'lab results');
      else if (key === 'impression') out.add('imaging');
      else if (key === 'creatinine' || key === 'egfr') out.add('kidney function');
      else if (key === 'timeline' || key === 'counts') out.add('teamwork log');
    }
  };
  walk(payload, 0);
  return FACTS.filter((f) => out.has(f));
}

/** The readable field list of one hand-off (leaf names, no ids). */
export function sharedFields(payload: Record<string, unknown> | undefined): string[] {
  const out: string[] = [];
  const nice = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').toLowerCase();
  const walk = (o: Record<string, unknown>, depth: number) => {
    for (const [k, v] of Object.entries(o)) {
      if (!filled(v)) continue;
      if (/^(caseid|medicationid|testid|osce|originalref|facultyid|enc|about)$/i.test(k)) continue;
      if (v && typeof v === 'object' && !Array.isArray(v) && depth < 2) walk(v as Record<string, unknown>, depth + 1);
      else out.push(nice(k));
    }
  };
  if (payload) walk(payload, 0);
  return [...new Set(out)];
}

/** Every fact each participant has been sent (or produced) in this room. */
export function knowledge(s: RoomState): Partial<Record<RoomRole, Fact[]>> {
  const acc = new Map<RoomRole, Set<Fact>>();
  const add = (r: RoomRole, facts: Fact[]) => {
    const set = acc.get(r) ?? new Set<Fact>();
    for (const f of facts) set.add(f);
    acc.set(r, set);
  };
  for (const m of s.messages) {
    if (m.type !== 'text') continue;
    const facts = factsIn(m.payload, m.action);
    add(m.from, facts);
    for (const r of m.to) add(r, facts);
  }
  const out: Partial<Record<RoomRole, Fact[]>> = {};
  for (const [r, set] of acc) out[r] = FACTS.filter((f) => set.has(f));
  return out;
}

/** Sensitive facts this role has never been sent in this room. */
export function notShared(s: RoomState, role: RoomRole): Fact[] {
  const known = new Set(knowledge(s)[role] ?? []);
  return SENSITIVE.filter((f) => !known.has(f));
}

// ── live tracker and timeline ────────────────────────────────────────────

export interface TrackerStep {
  label: string;
  state: 'done' | 'now' | 'todo' | 'bad';
}

const END_LABEL: Partial<Record<DelegationStatus, string>> = {
  done: 'done',
  held: 'on hold',
  overridden: 'released by faculty',
  cancelled: 'cancelled',
  failed: 'failed',
  timeout: 'no reply',
};

const verdictWord = (d: Delegation): string => (d.action === 'verify_rx' ? 'verdict' : d.action === 'ask' ? 'answer' : d.action === 'score_teamwork' ? 'score' : 'result');

/** sent > working > waiting on Lab > verdict, from the recorded history. */
export function tracker(s: RoomState, d: Delegation): TrackerStep[] {
  const hist = s.stages[d.ref] ?? [];
  const waited = [...hist].reverse().find((h) => h.status === 'waiting' && h.waitingOn)?.waitingOn;
  const sawWork = hist.some((h) => h.status === 'working' || h.status === 'waiting') || !isOpen(d);
  const ended = !isOpen(d);
  const steps: TrackerStep[] = [{ label: 'sent', state: d.status === 'sent' ? 'now' : 'done' }];
  steps.push({ label: 'working', state: ended || d.status === 'waiting' ? (sawWork ? 'done' : 'todo') : d.status === 'working' ? 'now' : 'todo' });
  if (waited) steps.push({ label: `waiting on ${ROLE_LABEL[waited] ?? waited}`, state: d.status === 'waiting' ? 'now' : 'done' });
  const bad = d.status === 'held' || d.status === 'failed' || d.status === 'timeout' || d.status === 'cancelled';
  steps.push({
    label: ended ? (d.status === 'done' ? verdictWord(d) : END_LABEL[d.status] ?? d.status) : verdictWord(d),
    state: ended ? (bad ? 'bad' : 'done') : 'todo',
  });
  return steps;
}

export function elapsedSeconds(d: Delegation, now: number): number {
  const from = Date.parse(d.startedAt);
  if (!Number.isFinite(from)) return 0;
  const to = d.finishedAt ? Date.parse(d.finishedAt) : now;
  return Math.max(0, Math.round((to - from) / 1000));
}

export interface TimelineItem {
  at: string;
  who: string;
  what: string;
  tone?: 'good' | 'bad' | 'human';
}

/** The room as a short story, for the debrief and for observers. */
export function timeline(s: RoomState): TimelineItem[] {
  const out: TimelineItem[] = [];
  for (const d of s.delegations) {
    out.push({ at: d.startedAt, who: 'Asha', what: `asked ${ROLE_LABEL[d.target]}: ${d.label}` });
    for (const h of s.stages[d.ref] ?? []) {
      if (h.status === 'waiting' && h.waitingOn && h.waitingOn !== 'nurse') {
        const what = h.waitingOn === 'faculty' ? 'is waiting for a human signature' : `asked ${ROLE_LABEL[h.waitingOn]} first`;
        out.push({ at: h.at, who: ROLE_LABEL[d.target], what });
      } else if (END_LABEL[h.status]) {
        out.push({
          at: h.at,
          who: h.status === 'overridden' ? facultyName(s) : ROLE_LABEL[d.target],
          what: `${d.label}: ${h.status === 'held' ? `held. ${h.summary ?? ''}`.trim() : h.summary ?? END_LABEL[h.status]}`,
          tone: h.status === 'done' ? 'good' : h.status === 'overridden' ? 'human' : 'bad',
        });
      }
    }
  }
  for (const q of s.questions) {
    out.push({ at: q.at, who: ROLE_LABEL[q.from], what: `asked the doctor: ${q.text}` });
  }
  for (const f of s.faculty) {
    const verb: Record<FacultyEvent['action'], string> = {
      invited: 'was invited', joined: 'joined the room', message: 'wrote', question: 'asked', approve: 'approved', deny: 'declined', note: 'noted', left: 'left the room',
    };
    const text = f.action === 'invited' || f.action === 'joined' || f.action === 'left' ? '' : f.text;
    out.push({ at: f.at, who: f.name || 'Faculty', what: `${verb[f.action]}${text ? `: ${text}` : ''}`, tone: 'human' });
  }
  return out.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** One line for the collapsed dock and the screen reader. */
export function ticker(s: RoomState): string {
  const q = openQuestion(s);
  if (q) return `${ROLE_LABEL[q.from]} asks: ${q.text}`;
  const open = openDelegations(s);
  const d = open[open.length - 1];
  if (d) {
    if (d.status === 'waiting' && d.waitingOn) return `${ROLE_LABEL[d.target]} is waiting on ${d.waitingOn === 'nurse' ? 'you' : ROLE_LABEL[d.waitingOn]}: ${d.label}`;
    return `${ROLE_LABEL[d.target]} ${d.status === 'working' ? 'is working on' : 'has been sent'} ${d.label}`;
  }
  const items = timeline(s);
  const last = items[items.length - 1];
  return last ? `${last.who}: ${last.what}` : 'Asha is alone in the room';
}

/** Counts for POST /close. */
export function closeSummary(s: RoomState, extra: Record<string, unknown> = {}): Record<string, unknown> {
  const n = (st: DelegationStatus) => s.delegations.filter((d) => d.status === st).length;
  return {
    delegations: s.delegations.length,
    done: n('done'),
    held: n('held'),
    overridden: n('overridden'),
    cancelled: n('cancelled'),
    timeout: n('timeout'),
    failed: n('failed'),
    open: openDelegations(s).length,
    questionsAsked: s.questions.length,
    questionsAnswered: s.questions.filter((q) => q.answer).length,
    facultyInRoom: facultyPresent(s),
    ...extra,
  };
}

// ── read-only summary for in-app observers ───────────────────────────────

export interface RoomSummary {
  url: string;
  participants: Array<{ role: RoomRole; name: string; human: boolean }>;
  items: TimelineItem[];
  /** One live line. */
  now: string;
}

export function roomSummary(s: RoomState | null): RoomSummary | null {
  if (!s || !s.enabled || (!s.roomId && !s.delegations.length)) return null;
  return {
    url: s.url,
    participants: s.participants.map((p) => ({ role: p.role, name: p.name, human: p.human })),
    items: timeline(s).slice(-14),
    now: ticker(s),
  };
}
