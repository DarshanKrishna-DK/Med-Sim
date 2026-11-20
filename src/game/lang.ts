// Session language for voice agents (patient, nurse, coach, teacher).
// The UI itself stays English; only spoken/displayed agent lines follow this.

export type Lang = 'en' | 'hi' | 'kn' | 'ta' | 'te' | 'mr' | 'bn';

export const LANGS: readonly Lang[] = ['en', 'hi', 'kn', 'ta', 'te', 'mr', 'bn'];

/** Languages shown as quick chips in the toggle; the rest sit under "More". */
export const QUICK_LANGS: readonly Lang[] = ['en', 'hi', 'kn'];

export const LANG_LOCALE: Record<Lang, string> = {
  en: 'en-IN',
  hi: 'hi-IN',
  kn: 'kn-IN',
  ta: 'ta-IN',
  te: 'te-IN',
  mr: 'mr-IN',
  bn: 'bn-IN',
};

/** Short labels for the toggle (native script) and full names for tooltips. */
export const LANG_LABEL: Record<Lang, string> = {
  en: 'EN',
  hi: 'हिं',
  kn: 'ಕನ್ನಡ',
  ta: 'தமிழ்',
  te: 'తెలుగు',
  mr: 'मराठी',
  bn: 'বাংলা',
};
export const LANG_NAME: Record<Lang, string> = {
  en: 'English',
  hi: 'Hindi',
  kn: 'Kannada',
  ta: 'Tamil',
  te: 'Telugu',
  mr: 'Marathi',
  bn: 'Bengali',
};

export const LANG_KEY = 'medsim:lang';

export function normLang(v: unknown): Lang {
  return typeof v === 'string' && (LANGS as readonly string[]).includes(v) ? (v as Lang) : 'en';
}

export function readLang(): Lang {
  try {
    if (typeof window === 'undefined') return 'en';
    return normLang(window.localStorage.getItem(LANG_KEY));
  } catch {
    return 'en';
  }
}

export function writeLang(lang: Lang) {
  try {
    window.localStorage.setItem(LANG_KEY, lang);
  } catch {
    /* private mode, non-fatal */
  }
}

/** Language of a spoken line, by script. Lets the nurse voice match the text
 *  actually shown (local rule alerts stay English even in a Hindi session). */
export function langOfText(text: string, session?: Lang): Lang {
  if (/[\u0C80-\u0CFF]/.test(text)) return 'kn';
  if (/[\u0B80-\u0BFF]/.test(text)) return 'ta';
  if (/[\u0C00-\u0C7F]/.test(text)) return 'te';
  if (/[\u0980-\u09FF]/.test(text)) return 'bn';
  // Devanagari covers Hindi and Marathi: the Marathi-only letter \u0933 or a Marathi session decides.
  if (/[\u0900-\u097F]/.test(text)) return /\u0933/.test(text) || session === 'mr' ? 'mr' : 'hi';
  return 'en';
}
