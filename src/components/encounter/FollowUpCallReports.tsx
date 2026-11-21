import { useCallback, useEffect, useState } from 'react';
import {
  absoluteCallUrl,
  callActionChips,
  callApi,
  followupCallsForCase,
  subscribeFollowupCalls,
  type CallRecord,
  type StoredCallLink,
} from '../../voice/followupCall';
import '../../styles/followup.css';

const POLL_MS = 20_000;

const CHIP_CLASS = { flag: 'tag--critical', reschedule: 'tag--ok', symptom: '' } as const;

const ADHERENCE_LABEL: Record<string, string> = {
  good: 'Taking meds',
  partial: 'Missing doses',
  poor: 'Not taking meds',
  unknown: 'Adherence unknown',
};

function clock(ms: number | null | undefined): string {
  if (!ms) return '';
  return new Date(ms).toLocaleString([], { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
}

/** Plan tab: Asha's follow-up call reports for this case, one block per call link. */
export function FollowUpCallReports({ caseId }: { caseId: string }) {
  const [links, setLinks] = useState<StoredCallLink[]>(() => followupCallsForCase(caseId));
  useEffect(() => {
    setLinks(followupCallsForCase(caseId));
    return subscribeFollowupCalls(() => setLinks(followupCallsForCase(caseId)));
  }, [caseId]);

  if (links.length === 0) return null;
  return (
    <section className="fu-reports" aria-label="Follow-up call reports">
      <h3 className="block-title">Follow-up call reports</h3>
      {links.slice(0, 3).map((l) => <CallLinkReports key={l.token} link={l} />)}
    </section>
  );
}

function CallLinkReports({ link }: { link: StoredCallLink }) {
  const [calls, setCalls] = useState<CallRecord[] | null>(null);
  const [left, setLeft] = useState<number | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const url = absoluteCallUrl(link);

  const load = useCallback(async () => {
    try {
      const d = await callApi.summaries(link.token);
      setCalls(d.calls);
      setLeft(d.callsLeftToday);
      setErr(null);
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    }
  }, [link.token]);

  useEffect(() => {
    void load();
    const t = window.setInterval(() => void load(), POLL_MS);
    return () => window.clearInterval(t);
  }, [load]);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch { /* clipboard blocked */ }
  };

  // A call shows once it has a summary, or as soon as Asha acted in it (live red flag).
  const done = (calls ?? []).filter((c) => c.summary || callActionChips(c.actions).length > 0).slice().reverse();
  return (
    <div className="fu-link">
      <div className="fu-link-actions">
        <a className="btn btn-secondary btn-sm" href={url} target="_blank" rel="noopener noreferrer">Open call link</a>
        <button type="button" className="btn btn-ghost btn-sm" onClick={copy}>{copied ? 'Copied' : 'Copy link'}</button>
        <button type="button" className="btn btn-ghost btn-sm" onClick={() => void load()}>Refresh</button>
      </div>
      {err ? (
        <p className="muted-note">{/expired|unknown|not found/i.test(err) ? 'Call link expired (the backend restarted or 30 days passed).' : `Could not load reports: ${err}`}</p>
      ) : calls === null ? (
        <p className="muted-note">Loading call reports...</p>
      ) : done.length === 0 ? (
        <p className="muted-note">
          No call yet. Open the link on the patient's phone to talk to Asha{left !== null ? ` (${left} of 3 calls left today)` : ''}.
        </p>
      ) : (
        <ul className="fu-list">
          {done.map((c) => {
            const s = c.summary;
            const chips = callActionChips(c.actions);
            const flagged = (s?.redFlags.length ?? 0) > 0 || chips.some((x) => x.kind === 'flag');
            return (
              <li key={c.callId} className={`fu-report${flagged ? ' fu-report--flag' : ''}`}>
                <div className="fu-report-head">
                  <span className="fu-when">{clock(c.startedAt)}</span>
                  {s ? (
                    <span className={`tag ${s.adherence === 'good' ? 'tag--ok' : s.adherence === 'unknown' ? '' : 'tag--urgent'}`}>
                      {ADHERENCE_LABEL[s.adherence] ?? s.adherence}
                    </span>
                  ) : (
                    <span className="tag">{c.endedAt ? 'Summary pending' : 'Call in progress'}</span>
                  )}
                  {s?.followUpNeeded && <span className="tag tag--urgent">Needs follow-up</span>}
                </div>
                {chips.length > 0 && (
                  <ul className="fu-chips" aria-label="What Asha did during the call">
                    {chips.map((x, i) => (
                      <li key={i} className={`tag fu-chip ${CHIP_CLASS[x.kind]}`} title={x.title}>{x.label}</li>
                    ))}
                  </ul>
                )}
                {s && s.redFlags.length > 0 && (
                  <p className="fu-flags"><span className="tag tag--critical">Red flag</span> {s.redFlags.join(', ')}</p>
                )}
                {s && <p className="fu-summary">{s.summary}</p>}
                {s && (
                  <dl className="fu-meta">
                    <dt>Side effects</dt><dd>{s.sideEffects.length ? s.sideEffects.join(', ') : 'None reported'}</dd>
                    <dt>Mood</dt><dd>{s.patientMood}</dd>
                  </dl>
                )}
                {c.transcript && c.transcript.length > 0 && (
                  <details className="fu-transcript">
                    <summary>Transcript</summary>
                    {c.transcript.map((m, i) => (
                      <p key={i}><b>{m.role === 'assistant' ? 'Asha' : 'Patient'}:</b> {m.content}</p>
                    ))}
                  </details>
                )}
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}
