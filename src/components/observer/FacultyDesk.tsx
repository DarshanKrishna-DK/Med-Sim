import { useCallback, useEffect, useRef, useState } from 'react';

/** What the backend shows a faculty member invited by phone (hub.guest_view). */
interface GuestView {
  name: string;
  doctor: string;
  open: boolean;
  holds: { ref: string; medication: string; dose: string; duration: string; reason: string; asked: boolean }[];
  given: { ref: string; medication: string; dose: string; overridden: boolean }[];
  waitingForDoctor: boolean;
  inbox: { id: number; from: 'nurse' | 'doctor'; text: string; at: string }[];
}

const POLL_MS = 2500;

async function detail(r: Response): Promise<string> {
  try {
    const d = ((await r.json()) as { detail?: unknown }).detail;
    return typeof d === 'string' ? d : `Error ${r.status}`;
  } catch {
    return `Error ${r.status}`;
  }
}

/** Faculty invited by phone: approve or deny a drug the pharmacy holds, and talk to
 *  the doctor through Asha. Every decision is recorded in the BAND room by Asha.
 *  The token came only in the text message Asha sent to this phone. */
export function FacultyDesk({ token }: { token: string }) {
  const [view, setView] = useState<GuestView | null>(null);
  const [gone, setGone] = useState('');
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [text, setText] = useState('');
  const base = `/agent/room/guest/${encodeURIComponent(token)}`;
  const box = useRef<HTMLOListElement>(null);

  const load = useCallback(async () => {
    try {
      const r = await fetch(base);
      if (r.status === 404) {
        setGone(await detail(r));
        return false;
      }
      if (r.ok) setView((await r.json()) as GuestView);
    } catch {
      /* offline for a moment: keep the last view */
    }
    return true;
  }, [base]);

  useEffect(() => {
    let live = true;
    let timer = 0;
    const tick = async () => {
      if (!live) return;
      const more = await load();
      if (live && more) timer = window.setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      live = false;
      window.clearTimeout(timer);
    };
  }, [load]);

  useEffect(() => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
  }, [view?.inbox.length]);

  const act = async (action: 'approve' | 'deny' | 'say', ref = '', words = '') => {
    setBusy(action + ref);
    setError('');
    try {
      const r = await fetch(`${base}/act`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, ref, text: words }),
      });
      if (!r.ok) {
        setError(await detail(r));
        return false;
      }
      setView((await r.json()) as GuestView);
      return true;
    } catch {
      setError('No connection. Try again.');
      return false;
    } finally {
      setBusy('');
    }
  };

  if (gone) {
    return (
      <div className="obs-panel obs-desk">
        <p className="field-label">Faculty decisions</p>
        <p className="obs-empty">{gone}</p>
      </div>
    );
  }
  if (!view) {
    return (
      <div className="obs-panel obs-desk">
        <p className="field-label">Faculty decisions</p>
        <p className="obs-empty">Connecting to the Agent Room...</p>
      </div>
    );
  }

  return (
    <div className="obs-panel obs-desk">
      <p className="field-label">Faculty decisions</p>
      <p className="obs-hint">
        You are in the Agent Room as faculty. Asha records each decision in the BAND room. Only you can release a drug the
        pharmacy holds.
      </p>

      {view.holds.length === 0 ? (
        <p className="obs-empty">{view.open ? 'Nothing is on hold. If the pharmacy holds a drug, it appears here.' : 'The consultation has ended.'}</p>
      ) : (
        <ul className="obs-holds">
          {view.holds.map((h) => (
            <li key={h.ref} className={`obs-hold ${h.asked ? 'is-asked' : ''}`}>
              <p className="obs-hold-drug">
                <b>{h.medication}</b> {h.dose}
                {h.duration ? `, ${h.duration}` : ''}
              </p>
              <p className="obs-hold-why">Held: {h.reason || 'no reason given'}</p>
              {h.asked && <p className="obs-hold-ask">The doctor asks you to override.</p>}
              <div className="obs-hold-actions">
                <button type="button" className="btn btn-primary btn-sm" disabled={!!busy || !view.open} onClick={() => void act('approve', h.ref)}>
                  {busy === 'approve' + h.ref ? 'Approving...' : 'Approve'}
                </button>
                <button type="button" className="btn btn-secondary btn-sm" disabled={!!busy || !view.open} onClick={() => void act('deny', h.ref)}>
                  {busy === 'deny' + h.ref ? 'Saving...' : 'Deny'}
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}

      {view.given.some((g) => g.overridden) && (
        <p className="obs-hint">
          Released by faculty: {view.given.filter((g) => g.overridden).map((g) => g.medication).join(', ')}.
        </p>
      )}

      {view.inbox.length > 0 && (
        <ol className="obs-inbox" ref={box} aria-live="polite">
          {view.inbox.map((m) => (
            <li key={m.id} className={`obs-inbox-${m.from}`}>
              <b>{m.from === 'doctor' ? view.doctor || 'Doctor' : 'Asha'}</b> {m.text}
            </li>
          ))}
        </ol>
      )}

      <form
        className="obs-desk-say"
        onSubmit={(e) => {
          e.preventDefault();
          const t = text.trim();
          if (t) void act('say', '', t).then((ok) => ok && setText(''));
        }}
      >
        <label className="sr-only" htmlFor="obs-desk-text">Message to the doctor through Asha</label>
        <input
          id="obs-desk-text"
          className="input"
          value={text}
          maxLength={800}
          placeholder={view.waitingForDoctor ? 'Waiting for the doctor to answer...' : 'Ask the doctor something, or say approve or deny'}
          onChange={(e) => setText(e.target.value)}
          disabled={!view.open}
        />
        <button type="submit" className="btn btn-secondary btn-sm" disabled={!!busy || !text.trim() || !view.open}>
          Send
        </button>
      </form>
      {error && <p className="obs-error" role="alert">{error}</p>}
    </div>
  );
}
