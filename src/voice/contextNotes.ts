// "What has happened during this visit" notes for the live patient's prompt.
// Pure (post and clock injected) so it is unit-tested.
//
//  - one push at a time and only the newest state: two notes in a row used to
//    race as two POSTs and the older prompt could land last;
//  - notes within 600 ms share one push;
//  - bounded: the newest notes win, the prompt never grows without limit;
//  - the patient never learns a result, a verdict or which tests were ordered.

export interface NoteDeps {
  push(block: string): Promise<void>;
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(h: unknown): void;
}

export const NOTE_DELAY_MS = 600;
export const MAX_NOTES = 12;
export const MAX_CHARS = 1600;
const MAX_NOTE_CHARS = 420;

const TESTS_NOTE = 'The doctor has ordered some tests.';

const TESTY = /\b(tests?|investigations?|blood (?:work|sample)|x-?ray|ecg|ekg|scan|ultrasound|mri|ct|cbc|lft|imaging)\b/i;
/** Values, verdicts and department talk: nothing a patient would be told. */
const SECRET =
  /\b(results?|reports?|abnormal|normal|critical|raised|elevated|deranged|positive|negative|verdict|on hold|held|hold|pharmac\w+|radiolog\w+|lab(?:oratory)?|contraindicat\w+|interact\w+|allerg\w+|diagnos\w+|egfr|creatinine|impression)\b|\d+(?:\.\d+)?\s*(?:mg\/dl|g\/dl|mmol|meq|u\/l|iu\/l|ng\/ml|pg\/ml|\/cumm|x10|mm\/hr|%)/i;

/** The sentence, or the part of it the patient may hear: without brackets
 *  ("(review the lab results)"), then without what follows a semicolon. */
function told(s: string): string {
  if (/^The doctor has (?:prescribed|stopped)\b/.test(s)) return s; // names and doses only
  const bare = s.replace(/ *[(][^)]*[)]/g, '');
  const first = bare.split(';')[0].trim().replace(/([^.!?])$/, '$1.');
  return [s, bare, first].find((x) => x && !SECRET.test(x)) ?? '';
}

/** Keep only what the patient may know. Empty string: nothing to tell. */
export function safeNote(note: string): string {
  const clean = note.replace(/\s+/g, ' ').trim();
  if (!clean) return '';
  const out: string[] = [];
  for (const s of clean.split(/(?<=[.!?])\s+(?=[A-Z"'])/)) {
    // "Your phone just buzzed...", examination cues and the like pass through.
    const orders = /\b(nurse|doctor)\b/i.test(s) && /\b(done|ordered|arranged|sent|drew|taken|arranging|ordering)\b/i.test(s) && TESTY.test(s);
    const keep = orders ? TESTS_NOTE : told(s);
    if (keep && !out.includes(keep)) out.push(keep);
  }
  return out.join(' ').slice(0, MAX_NOTE_CHARS);
}

export class ContextNotes {
  private deps: NoteDeps;
  private notes: string[] = [];
  private timer: unknown = null;
  private pushing = false;
  private dirty = false;
  private closed = false;
  private waiters: Array<() => void> = [];

  constructor(deps: NoteDeps) {
    this.deps = deps;
  }

  /** Text block for the prompt, or '' when nothing has happened yet. */
  block(): string {
    if (!this.notes.length) return '';
    return (
      'WHAT HAS HAPPENED DURING THIS VISIT (you are aware of these; mention them naturally only if relevant):\n' +
      this.notes.map((n) => `- ${n}`).join('\n')
    );
  }

  list(): readonly string[] {
    return this.notes;
  }

  /** Add a note. Resolves once a push that contains it has been attempted. */
  add(raw: string): Promise<void> {
    const note = safeNote(raw);
    if (!note || this.closed) return Promise.resolve();
    // The same thing again moves to the end instead of piling up.
    this.notes = [...this.notes.filter((n) => n !== note), note].slice(-MAX_NOTES);
    while (this.notes.length > 1 && this.notes.join('').length > MAX_CHARS) this.notes.shift();
    this.dirty = true;
    const p = new Promise<void>((res) => this.waiters.push(res));
    this.schedule();
    return p;
  }

  /** Push again soon (the live agent was replaced). */
  refresh(): void {
    if (this.closed || !this.notes.length) return;
    this.dirty = true;
    this.schedule();
  }

  close(): void {
    this.closed = true;
    if (this.timer !== null) this.deps.clearTimeout(this.timer);
    this.timer = null;
    this.settle();
  }

  private settle() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private schedule() {
    if (this.timer !== null || this.pushing) return; // the running push re-schedules
    this.timer = this.deps.setTimeout(() => {
      this.timer = null;
      void this.flush();
    }, NOTE_DELAY_MS);
  }

  private async flush(): Promise<void> {
    if (this.pushing || !this.dirty || this.closed) return;
    this.pushing = true;
    this.dirty = false;
    const mine = this.waiters;
    this.waiters = [];
    try {
      await this.deps.push(this.block());
    } catch {
      /* the caller logs; the next note carries this one too */
    } finally {
      this.pushing = false;
      for (const f of mine) f();
      if (this.dirty && !this.closed) this.schedule();
    }
  }
}
