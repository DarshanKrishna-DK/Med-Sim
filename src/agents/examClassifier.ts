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

// Test / drug words: "check the chest X-ray" is an order for the nurse, not an exam.
const ORDER_WORDS =
  /\b(x-?ray|cxr|ecg|ekg|echo(?:cardiogram)?|ultrasound|usg|scan|ct|mri|cbc|fbc|blood (?:test|sugar|work)|bloods|labs?|urine|culture|swab|troponin|report|results?|tablets?|mg|prescri\w*|order\w*)\b|एक्स-?रे|एक्सरे|अल्ट्रासाउंड|ईसीजी|रिपोर्ट|खून|टेस्ट|ಎಕ್ಸ್-?ರೇ|ಸ್ಕ್ಯಾನ್|ರಿಪೋರ್ಟ್|ರಕ್ತ|ಟೆಸ್ಟ್/i;

function firstMatch(parts: Array<[ExamSystem, RegExp]>, text: string): ExamSystem | null {
  for (const [sys, rx] of parts) if (rx.test(text)) return sys;
  return null;
}

/** Map a final doctor utterance to the body system being examined, or null
 *  when it is not an examination request. */
export function classifyExam(text: string): ExamSystem | null {
  const t = text.trim();
  if (t.length < 4 || ORDER_WORDS.test(t)) return null;
  if (EN_VERB.test(t)) {
    const sys = firstMatch(EN_PARTS, t);
    if (sys) return sys;
  }
  if (/\b(general|systemic|full|physical) exam(?:ination)?\b/i.test(t)) return 'general';
  if (HI_VERB.test(t)) {
    const sys = firstMatch(HI_PARTS, t);
    if (sys) return sys;
  }
  if (KN_VERB.test(t)) {
    const sys = firstMatch(KN_PARTS, t);
    if (sys) return sys;
  }
  return null;
}
