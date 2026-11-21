import { useEffect, useMemo, useRef, useState } from 'react';
import { ObserverContacts } from './ObserverContacts';
import { usePopoverRequest } from '../../observer/observerCall';
import { POLYCLINIC_BED_INDEX } from '../../game/store';
import { getExistingConversation } from '../../voice/conversationStore';
import { inviteObserver, stopObserverLink, useObserverLink } from '../../observer/studentLink';
import { qrMatrix, qrPath } from '../../observer/qr';
import '../../styles/observer.css';

/** "Invite observer": a small secondary control pinned bottom-left of the
 *  encounter (practice and OSCE). Mints a faculty link for the live call. */
export function ObserverInvite({ caseId, voiceStatus }: { caseId: string | null; voiceStatus: string }) {
  const voiceLive = ['ready', 'listening', 'thinking', 'speaking'].includes(voiceStatus);
  const link = useObserverLink();
  const [open, setOpen] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [adding, setAdding] = useState(false);
  const [prefill, setPrefill] = useState('');
  const popReq = usePopoverRequest();

  // "Invite Priya" with no saved Priya: Asha opens the add-contact form, name filled in.
  useEffect(() => {
    if (!popReq.seq) return;
    setOpen(true);
    setAdding(true);
    setPrefill(popReq.prefillName);
  }, [popReq]);

  const currentChannel = voiceLive ? getExistingConversation(POLYCLINIC_BED_INDEX)?.getSessionInfo()?.channel ?? '' : '';
  const sharingThisCase = link.status === 'live' && link.caseId === caseId;
  const stale = sharingThisCase && !!currentChannel && currentChannel !== link.channel;
  const watching = sharingThisCase ? link.observers.length : 0;

  useEffect(() => {
    if (!open) return;
    const onDown = (e: PointerEvent) => {
      if (!wrap.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopImmediatePropagation();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey, true);
    return () => {
      document.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey, true);
    };
  }, [open]);

  if (!caseId) return null;

  return (
    <div className="obs-invite" ref={wrap}>
      {open && (
        <div className="obs-pop" role="dialog" aria-label="Invite a faculty observer">
          <p className="obs-pop-title">Faculty observer</p>
          <p className="obs-pop-body">
            A tutor can listen to this consultation, follow your chart, send you quiet notes and mark you. They join
            as a silent listener: no microphone, nobody hears them.
          </p>
          {sharingThisCase && !stale ? (
            <SharePanel url={link.inviteUrl} expiresAt={link.expiresAt} watching={watching} />
          ) : (
            <>
              {stale && <p className="obs-pop-warn">Voice reconnected, so the old link points at the previous call. Create a new one.</p>}
              {!voiceLive && <p className="obs-pop-warn">Start voice first (press T): the observer listens to the live call.</p>}
              {link.status === 'error' && link.error && <p className="obs-pop-warn">{link.error}</p>}
              <button
                type="button"
                className="btn btn-primary btn-sm btn-block"
                disabled={!voiceLive || link.status === 'creating'}
                onClick={() => void inviteObserver()}
              >
                {link.status === 'creating' ? 'Creating link...' : 'Create observer link'}
              </button>
            </>
          )}
          {sharingThisCase && (
            <button type="button" className="btn btn-ghost btn-sm btn-block" onClick={stopObserverLink}>
              Stop sharing
            </button>
          )}
          <ObserverContacts
            voiceLive={voiceLive}
            adding={adding}
            setAdding={setAdding}
            prefill={prefill}
          />
        </div>
      )}
      <button
        ref={trigger}
        type="button"
        className={`obs-trigger ${open ? 'is-active' : ''}`}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((o) => !o)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5">
          <path d="M1.5 8s2.4-4.5 6.5-4.5S14.5 8 14.5 8 12.1 12.5 8 12.5 1.5 8 1.5 8Z" />
          <circle cx="8" cy="8" r="2" />
        </svg>
        {sharingThisCase ? (watching ? `${watching} observing` : 'Observer link live') : 'Invite observer'}
        {watching > 0 && <span className="obs-live-dot" aria-hidden="true" />}
      </button>
    </div>
  );
}

function SharePanel({ url, expiresAt, watching }: { url: string; expiresAt: number; watching: number }) {
  const [copied, setCopied] = useState(false);
  const qr = useMemo(() => {
    try {
      return qrPath(qrMatrix(url));
    } catch {
      return null;
    }
  }, [url]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1800);
    } catch {
      /* clipboard blocked: the field is selectable */
    }
  };

  return (
    <div className="obs-share">
      <div className="obs-share-row">
        <input className="input obs-url" readOnly value={url} aria-label="Observer link" onFocus={(e) => e.currentTarget.select()} />
        <button type="button" className="btn btn-secondary btn-sm" onClick={() => void copy()}>
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      {qr && (
        <svg className="obs-qr" viewBox={`0 0 ${qr.size} ${qr.size}`} role="img" aria-label="QR code of the observer link" shapeRendering="crispEdges">
          <rect width={qr.size} height={qr.size} fill="#f3f1e2" />
          <path d={qr.d} fill="#0b1f4b" />
        </svg>
      )}
      <p className="obs-share-meta">
        {watching ? `${watching} observer${watching === 1 ? '' : 's'} connected.` : 'Waiting for the observer to open the link.'}{' '}
        Expires {new Date(expiresAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}.
      </p>
    </div>
  );
}
