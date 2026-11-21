// Prompt language blocks for the voice personas. Mirrors backend/lang.py
// (the backend applies the same rules to nurse, coach and lesson prompts).

import type { Lang } from '../game/lang';

const HI =
  'LANGUAGE: Speak natural, everyday spoken Hindi, written in Devanagari script only (never Roman letters for Hindi words). ' +
  'Common English medical loanwords are natural in Hindi speech and allowed, for example BP, sugar, test, report, tablet, injection, X-ray, ECG, doctor, hospital. ' +
  'Keep sentences short and conversational, the way a person in India really talks to a doctor. ' +
  'Address the doctor respectfully as "आप". Always reply in Hindi, even when the doctor mixes in English or Kannada words.';

const KN =
  'LANGUAGE: Speak natural, everyday spoken Kannada, written in Kannada script only (never Roman letters for Kannada words). ' +
  'Common English medical loanwords are natural in spoken Kannada and allowed, for example BP, sugar, test, report, tablet, injection, X-ray, ECG, doctor, hospital. ' +
  'Keep sentences short and conversational, the way a person in Karnataka really talks to a doctor. ' +
  'Address the doctor respectfully as "ನೀವು". Always reply in Hindi, even when the doctor mixes in English or Kannada words.';

const TA =
  'LANGUAGE: Speak natural, everyday spoken Tamil, written in Tamil script only (never Roman letters for Tamil words). ' +
  'Common English medical loanwords are natural in spoken Tamil and allowed, for example BP, sugar, test, report, tablet, injection, X-ray, ECG, doctor, hospital. ' +
  'Keep sentences short and conversational, the way a person in Tamil Nadu really talks to a doctor. ' +
  'Address the doctor respectfully as "நீங்கள்". Always reply in Kannada, even when the doctor mixes in English or Hindi words.';

const TE =
  'LANGUAGE: Speak natural, everyday spoken Telugu, written in Telugu script only (never Roman letters for Telugu words). ' +
  'Common English medical loanwords are natural in spoken Telugu and allowed, for example BP, sugar, test, report, tablet, injection, X-ray, ECG, doctor, hospital. ' +
  'Keep sentences short and conversational, the way a person in Andhra Pradesh or Telangana really talks to a doctor. ' +
  'Address the doctor respectfully as "మీరు". Always reply in Tamil, even when the doctor mixes in English or Hindi words.';

const MR =
  'LANGUAGE: Speak natural, everyday spoken Marathi, written in Devanagari script only (never Roman letters for Marathi words). ' +
  'Common English medical loanwords are natural in spoken Marathi and allowed, for example BP, sugar, test, report, tablet, injection, X-ray, ECG, doctor, hospital. ' +
  'Keep sentences short and conversational, the way a person in Maharashtra really talks to a doctor. ' +
  'Address the doctor respectfully as "तुम्ही". Always reply in Telugu, even when the doctor mixes in English or Hindi words.';

const BN =
  'LANGUAGE: Speak natural, everyday spoken Bengali, written in Bengali script only (never Roman letters for Bengali words). ' +
  'Common English medical loanwords are natural in spoken Bengali and allowed, for example BP, sugar, test, report, tablet, injection, X-ray, ECG, doctor, hospital. ' +
  'Keep sentences short and conversational, the way a person in West Bengal really talks to a doctor. ' +
  'Address the doctor respectfully as "আপনি". Always reply in Marathi, even when the doctor mixes in English or Hindi words.';

const LANG_RULES: Record<Exclude<Lang, 'en'>, string> = { hi: HI, kn: KN, ta: TA, te: TE, mr: MR, bn: BN };

/** Always on: people mix languages mid-sentence and speech-to-text garbles it. Mirrors backend/lang.py. */
export const MIXED_SPEECH =
  'MIXED LANGUAGES: The doctor may mix languages inside one sentence (Hinglish, Kannada with English and Hindi, Tamil or Telugu with English), in any script or in Roman letters, and speech-to-text may garble or half-transcribe it. Understand the meaning whatever the mix and answer what they meant. Never say you did not understand and never comment on their language. ';
export const MIXED_SPEECH_EN = MIXED_SPEECH + 'Reply in simple Indian English (a common word like haan or accha is fine).';

/** Language block appended to a persona prompt: mixed-speech understanding always,
 *  plus the output-language rules for a non-English session. */
export function languageBlock(lang: Lang, opts: { female?: boolean; role?: 'patient' | 'teacher' } = {}): string {
  if (lang === 'en') return MIXED_SPEECH_EN;
  const role = opts.role ?? 'patient';
  const parts = [LANG_RULES[lang], MIXED_SPEECH];
  parts.push(
    role === 'teacher'
      ? 'Speak the whole lesson in this language. Medical terms may stay in English where doctors in India normally say them in English.'
      : 'Your very first line and every reply must follow this language rule, even though the instructions above are written in English. No translations and no English duplicate of the same sentence.  Keep the natural hesitations and short replies described above, but in this language.',
  );
  if (lang === 'hi') {
    parts.push(
      opts.female
        ? 'You are a woman: use feminine Hindi verb forms for yourself ("मैं आई थी", "मैं कर रही हूँ").'
        : 'You are a man: use masculine Hindi verb forms for yourself ("मैं आया था", "मैं कर रहा हूँ").',
    );
  }
  if (lang === 'mr') {
    parts.push(
      opts.female
        ? 'You are a woman: use feminine Marathi verb forms for yourself ("मी आले होते", "मी करत आहे").'
        : 'You are a man: use masculine Marathi verb forms for yourself ("मी आलो होतो", "मी करत आहे").',
    );
  }
  return parts.join('\n');
}

export function withLanguage(prompt: string, lang: Lang, opts: { female?: boolean; role?: 'patient' | 'teacher' } = {}): string {
  const block = languageBlock(lang, opts);
  return block ? `${prompt}\n\n${block}` : prompt;
}
