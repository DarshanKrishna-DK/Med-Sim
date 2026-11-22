// Offline stand-in for backend/intent.py: who is the doctor talking to? Used
// only when POST /voice/route is slow or unreachable, and checked against the
// same labelled utterances (backend/tests/fixtures/intent_cases.json). Pure.
//
// Order matters: somebody named out loud wins, then a question that is waiting
// for an answer, then what the sentence asks for. Anything else is for the
// patient, because a wrong silence is worse than a wrong nurse call.

import { classifyExam } from '../agents/examClassifier.ts';
import { HINT_RX } from '../agents/coachRules.ts';
import {
  englishPatientQuestion,
  hasClinicalWord,
  hasNativeClinical,
  INDIC,
  isAddressedToNurse,
  looksLikeNativeOrder,
  looksLikeOrder,
  nativePatientQuestion,
  normalise,
  patientTalk,
  romanPatientTalk,
  stripLead,
} from '../agents/nurseIntent.ts';
import { parseInviteCommand } from '../observer/contacts.ts';
import type { RouteAction, RouteTarget } from './router.ts';

export interface OfflineContext {
  patientName?: string;
  pendingQuestion?: { role: string; ref: string };
  awaitingFaculty?: boolean;
  observerNames?: string[];
  /** Relatives named in the case: their names are not staff vocatives either. */
  relatedNames?: string[];
}

export interface OfflineRoute {
  target: RouteTarget;
  action: RouteAction;
  confidence: number;
}

type Dept = 'pharmacist' | 'lab' | 'radiology';

const rx = (src: string) => new RegExp(src, 'iu');
const B0 = '(?<![\\p{L}\\p{M}])';
const B1 = '(?![\\p{L}\\p{M}])';

// ── departments ─────────────────────────────────────────────────

const DEPT_TITLE: Record<Dept, string> = {
  pharmacist: 'pharmacist|pharmacy|फार्मासिस्ट|फार्मेसी|ಫಾರ್ಮಸಿಸ್ಟ್|ಫಾರ್ಮಾಸಿಸ್ಟ್|ಫಾರ್ಮಸಿ|பார்மசிஸ்ட்|ஃபார்மசிஸ்ட்|பார்மசி|ஃபார்மசி|ఫార్మసిస్ట్|ఫార్మసీ|ফার্মাসিস্ট|ফার্মেসি',
  lab: 'lab(?:oratory)?(?: (?:officer|technician|tech|team))?|लैब|लॅब|ಲ್ಯಾಬ್|லேப்|ల్యాబ్|ল্যাব',
  radiology: 'radiolog(?:y|ist)|रेडियोलॉजी|रेडियोलॉजिस्ट|ರೇಡಿಯಾಲಜಿ|ರೇಡಿಯಾಲಜಿಸ್ಟ್|ரேடியாலஜி|ரேடியாலஜிஸ்ட்|రేడియాలజీ|రేడియాలజిస్ట్|রেডিওলজি|রেডিওলজিস্ট',
};
const DEPT_NAME: Record<Dept, string> = {
  pharmacist: 'meera|mira|मीरा|ಮೀರಾ|மீரா|మీరా|মীরা',
  lab: 'dev|देव|ದೇವ್|தேவ்|దేవ్|দেব',
  radiology: 'vikram|विक्रम|ವಿಕ್ರಮ್|விக்ரம்|విక్రమ్|বিক্রম',
};
const DEPTS = Object.keys(DEPT_TITLE) as Dept[];
const each = (f: (d: Dept) => RegExp) => Object.fromEntries(DEPTS.map((d) => [d, f(d)])) as Record<Dept, RegExp>;

const NEXT = 'can|could|is|are|was|were|what|which|why|how|any|do|does|did|has|have|will|would|please|when|who|where|should|give|send|run|check|tell|confirm|verify|hold|stop|cancel|repeat|report';
/** "Lab, ...", "Pharmacist can you ...". */
const TITLE_LEAD = each((d) => rx(`^(?:dr\\.?\\s+|doctor\\s+)?(?:${DEPT_TITLE[d]})(?:\\s+(?:${DEPT_NAME[d]}|ji|जी|team|please))?\\s*(?:[,:;.!?]|$|\\s(?=(?:${NEXT})${B1}))`));
/** An Indian-script title at the start is a call even without the comma. */
const TITLE_LEAD_NATIVE = each((d) => rx(`^(?:${DEPT_TITLE[d].split('|').filter((w) => /[^\x00-\x7f]/.test(w)).join('|')})(?:\\s*जी)?${B1}(?!\\s*(?:की|का|के|में|से|रिपोर्ट|ರಿಪೋರ್ಟ್|রিপোর্ট))`));
/** Their own name at the start ("Meera ye dose theek hai"), not talk about them ("Meera will explain it"). */
const ABOUT = '(?!\\s+(?:will|said|says|told|gave|ne|ko|ने|को|is (?:a|an|my|our|the|coming|here)|was (?:a|my|here))(?![\\p{L}\\p{M}]))';
const NAME_LEAD = each((d) => rx(`^(?:dr\\.?\\s+|doctor\\s+|officer\\s+)?(?:${DEPT_NAME[d]})${B1}${ABOUT}`));
const TAIL = each((d) => rx(`,\\s*(?:${DEPT_TITLE[d]}|${DEPT_NAME[d]})\\s*[.?!]*$`));
const MENTION = each((d) => rx(`${B0}(?:${DEPT_TITLE[d]}|${DEPT_NAME[d]})${B1}(?!\\s+(?:reports?|results?|tests?|work|values?|slip))`));

const ASK = '(?:ask|tell|check with|speak to|talk to|consult|confirm with|get|let|message|contact|inform|find out from)';
const ASKED = each((d) =>
  rx(
    `\\b${ASK}\\s+(?:the\\s+|our\\s+|with\\s+)?(?:${DEPT_TITLE[d]}|${DEPT_NAME[d]})${B1}|\\b(?:run|check) (?:it|this) (?:by|with) (?:the\\s+)?(?:${DEPT_TITLE[d]})|` +
      `${B0}(?:${DEPT_TITLE[d]}|${DEPT_NAME[d]})[\\p{L}\\p{M}]*\\s*(?:को|से|ला|कडून|ಗೆ|ಅವರನ್ನು|ಹತ್ತಿರ|க்கு|கிட்ட|கிட்டே|ని|కి|কে|থেকে)?\\s*(?:से\\s*)?(?:पूछ|पुछ|बोल|कह|विचार|सांग|ಕೇಳ|ಹೇಳ|கேளு|கேள|கேட்|சொல்லு|అడగ|అడుగ|చెప్ప|জিজ্ঞ|বল)|` +
      `\\b(?:${DEPT_TITLE[d]}|${DEPT_NAME[d]})\\s*(?:ko|se|ge|kitta|ki|ke|la)?\\s*(?:puch\\w*|pooch\\w*|bolo|kaho|kelu|keli|heli|kelunga|sollunga|adagandi|cheppandi|jigges\\w*|bolun|vichar\\w*|sanga)\\b`,
  ),
);
/** "Call the radiologist please", "bring the pharmacist in here". */
const DEPT_INVITE = each((d) => rx(`\\b(?:call|get|bring|invite|page|fetch|add)\\s+(?:in\\s+)?(?:the\\s+|our\\s+)?(?:${DEPT_TITLE[d]}|${DEPT_NAME[d]})\\s*(?:please|now|in|here|in here|over|to join.*|to come.*|to the room)?\\s*[.!?]*$`));
/** "What did the pharmacist say", "has the lab sent the report". */
const DEPT_SAID = each((d) => rx(`\\b(?:what|has|have|did|does|is|any)\\b.*(?:${DEPT_TITLE[d]}|${DEPT_NAME[d]})${B1}.*\\b(?:say|said|think|sent|send|replied|reply|confirm\\w*|finish\\w*|done|ready|verif\\w*|approv\\w*)\\b`));

// ── faculty ─────────────────────────────────────────────────────

const FACULTY =
  'faculty|professor|prof|hod|head of department|senior doctor|supervisor|प्रोफेसर|फैकल्टी|फॅकल्टी|सीनियर डॉक्टर|प्राध्यापक|ಪ್ರೊಫೆಸರ್|ಫ್ಯಾಕಲ್ಟಿ|பேராசிரியர|புரொபசர்|ப்ரொபசர்|ஃபேகல்டி|ஃபேக்கல்டி|ప్రొఫెసర్|ఫ్యాకల్టీ|প্রফেসর|অধ্যাপক|ফ্যাকাল্টি';
const FACULTY_ANY = rx(`${B0}(?:${FACULTY})[\\p{M}\\p{L}]*`);
const FACULTY_LEAD = rx(`^(?:dr\\.?\\s+)?(?:${FACULTY})(?:\\s*(?:ji|sir|madam|जी))?\\s*(?:[,:;]|\\s(?=(?:i|we|this|the|can|could|should|please|he|she|my|what|is|may|shall)${B1}))|,\\s*(?:professor|prof)\\s*[.?!]*$`);
const FACULTY_INVITE = rx(
  `\\b(?:invite|call|get|bring|need|want|page|ring|phone|add|loop in|involve|fetch|contact|send for|have)\\b[^.?!]*${B0}(?:${FACULTY})|\\bask (?:the |our )?(?:${FACULTY}) to (?:join|come|see|look|step)|` +
    `${B0}(?:${FACULTY})[\\p{L}\\p{M}\\u200c\\u200d]*\\s*(?:को|ko|la|ni|ke|ge|ला|কে|ని|ಅನ್ನು)?\\s*(?:जी\\s*)?(?:बुला|बोलव|कॉल|ಕರೆ|ಕರೀ|கூப்பிடு|கூப்பி|అ?పిలవ|పిలిపి|ডাক|bula|bolva|call|karis|karey|kupidu|koopidu|pilav|pilip|dak)`,
);
/** "senior", "consultant" and "attending" need somewhere to come to. */
const SENIOR_INVITE = rx(
  `\\b(?:call|get|bring|page|fetch|invite|add|send for|have)\\s+(?:in\\s+)?(?:the|our|a|an)?\\s*(?:senior(?: doctor| consultant| resident)?|consultant|attending|chief)\\s*(?:doctor|on call|on duty)?\\s+(?:to (?:join|come|see|step in|have a look|look|help)|in\\b|here\\b|over\\b|on the line|now\\b|please\\b|right away)|` +
    `(?:सीनियर|कंसल्टेंट|ಸೀನಿಯರ್|சீனியர்|సీనియర్|সিনিয়র|senior|consultant)[\\p{L}\\p{M}]*\\s*(?:डॉक्टर|doctor|ಡಾಕ್ಟರ್|டாக்டர்|డాక్టర్|ডাক্তার)?\\s*(?:को|ko|la|ni|ke|ge)?\\s*(?:बुला|बोलव|ಕರೆ|கூப்பிடு|పిలవ|ডাক|bula|bolva|karey|koopidu|pilav|dak)`,
);
const VARA_SOLLUNGA = /\b(?:professor|faculty)\b.*\bvara ?sollunga\b|வர ?சொல்லுங்க/iu;
/** "Asha is the drip running": her name opening a question. */
const ASHA_ASKED = /^(?:nurse\s+)?(?:asha|aasha|nurse)\s+(?:(?:is|are|was|has|have|had|did|does)\s+(?:the|it|this|that|these|he|she|they|there|any|her|his)|(?:should|can|could|shall)\s+(?:we|i|he|she|the))\b/i;
const FACULTY_DECIDE = rx(`\\b(?:let|ask) (?:the )?(?:${FACULTY}) (?:to )?(?:decide|approve|release|override|clear|sign)|\\bescalate\\b|(?:${FACULTY})[\\p{L}\\p{M}]*\\s*(?:se|से|ko|को)?\\s*(?:permission|approval|परमिशन|मंजूरी|अनुमति)`);
const FACULTY_ASK = rx(`\\b(?:ask|tell|inform|update|say to|let|consult|check with)\\s+(?:the\\s+|my\\s+|our\\s+)?(?:${FACULTY}|sir)${B1}`);
/** With a faculty member waiting these are said to them. */
const SIR = rx(`^(?:sir|ma'?am|madam|mam|सर|मैडम|ಸರ್|ಸಾರ್|ಮೇಡಂ|சார்|சர்|மேடம்|సార్|సర్|మేడం|স্যার|ম্যাডাম)${B1}|${B0}(?:sir|maam|ma'am|madam|सर|ಸರ್|சார்|సార్|স্যার)\\s*[.?!]*$`);

const OVERRIDE = rx(
  `\\b(?:overrid\\w+|override karo|release (?:it|the (?:drug|hold|medicine|antibiotic))(?: anyway)?|(?:give|prescribe|start|dispense|send) (?:it|them|that)? ?(?:anyway|regardless)|prescribe it anyway|go ahead anyway|i still want (?:to give|it|the)|ignore the (?:hold|warning|pharmacist|pharmacy)|(?:lift|remove|release|clear) (?:the|that|this) hold|i(?:'ll| will) take (?:full |the )?responsibility|on my responsibility|against (?:pharmacy|the pharmacist)(?:'s)? advice|phir bhi (?:de do|dedo|dijiye)|aadru kodi|aadroo kodi|irundhalum kodunga|ayina ivvandi|tarihi dya|tobuo din)\\b|` +
    `फिर भी (?:दे|दीजिए|लगा)|होल्ड हटा|ओवरराइड|तरीही द्या|ಓವರ್‌?ರೈಡ್|ಆದರೂ ಕೊಡಿ|ಆದ್ರೂ ಕೊಡಿ|ஓவர்ரைட்|இருந்தாலும் கொடு|ఓవర్‌?రైడ్|అయినా ఇవ్వండి|ওভাররাইড|তবুও দিন`,
);

// ── stop ────────────────────────────────────────────────────────

const STOP_EN =
  /\b(?:cancel|stop|discontinue|hold off(?: on)?|hold|withhold|take off|remove|scrap|abort|undo|forget|never ?mind|don'?t (?:give|send|do|order|start|run)|do not (?:give|send|do|order|start|run)|rok do|ruk jao|band kar\w*|cancel kar\w*|cancel maadi|cancel pannunga|mat (?:do|lagao|dena|karo|dijiye)|nillisi|niruthunga|aapandi|thambva|bondho korun)\b/i;
const STOP_NATIVE =
  /रोक\s*(?:दो|दीजिए)|बंद\s*कर|कैंसल|कैंसिल|रद्द|मत\s*(?:दो|दीजिए|करो|लगाओ|लगाइए|देना)|थांबवा|देऊ नका|(?<![\p{L}\p{M}])नको|ನಿಲ್ಲಿಸಿ|ಕ್ಯಾನ್ಸಲ್|ಕೊಡಬೇಡಿ|ಹಾಕಬೇಡಿ|ಮಾಡಬೇಡಿ|நிறுத்து|கேன்சல்|போடாதீங்க|கொடுக்காதீங்க|வேண்டாம்|ఆపండి|క్యాన్సిల్|ఇవ్వకండి|పెట్టకండి|చేయకండి|వద్దు|বন্ধ\s*কর|বাতিল|ক্যানসেল|দেবেন না|করবেন না/u;
const STOP_OBJECT = /\b(?:that|it|the (?:last )?(?:order|test|scan|drug|medicine|prescription|injection|drip|referral|follow ?up)|order|prescription|test|medicine|drip|dawai|dava)\b/i;
const PATIENT_STOP =
  /\b(?:stop|cancel|don'?t)\s+(?:smoking|drinking|crying|moving|talking|worry\w*|taking|eating|me if|if it)\b|\b(?:smoking|alcohol|tobacco)\b|\bhold (?:your|on|still)\b|\bdon'?t worry\b/i;

function isStop(t: string, named: boolean): boolean {
  const native = STOP_NATIVE.test(t);
  if (!native && (!STOP_EN.test(t) || PATIENT_STOP.test(t))) return false;
  if (patientTalk(t) && !named && !native) return false;
  if (!named && (englishPatientQuestion(t) || romanPatientTalk(t))) return false;
  return named || STOP_OBJECT.test(t) || hasClinicalWord(normalise(t)) || hasNativeClinical(t);
}

// ── hints ───────────────────────────────────────────────────────

const HINT_NATIVE =
  /कोई (?:हिंट|सुझाव|संकेत)|हिंट (?:दो|दीजिए|द्या)|मैं (?:कैसा|कैसी|कैसे) कर रह|अब क्या कर(?:ूँ|ूं|ना)|क्या मैं सही|आगे क्या कर|ಸುಳಿವು|ಹಿಂಟ್|ನಾನು ಹೇಗೆ ಮಾಡ್ತಾ|ಮುಂದೆ ಏನು ಮಾಡ|ಈಗ ಏನು ಮಾಡ|குறிப்பு|ஹிண்ட்|நான் எப்படி பண்|அடுத்து என்ன (?:பண்|செய்)|సూచన|హింట్|నేను ఎలా చేస్తున్న|తర్వాత ఏం చే|తర్వాత ఏమి చే|मी कसं करत|पुढे काय कर|আমি কেমন করছি|হিন্ট|এবার কী করব|এরপর কী করব|পরামর্শ দিন/u;
const HINT_ROMAN = /\b(?:koi hint|hint do|hint dijiye|hint kodi|hint kodunga|hint ivvandi|main kaisa kar raha|main kaisi kar rahi|naanu hege madta\w*|naan eppadi panren|nenu ela chestunna\w*|ami kemon korchi|mi kasa karto\w*)\b/i;

// ── misc ────────────────────────────────────────────────────────

const YESNO =
  /^(?:yes|yeah|yep|no|nope|not|none|never|negative|correct|right|sure|maybe|unknown|i don'?t know|not sure|haan?|nahi+n?|ji|howdu|illa|aama|illai|avunu|ledu|kaadu|ho|hya+n?|na)\b|^(?:हाँ|हां|नहीं|जी|हो|नाही|ಹೌದು|ಇಲ್ಲ|ಹಾಂ|ஆமா|ஆம்|இல்லை|இல்ல|అవును|లేదు|కాదు|হ্যাঁ|না|নেই)/iu;
const RESULT_Q =
  /\b(?:(?:is|are|has|have|did|what|when|any|show|read|check)\b[^.?]*\b(?:results?|reports?|come back|came back|back yet|ready)|(?:results?|reports?)\b[^.?]*\b(?:back|ready|out|yet|aa gay\w*))\b/i;
/** "Have chest pain while watching TV?": a symptom, not somebody's name. */
const SYMPTOM = /^(?:any|chest|pain|pains|dizzy|breathless|fever|cough|headache|nausea|vomiting|tired|weak|blood|swelling|symptoms?|trouble|rash|itching|anxious|sleepy|numb|palpitations)\b/i;
const EXPLICIT_ORDER = /^(?:please |can you |could you |let'?s |lets )*(?:order|get|run|send|do|arrange|repeat|start|give|prescribe)\b/i;

const route = (target: RouteTarget, action: RouteAction, confidence: number): OfflineRoute => ({ target, action, confidence });

const CAN_YOU_DO =
  /^(?:can|could|will|would) you (?:please |kindly )?(?:ask .* to |get |give |do |send |run |repeat |order |arrange |start |book |put |draw |take |set |bring |prepare |add |check |hang |page |call )/i;

const isQuestion = (t: string): boolean => {
  const s = stripLead(t);
  if (CAN_YOU_DO.test(s)) return /\b(?:tell|explain|know|confirm|if|whether|why)\b/i.test(s);
  if (/^(?:should|shall) we\b/i.test(s)) return true;
  return (
    /[?？]\s*$/.test(t) ||
    /^(?:is|are|was|were|can|could|what|what's|whats|which|why|how|any|do (?:you|we|they|i|she|he|it|these|those)|does|did|has|have|will|would|should|when|who)\b/i.test(s) ||
    /\b(?:kya|kitna|kitni|kyun|kaisa|kab|enu|eshtu|yaake|enna|evvalavu|en|emi|entha|enduku|kay|kiti|ki|koto|keno)\s*(?:hai|hua|aaya|idhe|ide)?\s*$|\b(?:kya hai|kya hua|kitna hai|kyu|kyun|kya dikh\w*|theek hai kya|result kya)\b/i.test(t) ||
    /(?<![\p{L}\p{M}])(?:क्या|क्यों|कितन|कब|कैसा|ಏನು|ಎಷ್ಟು|ಯಾಕೆ|ಹೇಗಿದೆ|என்ன|எவ்வளவு|ஏன்|ఏమి|ఏం|ఎంత|ఎందుకు|काय|किती|का|কী|কত|কেন)/u.test(t) ||
    /(?:ಯಾ|ದಾ|லாமா|ிருக்கா|చ్చా|ుందా)\s*[?.]*\s*$/u.test(t)
  );
};

/** The utterance without the name it starts with. */
function body(t: string): string {
  const names = [...Object.values(DEPT_TITLE), ...Object.values(DEPT_NAME)].join('|');
  return stripLead(t)
    .replace(rx(`^(?:dr\\.?\\s+)?(?:staff nurse|nurse|sister|asha|aasha|didi|madam|ma'?am|नर्स|सिस्टर|आशा|दीदी|ನರ್ಸ್|ಸಿಸ್ಟರ್|ಆಶಾ|நர்ஸ்|சிஸ்டர்|ஆஷா|నర్స్|సిస్టర్|ఆశా|নার্স|সিস্টার|আশা|${names})(?:\\s+(?:asha|meera|dev|vikram|officer|ji|जी|please))?[\\s,:;.]*`), '')
    .trim();
}

/** What the doctor wants from a person they named. */
function wants(t: string): RouteAction {
  const b = body(t);
  if (isStop(b, true)) return 'stop';
  if (isQuestion(b)) return 'question';
  return 'order';
}

function namedDepartment(t: string, patientName: string): { role: Dept; called: boolean } | null {
  for (const role of DEPTS) {
    if (TITLE_LEAD[role].test(t) || TITLE_LEAD_NATIVE[role].test(t)) return { role, called: true };
    if (NAME_LEAD[role].test(t) && !sharesName(role, patientName)) return { role, called: true };
    if (TAIL[role].test(t) && !sharesName(role, patientName)) return { role, called: true };
  }
  for (const role of DEPTS) if (ASKED[role].test(t) && MENTION[role].test(t)) return { role, called: false };
  return null;
}

const sharesName = (d: Dept, patientName: string): boolean => new RegExp(`${B0}(?:${DEPT_NAME[d]})${B1}`, 'iu').test(patientName);

/** "Mr Rao, ...", "Lakshmi, how are you": the patient by name. */
function namesPatient(t: string, patientName: string): boolean {
  if (/^(?:mr|mrs|ms|uncle|aunty|amma|appa|baba|bhaiya|dada|beta|aunti|ajji|thatha)\b/i.test(t)) return true;
  const parts = patientName.trim().toLowerCase().split(/\s+/).filter((w) => w.length > 2);
  const head = t.toLowerCase().match(/^([\p{L}\p{M}]+)/u)?.[1];
  return !!head && parts.includes(head);
}

function observerInvite(raw: string, names: string[]): boolean {
  const cmd = parseInviteCommand(raw.replace(/^\W*(?:can|could) (?:someone|somebody|anyone)\s+/i, ''));
  if (!cmd) return false;
  const first = cmd.name.toLowerCase().split(/\s+/)[0];
  if (names.some((n) => n.toLowerCase() === first)) return true;
  if (!cmd.explicit || (/\?\s*$/.test(raw) && !/\b(?:can|could|will|would) (?:you|we)\b/i.test(raw)) || SYMPTOM.test(cmd.name)) return false;
  if (DEPTS.some((d) => rx(`^(?:${DEPT_TITLE[d]}|${DEPT_NAME[d]})$`).test(first))) return false;
  return !FACULTY_ANY.test(cmd.name) && !hasClinicalWord(normalise(cmd.name)) && !/\b(?:follow ?up|referral|appointment)\b/i.test(raw);
}

/** Who is this for, without the backend. */
export function classifyOffline(text: string, ctx: OfflineContext = {}): OfflineRoute {
  const raw = (text ?? '').trim();
  if (!raw) return route('patient', 'none', 1);
  const t = stripLead(raw);
  const name = [ctx.patientName ?? '', ...(ctx.relatedNames ?? [])].join(' ').trim();
  const toNurse = isAddressedToNurse(raw, name) || (ASHA_ASKED.test(t) && !/\ba+sha\b/i.test(name));
  const patientQ = englishPatientQuestion(raw) || nativePatientQuestion(raw) || (!INDIC.test(raw) && romanPatientTalk(raw));
  const dept = namedDepartment(t, name);
  const clinical = hasClinicalWord(normalise(raw)) || hasNativeClinical(raw);
  const faculty = FACULTY_ANY.test(raw);

  // A pharmacy hold, against advice: only a human may lift it.
  if ((OVERRIDE.test(raw) || FACULTY_DECIDE.test(raw)) && !patientQ) return route('faculty', 'override', 0.85);
  if ((SENIOR_INVITE.test(raw) && !/\b(?:my|observe|watch)\b/i.test(raw) && !/^\W*(?:did|have|has|is|are|was|do|does|when|what)\b/i.test(raw)) || VARA_SOLLUNGA.test(raw)) {
    return route('faculty', 'invite', 0.8);
  }
  if (observerInvite(raw, ctx.observerNames ?? [])) return route('observer', 'invite', 0.8);

  if (faculty && FACULTY_LEAD.test(t)) {
    return route('faculty', ctx.awaitingFaculty && !isQuestion(body(t)) ? 'answer' : 'question', 0.85);
  }
  if (faculty && !patientQ) {
    if (FACULTY_INVITE.test(raw)) return route('faculty', 'invite', 0.85);
    if (FACULTY_ASK.test(raw)) return route('faculty', ctx.awaitingFaculty ? 'answer' : 'question', 0.8);
  }
  if (ctx.awaitingFaculty && SIR.test(t) && !englishPatientQuestion(t.replace(SIR, '')) && !nativePatientQuestion(raw)) {
    return route('faculty', 'answer', 0.85);
  }

  if (!patientQ || dept?.called) {
    for (const d of DEPTS) {
      if (DEPT_INVITE[d].test(raw) && !sharesName(d, name)) return route(d, 'invite', 0.85);
    }
  }
  for (const d of DEPTS) if (DEPT_SAID[d].test(raw) && !/\byou\b/i.test(raw)) return route(d, 'question', 0.75);

  if (dept && !(dept.called === false && /\b(?:you can|you could|you may|if you)\b/i.test(raw))) {
    if (dept.called && ctx.pendingQuestion?.role === dept.role && !isQuestion(body(t))) return route(dept.role, 'answer', 0.9);
    const b = body(raw);
    if (dept.called) return route(dept.role, isStop(b, true) ? 'stop' : isQuestion(b) ? 'question' : 'order', 0.88);
    const does = /\bto (?:run|do|send|process|give|dispense|start|repeat|check|prepare|hold|release)\b/i.test(raw);
    return route(dept.role, /\bto (?:hold|stop|cancel)\b/i.test(raw) ? 'stop' : does && clinical ? 'order' : 'question', 0.85);
  }

  if (toNurse) {
    const b = body(raw);
    if (HINT_RX.test(b) || HINT_NATIVE.test(raw) || HINT_ROMAN.test(raw)) return route('coach', 'hint', 0.9);
    if (!isStop(b, true)) {
      const exam = classifyExam(b) ?? classifyExam(raw);
      if (exam && !clinical) return route('exam', 'order', 0.88);
    }
    if (/^(?:is|are|was) there\b/i.test(t) || (englishPatientQuestion(b) && /\byour\b/i.test(b) && !clinical)) return route('patient', 'none', 0.6);
    return route('nurse', wants(raw), 0.92);
  }

  if (namesPatient(t, name)) return route('patient', 'none', 0.85);

  if (ctx.pendingQuestion && !patientQ && !patientTalk(raw)) {
    if (EXPLICIT_ORDER.test(t) && clinical && !YESNO.test(raw)) return route('nurse', 'order', 0.8);
    if (/\b(?:cancel)\b|कैंसल|रद्द|ರದ್ದು|ಕ್ಯಾನ್ಸಲ್|கேன்சல்|క్యాన్సిల్|বাতিল/iu.test(raw)) return route('nurse', 'stop', 0.8);
    if (!classifyExam(raw) && raw.split(/\s+/).length <= 25 && !/[?？]\s*$/.test(raw)) {
      return route(ctx.pendingQuestion.role as RouteTarget, 'answer', YESNO.test(raw) ? 0.85 : 0.7);
    }
  }
  if (ctx.awaitingFaculty && !patientQ && !patientTalk(raw) && !looksLikeOrder(raw, name) && !classifyExam(raw) && raw.split(/\s+/).length >= 3) {
    return route('faculty', 'answer', 0.7);
  }

  if (HINT_RX.test(raw) || HINT_NATIVE.test(raw) || HINT_ROMAN.test(raw)) return route('coach', 'hint', 0.9);
  if (isStop(raw, false)) return route('nurse', 'stop', 0.8);

  const exam = classifyExam(raw);
  if (exam) return route('exam', 'order', 0.85);
  if (patientQ) {
    // "Are the results back?" is for whoever has them.
    if (RESULT_Q.test(raw) && !/\byour?\b/i.test(raw) && !romanPatientTalk(raw)) return route('nurse', 'question', 0.7);
    return route('patient', 'none', 0.85);
  }
  if (RESULT_Q.test(raw) && !/\byour?\b/i.test(raw) && isQuestion(raw)) return route('nurse', 'question', 0.65);
  if (looksLikeOrder(raw, name) || looksLikeNativeOrder(raw)) return route('nurse', 'order', 0.78);
  return route('patient', 'none', INDIC.test(raw) ? 0.6 : 0.65);
}
