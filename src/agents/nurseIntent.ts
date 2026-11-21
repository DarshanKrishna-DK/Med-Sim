// Pure prefilter for the charge-nurse agent: decides whether a doctor's
// utterance is worth a round-trip to /agent/nurse/act. The backend LLM makes
// the real call (intent 'order' vs 'none'), so this errs on the side of
// sending: a false positive costs one cheap call, a false negative means the
// nurse ignores the doctor. No store imports, so Node tests can load it.

import { TESTS } from '../data/tests.ts';
import { MEDICATIONS } from '../data/medications.ts';

/** Generic or anatomy words from catalogue names that also show up in history
 *  talk ("your chest", "blood in the stool"), so they do not count alone. */
const STOP = new Set(
  ('injection cream oral blood serum anti spine test urine rapid screen chest bedside panel function studies free ' +
    'level abdominal pelvis abdomen cervical lumbar bone skin analysis assessment dental cell type lead peak flow high ' +
    'sensitivity basic morning head brain visual field dilated nerve fever lying standing cognitive airway mouth opening ' +
    'cold whole total direct wound mucosal soft tissue joint limb hips infant nasal spray immediate release tablet ' +
    'solution dose units scar paste keep available combined loading neurological artificial tears drops syrup ointment ' +
    'shampoo vaginal sublingual transdermal suspension mouthwash toothpaste extremity pelvic cardiac contrast density ' +
    'pulp vitality iron calcium potassium zinc copper fluid stool fecal pregnancy hepatitis influenza covid dengue ' +
    'syphilis typhus scrub leptospira rabies tetanus diphtheria chlamydia tropical concussion snake venom silver acid ' +
    'factor complement antibody antibodies antigen studies quantitative differential conduction marrow peripheral ' +
    'orthostatic intraoral panoramic periapical arterial metabolic coagulation clotting retina sensitivity').split(' '),
);

/** Abbreviations, slang and drug classes doctors use instead of catalogue names. */
const EXTRA = (
  'cbc fbc bmp cmp lft lfts kft rft tsh hba1c a1c ecg ekg xray cxr usg ct mri echo labs bloods sugar rbs fbs ppbs ' +
  'urinalysis culture swab troponin lipid lipids crp esr electrolytes abg ultrasound scan sonography ' +
  'antibiotic antibiotics painkiller painkillers analgesic analgesia antacid antacids fluids drip saline ringer iv ' +
  'inhaler nebulisation nebulization neb nebs oxygen steroid steroids antihistamine antiemetic laxative ors ' +
  'paracetamol crocin dolo pcm amoxy augmentin azithro cipro pan pantop omez ondem metro mg milligram milligrams ' +
  'tablet tablets tabs capsule capsules injection jab shot vaccine dressing bandage referral'
).split(' ');

function buildWords(): Set<string> {
  const out = new Set<string>(EXTRA);
  const names = [...TESTS.map((t) => t.name), ...MEDICATIONS.map((m) => m.name)];
  for (const n of names) {
    for (const w of n.toLowerCase().match(/[a-z]+/g) ?? []) if (w.length >= 4 && !STOP.has(w)) out.add(w);
  }
  return out;
}

/** Built once at module load from src/data/tests.ts + medications.ts. */
export const CLINICAL_WORDS: ReadonlySet<string> = buildWords();

const LEAD_FILLER = /^\W*(?:(?:ok(?:ay)?|so|and|right|alright|um+|uh+|hmm+|well|accha|achha|haan|theek hai|fine)\W+)*/i;

/** Spoken to the nurse: "Nurse, ...", "Sister ...", "Asha ...", "Didi ...",
 *  "Ma'am ..." at the start, or "nurse"/"Asha" anywhere in the sentence. */
/** "Nurse", "Asha", "Sister", "Didi" written in Devanagari, Kannada, Tamil, Telugu or Bengali script
 *  (Sarvam speech-to-text writes Indian-language speech in its own script). */
const NATIVE_NURSE = /(नर्स|आशा|सिस्टर|दीदी|ನರ್ಸ್|ನರ್ಸ|ಆಶಾ|ಸಿಸ್ಟರ್|ಅಕ್ಕ|நர்ஸ்|ஆஷா|சிஸ்டர்|నర్స్|ఆశా|సిస్టర్|নার্স|আশা|সিস্টার)/;
const INDIC = /[ऀ-෿]/;
/** Request verbs in Hindi, Marathi, Kannada, Tamil, Telugu and Bengali, plus Roman Kannada / Hindi. */
const NATIVE_ORDER =
  /(करा\s*दो|करवा\s*दो|करवाइए|कर\s*दो|दे\s*दो|दीजिए|लगा\s*दो|चढ़ा\s*दो|भेज\s*दो|मंगवा|करा|द्या|लावा|ಮಾಡಿಸಿ|ಮಾಡ್ಸಿ|ಕೊಡಿ|ಕೊಡ್ರಿ|ಹಾಕಿ|ಕಳುಹಿಸಿ|ಕಳಿಸಿ|ತರಿಸಿ|ಚೆಕ್\s*ಮಾಡಿ|கொடுங்க|கொடுங்கள்|பண்ணுங்க|போடுங்க|எடுங்க|ఇవ్వండి|చేయించండి|చేయండి|పెట్టండి|দিন|করান|করুন)/;
const ROMAN_ORDER = /(maadi|maadsi|madsi|maadisi|kodi|kodri|haaki|kalsi|karwa\s*do|karva\s*do|lagao|chadhao|bhejo|chadha\s*do)/i;
/** English medical loanwords written in Indian scripts ("ECG", "X-ray", "sugar", "test", "tablet"). */
const NATIVE_CLINICAL =
  /(ईसीजी|एक्स\s*-?\s*रे|सीबीसी|ब्लड|शुगर|टेस्ट|जांच|इंजेक्शन|गोली|दवा|पैरासिटामोल|स्कैन|ड्रिप|ಇಸಿಜಿ|ಎಕ್ಸ್\s*-?\s*ರೇ|ಬ್ಲಡ್|ಶುಗರ್|ಟೆಸ್ಟ್|ಇಂಜೆಕ್ಷನ್|ಮಾತ್ರೆ|ಔಷಧ|ಪ್ಯಾರಸಿಟಮಾಲ್|ಸ್ಕ್ಯಾನ್|ಡ್ರಿಪ್|ஈசிஜி|எக்ஸ்\s*ரே|டெஸ்ட்|மாத்திரை|ஊசி|ఈసీజీ|ఎక్స్\s*రే|టెస్ట్|మాత్ర|ఇంజెక్షన్|ইসিজি|এক্স\s*রে|টেস্ট|ওষুধ)/;

/** Mixed or native-script speech ("ಒಂದು ECG ಮಾಡಿಸಿ", "पैरासिटामोल दे दो", "sugar test maadi"). */
export function looksLikeNativeOrder(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  if (NATIVE_NURSE.test(t)) return true;
  if (ROMAN_ORDER.test(t)) return true;
  if (!INDIC.test(t)) return false;
  if (NATIVE_ORDER.test(t)) return true;
  return NATIVE_CLINICAL.test(t) && !/[?？]\s*$/.test(t) && t.split(/\s+/).length <= 6;
}

export function isAddressedToNurse(text: string): boolean {
  if (NATIVE_NURSE.test(text ?? '')) return true;
  const t = (text ?? '').trim().replace(LEAD_FILLER, '');
  if (/^(?:hey\s+|hi\s+)?(nurse|sister|a{1,2}sha|didi|ma'?am|madam|staff)\b/i.test(t)) return true;
  return /\b(nurse|a{1,2}sha)\b/i.test(t);
}

const normalise = (text: string) =>
  ` ${text
    .toLowerCase()
    .replace(/\bx[\s-]?rays?\b/g, 'xray')
    .replace(/\be\.?c\.?g\b/g, 'ecg')
    .replace(/\bc\.?b\.?c\b/g, 'cbc')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;

function hasClinicalWord(n: string): boolean {
  for (const w of n.trim().split(' ')) if (CLINICAL_WORDS.has(w)) return true;
  return false;
}

// Orders that need no catalogue word ("book a follow-up", "sort out the pain").
const ORDER_PHRASE =
  /\b(order(?:ing)?|prescrib(?:e|ing)|start (?:him|her|them|the patient)?\s*on|put (?:him|her|them|the patient) on|send (?:off|for)|draw (?:some )?bloods?|book|schedule|refer(?:ral)?|log (?:this|the) case|add (?:this|the) case to|logbook|follow ?up|sort (?:out )?(?:the |her |his |their )?pain|something for (?:the |her |his )?(?:pain|fever|acidity|vomiting|nausea|cough|itch\w*|allergy|sleep)|(?:kara|karwa|karva|karao|karwao|laga|likh|bhej|chadha) do|de do|dedo)\b/i;

// A request cue that turns a catalogue word into an order.
const REQUEST_CUE =
  /\b(please|pls|let'?s|lets|i want|i need|i'?d like|i would like|we need|we'?ll need|needs?|should we|shall we|can we|could we|can you|could you|go ahead|get|give|start|put|send|run|do|check(?:ed)?|arrange|organi[sz]e|repeat|add|kara|karo|karwa|karao|de|dedo|chahiye|bhejo|lagao|laga)\b/i;

const QUESTION_START =
  /^(do|does|did|have|has|had|are|is|were|was|when|how|what|what's|where|why|any|which|who|will|would|can|could|have you)\b/i;
const WE_QUESTION = /^(should|shall|can|could) (we|you|i)\b/i;

/** Does this utterance look like a clinical instruction worth sending to the
 *  nurse agent? Anything addressed to the nurse always goes; the backend
 *  decides 'none' vs 'order'. Questions to the patient stay excluded. */
export function looksLikeOrder(text: string): boolean {
  const raw = (text ?? '').trim();
  if (raw.length < 3) return false;
  if (isAddressedToNurse(raw)) return true;
  const t = raw.replace(LEAD_FILLER, '');
  // History questions to the patient ("do you take any medication?",
  // "how long have you had the fever") are not orders. "Should we get an
  // ECG?" is a suggestion to the team, so it still counts.
  if (QUESTION_START.test(t) && !WE_QUESTION.test(t) && (/\?\s*$/.test(t) || /\b(you|your|she|he|her|his)\b/i.test(t))) {
    return false;
  }
  if (ORDER_PHRASE.test(t)) return true;
  if (looksLikeNativeOrder(raw)) return true;
  const n = normalise(t);
  if (!hasClinicalWord(n)) return false;
  // "Bloods", "CBC and LFT", "chest x-ray please": short and clinical.
  const words = n.trim().split(' ').length;
  if (words <= 5) return true;
  return REQUEST_CUE.test(n);
}
