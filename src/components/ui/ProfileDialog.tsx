import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { closeProfileDialog, DEFAULT_RESULTS_TO, getProfile, saveProfile, useProfileDialog, type Gender } from '../../game/profile';
import { isTelegramDest } from '../../agents/resultSend';

const GENDERS: { value: Gender; label: string; hint: string }[] = [
  { value: 'female', label: 'Female', hint: 'You play a woman doctor' },
  { value: 'male', label: 'Male', hint: 'You play a man doctor' },
  { value: 'other', label: 'Prefer not to say', hint: 'Default doctor model' },
];

/** First-visit profile card shown before the hospital opens. Local only. */
export function ProfileDialog() {
  const { open } = useProfileDialog();
  if (!open) return null;
  return <ProfileForm />;
}

function ProfileForm() {
  const existing = getProfile();
  const [name, setName] = useState(existing?.name ?? '');
  const [university, setUniversity] = useState(existing?.university ?? '');
  const [gender, setGender] = useState<Gender | ''>(existing?.gender ?? '');
  const [resultsTo, setResultsTo] = useState(existing?.resultsTo ?? DEFAULT_RESULTS_TO);
  const [tried, setTried] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    nameRef.current?.focus();
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') closeProfileDialog(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const resultsOk = resultsTo.trim() === '' || isTelegramDest(resultsTo);
  const valid = name.trim().length >= 2 && university.trim().length >= 2 && gender !== '' && resultsOk;

  const submit = () => {
    setTried(true);
    if (!valid) return;
    saveProfile({ name, university, gender: gender as Gender, resultsTo });
    closeProfileDialog(true);
  };

  return (
    <div className="modal-layer profile-layer" role="dialog" aria-modal="true" aria-labelledby="profile-title" onMouseDown={(e) => { if (e.target === e.currentTarget) closeProfileDialog(false); }}>
      <form
        className="modal profile-card"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
        noValidate
      >
        <p className="kicker">Before your shift</p>
        <h2 id="profile-title" className="modal-title">Sign in to the ward</h2>
        <p className="modal-body">Your name goes on your badge and report cards. Saved only in this browser.</p>

        <label className="profile-field">
          <span className="field-label">Full name</span>
          <input
            ref={nameRef}
            className="input"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Ananya Rao"
            autoComplete="name"
            maxLength={60}
            aria-invalid={tried && name.trim().length < 2}
          />
          {tried && name.trim().length < 2 && <span className="profile-err">Enter your name</span>}
        </label>

        <label className="profile-field">
          <span className="field-label">University</span>
          <input
            className="input"
            value={university}
            onChange={(e) => setUniversity(e.target.value)}
            placeholder="Rajiv Gandhi University of Health Sciences"
            autoComplete="organization"
            maxLength={80}
            aria-invalid={tried && university.trim().length < 2}
          />
          {tried && university.trim().length < 2 && <span className="profile-err">Enter your university</span>}
        </label>

        <div className="profile-field">
          <span className="field-label" id="gender-label">Gender</span>
          <Select value={gender} onChange={setGender} labelledBy="gender-label" invalid={tried && gender === ''} />
          {tried && gender === '' && <span className="profile-err">Choose one</span>}
        </div>

        <label className="profile-field">
          <span className="field-label">Telegram for my results (optional)</span>
          <input
            className="input"
            value={resultsTo}
            onChange={(e) => setResultsTo(e.target.value)}
            placeholder="telegram, @username or tg:chat id"
            autoComplete="off"
            spellCheck={false}
            maxLength={40}
            aria-invalid={tried && !resultsOk}
            aria-describedby="results-to-hint"
          />
          {tried && !resultsOk ? (
            <span className="profile-err">Use telegram, @username or tg:chat id, or leave it empty</span>
          ) : (
            <span className="profile-hint" id="results-to-hint">Your debrief, report card PDF and a voice summary go here after each case. Press Start on the MedSim bot first. Leave empty to turn it off.</span>
          )}
        </label>

        <button type="submit" className="btn btn-primary btn-lg btn-block">
          Enter
        </button>
      </form>
    </div>
  );
}

/** Styled single-select listbox (native <option> menus can't be themed). */
function Select({
  value,
  onChange,
  labelledBy,
  invalid,
}: {
  value: Gender | '';
  onChange: (g: Gender) => void;
  labelledBy: string;
  invalid: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(Math.max(0, GENDERS.findIndex((g) => g.value === value)));
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const current = GENDERS.find((g) => g.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (i: number) => {
    onChange(GENDERS[i].value);
    setActive(i);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + d + GENDERS.length) % GENDERS.length);
    } else if ((e.key === 'Enter' || e.key === ' ') && open) {
      e.preventDefault();
      pick(active);
    } else if (e.key === ' ') {
      e.preventDefault();
      setOpen(true);
    } else if (e.key === 'Escape' && open) {
      e.stopPropagation();
      e.nativeEvent.stopImmediatePropagation();
      setOpen(false);
    }
  };

  return (
    <div className="select" ref={root} data-open={open || undefined}>
      <button
        type="button"
        className="input select-trigger"
        role="combobox"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listId}
        aria-labelledby={labelledBy}
        aria-invalid={invalid}
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
      >
        <span className={current ? '' : 'select-placeholder'}>{current?.label ?? 'Select gender'}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="select-chev">
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </button>
      {open && (
        <ul className="select-menu" role="listbox" id={listId} aria-labelledby={labelledBy}>
          {GENDERS.map((g, i) => (
            <li
              key={g.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={g.value === value}
              className="select-option"
              data-active={i === active || undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span>{g.label}</span>
              <span className="select-hint">{g.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
