import { useEffect, useId, useRef, useState, useSyncExternalStore, type KeyboardEvent } from 'react';
import {
  addContact,
  getContacts,
  RELATIONS,
  removeContact,
  subscribeContacts,
  validateContact,
  type Relation,
} from '../../observer/contacts';
import { callObserver, clearObserverCall, isCallBusy, useObserverCall, type CallStatus } from '../../observer/observerCall';

const STATUS_LABEL: Record<CallStatus, string> = {
  idle: '',
  inviting: 'Creating the observer link',
  placing: 'Sending the link',
  preparing: 'Sending the link',
  queued: 'Dialling',
  ringing: 'Ringing',
  'in-progress': 'On the call with Asha',
  completed: 'Call ended',
  busy: 'Line busy',
  'no-answer': 'No answer',
  failed: 'Call failed',
  canceled: 'Call cancelled',
  error: 'Could not call',
};

const relationLabel = (r: Relation) => RELATIONS.find((x) => x.value === r)?.label ?? r;
const firstName = (n: string) => n.trim().split(/\s+/)[0] ?? n;

/** Contact book + "Call & invite" inside the observer popover. */
export function ObserverContacts({
  voiceLive,
  adding,
  setAdding,
  prefill,
}: {
  voiceLive: boolean;
  adding: boolean;
  setAdding: (v: boolean) => void;
  prefill: string;
}) {
  const contacts = useSyncExternalStore(subscribeContacts, getContacts);
  const call = useObserverCall();
  const busy = isCallBusy(call.status);

  return (
    <section className="obs-contacts" aria-label="Call an observer">
      <div className="obs-sec-head">
        <p className="obs-sec-title">Call an observer</p>
        {!adding && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={() => setAdding(true)}>
            Add contact
          </button>
        )}
      </div>
      <p className="obs-pop-hint">Or say “Asha, invite {contacts[0] ? firstName(contacts[0].name) : 'Darshan'} to observe”.</p>

      {call.status !== 'idle' && <CallPanel />}

      {contacts.length > 0 ? (
        <ul className="obs-contact-list">
          {contacts.map((c) => (
            <li key={c.id} className="obs-contact">
              <div className="obs-contact-id">
                <span className="obs-contact-name">{c.name}</span>
                <span className="obs-contact-meta">
                  <span className="chip">{relationLabel(c.relation)}</span>
                  {c.telegram && <span className="chip">Telegram</span>}
                </span>
              </div>
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={!voiceLive || busy}
                title={voiceLive ? undefined : 'Start voice first (press T)'}
                onClick={() => void callObserver(c)}
              >
                Call &amp; invite
              </button>
              <button type="button" className="obs-contact-del" aria-label={`Remove ${c.name}`} onClick={() => removeContact(c.id)}>
                <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                  <path d="m2.5 2.5 7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
                </svg>
              </button>
            </li>
          ))}
        </ul>
      ) : (
        !adding && <p className="obs-share-meta">No contacts yet. Add a teacher, senior or friend and Asha will phone them with the link.</p>
      )}

      {adding && <AddContactForm key={prefill} prefill={prefill} onDone={() => setAdding(false)} />}
    </section>
  );
}

function CallPanel() {
  const call = useObserverCall();
  const busy = isCallBusy(call.status);
  const who = firstName(call.contactName || 'Observer');
  const lines = call.transcript.slice(-6);
  return (
    <div className="obs-call" aria-live="polite">
      <div className="obs-call-head">
        <span className={`obs-call-dot ${busy ? 'is-live' : ''}`} aria-hidden="true" />
        <span className="obs-call-status">
          {STATUS_LABEL[call.status]}
          {call.contactName ? `: ${call.contactName}` : ''}
        </span>
        {!busy && (
          <button type="button" className="obs-contact-del" aria-label="Clear call status" onClick={clearObserverCall}>
            <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
              <path d="m2.5 2.5 7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
            </svg>
          </button>
        )}
      </div>
      {call.deliveryOk && call.deliveryChannel && (
        <p className="obs-share-meta">Link sent on {call.deliveryChannel === 'sms' ? 'SMS' : call.deliveryChannel[0].toUpperCase() + call.deliveryChannel.slice(1)}.</p>
      )}
      {call.error && <p className="obs-pop-warn">{call.error}</p>}
      {lines.length > 0 && (
        <ol className="obs-call-lines">
          {lines.map((l, i) => (
            <li key={`${l.at}-${i}`} className={`obs-call-line is-${l.who}`}>
              <span className="obs-call-who">{l.who === 'observer' ? `${who} asked:` : 'Asha:'}</span> {l.text}
            </li>
          ))}
        </ol>
      )}
      {call.messages.map((m) => (
        <p key={m.id} className="obs-call-msg">
          <span className="obs-call-who">Message from {firstName(m.from)}:</span> {m.text}
        </p>
      ))}
    </div>
  );
}

function AddContactForm({ prefill, onDone }: { prefill: string; onDone: () => void }) {
  const [name, setName] = useState(prefill);
  const [relation, setRelation] = useState<Relation>('teacher');
  const [phone, setPhone] = useState('');
  const [telegram, setTelegram] = useState('');
  const [tried, setTried] = useState(false);
  const first = useRef<HTMLInputElement>(null);
  const phoneRef = useRef<HTMLInputElement>(null);
  const relId = useId();
  const draft = { name, relation, phone, telegram };
  const errors = validateContact(draft);

  useEffect(() => {
    (prefill ? phoneRef : first).current?.focus();
  }, [prefill]);

  const submit = () => {
    setTried(true);
    if (Object.keys(errors).length) return;
    if (addContact(draft)) onDone();
  };

  return (
    <form
      className="obs-add"
      noValidate
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <label className="obs-field">
        <span className="field-label">Name</span>
        <input ref={first} className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="Darshan Kumar"
          maxLength={60} autoComplete="off" aria-invalid={tried && !!errors.name} />
        {tried && errors.name && <span className="profile-err">{errors.name}</span>}
      </label>
      <div className="obs-field">
        <span className="field-label" id={relId}>Relation</span>
        <RelationSelect value={relation} onChange={setRelation} labelledBy={relId} />
      </div>
      <label className="obs-field">
        <span className="field-label">Phone</span>
        <input ref={phoneRef} className="input" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="+91 98765 43210"
          inputMode="tel" autoComplete="off" maxLength={20} aria-invalid={tried && !!errors.phone} />
        {tried && errors.phone && <span className="profile-err">{errors.phone}</span>}
      </label>
      <label className="obs-field">
        <span className="field-label">Telegram (optional)</span>
        <input className="input" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="@username"
          autoComplete="off" maxLength={40} aria-invalid={tried && !!errors.telegram} />
        {tried && errors.telegram && <span className="profile-err">{errors.telegram}</span>}
      </label>
      <div className="obs-add-actions">
        <button type="button" className="btn btn-ghost btn-sm" onClick={onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary btn-sm">
          Save contact
        </button>
      </div>
    </form>
  );
}

/** Same themed listbox as the profile dialog's gender select. */
function RelationSelect({ value, onChange, labelledBy }: { value: Relation; onChange: (r: Relation) => void; labelledBy: string }) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(Math.max(0, RELATIONS.findIndex((r) => r.value === value)));
  const listId = useId();
  const root = useRef<HTMLDivElement>(null);
  const current = RELATIONS.find((r) => r.value === value);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  const pick = (i: number) => {
    onChange(RELATIONS[i].value);
    setActive(i);
    setOpen(false);
  };

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) return setOpen(true);
      const d = e.key === 'ArrowDown' ? 1 : -1;
      setActive((a) => (a + d + RELATIONS.length) % RELATIONS.length);
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
        aria-activedescendant={open ? `${listId}-${active}` : undefined}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKey}
      >
        <span>{current?.label ?? 'Relation'}</span>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true" className="select-chev">
          <path d="M2 4l4 4 4-4" fill="none" stroke="currentColor" strokeWidth="1.8" />
        </svg>
      </button>
      {open && (
        <ul className="select-menu" role="listbox" id={listId} aria-labelledby={labelledBy}>
          {RELATIONS.map((r, i) => (
            <li
              key={r.value}
              id={`${listId}-${i}`}
              role="option"
              aria-selected={r.value === value}
              className="select-option"
              data-active={i === active || undefined}
              onMouseEnter={() => setActive(i)}
              onMouseDown={(e) => e.preventDefault()}
              onClick={() => pick(i)}
            >
              <span>{r.label}</span>
              <span className="select-hint">{r.hint}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
