// Session language for voice agents (patient, nurse, coach, teacher).
// The UI itself stays English; only spoken/displayed agent lines follow this.

export type Lang = 'en' | 'hi' | 'kn';

export const LANGS: readonly Lang[] = ['en', 'hi', 'kn'];

export const LANG_LOCALE: Record<Lang, string> = { en: 'en-IN', hi: 'hi-IN', kn: 'kn-IN' };

/** Short labels for the toggle (native script) and full names for tooltips. */
export const LANG_LABEL: Record<Lang, string> = { en: 'EN', hi: 'हिं', kn: 'ಕನ್ನಡ' };
export const LANG_NAME: Record<Lang, string> = { en: 'English', hi: 'Hindi', kn: 'Kannada' };

export const LANG_KEY = 'medsim:lang';

export function normLang(v: unknown): Lang {
  return v === 'hi' || v === 'kn' ? v : 'en';
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
export function langOfText(text: string): Lang {
  if (/[\u0C80-\u0CFF]/.test(text)) return 'kn';
  if (/[\u0900-\u097F]/.test(text)) return 'hi';
  return 'en';
}
