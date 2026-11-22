/**
 * Voice / typed command parser for the operation theatre drill.
 *   "starting 500 ml RL bolus"   -> { kind: 'fluid-bolus', fluid: 'RL', volumeMl: 500 }
 *   "giving atropine 0.6"        -> { kind: 'drug', drug: 'atropine', dose: 0.6 }
 *   "suction on at 150"          -> { kind: 'suction', on: true, pressure: 150 }
 * English plus common Hindi words (Latin and Devanagari) and Indian brand
 * names. Pure regex and word tables, no network.
 */

import { DRUGS, type ChecklistItem, type CauteryMode, type DrugId, type FluidId, type OTAction } from './scenarios.ts';

const DRUG_WORDS: Array<{ drug: DrugId; re: RegExp }> = [
  { drug: 'phenylephrine', re: /phenyl|phenylephrine|neosynephrine|neo.?synephrine|फिनाइल|फेनिल/ },
  { drug: 'ephedrine', re: /ephed|ephedrine|एफेड्रिन|इफेड्रिन/ },
  { drug: 'atropine', re: /atropin|एट्रोपिन|ऐट्रोपिन/ },
  { drug: 'ondansetron', re: /ondan|ondem|emeset|zofran|vomikind|ओन्डेन|ओंडेन/ },
  { drug: 'paracetamol', re: /paracet|\bpcm\b|perfalgan|acetaminophen|\bpacimol\b|पैरासिटामोल|पेरासिटामोल/ },
  { drug: 'tranexamic', re: /tranex|\btxa\b|ट्रानेक्स/ },
  { drug: 'cefazolin', re: /cefazol|cephazol|ancef|reflin|\bcefaz|सेफाज़ोलिन|सेफाजोलिन/ },
];

const NUM_WORDS: Record<string, number> = {
  zero: 0, half: 0.5, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10,
  fifty: 50, hundred: 100, 'one hundred': 100, 'a hundred': 100, 'two hundred fifty': 250, 'two fifty': 250,
  'five hundred': 500, thousand: 1000, 'one thousand': 1000,
  ek: 1, teen: 3, char: 4, paanch: 5, panch: 5, chhe: 6, das: 10, sau: 100, 'paanch sau': 500, 'dhai sau': 250,
};

/** "point six" -> "0.6", "zero point six" -> "0.6", word numbers -> digits. */
function normaliseNumbers(text: string): string {
  let t = ` ${text} `;
  t = t.replace(/\b(?:zero\s+)?point\s+(one|two|three|four|five|six|seven|eight|nine|\d)\b/g, (_, d: string) => {
    const n = /\d/.test(d) ? d : String(NUM_WORDS[d]);
    return ` 0.${n} `;
  });
  const keys = Object.keys(NUM_WORDS).sort((a, b) => b.length - a.length);
  for (const k of keys) {
    t = t.replace(new RegExp(String.raw`(^|\s)${k}(?=\s)`, 'g'), (_m, pre: string) => `${pre}${NUM_WORDS[k]}`);
  }
  return t.trim();
}

function clean(input: string): string {
  return normaliseNumbers(
    input
      .toLowerCase()
      .replace(/(\d),(\d{3})/g, '$1$2')
      .replace(/[।,;!?]/g, ' ')
      .replace(/(\d)\s*\.\s*(\d)/g, '$1.$2')
      .replace(/(^|\s)\.(\d)/g, (_m, a: string, d: string) => `${a}0.${d}`)
      .replace(/\s+/g, ' ')
      .trim(),
  );
}

type Unit = 'mcg' | 'mg' | 'g';

/** First "<number> <unit?>" in the text. */
function numberWithUnit(t: string): { value: number; unit: Unit | null } | null {
  const m = /(\d+(?:\.\d+)?)\s*(micrograms?|mcg|µg|ug|milligrams?|mg|grams?|gm|g)?(?![a-z])/.exec(t);
  if (!m) return null;
  const value = Number(m[1]);
  const u = m[2] ?? '';
  const unit: Unit | null = /^(micro|mcg|µg|ug)/.test(u) ? 'mcg' : /^(milli|mg)/.test(u) ? 'mg' : /^(g|gm|gram)/.test(u) ? 'g' : null;
  return { value, unit };
}

function toUnit(value: number, from: Unit, to: Unit): number {
  const mcg = from === 'g' ? value * 1e6 : from === 'mg' ? value * 1000 : value;
  const out = to === 'g' ? mcg / 1e6 : to === 'mg' ? mcg / 1000 : mcg;
  return Math.round(out * 1000) / 1000;
}

function fluidOf(t: string): FluidId | null {
  if (/\bblood\b|prbc|packed (?:red )?cells|\bprc\b|खून|रक्त/.test(t)) return 'blood';
  if (/\brl\b|ringer|lactate|hartmann|आर ?एल/.test(t)) return 'RL';
  if (/\bns\b|normal saline|\bsaline\b|0\.9|\bnacl\b|सलाइन/.test(t)) return 'NS';
  return null;
}

/** Whole-word test that also works for Devanagari (JS \b is ASCII only). */
const word = (alts: string) => new RegExp(String.raw`(?:^|\s)(?:${alts})(?=\s|$)`);
const ON = word('on|start|starting|switch on|switching on|turn on|turning on|up|chalu|chalao|चालू|शुरू|ऑन');
const OFF = word('off|stop|stopping|switch off|switching off|turn off|turning off|band|बंद|ऑफ');

// Theatre room orders, only understood while a room is connected.
const HELP = /call (?:for )?(?:help|the consultant|a consultant|senior|the boss)|(?:need|get|send) (?:some )?help|consultant (?:ko )?(?:bula|call)|senior (?:ko )?(?:bula|call)|madad|sahayak? (?:bula|chahiye)|help (?:chahiye|beku|venum|kavali|pahije|lagbe)|मदद|सीनियर को बुला|कंसल्टेंट|ಸಹಾಯ|ಸೀನಿಯರ್|உதவி|సహాయం|మదద|मदत|সাহায্য/;
const BLOOD = /\bblood\b|prbc|packed (?:red )?cells|\bprc\b|khoon|raktha?m?\b|खून|रक्त|ब्लड|ರಕ್ತ|ಬ್ಲಡ್|ரத்த|இரத்த|రక్త|బ్లడ్|রক্ত|ব্লাড/;
const SAMPLE = /sample|specimen|cross ?match tube|सैंपल|सैम्पल|नमुना|नमूना|ಸ್ಯಾಂಪಲ್|ಮಾದರಿ|மாதிரி|శాంపిల్|నమూనా|নমুনা|স্যাম্পল/;
const SEND = /\bsend|\bsent\b|bhej|kalis|kaluhis|anupp|pamp|pampu|pathav|patha|भेज|ಕಳುಹಿಸ|ಕಳಿಸ|அனுப்ப|పంప|पाठव|পাঠা/;
const EMERGENCY = /emergency|o neg(?:ative)?\b|o minus|uncross|un cross|universal donor|इमरजेंसी|आपात|ओ नेगेटिव|ತುರ್ತು|ಒ ನೆಗೆಟಿವ್|அவசர|ஓ நெகட்டிவ்|అత్యవసర|ఓ నెగటివ్|आपत्कालीन|ओ निगेटिव्ह|জরুরি|ও নেগেটিভ/;

const OTHER = /blood (?:pressure|loss|sugar|gas)|suction|sucker|cautery|diathermy|warmer|oxygen|fio2|rl|ringer|saline|सक्शन/;

function parseRoomCommand(t: string): OTAction | null {
  if (HELP.test(t)) return { kind: 'call-help' };
  // An order for something else that happens to mention blood.
  if (OTHER.test(t) || DRUG_WORDS.some((d) => d.re.test(t))) return null;
  const blood = BLOOD.test(t);
  if (SAMPLE.test(t) && (SEND.test(t) || /cross ?match|group|label/.test(t))) return { kind: 'send-sample' };
  if (/\b(?:stop|slow)\b|\bband\b|बंद|रोक/.test(t)) return null;
  const vol = /(\d{3,4})\s*(?:ml|mls|cc)?/.exec(t);
  const volumeMl = vol ? Number(vol[1]) : 250;
  if (EMERGENCY.test(t) && (blood || /o neg|o minus|नेगेटिव|निगेटिव्ह|ನೆಗೆಟಿವ್|நெகட்டிவ்|నెగటివ్|নেগেটিভ/.test(t))) {
    return { kind: 'fluid-bolus', fluid: 'blood', volumeMl, emergency: true };
  }
  if (blood && !/ml ?\/ ?h|per h|an hour/.test(t) && (SEND.test(t) || /cross ?match|hang|start|give|unit|de do|चढ़ा|दो|ಕೊಡಿ|ಹಾಕಿ|கொடு|ఇవ్వ|ఎక్కించ|द्या|लावा|দিন|give/.test(t))) {
    return { kind: 'fluid-bolus', fluid: 'blood', volumeMl };
  }
  return null;
}

/** Parse one spoken or typed command. Returns null if nothing matched. `room`: a theatre room is connected. */
export function parseOTCommand(input: string, opts: { room?: boolean } = {}): OTAction | null {
  const t = clean(input);
  if (!t) return null;
  if (opts.room) {
    const a = parseRoomCommand(t);
    if (a) return a;
  }

  // Patient checks first: they rarely carry numbers.
  if (/allergy|wrist ?band|id band|name band|identity|एलर्जी|बैंड/.test(t)) return { kind: 'allergy-check' };
  if (/capillary|\bcrt\b|cap refill|refill/.test(t)) return { kind: 'cap-refill' };

  for (const d of DRUG_WORDS) {
    if (!d.re.test(t)) continue;
    const info = DRUGS[d.drug];
    const n = numberWithUnit(t.replace(d.re, ' '));
    let dose = info.ideal;
    if (n) {
      dose = n.unit ? toUnit(n.value, n.unit, info.unit) : n.value;
      // A bare number far outside the drug's scale was probably said in a smaller unit.
      if (!n.unit && info.unit === 'g' && n.value >= 100) dose = toUnit(n.value, 'mg', 'g');
      if (!n.unit && info.unit === 'mcg' && n.value < 2) dose = toUnit(n.value, 'mg', 'mcg');
    }
    return { kind: 'drug', drug: d.drug, dose };
  }

  if (/pulse|palpat|carotid|radial|नब्ज़|नब्ज|नाड़ी/.test(t)) return { kind: 'pulse-check' };

  if (/suction|sucker|yankauer|सक्शन/.test(t)) {
    const p = /(\d{2,3})/.exec(t);
    const on = !OFF.test(t);
    return { kind: 'suction', on, ...(p ? { pressure: Number(p[1]) } : {}) };
  }

  if (/cautery|diathermy|bovie|electro|\besu\b|return (?:pad|plate|electrode)|patient plate|\bpad\b|plate|कॉटरी/.test(t)) {
    const padChecked = /pad|plate|electrode/.test(t);
    const mode: CauteryMode | undefined = /bipolar/.test(t) ? 'bipolar' : /\bcut\b/.test(t) ? 'cut' : /coag|fulgur/.test(t) ? 'coag' : undefined;
    const on = OFF.test(t) && !padChecked ? false : true;
    return { kind: 'cautery', on, ...(mode ? { mode } : {}), ...(padChecked ? { padChecked } : {}) };
  }

  if (/warm|bair|hugger|forced air|blanket|heater|गर्म|वार्मर/.test(t)) {
    const n = /(\d{2})(?:\s*(?:degrees?|deg|c\b|°))?/.exec(t);
    const on = OFF.test(t) && !ON.test(t) ? false : true;
    return { kind: 'warmer', on, ...(n ? { tempC: Number(n[1]) } : {}) };
  }

  if (/fio2|f i o 2|oxygen|\bo2\b|ऑक्सीजन|आक्सीजन/.test(t)) {
    const n = /(\d{2,3})/.exec(t);
    if (n) return { kind: 'oxygen', fio2: Math.min(100, Number(n[1])) };
    if (/increase|up|full|max|hundred|बढ़ा/.test(t)) return { kind: 'oxygen', fio2: 100 };
    return { kind: 'oxygen', fio2: 100 };
  }

  const fluid = fluidOf(t);
  const fluidWords = /bolus|drip|fluid|infusion|\biv\b|ml|\bpump\b|ड्रिप|बोतल/.test(t);
  if (fluid || fluidWords) {
    if (OFF.test(t) && !/bolus/.test(t)) return { kind: 'fluid-stop' };
    const rate = /(\d+)\s*(?:ml|mls|cc)?\s*(?:\/|per|an|a|every)\s*(?:h\b|hr|hour|ghante|घंटे)|(\d+)\s*ml\/h/.exec(t);
    if (rate) return { kind: 'fluid-rate', fluid: fluid ?? 'RL', rateMlH: Number(rate[1] ?? rate[2]) };
    const vol = /(\d+)\s*(?:ml|mls|cc|millilit)/.exec(t) ?? /(\d+)/.exec(t);
    if (vol && (/bolus|stat|fast|push|squeeze|challenge/.test(t) || Number(vol[1]) >= 200)) {
      return { kind: 'fluid-bolus', fluid: fluid ?? 'RL', volumeMl: Number(vol[1]) };
    }
    if (/bolus/.test(t)) return { kind: 'fluid-bolus', fluid: fluid ?? 'RL', volumeMl: 500 };
    if (vol && /(?:^|\s)(?:at|rate|run|running)(?=\s|$)/.test(t)) return { kind: 'fluid-rate', fluid: fluid ?? 'RL', rateMlH: Number(vol[1]) };
    if (/maintenance/.test(t)) return { kind: 'fluid-rate', fluid: fluid ?? 'RL', rateMlH: vol ? Number(vol[1]) : 100 };
  }
  return null;
}

const YES_RE = word('yes|yeah|yep|confirmed|confirm|correct|haan|ha|ji|हाँ|हां|जी');
const NO_RE = word('no|not|nahi|nahin|none|नहीं|नही');
const NA_RE = /not applicable|\bn\/?a\b|\bna\b|lagu nahi|लागू नहीं/;

/** Map a free-text checklist answer to one of the item's option ids. */
export function parseChecklistAnswer(item: ChecklistItem, input: string): string | null {
  const t = clean(input);
  if (!t) return null;
  const ids = item.options.map((o) => o.id);
  if (ids.includes('na') && NA_RE.test(t)) return 'na';
  if (item.id === 'allergy' && /no known|no allerg|nkda|not allergic|koi allergy nahi|कोई एलर्जी नहीं/.test(t)) return 'none';
  const yes = YES_RE.test(t);
  const no = NO_RE.test(t);
  if (ids.includes('yes') && ids.includes('no')) {
    if (yes && !no) return 'yes';
    if (no && !yes) return 'no';
  }
  // Score options by the words that tell them apart ("sulfa", "appendicectomy", "left").
  const words = (s: string) => new Set(s.toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]/g, ' ').split(/\s+/).filter((w) => w.length > 3));
  const said = words(t);
  const sets = item.options.map((o) => words(o.label));
  const common = new Set([...(sets[0] ?? [])].filter((w) => sets.every((st) => st.has(w))));
  let bestId: string | null = null;
  let bestScore = 0;
  let tie = false;
  for (let i = 0; i < item.options.length; i++) {
    let score = 0;
    for (const w of sets[i]) if (!common.has(w) && said.has(w)) score += 1;
    if (score > bestScore) {
      bestId = item.options[i].id;
      bestScore = score;
      tie = false;
    } else if (score > 0 && score === bestScore) tie = true;
  }
  if (bestId && !tie) return bestId;
  if (yes && !no && ids.includes('right')) return 'right';
  if (no && /consent/.test(t) && ids.includes('no-consent')) return 'no-consent';
  return null;
}
