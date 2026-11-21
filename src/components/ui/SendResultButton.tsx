import { useEffect, useSyncExternalStore } from 'react';
import {
  autoSendResultOnce,
  resultDestination,
  resultStatus,
  sendResult,
  subscribeResultStatus,
  type ResultPayload,
} from '../../agents/resultSend';
import { useProfile } from '../../game/profile';
import { usePatientContact } from '../../game/patientContact';

/** "Send result to Telegram" + a status chip. Auto-sends once per encounter key when
 *  a destination is set (profile field, else a Telegram-style Plan-tab contact). */
export function SendResultButton({ sendKey, payload, auto = true }: { sendKey: string; payload: ResultPayload; auto?: boolean }) {
  const profile = useProfile();
  const contact = usePatientContact();
  const dest = resultDestination(profile?.resultsTo, contact);
  const status = useSyncExternalStore(subscribeResultStatus, () => resultStatus(sendKey));

  useEffect(() => {
    if (auto && dest) autoSendResultOnce(sendKey, { ...payload, to: dest });
    // payload is rebuilt each render; the key pins one send per encounter.
  }, [auto, dest, sendKey]);

  const busy = status.state === 'sending';
  return (
    <div className="result-send no-print" aria-live="polite">
      <button
        type="button"
        className="btn btn-secondary"
        disabled={busy}
        onClick={() => void sendResult(sendKey, { ...payload, to: dest || 'telegram' })}
      >
        {busy ? 'Sending to Telegram...' : status.state === 'sent' ? 'Send again to Telegram' : 'Send result to Telegram'}
      </button>
      {status.state === 'sent' && (
        <span className="tag tag--ok">Sent to Telegram{status.partial ? ` (${status.partial})` : ''}</span>
      )}
      {status.state === 'error' && <span className="tag tag--critical" title={status.error}>Not sent: {status.error}</span>}
    </div>
  );
}
