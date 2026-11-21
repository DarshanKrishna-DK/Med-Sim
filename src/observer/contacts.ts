/**
 * Observer contact book: people the student can ask Asha to phone and invite
 * to watch a live consultation. Kept in this browser only
 * (localStorage 'medsim.observerContacts.v1'), no account, no backend copy.
 *
 * Pure helpers (phone / Telegram normalisation, fuzzy name match, the
 * "invite Darshan to observe" command parser) carry no imports so the Node
 * test runner can load this file directly.
 */

export type Relation = 'friend' | 'senior' | 'teacher' | 'classmate' | 'family' | 'other';

export const RELATIONS: { value: Relation; label: string; hint: string }[] = [
  { value: 'teacher', label: 'Teacher', hint: 'Notes and marks' },
  { value: 'senior', label: 'Senior', hint: 'Listen, whisper tips' },
  { value: 'classmate', label: 'Classmate', hint: 'Listen, whisper tips' },
  { value: 'friend', label: 'Friend', hint: 'Listen, whisper tips' },
  { value: 'family', label: 'Family', hint: 'Listen only' },
  { value: 'other', label: 'Other', hint: 'Listen only' },
];

export interface ObserverContact {
  id: string;
  name: string;
  relation: Relation;
  /** E.164, e.g. +919876543210. */
  phone: string;
  /** 'telegram' (latest bot chat), '@username' or 'tg:<chat id>'. */
  telegram?: string;
}

const KEY = 'medsim.observerContacts.v1';
const MAX_CONTACTS = 40;

// ── pure helpers ────────────────────────────────────────────────

/** E.164 or null. 10 bare digits are Indian (+91), same rule as the backend. */
export function normalizePhone(raw: string): string | null {
  let s = (raw ?? '').trim().replace(/[\s\-().]/g, '');
  if (s.startsWith('00')) s = `+${s.slice(2)}`;
  if (s.startsWith('+')) return /^\+\d{8,15}$/.test(s) ? s : null;
  if (/^0\d{10}$/.test(s)) s = s.slice(1);
  if (/^\d{10}$/.test(s)) return `+91${s}`;
  if (/^91\d{10}$/.test(s)) return `+${s}`;
  return null;
}

/** 'telegram' | '@user' | 'tg:<id>' (lower-cased), '' for blank, null when invalid. */
export function normalizeTelegram(raw: string | undefined): string | null {
  const s = (raw ?? '').trim().toLowerCase().replace(/^https?:\/\/t\.me\//, '@');
  if (!s) return '';
  if (s === 'telegram' || s === 'tg') return 'telegram';
  if (/^tg:-?\d{3,20}$/.test(s)) return s;
  const user = s.startsWith('@') ? s : `@${s}`;
  return /^@[a-z0-9_]{4,32}$/.test(user) ? user : null;
}

export function isRelation(v: unknown): v is Relation {
  return typeof v === 'string' && RELATIONS.some((r) => r.value === v);
}

/** Levenshtein distance, early exit above `max`. */
export function editDistance(a: string, b: string, max = 3): number {
  if (a === b) return 0;
  if (Math.abs(a.length - b.length) > max) return max + 1;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const cur = [i];
    let rowMin = i;
    for (let j = 1; j <= b.length; j++) {
      const v = Math.min(prev[j] + 1, cur[j - 1] + 1, prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      cur.push(v);
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    prev = cur;
  }
  return prev[b.length];
}

const norm = (s: string) =>
  s
    .toLowerCase()
    .replace(/^(dr|prof|sir|madam|mr|mrs|ms)\.?\s+/, '')
    .replace(/[^a-z\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();

/** Best contact for a spoken name: exact full name, then first name, then one
 *  typo (edit distance <= 1, names of 3+ letters). Null when nothing or an
 *  ambiguous tie matches. */
export function findContact(name: string, contacts: ObserverContact[]): ObserverContact | null {
  const q = norm(name);
  if (!q) return null;
  const rel = relationOf(name);
  if (rel) {
    const hits = contacts.filter((c) => c.relation === rel);
    return hits.length === 1 ? hits[0] : null;
  }
  const qFirst = q.split(' ')[0];
  const tiers: ((c: ObserverContact) => boolean)[] = [
    (c) => norm(c.name) === q,
    (c) => norm(c.name).split(' ')[0] === qFirst && (q === qFirst || norm(c.name).startsWith(q)),
    (c) => norm(c.name).split(' ')[0] === qFirst,
    (c) => {
      const full = norm(c.name);
      const first = full.split(' ')[0];
      if (q.length < 3) return false;
      return editDistance(full, q, 1) <= 1 || editDistance(first, qFirst, 1) <= 1;
    },
  ];
  for (const t of tiers) {
    const hits = contacts.filter(t);
    if (hits.length === 1) return hits[0];
    if (hits.length > 1) return null;
  }
  return null;
}

export interface InviteCommand {
  name: string;
  /** "invite X" or "... X to observe/watch/join": clearly an observer request,
   *  even when X is not in the contact book. A bare "call X" is not. */
  explicit: boolean;
}

const STOP_NAMES = new Set([
  'you', 'your', 'me', 'us', 'him', 'her', 'them', 'the', 'a', 'an', 'my', 'our', 'someone', 'somebody', 'back',
  'it', 'this', 'that', 'lab', 'security', 'code', 'ambulance', 'doctor', 'surgeon', 'surgery', 'radiology',
]);

/** "my teacher", "sir", "my senior": a relation word instead of a name. */
const RELATION_WORDS: Record<string, Relation> = {
  teacher: 'teacher', sir: 'teacher', madam: 'teacher', professor: 'teacher', mentor: 'teacher', guru: 'teacher',
  senior: 'senior', classmate: 'classmate', batchmate: 'classmate', friend: 'friend', dost: 'friend',
  sister: 'family', brother: 'family', mom: 'family', mother: 'family', dad: 'family', father: 'family',
};

/** Relation for a bare relation phrase ("my teacher", "sir"), else null. */
export function relationOf(phrase: string): Relation | null {
  const w = phrase.toLowerCase().replace(/[^a-z\s]/g, '').trim().replace(/^(my|our|the)\s+/, '');
  return RELATION_WORDS[w] ?? null;
}

const LEAD = /^\W*(?:(?:ok(?:ay)?|so|and|right|alright|hello|hi|hey|accha|achha|please|can you|could you|would you)\W+)*(?:(?:nurse|sister|a{1,2}sha)\W+)?(?:(?:please|can you|could you|would you)\W+)*/i;
const VERB = /^(invite|ask|call|ring|phone|add|get|bring|loop in|have|i want|i'?d like|i would like|let'?s get|let'?s have)\s+(.+)$/i;
/** Name first: "Darshan should watch this", "Darshan can sit in". */
const NAME_FIRST = /^([a-z][a-z'.-]*(?:\s+[a-z][a-z'.-]*)?)\s+(?:should|can|could|must|needs? to|has to|will)\s+(.+)$/i;
const NOT_NAMES = new Set(['i', 'we', 'she', 'he', 'they', 'nurse', 'sister', 'asha', 'patient', 'what', 'who', 'how', 'where', 'when', 'why']);
/** Words that end the name and start the purpose: "Darshan as an observer". */
const TAIL_START = new Set(['as', 'to', 'for', 'in', 'into', 'please', 'now', 'too', 'also', 'over', 'up', 'on', 'so', 'and', 'join', 'observe', 'watch']);
const PURPOSE = /\b(observ\w*|watch\w*|join\w*|sit\s+in|listen\w*|session|consult\w*|this call|the call|on the line|on (?:the )?call|see (?:this|it|me|how)|have a look|look at this|dial in|hop on)\b/i;

/** Intent, not one fixed phrase: "invite Darshan", "invite Darshan as an observer",
 *  "Asha, can you get Darshan to join", "add Darshan as observer",
 *  "call Darshan to watch", "loop in Darshan for this session". Null otherwise. */
export function parseInviteCommand(text: string): InviteCommand | null {
  const t = (text ?? '').trim().replace(LEAD, '').trim().replace(/[.!?]+$/, '');
  const nf = NAME_FIRST.exec(t);
  if (nf && !VERB.test(t) && PURPOSE.test(nf[2])) {
    const name = nf[1].trim();
    const first = name.split(/\s+/)[0].toLowerCase();
    if (!STOP_NAMES.has(first) && !NOT_NAMES.has(first)) return { name, explicit: true };
  }
  const m = VERB.exec(t);
  if (!m) return null;
  let verb = m[1].toLowerCase().replace(/'/g, '');
  if (/^(i want|id like|i would like|lets get|lets have)$/.test(verb)) verb = 'have';
  let words = m[2].trim().split(/\s+/);
  // "my teacher Darshan" -> Darshan; "my teacher" alone -> relation lookup.
  let relationPhrase = '';
  const w0 = (words[0] ?? '').toLowerCase().replace(/[.,!?]+$/, '');
  const w1 = (words[1] ?? '').toLowerCase().replace(/[.,!?]+$/, '');
  if ((w0 === 'my' || w0 === 'our') && relationOf(w1)) {
    relationPhrase = `my ${w1}`;
    words = words.slice(2);
  } else if (w0 === 'sir' || w0 === 'madam') {
    relationPhrase = w0;
    words = words.slice(1);
  }
  const nameWords: string[] = [];
  for (const w of words) {
    const bare = w.replace(/[.,'!?]+$/, '');
    if (nameWords.length >= 2 || TAIL_START.has(bare.toLowerCase())) break;
    if (!/^[a-z][a-z'.-]*$/i.test(bare)) break;
    nameWords.push(bare);
  }
  if (!nameWords.length && relationPhrase) {
    if ((verb === 'ask' || verb === 'get' || verb === 'have') && !PURPOSE.test(words.join(' '))) return null;
    return { name: relationPhrase, explicit: true };
  }
  if (!nameWords.length || STOP_NAMES.has(nameWords[0].toLowerCase())) return null;
  const tail = words.slice(nameWords.length).join(' ');
  const hasPurpose = PURPOSE.test(tail) || (!!relationPhrase && ['call', 'ring', 'phone'].includes(verb));
  const inviteVerb = ['invite', 'add', 'bring', 'loop in'].includes(verb);
  if (verb === 'ask' && !hasPurpose) return null;
  if ((verb === 'get' || verb === 'have') && !hasPurpose) return null;
  return { name: nameWords.join(' '), explicit: inviteVerb || hasPurpose };
}

// ── storage ─────────────────────────────────────────────────────

const storage = (): Storage | undefined => (typeof window === 'undefined' ? undefined : window.localStorage);
const listeners = new Set<() => void>();
let contacts: ObserverContact[] = read();

function read(): ObserverContact[] {
  try {
    const raw = storage()?.getItem(KEY);
    if (!raw) return [];
    const list = JSON.parse(raw) as unknown;
    if (!Array.isArray(list)) return [];
    return list
      .filter((c): c is ObserverContact => !!c && typeof c.name === 'string' && typeof c.phone === 'string')
      .map((c) => ({
        id: String(c.id || newId()),
        name: c.name.slice(0, 60),
        relation: isRelation(c.relation) ? c.relation : 'other',
        phone: c.phone,
        ...(c.telegram ? { telegram: String(c.telegram) } : {}),
      }))
      .slice(0, MAX_CONTACTS);
  } catch {
    return [];
  }
}

function write() {
  try {
    storage()?.setItem(KEY, JSON.stringify(contacts));
  } catch {
    /* private mode: keep for this session */
  }
  for (const l of listeners) l();
}

function newId(): string {
  return `oc-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

export const getContacts = (): ObserverContact[] => contacts;

export function subscribeContacts(l: () => void): () => void {
  listeners.add(l);
  return () => listeners.delete(l);
}

export interface ContactDraft {
  name: string;
  relation: Relation;
  phone: string;
  telegram?: string;
}

/** Validation messages per field; empty object when the draft is valid. */
export function validateContact(d: ContactDraft): Partial<Record<'name' | 'phone' | 'telegram', string>> {
  const out: Partial<Record<'name' | 'phone' | 'telegram', string>> = {};
  if (d.name.trim().length < 2) out.name = 'Enter a name';
  if (!normalizePhone(d.phone)) out.phone = 'Use +91 and 10 digits';
  if (normalizeTelegram(d.telegram) === null) out.telegram = "Use @username, 'telegram' or tg:<chat id>";
  return out;
}

/** Adds (or replaces a contact with the same phone). Returns it, or null when invalid. */
export function addContact(d: ContactDraft): ObserverContact | null {
  if (Object.keys(validateContact(d)).length) return null;
  const phone = normalizePhone(d.phone)!;
  const tg = normalizeTelegram(d.telegram) || undefined;
  const c: ObserverContact = { id: newId(), name: d.name.trim().slice(0, 60), relation: d.relation, phone, ...(tg ? { telegram: tg } : {}) };
  contacts = [c, ...contacts.filter((x) => x.phone !== phone)].slice(0, MAX_CONTACTS);
  write();
  return c;
}

export function removeContact(id: string) {
  contacts = contacts.filter((c) => c.id !== id);
  write();
}
