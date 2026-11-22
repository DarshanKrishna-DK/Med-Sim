// Fixed spoken lines that do not come from a model, in the session language.
// Pure data, so Node tests can check every language has every line.

import type { Lang } from '../game/lang';

type Per<T> = Record<Lang, T>;

/** The patient's goodbye (their own voice, through the Agora agent). */
export const FAREWELL_LINES: Per<string[]> = {
  en: [
    'Okay, thank you so much, doctor. Goodbye.',
    'Thanks, doctor. Take care.',
    'Alright, thank you. Bye now.',
    'Okay. Thanks for your help, doctor. Bye.',
  ],
  hi: ['ठीक है डॉक्टर, बहुत धन्यवाद। नमस्ते।', 'शुक्रिया डॉक्टर साहब। अपना ख्याल रखिए।', 'अच्छा, धन्यवाद डॉक्टर। चलते हैं।'],
  kn: ['ಸರಿ ಡಾಕ್ಟರ್, ತುಂಬಾ ಧನ್ಯವಾದಗಳು. ಬರ್ತೀನಿ.', 'ಥ್ಯಾಂಕ್ಸ್ ಡಾಕ್ಟರ್. ನಮಸ್ಕಾರ.', 'ಆಯ್ತು ಡಾಕ್ಟರ್, ನಿಮ್ಮ ಸಹಾಯಕ್ಕೆ ಧನ್ಯವಾದ.'],
  ta: ['சரி டாக்டர், ரொம்ப நன்றி. போயிட்டு வரேன்.', 'நன்றி டாக்டர். வணக்கம்.', 'சரிங்க டாக்டர், உங்க உதவிக்கு நன்றி.'],
  te: ['సరే డాక్టర్, చాలా థాంక్స్. వెళ్ళొస్తాను.', 'ధన్యవాదాలు డాక్టర్. నమస్కారం.', 'సరేనండి డాక్టర్, మీ సహాయానికి ధన్యవాదాలు.'],
  mr: ['ठीक आहे डॉक्टर, खूप धन्यवाद. येतो.', 'धन्यवाद डॉक्टर. नमस्कार.', 'बरं डॉक्टर, तुमच्या मदतीबद्दल आभारी आहे.'],
  bn: ['ঠিক আছে ডাক্তারবাবু, অনেক ধন্যবাদ। আসি।', 'ধন্যবাদ ডাক্তারবাবু। নমস্কার।', 'আচ্ছা ডাক্তারবাবু, সাহায্যের জন্য ধন্যবাদ।'],
};
// Marathi "येतो" is masculine; used by everyone as a set phrase is wrong for a
// woman, so a woman (or a mother speaking for a child) gets these instead.
const FAREWELL_MR_F = ['ठीक आहे डॉक्टर, खूप धन्यवाद. येते.', 'धन्यवाद डॉक्टर. नमस्कार.', 'बरं डॉक्टर, तुमच्या मदतीबद्दल आभारी आहे.'];

export function farewellLine(lang: Lang, gender: 'M' | 'F', rnd: number = Math.random()): string {
  const list = lang === 'mr' && gender === 'F' ? FAREWELL_MR_F : FAREWELL_LINES[lang] ?? FAREWELL_LINES.en;
  return list[Math.min(list.length - 1, Math.floor(rnd * list.length))];
}

/** "I heard you" while a nurse run is still working. */
export const ACK_ORDER: Per<string[]> = {
  en: ['Right away, doctor.', 'On it, doctor.', 'Yes doctor, doing it now.'],
  hi: ['जी डॉक्टर, अभी करती हूँ।', 'ठीक है डॉक्टर, कर रही हूँ।', 'हाँ डॉक्टर, तुरंत।'],
  kn: ['ಸರಿ ಡಾಕ್ಟರ್, ಈಗಲೇ ಮಾಡ್ತೀನಿ.', 'ಆಯ್ತು ಡಾಕ್ಟರ್, ಮಾಡ್ತಾ ಇದ್ದೀನಿ.', 'ಹಾಂ ಡಾಕ್ಟರ್, ತಕ್ಷಣ.'],
  ta: ['சரி டாக்டர், இப்பவே பண்றேன்.', 'ஆமா டாக்டர், பண்ணிட்டு இருக்கேன்.', 'உடனே பண்றேன் டாக்டர்.'],
  te: ['సరే డాక్టర్, ఇప్పుడే చేస్తాను.', 'అలాగే డాక్టర్, చేస్తున్నాను.', 'వెంటనే చేస్తాను డాక్టర్.'],
  mr: ['हो डॉक्टर, लगेच करते.', 'ठीक आहे डॉक्टर, करतेय.', 'लगेच डॉक्टर.'],
  bn: ['ঠিক আছে ডাক্তারবাবু, এখনই করছি।', 'হ্যাঁ ডাক্তারবাবু, করছি।', 'এক্ষুনি করছি ডাক্তারবাবু।'],
};

/** The same, for a question to the nurse. */
export const ACK_QUESTION: Per<string[]> = {
  en: ['Let me check, doctor.', 'One moment, doctor.'],
  hi: ['देखती हूँ डॉक्टर।', 'एक मिनट डॉक्टर।'],
  kn: ['ನೋಡ್ತೀನಿ ಡಾಕ್ಟರ್.', 'ಒಂದು ನಿಮಿಷ ಡಾಕ್ಟರ್.'],
  ta: ['பார்க்கிறேன் டாக்டர்.', 'ஒரு நிமிஷம் டாக்டர்.'],
  te: ['చూస్తాను డాక్టర్.', 'ఒక్క నిమిషం డాక్టర్.'],
  mr: ['बघते डॉक्टर.', 'एक मिनिट डॉक्टर.'],
  bn: ['দেখছি ডাক্তারবাবু।', 'এক মিনিট ডাক্তারবাবু।'],
};

/** Asha while the hint is being prepared, and when it could not be. */
export const COACH_LOOKING: Per<string> = {
  en: 'Let me have a look, doctor.',
  hi: 'एक नज़र देख लेती हूँ, डॉक्टर।',
  kn: 'ಒಮ್ಮೆ ನೋಡ್ತೀನಿ, ಡಾಕ್ಟರ್.',
  ta: 'ஒரு முறை பார்க்கிறேன், டாக்டர்.',
  te: 'ఒకసారి చూస్తాను, డాక్టర్.',
  mr: 'एकदा बघते, डॉक्टर.',
  bn: 'একবার দেখে নিই, ডাক্তারবাবু।',
};
export const COACH_FAILED: Per<string> = {
  en: "Sorry doctor, I couldn't check just now. Ask me again in a moment.",
  hi: 'माफ़ कीजिए डॉक्टर, अभी देख नहीं पाई। थोड़ी देर में फिर पूछिए।',
  kn: 'ಕ್ಷಮಿಸಿ ಡಾಕ್ಟರ್, ಈಗ ನೋಡೋಕೆ ಆಗಲಿಲ್ಲ. ಸ್ವಲ್ಪ ಹೊತ್ತಲ್ಲಿ ಮತ್ತೆ ಕೇಳಿ.',
  ta: 'மன்னிக்கணும் டாக்டர், இப்போ பார்க்க முடியலை. கொஞ்ச நேரத்துல திரும்ப கேளுங்க.',
  te: 'క్షమించండి డాక్టర్, ఇప్పుడు చూడలేకపోయాను. కాసేపట్లో మళ్ళీ అడగండి.',
  mr: 'माफ करा डॉक्टर, आत्ता बघता आलं नाही. थोड्या वेळाने पुन्हा विचारा.',
  bn: 'দুঃখিত ডাক্তারবাবু, এখন দেখতে পারলাম না। একটু পরে আবার জিজ্ঞেস করুন।',
};

/** A request that got lost on the way to a department. */
export const DEPARTMENT_FAILED: Per<string> = {
  en: "Sorry doctor, I couldn't reach them. Please try again.",
  hi: 'माफ़ कीजिए डॉक्टर, उनसे बात नहीं हो पाई। फिर से कहिए।',
  kn: 'ಕ್ಷಮಿಸಿ ಡಾಕ್ಟರ್, ಅವರನ್ನು ಸಂಪರ್ಕಿಸೋಕೆ ಆಗಲಿಲ್ಲ. ಮತ್ತೆ ಹೇಳಿ.',
  ta: 'மன்னிக்கணும் டாக்டர், அவங்களை தொடர்பு கொள்ள முடியலை. மறுபடியும் சொல்லுங்க.',
  te: 'క్షమించండి డాక్టర్, వాళ్ళని సంప్రదించలేకపోయాను. మళ్ళీ చెప్పండి.',
  mr: 'माफ करा डॉक्टर, त्यांच्याशी संपर्क झाला नाही. पुन्हा सांगा.',
  bn: 'দুঃখিত ডাক্তারবাবু, ওঁদের সঙ্গে যোগাযোগ করতে পারলাম না। আবার বলুন।',
};

type ObserverLine = 'stillOnCall' | 'startVoice' | 'linkFailed' | 'callFailed' | 'noContact';

/** Asha inviting an observer. `{name}` is the contact's first name. */
export const OBSERVER_LINES: Record<ObserverLine, Per<string>> = {
  stillOnCall: {
    en: "I'm still on the call with {name}, doctor.",
    hi: 'मैं अभी {name} के साथ कॉल पर हूँ, डॉक्टर।',
    kn: 'ನಾನು ಇನ್ನೂ {name} ಜೊತೆ ಕಾಲ್‌ನಲ್ಲಿ ಇದ್ದೀನಿ, ಡಾಕ್ಟರ್.',
    ta: 'நான் இன்னும் {name} கூட கால்ல இருக்கேன், டாக்டர்.',
    te: 'నేను ఇంకా {name} తో కాల్‌లో ఉన్నాను, డాక్టర్.',
    mr: 'मी अजून {name} सोबत कॉलवर आहे, डॉक्टर.',
    bn: 'আমি এখনও {name} এর সঙ্গে কলে আছি, ডাক্তারবাবু।',
  },
  startVoice: {
    en: 'Start voice first, doctor. Press T, then ask me again to invite {name}.',
    hi: 'पहले वॉइस शुरू कीजिए, डॉक्टर। T दबाइए, फिर {name} को बुलाने के लिए कहिए।',
    kn: 'ಮೊದಲು ವಾಯ್ಸ್ ಶುರು ಮಾಡಿ, ಡಾಕ್ಟರ್. T ಒತ್ತಿ, ಆಮೇಲೆ {name} ಅವರನ್ನು ಕರೆಯೋಕೆ ಹೇಳಿ.',
    ta: 'முதல்ல வாய்ஸ் ஆரம்பிங்க, டாக்டர். T அழுத்துங்க, அப்புறம் {name} ஐ கூப்பிட சொல்லுங்க.',
    te: 'ముందు వాయిస్ మొదలుపెట్టండి, డాక్టర్. T నొక్కి, తర్వాత {name} ని పిలవమని చెప్పండి.',
    mr: 'आधी व्हॉइस सुरू करा, डॉक्टर. T दाबा, मग {name} यांना बोलवायला सांगा.',
    bn: 'আগে ভয়েস চালু করুন, ডাক্তারবাবু। T টিপুন, তারপর {name} কে ডাকতে বলুন।',
  },
  linkFailed: {
    en: "Sorry doctor, I couldn't create the observer link.",
    hi: 'माफ़ कीजिए डॉक्टर, ऑब्ज़र्वर लिंक नहीं बन पाया।',
    kn: 'ಕ್ಷಮಿಸಿ ಡಾಕ್ಟರ್, ಅಬ್ಸರ್ವರ್ ಲಿಂಕ್ ಮಾಡೋಕೆ ಆಗಲಿಲ್ಲ.',
    ta: 'மன்னிக்கணும் டாக்டர், அப்சர்வர் லிங்க் உருவாக்க முடியலை.',
    te: 'క్షమించండి డాక్టర్, అబ్జర్వర్ లింక్ చేయలేకపోయాను.',
    mr: 'माफ करा डॉक्टर, ऑब्झर्व्हर लिंक तयार झाली नाही.',
    bn: 'দুঃখিত ডাক্তারবাবু, অবজার্ভার লিঙ্ক তৈরি করতে পারলাম না।',
  },
  callFailed: {
    en: "Sorry doctor, I couldn't call {name}.",
    hi: 'माफ़ कीजिए डॉक्टर, {name} को कॉल नहीं लग पाया।',
    kn: 'ಕ್ಷಮಿಸಿ ಡಾಕ್ಟರ್, {name} ಅವರಿಗೆ ಕಾಲ್ ಮಾಡೋಕೆ ಆಗಲಿಲ್ಲ.',
    ta: 'மன்னிக்கணும் டாக்டர், {name} க்கு கால் பண்ண முடியலை.',
    te: 'క్షమించండి డాక్టర్, {name} కి కాల్ చేయలేకపోయాను.',
    mr: 'माफ करा डॉक्टर, {name} यांना कॉल लागला नाही.',
    bn: 'দুঃখিত ডাক্তারবাবু, {name} কে কল করতে পারলাম না।',
  },
  noContact: {
    en: "I don't have {name} in your contacts yet. Add their number and I'll call.",
    hi: '{name} अभी आपके कॉन्टैक्ट में नहीं हैं। नंबर जोड़ दीजिए, मैं कॉल कर दूँगी।',
    kn: '{name} ಇನ್ನೂ ನಿಮ್ಮ ಕಾಂಟ್ಯಾಕ್ಟ್ಸ್‌ನಲ್ಲಿ ಇಲ್ಲ. ನಂಬರ್ ಸೇರಿಸಿ, ನಾನು ಕಾಲ್ ಮಾಡ್ತೀನಿ.',
    ta: '{name} இன்னும் உங்க கான்டாக்ட்ஸ்ல இல்லை. நம்பர் சேருங்க, நான் கால் பண்றேன்.',
    te: '{name} ఇంకా మీ కాంటాక్ట్స్‌లో లేరు. నంబర్ చేర్చండి, నేను కాల్ చేస్తాను.',
    mr: '{name} अजून तुमच्या कॉन्टॅक्टमध्ये नाहीत. नंबर टाका, मी कॉल करते.',
    bn: '{name} এখনও আপনার কন্ট্যাক্টে নেই। নম্বর যোগ করুন, আমি কল করব।',
  },
};

export const observerLine = (k: ObserverLine, lang: Lang, name = ''): string =>
  (OBSERVER_LINES[k][lang] ?? OBSERVER_LINES[k].en).replace('{name}', name);

/** Dr. Vikram Rao at the reporting desk: first hello, and "you are back". */
export const RADIOLOGIST_HELLO: Per<string> = {
  en: 'Come in, come in. I am Doctor Vikram Rao. Pick a film, look at it properly, then describe it to me in order, the way you would report it. Take your time.',
  hi: 'आइए, आइए। मैं डॉक्टर विक्रम राव हूँ। एक फ़िल्म चुनिए, ध्यान से देखिए, फिर क्रम से बताइए, जैसे रिपोर्ट लिखते हैं। आराम से।',
  kn: 'ಬನ್ನಿ, ಬನ್ನಿ. ನಾನು ಡಾಕ್ಟರ್ ವಿಕ್ರಮ್ ರಾವ್. ಒಂದು ಫಿಲ್ಮ್ ಆರಿಸಿ, ಸರಿಯಾಗಿ ನೋಡಿ, ಆಮೇಲೆ ರಿಪೋರ್ಟ್ ಮಾಡೋ ಹಾಗೆ ಕ್ರಮವಾಗಿ ಹೇಳಿ. ನಿಧಾನವಾಗಿ.',
  ta: 'வாங்க, வாங்க. நான் டாக்டர் விக்ரம் ராவ். ஒரு ஃபிலிம் எடுங்க, நல்லா பாருங்க, அப்புறம் ரிப்போர்ட் பண்ற மாதிரி வரிசையா சொல்லுங்க. நிதானமா.',
  te: 'రండి, రండి. నేను డాక్టర్ విక్రమ్ రావు. ఒక ఫిల్మ్ ఎంచుకోండి, బాగా చూడండి, తర్వాత రిపోర్ట్ చేసినట్టు వరుసగా చెప్పండి. నిదానంగా.',
  mr: 'या, या. मी डॉक्टर विक्रम राव. एक फिल्म निवडा, नीट बघा, मग रिपोर्ट करतो तसं क्रमाने सांगा. सावकाश.',
  bn: 'আসুন, আসুন। আমি ডাক্তার বিক্রম রাও। একটা ফিল্ম বেছে নিন, ভালো করে দেখুন, তারপর রিপোর্ট করার মতো পরপর বলুন। ধীরে সুস্থে।',
};
const RADIOLOGIST_BACK: Per<string> = {
  en: 'Achha, you are back. The film on the screen is a {study}. Go ahead, describe it to me.',
  hi: 'अच्छा, आप वापस आ गए। स्क्रीन पर {study} की फ़िल्म है। बताइए, क्या दिख रहा है।',
  kn: 'ಸರಿ, ಮತ್ತೆ ಬಂದ್ರಿ. ಸ್ಕ್ರೀನ್ ಮೇಲೆ ಇರೋದು {study} ಫಿಲ್ಮ್. ಹೇಳಿ, ಏನು ಕಾಣ್ತಿದೆ.',
  ta: 'சரி, திரும்ப வந்துட்டீங்க. ஸ்கிரீன்ல இருக்கிறது {study} ஃபிலிம். சொல்லுங்க, என்ன தெரியுது.',
  te: 'సరే, మళ్ళీ వచ్చారు. స్క్రీన్ మీద ఉన్నది {study} ఫిల్మ్. చెప్పండి, ఏం కనిపిస్తోంది.',
  mr: 'बरं, तुम्ही परत आलात. स्क्रीनवर {study} फिल्म आहे. सांगा, काय दिसतंय.',
  bn: 'আচ্ছা, আবার এলেন। স্ক্রিনে {study} ফিল্ম আছে। বলুন, কী দেখছেন।',
};
export const radiologistBack = (lang: Lang, study: string): string =>
  (RADIOLOGIST_BACK[lang] ?? RADIOLOGIST_BACK.en).replace('{study}', study);

const RADIOLOGIST_NEXT: Per<string> = {
  en: 'Next film. {study} for {who}, from {place}. Read the history on your panel, then tell me what you see.',
  hi: 'अगली फ़िल्म। {who}, {place} से, {study}। पैनल पर हिस्ट्री पढ़िए, फिर बताइए क्या दिख रहा है।',
  kn: 'ಮುಂದಿನ ಫಿಲ್ಮ್. {who}, {place} ಇಂದ, {study}. ಪ್ಯಾನೆಲ್‌ನಲ್ಲಿ ಹಿಸ್ಟರಿ ಓದಿ, ಆಮೇಲೆ ಏನು ಕಾಣ್ತಿದೆ ಹೇಳಿ.',
  ta: 'அடுத்த ஃபிலிம். {who}, {place}, {study}. பேனல்ல ஹிஸ்டரி படிங்க, அப்புறம் என்ன தெரியுதுன்னு சொல்லுங்க.',
  te: 'తర్వాతి ఫిల్మ్. {who}, {place} నుంచి, {study}. ప్యానెల్‌లో హిస్టరీ చదవండి, తర్వాత ఏం కనిపిస్తోందో చెప్పండి.',
  mr: 'पुढची फिल्म. {who}, {place} हून, {study}. पॅनेलवर हिस्टरी वाचा, मग काय दिसतंय ते सांगा.',
  bn: 'পরের ফিল্ম। {who}, {place} থেকে, {study}। প্যানেলে হিস্ট্রি পড়ুন, তারপর বলুন কী দেখছেন।',
};
export const radiologistNextFilm = (lang: Lang, study: string, who: string, place: string): string =>
  (RADIOLOGIST_NEXT[lang] ?? RADIOLOGIST_NEXT.en).replace('{study}', study).replace('{who}', who).replace('{place}', place);

/** Rotates through variants so two orders in a row do not sound canned. */
export class Rotator {
  private at = new Map<string, number>();
  pick(name: string, list: readonly string[]): string {
    const i = (this.at.get(name) ?? -1) + 1;
    this.at.set(name, i);
    return list[i % list.length];
  }
}
