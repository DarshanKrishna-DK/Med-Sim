// Prompt language blocks for the voice personas. Mirrors backend/lang.py
// (the backend applies the same rules to nurse, coach and lesson prompts).

import type { Lang } from '../game/lang';

/** Rules for one language. Each block must name its own language (tested): never copy and paste these. */
function rules(name: string, script: string, region: string, you: string, others: string): string {
  return (
    `LANGUAGE: Speak natural, everyday spoken ${name}, written in ${script} only (never Roman letters for ${name} words). ` +
    `Common English medical loanwords are natural in spoken ${name} and allowed, for example BP, sugar, test, report, tablet, injection, X-ray, ECG, doctor, hospital. ` +
    `Keep sentences short and conversational, the way a person in ${region} really talks to a doctor. ` +
    `Address the doctor respectfully as "${you}". Reply in ${name} by default, even when the doctor mixes in ${others} words.`
  );
}

const LANG_RULES: Record<Exclude<Lang, 'en'>, string> = {
  hi: rules('Hindi', 'Devanagari script', 'India', 'आप', 'English or Kannada'),
  kn: rules('Kannada', 'Kannada script', 'Karnataka', 'ನೀವು', 'English or Hindi'),
  ta: rules('Tamil', 'Tamil script', 'Tamil Nadu', 'நீங்கள்', 'English or Hindi'),
  te: rules('Telugu', 'Telugu script', 'Andhra Pradesh or Telangana', 'మీరు', 'English or Hindi'),
  mr: rules('Marathi', 'Devanagari script', 'Maharashtra', 'तुम्ही', 'English or Hindi'),
  bn: rules('Bengali', 'Bengali script', 'West Bengal', 'আপনি', 'English or Hindi'),
};

/** Always on: people mix languages mid-sentence and speech-to-text garbles it.
 *  Same text as MIXED_SPEECH in backend/lang.py (a test compares them). Murf reads any
 *  Indian script whatever the locale, but stumbles on romanised Hindi or Kannada. */
export const MIXED_SPEECH =
  'MIXED LANGUAGES: The doctor may mix two or three languages inside one sentence (Hinglish, Kannada with English and Hindi, Tamil or Telugu with English), in any script or in Roman letters, and speech-to-text may garble or half-transcribe it. Understand the meaning whatever the mix and answer what they meant. Never say you did not understand and never comment on their language. ' +
  'REPLYING: Answer in the session language by default. If the doctor has clearly switched, meaning their last two turns in a row are mostly in another Indian language or in English, follow them and answer in that language until they switch again; one mixed or foreign sentence is not a switch. If the doctor mixes languages, a natural light mix in your reply is fine. Write each language in its own script, because a voice reads it aloud, and never write whole Indian-language sentences in Roman letters. Keep medical terms recognisable: BP, sugar, ECG, X-ray, test and medicine names. ';
export const MIXED_SPEECH_EN = MIXED_SPEECH + 'The session language is English: reply in simple Indian English (a common word like haan or accha is fine).';

/** Language block appended to a persona prompt: mixed-speech understanding always,
 *  plus the output-language rules for a non-English session. */
export function languageBlock(lang: Lang, opts: { female?: boolean; role?: 'patient' | 'teacher' } = {}): string {
  if (lang === 'en') return MIXED_SPEECH_EN;
  const role = opts.role ?? 'patient';
  const parts = [LANG_RULES[lang], MIXED_SPEECH];
  parts.push(
    role === 'teacher'
      ? 'Speak the whole lesson in this language. Medical terms may stay in English where doctors in India normally say them in English.'
      : 'Your very first line and every reply must follow this language rule, even though the instructions above are written in English. No translations and no English duplicate of the same sentence. Keep the natural hesitations and short replies described above, but in this language.',
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
