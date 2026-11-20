import { store, useStore } from '../../game/store';
import { LANGS, LANG_LABEL, LANG_NAME, QUICK_LANGS, type Lang } from '../../game/lang';

/** Session language switch for the voice agents (patient, nurse, coach,
 *  teacher). The UI stays English; changing it reconnects a live call.
 *  EN / हिं / ಕನ್ನಡ are quick chips; the other Indian languages sit in a
 *  compact "More" dropdown once there are more than three languages. */
export function LangToggle({ className = '', light = false }: { className?: string; light?: boolean }) {
  const lang = useStore((s) => s.lang);
  const more = LANGS.filter((l) => !QUICK_LANGS.includes(l));
  const chips = more.length > 0 ? QUICK_LANGS : LANGS;
  const moreActive = more.includes(lang);
  return (
    <div
      className={`lang-toggle${light ? ' lang-toggle--light' : ''} ${className}`.trim()}
      role="radiogroup"
      aria-label="Voice language"
      title="Language the patient, nurse and teacher speak. Changing it reconnects a live call."
    >
      {chips.map((l: Lang) => (
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
      {more.length > 0 && (
        <select
          className={`lang-more${moreActive ? ' is-active' : ''}`}
          aria-label="More languages"
          value={moreActive ? lang : ''}
          onChange={(e) => {
            store.setLang(e.target.value as Lang);
            e.currentTarget.blur();
          }}
        >
          <option value="" disabled>
            More
          </option>
          {more.map((l) => (
            <option key={l} value={l}>
              {LANG_LABEL[l]} {LANG_NAME[l]}
            </option>
          ))}
        </select>
      )}
    </div>
  );
}
