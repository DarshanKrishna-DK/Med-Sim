/**
 * Voice / typed command parser for the triage drill.
 * "bed one is red, oxygen and IV access"  ->  { bed: 1, level: 1, action: 'resus' }
 * Understands English, Hindi (Latin and Devanagari) and Kannada (Latin and script).
 * Pure regex and word tables, no network.
 */

import type { ActionId, EsiLevel } from './cases';

export interface TriageCommand {
  bed?: number;
  level?: EsiLevel;
  action?: ActionId;
}

const NUM_WORDS: Record<string, number> = {
  // English
  one: 1, two: 2, three: 3, four: 4, five: 5, first: 1, second: 2, third: 3, fourth: 4, fifth: 5,
  // Hindi (Latin)
  ek: 1, do: 2, teen: 3, tin: 3, char: 4, chaar: 4, paanch: 5, panch: 5, pach: 5,
  // Hindi (Devanagari)
  'एक': 1, 'दो': 2, 'तीन': 3, 'चार': 4, 'पांच': 5, 'पाँच': 5,
  // Kannada (Latin)
  ondu: 1, onde: 1, eradu: 2, mooru: 3, muru: 3, naalku: 4, nalku: 4, aidu: 5, ayidu: 5,
  // Kannada (script)
  'ಒಂದು': 1, 'ಎರಡು': 2, 'ಮೂರು': 3, 'ನಾಲ್ಕು': 4, 'ಐದು': 5,
};

const NUM_TOKEN = Object.keys(NUM_WORDS)
  .sort((a, b) => b.length - a.length)
  .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
  .join('|');
const NUM_RE = `(?:[1-5]|${NUM_TOKEN})`;

function numOf(token: string): number | undefined {
  if (/^[1-5]$/.test(token)) return Number(token);
  return NUM_WORDS[token];
}

const BED_WORDS = 'bed|patient|number|no\\.?|cot|बेड|मरीज|मरीज़|पेशेंट|नंबर|ಬೆಡ್|ರೋಗಿ|ನಂಬರ್|bistar|marij|rogi';
const LEVEL_WORDS = 'esi|level|triage|category|लेवल|स्तर|ಲೆವೆಲ್|ಹಂತ';

const COLOURS: Array<{ level: EsiLevel; words: string[] }> = [
  { level: 1, words: ['red', 'lal', 'laal', 'लाल', 'kempu', 'ಕೆಂಪು'] },
  { level: 2, words: ['orange', 'narangi', 'नारंगी', 'santri', 'kittale', 'ಕಿತ್ತಳೆ'] },
  { level: 3, words: ['yellow', 'peela', 'pila', 'पीला', 'haladi', 'ಹಳದಿ'] },
  { level: 4, words: ['green', 'hara', 'हरा', 'hasiru', 'ಹಸಿರು'] },
  { level: 5, words: ['blue', 'neela', 'nila', 'नीला', 'neeli', 'ನೀಲಿ'] },
];

const ACTION_PATTERNS: Array<{ action: ActionId; re: RegExp }> = [
  { action: 'stroke', re: /stroke|\bct\b|brain scan|लकवा|स्ट्रोक|ಸ್ಟ್ರೋಕ್|paralysis/ },
  { action: 'ecg', re: /\becg\b|\bekg\b|e c g|ईसीजी|ಇಸಿಜಿ|cardiac/ },
  { action: 'obstetric', re: /obstet|labou?r|delivery|gynae|gyne|prasav|प्रसव|ಹೆರಿಗೆ/ },
  { action: 'resus', re: /resus|oxygen|\bo2\b|\biv\b|i\.v\.|iv access|airway|ऑक्सीजन|आक्सीजन|ಆಕ್ಸಿಜನ್|oxijan/ },
  { action: 'monitored', re: /monitor|high dependency|\bhdu\b|\bicu\b|doctor now|मॉनिटर|ಮಾನಿಟರ್/ },
  { action: 'treatment', re: /dressing|suture|stitch|procedure|treatment room|plaster|पट्टी|ಡ್ರೆಸ್ಸಿಂಗ್/ },
  { action: 'fast', re: /fast.?track|\bopd\b|dental|outpatient|ओपीडी|ಒಪಿಡಿ/ },
  { action: 'waiting', re: /wait|re.?check|baith|बैठ|इंतजार|इंतज़ार|ಕಾಯ|kaayi/ },
];

export function parseTriageCommand(input: string): TriageCommand {
  const text = input.toLowerCase().replace(/[,.;:!?]/g, ' ').replace(/\s+/g, ' ').trim();
  const cmd: TriageCommand = {};
  if (!text) return cmd;

  // Level from an explicit "level 2" / "ESI two" phrase first, so it never gets read as the bed.
  let levelNum: number | undefined;
  let working = text;
  const lvl = new RegExp(`(?:${LEVEL_WORDS})\\s*(${NUM_RE})(?![a-z])`, 'u').exec(working);
  if (lvl) {
    levelNum = numOf(lvl[1]);
    working = working.replace(lvl[0], ' ');
  }

  // Bed: "bed one", "patient 3", "number teen".
  const bedRe = new RegExp(`(?:${BED_WORDS})\\s*(${NUM_RE})(?![a-z])`, 'u');
  const bed = bedRe.exec(working);
  if (bed) {
    cmd.bed = numOf(bed[1]);
    working = working.replace(bed[0], ' ');
  } else {
    // Bare number at the start: "one is red".
    const lead = new RegExp(`^(${NUM_RE})(?:\\s|$)`, 'u').exec(working);
    if (lead) {
      cmd.bed = numOf(lead[1]);
      working = working.slice(lead[0].length);
    }
  }

  // Colour names.
  for (const c of COLOURS) {
    if (c.words.some((w) => new RegExp(`(?:^|[^a-z])${w}(?![a-z])`, 'u').test(working))) {
      cmd.level = c.level;
      break;
    }
  }
  if (cmd.level === undefined && levelNum !== undefined && levelNum >= 1 && levelNum <= 5) {
    cmd.level = levelNum as EsiLevel;
  }

  for (const a of ACTION_PATTERNS) {
    if (a.re.test(working)) {
      cmd.action = a.action;
      break;
    }
  }
  return cmd;
}
