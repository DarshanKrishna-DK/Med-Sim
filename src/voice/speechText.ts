// Pure text helpers for staff speech: which language a line is in, how to cut
// it into TTS-sized sentences, and whether a transcript is only the staff's
// own words coming back through the microphone. No store or SDK imports, so
// Node tests can load it.

import type { Lang } from '../game/lang';

const SCRIPT: Array<[Lang, RegExp]> = [
  ['kn', /[ಀ-೿]/g],
  ['ta', /[஀-௿]/g],
  ['te', /[ఀ-౿]/g],
  ['bn', /[ঀ-৿]/g],
  ['hi', /[ऀ-ॣ०-ॿ]/g], // without the danda, which Bengali also uses
];

/** Language by majority script. A Latin drug name inside a Hindi sentence does
 *  not make it English, and one Hindi word does not make English Hindi.
 *  Devanagari is Marathi when the session is Marathi or the text has "ळ". */
export function majorityLang(text: string, session?: Lang): Lang {
  let best: Lang = 'en';
  let bestCount = 0;
  for (const [lang, rx] of SCRIPT) {
    const n = (text.match(rx) ?? []).length;
    if (n > bestCount) {
      best = lang;
      bestCount = n;
    }
  }
  if (!bestCount) return 'en';
  // Indic letters and vowel signs outnumber Latin letters per word, so a
  // plain majority is enough; loanwords in Latin rarely tip it.
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  if (latin > bestCount * 3) return 'en';
  if (best === 'hi') return session === 'mr' || /ळ/.test(text) ? 'mr' : 'hi';
  return best;
}

/** The language whose voice should read this line. Within a session the voice
 *  identity stays constant: an English line in a Hindi session is read by the
 *  Hindi voice, so Asha never turns into a different person mid-visit. Only a
 *  line in another script (which that voice cannot read) changes it. */
export function voiceLang(text: string, explicit: Lang | undefined, session: Lang): Lang {
  const script = majorityLang(text, explicit === 'mr' ? 'mr' : session);
  if (script !== 'en') return script;
  if (explicit && explicit !== 'en') return explicit;
  return session;
}

const SENTENCE_END = /(?<=[.!?।॥…]["'’”)\]]*)\s+|\n+/;
const CLAUSE_END = /(?<=[,;:،–—])\s+/;

/** Do not cut after "Dr.", "e.g.", "5." and friends. */
const FALSE_END = /(?:\b(?:dr|mr|mrs|ms|st|vs|no|approx|e\.g|i\.e|etc|tab|inj|cap)\.|\b\d{1,2}\.)$/i;

function hardWrap(s: string, max: number): string[] {
  const out: string[] = [];
  let cur = '';
  for (const w of s.split(/\s+/)) {
    if (cur && cur.length + 1 + w.length > max) {
      out.push(cur);
      cur = w;
    } else cur = cur ? `${cur} ${w}` : w;
  }
  if (cur) out.push(cur);
  return out;
}

/** Split into sentence groups of at most `max` characters, on sentence
 *  boundaries (Latin and the Devanagari danda), then clauses, then words. */
export function splitForTts(text: string, max = 260): string[] {
  const clean = text.replace(/[*_`#]+/g, '').replace(/[ \t]+/g, ' ').trim();
  if (!clean) return [];
  const raw = clean.split(SENTENCE_END).map((s) => s.trim()).filter(Boolean);
  const sentences: string[] = [];
  for (const s of raw) {
    const prev = sentences[sentences.length - 1];
    if (prev !== undefined && FALSE_END.test(prev)) sentences[sentences.length - 1] = `${prev} ${s}`;
    else sentences.push(s);
  }
  const pieces: string[] = [];
  for (const s of sentences) {
    if (s.length <= max) {
      pieces.push(s);
      continue;
    }
    for (const c of s.split(CLAUSE_END)) pieces.push(...(c.length <= max ? [c] : hardWrap(c, max)));
  }
  // Glue short neighbours so "Okay." is not its own round-trip, but keep
  // chunks sentence-sized: a chunk is the unit that finishes on a barge-in.
  const out: string[] = [];
  for (const p of pieces) {
    const last = out[out.length - 1];
    if (last !== undefined && (last.length < 28 || p.length < 18) && last.length + 1 + p.length <= max) {
      out[out.length - 1] = `${last} ${p}`;
    } else out.push(p);
  }
  return out;
}

export function normWords(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Is `heard` just staff speech leaking back through the microphone? Uses the
 *  share of heard words found, in order, in one of the staff lines. Short
 *  utterances need a full match, so a doctor's "stop" is never swallowed. */
export function isEchoOf(heard: string, staffLines: ReadonlyArray<string>): boolean {
  const h = normWords(heard).split(' ').filter(Boolean);
  if (!h.length) return false;
  for (const line of staffLines) {
    const l = normWords(line).split(' ').filter(Boolean);
    if (!l.length) continue;
    if (h.length < 3) {
      if (h.length === l.length && h.every((w, i) => w === l[i])) return true;
      continue;
    }
    let li = 0;
    let hit = 0;
    for (const w of h) {
      const at = l.indexOf(w, li);
      if (at >= 0) {
        hit += 1;
        li = at + 1;
      }
    }
    if (hit / h.length >= 0.75) return true;
  }
  return false;
}
