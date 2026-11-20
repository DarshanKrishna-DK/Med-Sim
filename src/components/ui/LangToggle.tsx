import { store, useStore } from '../../game/store';
import { LANGS, LANG_LABEL, LANG_NAME, type Lang } from '../../game/lang';

/** Session language switch for the voice agents (patient, nurse, coach,
 *  teacher). The UI stays English; changing it reconnects a live call. */
export function LangToggle({ className = '', light = false }: { className?: string; light?: boolean }) {
  const lang = useStore((s) => s.lang);
  return (
    <div
      className={`lang-toggle${light ? ' lang-toggle--light' : ''} ${className}`.trim()}
      role="radiogroup"
      aria-label="Voice language"
      title="Language the patient, nurse and teacher speak. Changing it reconnects a live call."
    >
      {LANGS.map((l: Lang) => (
        <button
          key={l}
          type="button"
          role="radio"
          aria-checked={lang === l}
          aria-label={LANG_NAME[l]}
          onClick={(e) => {
            store.setLang(l);
            (e.currentTarget as HTMLButtonElement).blur();
          }}
        >
          {LANG_LABEL[l]}
        </button>
      ))}
    </div>
  );
}
