// Prompt language blocks for the voice personas. Mirrors backend/lang.py
// (the backend applies the same rules to nurse, coach and lesson prompts).

import type { Lang } from '../game/lang';

const HI =
  'LANGUAGE: Speak natural, everyday spoken Hindi, written in Devanagari script only (never Roman letters for Hindi words). ' +
  'Common English medical loanwords are natural in Hindi speech and allowed, for example BP, sugar, test, report, tablet, injection, X-ray, ECG, doctor, hospital. ' +
  'Keep sentences short and conversational, the way a person in India really talks to a doctor. ' +
  'Address the doctor respectfully as "आप". If the doctor switches to English or Kannada, reply in the language the doctor last spoke.';

const KN =
  'LANGUAGE: Speak natural, everyday spoken Kannada, written in Kannada script only (never Roman letters for Kannada words). ' +
  'Common English medical loanwords are natural in spoken Kannada and allowed, for example BP, sugar, test, report, tablet, injection, X-ray, ECG, doctor, hospital. ' +
  'Keep sentences short and conversational, the way a person in Karnataka really talks to a doctor. ' +
  'Address the doctor respectfully as "ನೀವು". If the doctor switches to English or Hindi, reply in the language the doctor last spoke.';

/** Language block appended to a persona prompt. Empty for English. */
export function languageBlock(lang: Lang, opts: { female?: boolean; role?: 'patient' | 'teacher' } = {}): string {
  if (lang === 'en') return '';
  const role = opts.role ?? 'patient';
  const parts = [lang === 'hi' ? HI : KN];
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
  return parts.join('\n');
}

export function withLanguage(prompt: string, lang: Lang, opts: { female?: boolean; role?: 'patient' | 'teacher' } = {}): string {
  const block = languageBlock(lang, opts);
  return block ? `${prompt}\n\n${block}` : prompt;
}
