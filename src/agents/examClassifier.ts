// Pure, dependency-free examination helpers: the body-system list and the
// regex classifier that maps a doctor's utterance (English, Hindi, Kannada)
// to the system being examined. Kept apart from `examAgent.ts` (store,
// backend, voice) so they can be unit-tested under plain Node.

import type { ExamSystem } from '../game/types';

export const EXAM_SYSTEMS: ReadonlyArray<{ id: ExamSystem; label: string; part: string }> = [
  { id: 'general', label: 'General', part: 'general appearance, hands, eyes and neck' },
  { id: 'vitals', label: 'Vitals', part: 'pulse and blood pressure' },
  { id: 'cardio', label: 'Heart', part: 'heart, with a stethoscope on your chest' },
  { id: 'resp', label: 'Chest', part: 'chest and lungs, with a stethoscope' },
  { id: 'abdomen', label: 'Abdomen', part: 'abdomen (tummy), pressing on it gently' },
  { id: 'neuro', label: 'Neuro', part: 'nerves: reflexes, strength and sensation' },
  { id: 'msk', label: 'Joints', part: 'joints, back and limbs' },
  { id: 'skin', label: 'Skin', part: 'skin' },
  { id: 'ent', label: 'ENT', part: 'throat, ears and nose' },
  { id: 'eye', label: 'Eyes', part: 'eyes, with a small torch' },
  { id: 'obgyn', label: 'OB/GYN', part: 'pelvis and abdomen (obstetric or gynaecological exam)' },
  { id: 'paeds', label: 'Growth', part: 'growth, hydration and development' },
];

export const examLabel = (s: ExamSystem) => EXAM_SYSTEMS.find((x) => x.id === s)?.label ?? s;

// ── voice classifier ─────────────────────────────────────────────

// English: an examining verb plus a body part. "Does your chest hurt?" has no
// examining verb, so it stays a history question.
const EN_VERB =
  /\b(examin\w*|exam\b|auscultat\w*|palpat\w*|percuss\w*|inspect\w*|listen(?:ing)?\s+(?:to|in|at)|have a listen|take a listen|feel(?:ing)?\s+(?:your|the|his|her|their)|press(?:ing)?\s+(?:on|your|the)|check(?:ing)?\s+(?:your|the|his|her|their|on)|look(?:ing)?\s+(?:at|in|into)\s+(?:your|the|his|her|their)|let me see (?:your|the)|test (?:your|the|his|her)|shine a (?:light|torch))\b/i;

// Ordered: the first matching system wins ("heart and chest" -> cardio).
const EN_PARTS: Array<[ExamSystem, RegExp]> = [
  ['vitals', /\b(vitals?|vital signs|blood pressure|bp|pulse|heart rate|temperature|sats|saturation|spo2|oxygen level)\b/i],
  ['cardio', /\b(heart|cardiac|cardiovascular|cvs|apex(?: beat)?|precordium|heart sounds|murmurs?|jvp)\b/i],
  ['obgyn', /\b(pelvic|vaginal|per vaginal|speculum|uterus|fundal height|obstetric|gyn\w*|breasts?)\b/i],
  ['resp', /\b(lungs?|chest|breath(?:ing)? sounds|respiratory|air entry|breathing)\b/i],
  ['abdomen', /\b(abdomen|abdominal|tummy|belly|stomach|liver|spleen|abdo)\b/i],
  ['eye', /\b(eyes?|pupils?|vision|fundus|fundi|conjunctiva)\b/i],
  ['ent', /\b(throat|tonsils?|ears?|nose|mouth|tongue|ent|sinus(?:es)?)\b/i],
  ['skin', /\b(skin|rash(?:es)?|lesions?|spots|moles?)\b/i],
  ['neuro', /\b(neuro\w*|reflexes|nervous system|cranial nerves|power|sensation|coordination|gait|tone)\b/i],
  ['msk', /\b(joints?|knees?|back|spine|hips?|shoulders?|ankles?|wrists?|elbows?|neck|limbs?|legs?|arms?|musculoskeletal)\b/i],
  ['paeds', /\b(growth|development\w*|milestones|fontanel+e?|hydration)\b/i],
  ['general', /\b(general(?: exam\w*| condition)?|pallor|icterus|jaundice|cyanosis|clubbing|lymph nodes?|o?edema|hands|nails|head to toe)\b/i],
];

// Hindi (Devanagari). JS \b is ASCII-only, so these are substring matches.
const HI_VERB = /(जाँच|जांच|चेक|देख(?:ना|ूँ|ूं|ता|ती|िए|ने|ेंगे|ूंगा|ूँगा|ूंगी|ूँगी)|सुन(?:ना|ूँ|ूं|ने|ता|ती|ूंगा|ूँगा|ूंगी|ूँगी)|दबा(?:कर|ऊँ|ऊं|ना|के|ता|ती)|परीक्षण|टटोल|मुआयना|एग्ज़ाम|एग्जाम)/;
const HI_PARTS: Array<[ExamSystem, RegExp]> = [
  ['vitals', /(नब्ज़|नब्ज|नाड़ी|बीपी|ब्लड प्रेशर|तापमान|बुखार नाप)/],
  ['cardio', /(दिल|हृदय|धड़कन|धडकन)/],
  ['resp', /(छाती|फेफड़|फेफड|सांस|साँस)/],
  ['abdomen', /(पेट|लिवर|जिगर|तिल्ली)/],
  ['eye', /(आँख|आंख|पुतली)/],
  ['ent', /(गला|गले|कान|नाक|मुँह|मुंह|जीभ|टॉन्सिल)/],
  ['skin', /(त्वचा|चमड़ी|दाने|चकत्ते)/],
  ['neuro', /(रिफ्लेक्स|नसों|तंत्रिका|ताकत|सुन्न)/],
  ['msk', /(जोड़|घुटन|कमर|पीठ|कंधे|टखन|कलाई)/],
];

// Kannada.
const KN_VERB = /(ಪರೀಕ್ಷ|ಚೆಕ್|ನೋಡ|ಕೇಳಿಸಿಕೊ|ಆಲಿಸ|ಒತ್ತ|ಮುಟ್ಟ|ತಪಾಸಣೆ)/;
const KN_PARTS: Array<[ExamSystem, RegExp]> = [
  ['vitals', /(ನಾಡಿ|ಬಿಪಿ|ರಕ್ತದೊತ್ತಡ|ತಾಪಮಾನ)/],
  ['cardio', /(ಹೃದಯ|ಎದೆಬಡಿತ)/],
  ['resp', /(ಎದೆ|ಶ್ವಾಸಕೋಶ|ಉಸಿರಾಟ|ಉಸಿರು)/],
  ['abdomen', /(ಹೊಟ್ಟೆ|ಯಕೃತ್ತು|ಲಿವರ್)/],
  ['eye', /(ಕಣ್ಣು|ಕಣ್ಣಿನ)/],
  ['ent', /(ಗಂಟಲು|ಕಿವಿ|ಮೂಗು|ಬಾಯಿ|ನಾಲಿಗೆ)/],
  ['skin', /(ಚರ್ಮ|ದದ್ದು)/],
  ['neuro', /(ರಿಫ್ಲೆಕ್ಸ್|ನರ)/],
  ['msk', /(ಕೀಲು|ಮಂಡಿ|ಸೊಂಟ|ಬೆನ್ನು|ಭುಜ)/],
];

// Tamil, Telugu, Marathi, Bengali: an examining verb said by the doctor ("I'll
// look", "let me press") or asked of the nurse ("check the BP").
const MORE_LANGS: Array<{ verb: RegExp; parts: Array<[ExamSystem, RegExp]> }> = [
  {
    verb: /(பார்க்கிறேன்|பார்க்கறேன்|பாக்குறேன்|பார்க்கலாம்|பாருங்க|பரிசோதி|செக் (?:பண்|செய்)|அழுத்தி|கேட்கிறேன்|எடுங்க)/,
    parts: [
      ['vitals', /(பிபி|நாடி|ரத்த அழுத்த|பல்ஸ்|பிரஷர்)/],
      ['cardio', /(இதயம்|இதய|ஹார்ட்)/],
      ['resp', /(நெஞ்சு|மார்பு|நுரையீரல்|மூச்சு)/],
      ['abdomen', /(வயிறு|வயிற்ற)/],
      ['eye', /(கண்)/],
      ['ent', /(தொண்டை|காது|மூக்கு|வாய்)/],
    ],
  },
  {
    verb: /(చూస్తాను|చూస్తా|చూడండి|చూద్దాం|పరీక్షి|చెక్ (?:చేస్|చేయ)|నొక్కి|వింటాను)/,
    parts: [
      ['vitals', /(బీపీ|బిపి|నాడి|పల్స్|రక్తపోటు)/],
      ['cardio', /(గుండె)/],
      ['resp', /(ఛాతీ|ఊపిరితిత్తు|శ్వాస)/],
      ['abdomen', /(పొట్ట|కడుపు)/],
      ['eye', /(కన్ను|కళ్ళు|కళ్లు)/],
      ['ent', /(గొంతు|చెవి|ముక్కు|నోరు)/],
    ],
  },
  {
    verb: /(तपास(?:तो|ते|ा|ून|ू)|बघ(?:तो|ते|ा|ू)|दाब(?:तो|ते|ून)|ऐक(?:तो|ते)|मोज(?:ा|तो|ते)|चेक कर(?:ा|तो|ते))/,
    parts: [
      ['vitals', /(बीपी|नाडी|रक्तदाब)/],
      ['cardio', /(हृदय)/],
      ['resp', /(छाती|फुफ्फुस|श्वास)/],
      ['abdomen', /(पोट)/],
      ['eye', /(डोळ)/],
      ['ent', /(घसा|कान|नाक|तोंड)/],
    ],
  },
  {
    verb: /(দেখছি|দেখি|দেখব|দেখুন|পরীক্ষা কর|মাপুন|মাপছি|চেক কর|টিপে|শুনছি|শুনব)/,
    parts: [
      ['vitals', /(প্রেসার|বিপি|নাড়ি|পালস|রক্তচাপ)/],
      ['cardio', /(হৃদ|হার্ট)/],
      ['resp', /(বুক|ফুসফুস|শ্বাস)/],
      ['abdomen', /(পেট)/],
      ['eye', /(চোখ)/],
      ['ent', /(গলা|কান|নাক|মুখ)/],
    ],
  },
];
/** "Trouble hearing", "have you looked at": the patient is being asked. */
const NATIVE_HISTORY = /दिक्कत|तकलीफ|परेशानी|समस्या|ತೊಂದರೆ|பிரச்சனை|సమస్య|ఇబ్బంది|त्रास|সমস্যা|অসুবিধা|[?？]\s*$/;

// Test / drug words: "check the chest X-ray" is an order for the nurse, not an exam.
const ORDER_WORDS =
  /\b(x-?ray|cxr|ecg|ekg|echo(?:cardiogram)?|ultrasound|usg|scan|ct|mri|cbc|fbc|blood (?:test|sugar|work)|bloods|labs?|urine|culture|swab|troponin|report|results?|tablets?|dawa|dawai|goli|mg|prescri\w*|order\w*)\b|एक्स-?रे|एक्सरे|अल्ट्रासाउंड|ईसीजी|रिपोर्ट|खून|टेस्ट|ಎಕ್ಸ್-?ರೇ|ಸ್ಕ್ಯಾನ್|ರಿಪೋರ್ಟ್|ರಕ್ತ|ಟೆಸ್ಟ್/i;

// Looser English phrasings: "have a look in the throat", "let me feel the
// tummy", "take her BP", "quick listen to the chest", "look in throat".
const EN_VERB_LOOSE =
  /\b(have a (?:look|feel|quick look|quick listen)|take a (?:look|quick look)|quick (?:look|listen|check|feel)|let me (?:feel|hear|see|look|check|listen|examine|press|test)|(?:take|measure|record)\s+(?:a |an |the |your |his |her |their )?(?:bp|blood pressure|pulse|temperature|temp|sats|vitals?)|look (?:at|in|into)|listen (?:to|in|at)|feel (?:for|the|your)|sound (?:the|your|his|her))\b/i;

// Romanized Hindi (Hinglish): "BP lena", "pulse dekho", "pet dabao", "chest sunna".
const HING_VERB =
  /\b(dekh(?:o|na|ta|ti|enge|unga|ungi|iye|lo|le|ne do)?|sun(?:o|na|ne do|unga|ungi|enge)|check kar(?:o|na|te|unga|ungi|enge)?|chek kar\w*|le(?:na|lo|te|nge|ta)|naap(?:o|na|te)?|nap(?:o|na)|daba(?:o|na|unga|ke)|jaanch\w*|janch\w*)\b/i;
const HING_PART = /\b(pet|chhati|chaati|seena|dil|gala|gale|kaan|naak|aankh|aankhen|nabz|nadi|bukhar|tapman|kamar|ghutna|ghutne)\b/i;
const HING_PART_MAP: Array<[ExamSystem, RegExp]> = [
  ['vitals', /\b(nabz|nadi|bukhar|tapman)\b/i],
  ['cardio', /\bdil\b/i],
  ['resp', /\b(chhati|chaati|seena)\b/i],
  ['abdomen', /\bpet\b/i],
  ['eye', /\b(aankh|aankhen)\b/i],
  ['ent', /\b(gala|gale|kaan|naak)\b/i],
  ['msk', /\b(kamar|ghutna|ghutne)\b/i],
];

// History questions to the patient ("did you check your BP at home?",
// "does your chest hurt?") are never exam requests.
const HISTORY_Q = /^\W*(?:(?:ok(?:ay)?|so|and|right|accha)\W+)*(do|does|did|have|has|had|is|are|was|were|when|how|how long|where|why|any)\b[^.!]*\b(you|your|she|he|her|his|it)\b/i;

function firstMatch(parts: Array<[ExamSystem, RegExp]>, text: string): ExamSystem | null {
  for (const [sys, rx] of parts) if (rx.test(text)) return sys;
  return null;
}

/** Map a final doctor utterance to the body system being examined, or null
 *  when it is not an examination request. */
export function classifyExam(text: string): ExamSystem | null {
  const t = text.trim();
  if (t.length < 4 || ORDER_WORDS.test(t)) return null;
  if (/^\W*(?:ok(?:ay)?\W+)?(?:can|could|do) you (?:feel|hear|see|smell|move)\b/i.test(t)) return null;
  if (HISTORY_Q.test(t) && !/^\W*(?:ok(?:ay)?\W+)?(?:can|could|may) i\b/i.test(t)) return null;
  if (EN_VERB.test(t) || EN_VERB_LOOSE.test(t)) {
    const sys = firstMatch(EN_PARTS, t);
    if (sys) return sys;
  }
  if (/\b(general|systemic|full|physical) exam(?:ination)?\b/i.test(t)) return 'general';
  if (NATIVE_HISTORY.test(t)) return null;
  if (HI_VERB.test(t)) {
    const sys = firstMatch(HI_PARTS, t);
    if (sys) return sys;
  }
  if (HING_VERB.test(t)) {
    const sys = HING_PART.test(t) ? firstMatch(HING_PART_MAP, t) : firstMatch(EN_PARTS, t);
    if (sys) return sys;
  }
  if (KN_VERB.test(t)) {
    const sys = firstMatch(KN_PARTS, t);
    if (sys) return sys;
  }
  for (const l of MORE_LANGS) {
    if (!l.verb.test(t)) continue;
    const sys = firstMatch(l.parts, t);
    if (sys) return sys;
  }
  return null;
}
