// Pure language rules for the doctor's utterances: is this spoken to the nurse,
// does it read like a clinical order, is it a question to the patient? Used by
// the offline router (voice/offlineRoute.ts) when POST /voice/route is slow or
// down, and by the coach watcher. backend/intent.py is the authority; both are
// tested on backend/tests/fixtures/intent_cases.json. No store imports, so Node
// tests can load it.

import { TESTS } from '../data/tests.ts';
import { MEDICATIONS } from '../data/medications.ts';
import { editDistance } from '../observer/contacts.ts';

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
const LONG_WORDS = [...CLINICAL_WORDS].filter((w) => w.length >= 8);
const fuzzy = new Map<string, boolean>();
/** "amoxycillin", "amoxicilin": a long word one or two letters off a drug. */
function nearClinical(w: string): boolean {
  if (w.length < 8) return false;
  let v = fuzzy.get(w);
  if (v === undefined) {
    v = LONG_WORDS.some((x) => x.slice(0, 3) === w.slice(0, 3) && Math.abs(x.length - w.length) <= 2 && editDistance(x, w, 2) <= 2);
    if (fuzzy.size > 500) fuzzy.clear();
    fuzzy.set(w, v);
  }
  return v;
}

// Indian-script word boundaries: JS \b only knows ASCII.
const B0 = '(?<![\\p{L}\\p{M}])';
const B1 = '(?![\\p{L}\\p{M}])';
const word = (alts: string, flags = 'iu') => new RegExp(`${B0}(?:${alts})${B1}`, flags);
/** Whole-word start only: Indian-language words carry case endings. */
const stem = (alts: string, flags = 'iu') => new RegExp(`${B0}(?:${alts})`, flags);

const LEAD_FILLER =
  /^[^\p{L}\p{N}]*(?:(?:ok(?:ay)?|so|and|right|alright|um+|uh+|hmm+|well|yes|yeah|no|now|hello|hi|hey|please|also|excuse me|thanks?|thank you|sorry|arre|accha|achha|haan|theek hai|thik hai|fine|अच्छा|ठीक है|हाँ|हां|अरे|ಸರಿ|ಆಯ್ತು|ಹಾಂ|சரி|ஆமா|సరే|అవును|बरं|ठीक आहे|आच्छा|আচ্ছা|ঠিক আছে|হ্যাঁ)[^\p{L}\p{N}]+)*/iu;
export const stripLead = (t: string): string => t.trim().replace(LEAD_FILLER, '');

export const INDIC = /[ऀ-෿]/;

// ── questions to the patient ────────────────────────────────────

const HISTORY_NATIVE = new RegExp(
  '(?:कब से|कब हुआ|कितने दिन|कितने समय|कितनी बार|कैसा (?:लग|महसूस)|कैसे हैं|क्या (?:हुआ|तकलीफ|परेशानी)|दर्द कहाँ|कहाँ (?:दर्द|होता|है)|पहले कभी|होता है\\s*[?？]|दिक्कत|तकलीफ|' +
    'ಎಷ್ಟು ದಿನ|ಯಾವಾಗ(?:ಿನಿಂದ)?|ಎಲ್ಲಿ ನೋವು|ಹೇಗಿದ್ದೀರ|ಏನಾಗಿದೆ|ಏನು ತೊಂದರೆ|ಇದೆಯಾ|ಇದ್ಯಾ|ದ್ದೀರಾ|ತ್ತೀರಾ|ಮೊದಲು .*ದ್ದೀರ|' +
    'எத்தனை நாள்|எப்போ(?:து|லேருந்து|லிருந்து)?|எங்க(?:ே)? வலி|எப்படி இருக்க|என்ன (?:பிரச்சனை|ஆச்சு)|இருக்கா|ிருக்கீங்களா|' +
    'ఎన్ని రోజు|ఎప్పటి నుంచి|ఎప్పుడు|ఎక్కడ నొప్పి|ఎలా ఉన్నారు|ఏమైంది|ఉందా|న్నారా|' +
    'किती दिवस|कधीपासून|केव्हापासून|कुठे दुख|कसं वाटत|काय झालं|काय त्रास|आहे का|होतं का|होतो का|' +
    'কত দিন|কতদিন|কবে থেকে|কখন থেকে|কোথায় ব্যথা|কেমন (?:আছেন|লাগছে)|কী হয়েছে|আছে কি|হয় কি|আগে কখনও|চ্ছেন|য়েছেন)',
  'u',
);
const YOU_NATIVE = stem('आप|आपको|आपके|आपका|आपकी|तुम|तुम्हें|तुम्हाला|तुम्ही|तुमच|ನಿಮ|ನೀವು|உங்க|நீங்க|మీకు|మీరు|మీ(?= )|আপনা|আপনি|তোমা|তুমি', 'u');
const NATIVE_Q =
  /(?<![\p{L}\p{M}])(?:क्या|कब|कहाँ|कहां|कैसे|कितन|कौन|ಏನು|ಯಾವ|ಹೇಗೆ|ಎಷ್ಟು|என்ன|எப்படி|எங்க|எவ்வளவு|ఏమి|ఏంటి|ఏం|ఎలా|ఎంత|काय|कसं|कुठे|कोणत|किती|কী|কি|কেন|কেমন|কোন|কত)/u;
/** The sentence ends as a yes/no question ("शुगर है क्या", "ಕೊಡಬಹುದಾ"). */
const NATIVE_Q_END = /(?:क्या|है क्या|का|ಯಾ|ದಾ|ತಾ|ீங்களா|லாமா|ிறதா|ுதா|ிருக்கா|ారా|ుందా|చ్చా|কি|না কি)\s*[?？.।]*\s*$/u;

/** Instructions and advice the patient carries out ("take with food"). */
const NATIVE_PATIENT_DO =
  /(?:खाइए|खाइये|खाना|पीजिए|पीना|लेटिए|लेट जाइए|बैठिए|बैठ जाइए|साँस लीजिए|सांस लीजिए|दवा.*लीजिए|गोली.*लीजिए|घर पर|अगर|मुँह खोल|मुंह खोल|चिंता मत|डरिए मत|ತಗೊಳ್ಳಿ|ತೆಗೆದುಕೊಳ್ಳಿ|ಕುಡಿಯಿರಿ|ತಿನ್ನಿ|ಕೂತ್ಕೊಳ್ಳಿ|ಕುಳಿತುಕೊಳ್ಳಿ|ಮಲಗಿ|ಉಸಿರು|ಭಯಪಡಬೇಡಿ|சாப்பிடுங்க|குடிங்க|உட்காருங்க|படுங்க|மூச்சு|வாயைத் திற|பயப்படாதீங்க|వేసుకోండి|తాగండి|తినండి|కూర్చోండి|పడుకోండి|ఊపిరి|భయపడకండి|खा(?:वा|ल|यच)|प्या|बसा|झोपा|श्वास|घाबरू नका|काळजी करू नका|গোলি খান|খাবেন|খান|বসুন|শুয়ে|শ্বাস|চিন্তা করবেন না|ভয় পাবেন না)/u;

/** A question the patient is being asked, or advice they get, in an Indian script. */
export function nativePatientQuestion(text: string): boolean {
  if (!INDIC.test(text)) return false;
  if (HISTORY_NATIVE.test(text)) return true;
  const q = /[?？]\s*$/.test(text) || NATIVE_Q.test(text) || NATIVE_Q_END.test(text);
  return q && (YOU_NATIVE.test(text) || NATIVE_Q_END.test(text));
}

/** Roman-script Hindi, Kannada, Tamil, Telugu, Marathi and Bengali history talk. */
const ROMAN_QUESTION =
  /\b(?:kab se|kitne din|kaisa lag\w*|kaise ho|kaise hain|kya hua|kya takleef|pehle kabhi|hua hai|hua tha|mila kya|aaram mila|lete ho|lete hain|kha rahe|aap(?:ko|ke|ka|ki)?|apko|apka|apki|apke|tumhe|tumhara|nimge|nimage|neevu|yavaga|yavattinda|eshtu dina|hegidd\w*|ideya|idya|ungalukku|neenga|epp?o irundhu|etthanai naal|irukka|meeku|meeru|eppudu|enni roju\w*|undha|unda|tumhala|tumhi|kadhi pasun|kiti divas|aahe ka|apnar|apni|kobe theke|koto din)\b|\b(?:hai|hain|tha|thi)\s+kya\b|\bkya\s*[?.]*$/i;
export const romanPatientTalk = (t: string): boolean => ROMAN_QUESTION.test(t);

const QUESTION_START =
  /^(do|does|did|have|has|had|are|is|were|was|when|how|what|what's|where|why|any|which|who|will|would|can|could|have you)\b/i;
const WE_QUESTION = /^(?:should|shall|can|could) (?:we|you|i)\b/i;
/** "Is there a nurse ...", "did you get an x-ray" inside a longer sentence. */
const INNER_YOU_Q = /\b(?:did|have|had|are|were) you(?:r)?\b|\b(?:do|can) you(?:r)?\b(?! (?:please |kindly )?(?:get|give|do|send|run|check|order|arrange|start|book|call|ask|put|draw|repeat|take|bring|help|set|prepare|page|invite))/i;

/** A question to the patient in English ("do you take any medication?"). */
export function englishPatientQuestion(text: string): boolean {
  const t = stripLead(text);
  if (/^can you feel\b|^could you (?:feel|describe|tell me)\b|^can you (?:describe|tell me|show me|point|breathe|move|lift|open|sit|lie|hear|see|walk|stand|help me understand)\b/i.test(t)) return true;
  if (INNER_YOU_Q.test(t) && !WE_QUESTION.test(t)) return true;
  if (!QUESTION_START.test(t) || WE_QUESTION.test(t)) return false;
  return /\?\s*$/.test(t) || /\b(you|your|she|he|her|his)\b/i.test(t);
}

/** Told to the patient: results, explanations, how to take it, what to do now. */
const PATIENT_TALK =
  /\b(?:you(?:'re| are| have|'ve)? (?:been )?(?:taking|on|allergic|had|having)|you (?:should|must|need to|can|will(?: need to)?|could|may|might) (?:take|drink|eat|avoid|rest|come|feel|stop|start|continue|get|have|ask|go|be|need)|(?:take|have) (?:this|these|it|the (?:tablets?|medicines?|capsules?))\b|(?:the|your) (?:[a-z]+ )?(?:ecg|ekg|x-?ray|xray|cbc|blood|bloods|sugar|scan|tests?|reports?|results?|mri|ct)\b[^?]*\b(?:is|are|was|were|shows?|showed|came|looks?|seems?)\b|come back (?:if|in|after)|i(?:'ll| will|'m going to| am going to) (?:give|write|prescribe|get|send|put|start) you|if you (?:need|feel|want|have|get)|don'?t (?:worry|be (?:scared|afraid)))\b/i;
const PATIENT_DO =
  /^(?:please\s+|just\s+|now\s+|madam\s+|sir\s+|ma'?am\s+)*(?:lie (?:down|back)|sit (?:down|up|here)|have a seat|come (?:in|here|sit)|open your|take a (?:deep )?breath|breathe|hold your breath|hold on|relax|stand up|turn (?:around|over)|look (?:up|down|at me)|tell me|show me|point|describe|don'?t worry|close your|stick out|roll up|give me your|follow my|squeeze|push against|stay still|one (?:moment|minute|second)|wait)\b/i;
/** Advice on habits, not a treatment order. */
const LIFESTYLE =
  /\b(?:stop|reduce|avoid|cut (?:down|out)|quit|give up|increase|do|start)\s+(?:on\s+|your\s+|the\s+)?(?:smoking|drinking|alcohol|salt|sugar|sweets|oily food|junk food|walking|exercise|exercising|tobacco|gutkha|coffee|tea|water|worrying)\b|\b(?:drink|eat)\b[^.]*\b(?:water|fluids|food|fruits?)\b/i;

export const patientTalk = (text: string): boolean => {
  const t = stripLead(text);
  if (INDIC.test(t)) return NATIVE_PATIENT_DO.test(t);
  return PATIENT_TALK.test(t) || PATIENT_DO.test(t) || LIFESTYLE.test(t);
};

// ── who is being spoken to ──────────────────────────────────────

const NATIVE_NURSE_WORD = 'नर्स|सिस्टर|ನರ್ಸ್|ನರ್ಸ|ಸಿಸ್ಟರ್|நர்ஸ்|சிஸ்டர்|నర్స్|సిస్టర్|নার্স|সিস্টার';
const NATIVE_NAME = 'आशा|ಆಶಾ|ஆஷா|ఆశా|আশা';
const NATIVE_SOFT = 'दीदी|दिदी|ताई|ಅಕ್ಕ|அக்கா|అక్క|দিদি';
const NATIVE_CALL = new RegExp(`^(?:${NATIVE_NURSE_WORD}|${NATIVE_NAME}|${NATIVE_SOFT})(?:\\s*(?:जी|ಅವರೇ|గారు|மேடம்))?${B1}`, 'iu');
const NATIVE_STRONG = new RegExp(`^(?:${NATIVE_NURSE_WORD}|${NATIVE_NAME})`, 'iu');
const NATIVE_NURSE_ANY = stem(NATIVE_NURSE_WORD);
/** Talked about: "नर्स ने बताया", "নার্স আপনাকে কী বলেছে". */
const NATIVE_ABOUT = new RegExp(`(?:${NATIVE_NURSE_WORD})\\s*(?:ने|से|का|की|के|है|थी|था|वाली)${B1}`, 'u');
/** "मुझे आशा है" (I hope), "आशा करता हूँ", "আশা করি": the word, not the nurse. */
const NATIVE_HOPE = /(?:आशा|আশা|ఆశ|ಆಶಾ)\s*(?:है|हैं|करत|करता|करती|करते|आहे|করি|করছি|আছে|ఉంది|ಇದೆ)/u;
/** The word used about somebody: "are you a nurse", "the nurse told you". */
const ABOUT_NURSE =
  /\b(?:(?:are|were) you (?:a|the|working as a) nurse|(?:i'?m|i am|she'?s|he'?s|is|was|as) a (?:staff )?nurse|(?:your|my|his|her) (?:wife|husband|mother|daughter|sister|friend)\b[^.?!]*\bnurse|nurse in your|(?:the|a|any|that|another)?\s*(?:nurse|sister|asha)\s+(?:told|gave|gives|said|came|did|has|had|was|is|took|taken|check(?:ed)|explained|see|seen|done|will|would|ne|ko(?! (?:bol|kaho|keh))|se|wali|aayi|aayegi|nimge|aapko|apko)|did (?:the|a|any) nurse|has (?:the|a|any) nurse|nurse at home)\b/i;
const SISTER_FAMILY =
  /^sister\b[^,]*\b(?:has|had|is|was|also|too|have|lives?|married|with diabetes|at home|illness|any)\b|\b(?:your|my|his|her|elder|younger|older|big|little|cousin)\s+(?:sister|didi)\b|\b(?:sister|didi)'s\b/i;
/** A polite word for the patient as much as for the nurse. */
const SOFT_CALL = /^(?:ma'?am|madam|staff|didi|akka|tai)\b/i;

/** Questions and instructions meant for the patient. */
const TO_PATIENT_EN =
  /\b(?:do|does|did|have|has|had|are|were|is|was|when|how long|how many|how often|how much|where)\b[^.!]*\b(?:you|your|yours|yourself)\b|\byour (?:pain|fever|symptoms?|name|age|job|mother|father|husband|wife|family|stomach|chest|head|period|problem)\b|\b(?:tell|show) me\b|\b(?:you (?:have|are|should|must|can|need|will)|don'?t worry|take care)\b/i;

/** Spoken to the nurse: "Nurse, ...", "Sister ...", "Asha ...", "Didi ...",
 *  "Ma'am ..." at the start, or clearly about what the nurse should do.
 *  `patientName` guards a patient who is herself called Asha. */
export function isAddressedToNurse(text: string, patientName = ''): boolean {
  const raw = (text ?? '').trim();
  if (!raw) return false;
  const t = stripLead(raw);
  const patientIsAsha = /\ba+sha\b/i.test(patientName) || new RegExp(NATIVE_NAME, 'u').test(patientName);

  if (INDIC.test(raw) && !NATIVE_HOPE.test(raw) && !NATIVE_ABOUT.test(raw)) {
    const toPatient = YOU_NATIVE.test(raw) || HISTORY_NATIVE.test(raw);
    if (NATIVE_CALL.test(t) && !(patientIsAsha && new RegExp(`^(?:${NATIVE_NAME})`, 'u').test(t))) {
      if (!toPatient) return NATIVE_STRONG.test(t) || looksLikeNativeOrder(t) || hasClinicalWord(normalise(t));
      return NATIVE_STRONG.test(t) && nativeOrderVerb(raw);
    }
    if (NATIVE_NURSE_ANY.test(raw) && !toPatient) return true;
    if (!patientIsAsha && new RegExp(`${B0}(?:${NATIVE_NAME})\\s*(?:जी)?\\s*[,]`, 'u').test(raw)) return true;
  }
  if (ABOUT_NURSE.test(raw) || SISTER_FAMILY.test(raw)) return false;
  if (/\b(?:ask|tell|call) the (?:nurse|sister) (?:if|when|whenever) you\b/i.test(raw)) return false;

  if (/^(?:staff\s+)?nurse\b/i.test(t)) return true;
  if (!patientIsAsha && /^a{1,2}sha\b/i.test(t)) return true;
  if (/^sister\b/i.test(t)) return !(/^sister\s+(?:do|does|did|have|are|how|any)\b/i.test(t) && /\byou|your|home\b/i.test(t));
  // "Madam, when did the fever start?" is the patient; "Madam, one ECG please" is not.
  if (SOFT_CALL.test(t)) {
    const rest = t.replace(SOFT_CALL, '').replace(/^[\s,.:;]+/, '');
    if (TO_PATIENT_EN.test(rest) || romanPatientTalk(rest) || PATIENT_DO.test(rest) || /^staff\s+(?:infection|room|at)\b/i.test(t)) return false;
    return true;
  }
  if (/[,;]\s*(?:please\s+)?(?:nurse|sister|didi)\s*[.!?]*$/i.test(raw)) return true;
  if (!patientIsAsha && /\ba{1,2}sha\b/i.test(raw) && !/\basha (?:hai|karta|karti|karte|aahe|kari)\b/i.test(raw)) return true;
  return /\bnurse\b/i.test(raw) && !(englishPatientQuestion(raw) && !/\b(?:ask|tell|get|have|call) (?:the )?nurse\b/i.test(raw));
}

// ── orders ──────────────────────────────────────────────────────

/** Request verbs in Hindi, Marathi, Kannada, Tamil, Telugu and Bengali. Whole
 *  words: "দিন" (give) must not fire inside "কত দিন ধরে" (for how many days),
 *  nor Marathi "करा" inside "चकरा". */
const NATIVE_ORDER = new RegExp(
  '(?:करा|करवा|कर|दे|लगा|चढ़ा|भेज|लिख|मंगवा|बुला|निकाल)\\s*(?:दो|दीजिए|दीजिये|देना|लो|लीजिए)|' +
    word(
      'करवाइए|कराइए|दीजिए|दीजिये|लगाइए|भेजिए|मंगवाइए|करो|कराओ|लगाओ|भेजो|चाहिए|दो|शुरू करो|करा|द्या|लावा|पाठवा|करून घ्या|मागवा|काढा|थांबवा|सुरू करा|' +
        'ಮಾಡಿಸಿ|ಮಾಡ್ಸಿ|ಮಾಡಿ|ಕೊಡಿ|ಕೊಡ್ರಿ|ಹಾಕಿ|ಕಳುಹಿಸಿ|ಕಳಿಸಿ|ತರಿಸಿ|ನಿಲ್ಲಿಸಿ|ಬೇಕು|ತೆಗೆಯಿರಿ|' +
        'கொடுங்க|கொடுங்கள்|குடுங்க|பண்ணுங்க|போடுங்க|எடுங்க|அனுப்புங்க|செய்யுங்க|செய்யுங்கள்|நிறுத்துங்க|வேணும்|எடுக்கணும்|கொடுக்கணும்|பண்ணணும்|' +
        'ఇవ్వండి|చేయించండి|చేయండి|పెట్టండి|తీయండి|పంపండి|ఆపండి|కావాలి|' +
        'দিন|দাও|করান|করুন|করো|পাঠান|লাগান|বন্ধ করুন|লাগবে',
    ).source,
  'u',
);
const nativeOrderVerb = (t: string): boolean => NATIVE_ORDER.test(t);
/** "কত দিন ধরে", "তিন দিন": দিন here is "days". */
const BN_DAYS = /(?:কত|কয়|এক|দুই|তিন|চার|পাঁচ|ছয়|সাত|দশ|কয়েক|প্রতি|অনেক|[০-৯0-9]+)\s*দিন/u;

const ROMAN_ORDER =
  /\b(?:maadi|maadsi|madsi|maadisi|kodi|kodri|haaki|kalsi|kalisi|tarisi|beku|nillisi|(?:kara|karwa|karva|karao|karwao|karvao|laga|likh|bhej|chadha|de|kar)\s*(?:do|dena|dijiye|dijiyega|lo)|dedo|karwao|karao|lagao|chadhao|bhejo|dijiye|chahiye|rok do|band kar\w*|kodunga|pannunga|podunga|edunga|ivvandi|cheyyandi|cheyinchandi|pettandi|korun|koran)\b/i;

/** English medical loanwords and native clinical words in Indian scripts. */
const NATIVE_CLINICAL = stem(
  'ईसीजी|इसीजी|एक्स\\s*-?\\s*रे|एक्सरे|सीबीसी|ब्लड|शुगर|टेस्ट|जांच|जाँच|इंजेक्शन|गोली|दवा|दवाई|पैरासिटामोल|पॅरासिटामॉल|एज़िथ्रोमाइसिन|एजिथ्रोमाइसिन|अमोक्सिसिलिन|एमोक्सिसिलिन|मेटफॉर्मिन|क्रोसिन|डोलो|एस्पिरिन|इंसुलिन|ओआरएस|स्कैन|स्कॅन|ड्रिप|सलाइन|सलाईन|ऑक्सीजन|ऑक्सिजन|अल्ट्रासाउंड|सोनोग्राफी|एंटीबायोटिक|एलएफटी|केएफटी|क्रिएटिनिन|पोटैशियम|खून|पेशाब|तपासणी|औषध|' +
    'ಇಸಿಜಿ|ಎಕ್ಸ್\\s*-?\\s*ರೇ|ಸಿಬಿಸಿ|ಬ್ಲಡ್|ಶುಗರ್|ಟೆಸ್ಟ್|ಇಂಜೆಕ್ಷನ್|ಮಾತ್ರೆ|ಔಷಧ|ಪ್ಯಾರಸಿಟಮಾಲ್|ಅಮಾಕ್ಸಿಸಿಲಿನ್|ಅಜಿಥ್ರೋ|ಕ್ರೋಸಿನ್|ಡೋಲೋ|ಇನ್ಸುಲಿನ್|ಆಕ್ಸಿಜನ್|ಸ್ಕ್ಯಾನ್|ಡ್ರಿಪ್|ರಕ್ತ|ಮೂತ್ರ|ಸಲೈನ್|ಕ್ರಿಯಾಟಿನಿನ್|' +
    'ஈசிஜி|எக்ஸ்\\s*-?\\s*ரே|எக்ஸ்ரே|சிபிசி|டெஸ்ட்|மாத்திரை|ஊசி|சுகர்|ஸ்கேன்|பாராசிட்டமால்|பாரசிட்டமால்|அமாக்ஸி|ஆக்சிஜன்|டிரிப்|ட்ரிப்|சலைன்|ரத்த|இரத்த|மருந்து|' +
    'ఈసీజీ|ఎక్స్\\s*-?\\s*రే|సీబీసీ|టెస్ట్|మాత్ర|ఇంజెక్షన్|షుగర్|స్కాన్|పారాసిటమాల్|పారాసెటమాల్|అమాక్సి|ఆక్సిజన్|డ్రిప్|సెలైన్|రక్త|మందు|' +
    'ইসিজি|এক্স\\s*-?\\s*রে|এক্সরে|সিবিসি|টেস্ট|ওষুধ|সুগার|স্ক্যান|ইঞ্জেকশন|ইনজেকশন|প্যারাসিটামল|অ্যামক্সি|অক্সিজেন|ড্রিপ|স্যালাইন|রক্ত|ট্যাবলেট',
  'u',
);
export const hasNativeClinical = (t: string): boolean => NATIVE_CLINICAL.test(t);

/** Mixed or native-script speech ("ಒಂದು ECG ಮಾಡಿಸಿ", "पैरासिटामोल दे दो", "sugar test maadi"). */
export function looksLikeNativeOrder(text: string): boolean {
  const t = (text ?? '').trim();
  if (!t) return false;
  const clinical = NATIVE_CLINICAL.test(t) || hasClinicalWord(normalise(t));
  if (!INDIC.test(t)) {
    if (romanPatientTalk(t)) return false;
    return ROMAN_ORDER.test(t) && (clinical || /\b(?:test|blood|bp|pulse|dawai|dava|goli|sui|drip)\b/i.test(t) || t.split(/\s+/).length <= 3);
  }
  if (nativePatientQuestion(t) || NATIVE_PATIENT_DO.test(t)) return false;
  if (nativeOrderVerb(t) && !(BN_DAYS.test(t) && !clinical)) return clinical || NATIVE_NURSE_ANY.test(t);
  return clinical && !/[?？]\s*$/.test(t) && t.split(/\s+/).length <= 6 && !YOU_NATIVE.test(t) && !NATIVE_Q.test(t) && !NATIVE_Q_END.test(t);
}

export const normalise = (text: string): string =>
  ` ${text
    .toLowerCase()
    .replace(/\bx[\s-]?rays?\b/g, 'xray')
    .replace(/\be[\s.]?c[\s.]?g\b/g, 'ecg')
    .replace(/\bc[\s.]?b[\s.]?c\b/g, 'cbc')
    .replace(/\bl[\s.]?f[\s.]?t\b/g, 'lft')
    .replace(/\bc[\s.]t\b/g, 'ct')
    .replace(/[^a-z0-9'\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;

export function hasClinicalWord(n: string): boolean {
  for (const w of n.trim().split(' ')) if (CLINICAL_WORDS.has(w) || nearClinical(w)) return true;
  return false;
}

// Orders that need no catalogue word ("book a follow-up", "sort out the pain").
const ORDER_PHRASE =
  /\b(order(?:ing)?|prescrib(?:e|ing)|start (?:him|her|them|the patient)?\s*on|put (?:him|her|them|the patient) on|send (?:off|for)|send (?:the |some )?(?:blood|bloods|samples?|urine)|draw (?:some )?bloods?|book|schedule|refer (?:him|her|them|the patient|this)|referral|log (?:this|the) case|add (?:this|the) case to|logbook|follow ?up|sort (?:out )?(?:the |her |his |their )?pain|something for (?:the |her |his )?(?:pain|fever|acidity|vomiting|nausea|cough|itch\w*|allergy|sleep)|(?:kara|karwa|karva|karao|karwao|laga|likh|bhej|chadha) do|de do|dedo)\b/i;

// A request cue that turns a catalogue word into an order.
const REQUEST_CUE =
  /\b(please|pls|let'?s|lets|let us|i want|i need|i'?d like|i would like|we need|we'?ll need|needs?|should we|shall we|can we|could we|can you|could you|go ahead|get|give|start|put|send|run|do|check(?:ed)?|arrange|organi[sz]e|repeat|add|hang|push|administer|inject|increase|reduce|double|switch|change|stop|cancel|hold|kara|karo|karwa|karao|de|dedo|chahiye|bhejo|lagao|laga)\b|\b(?:tds|bd|od|qid|sos|stat|hs|for (?:\w+ )?(?:days?|weeks?)|\d+ ?(?:mg|ml|mcg))\b/i;

/** "We don't need an ECG", "no antibiotics for now": a decision, not an order. */
const NEGATED =
  /\b(?:don'?t|do not|doesn'?t|no|not|without|won'?t|never)\b(?:\s+\w+){0,3}\s+(?:need|needed|want|order|give|start|prescribe|require|necessary|antibiotics?|tests?|scans?|ecg|xray|ct|mri)\b/i;

/** Does this utterance look like a clinical instruction worth sending to the
 *  nurse agent? Anything addressed to the nurse always goes; the backend
 *  decides 'none' vs 'order'. Questions to the patient stay excluded. */
export function looksLikeOrder(text: string, patientName = ''): boolean {
  const raw = (text ?? '').trim();
  if (raw.length < 3) return false;
  if (isAddressedToNurse(raw, patientName)) return true;
  if (ABOUT_NURSE.test(raw)) return false;
  const t = stripLead(raw);
  if (INDIC.test(raw)) return looksLikeNativeOrder(raw);
  // History questions to the patient ("do you take any medication?",
  // "how long have you had the fever") are not orders. "Should we get an
  // ECG?" is a suggestion to the team, so it still counts.
  if (englishPatientQuestion(t) || romanPatientTalk(t) || patientTalk(t)) return false;
  const n = normalise(t);
  if (NEGATED.test(n)) return false;
  if (ORDER_PHRASE.test(t)) return true;
  if (looksLikeNativeOrder(raw)) return true;
  if (!hasClinicalWord(n)) return false;
  // "Bloods", "CBC and LFT", "chest x-ray please": short and clinical.
  const count = n.trim().split(' ').length;
  if (count <= 5 && !/\?\s*$/.test(t)) return true;
  return REQUEST_CUE.test(n);
}
