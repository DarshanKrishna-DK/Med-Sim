import { useState } from 'react';
import type { AcademicRoom } from '../../room/academic';
import { finalScore, isSigned, nextStep, stampOf, statusLine, type AuditRow } from '../../room/academicCore';

function Row({ a }: { a: AuditRow }) {
  const at = Date.parse(a.at);
  return (
    <li className={a.human ? 'is-human' : undefined}>
      <time dateTime={a.at}>{Number.isFinite(at) ? new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : ''}</time>
      <span>
        <b>{a.who}</b> {a.what}
        {a.comment && <q>{a.comment}</q>}
      </span>
    </li>
  );
}

/** The foot of a mark sheet: the examiner's note, the signature line and the
 *  stamp. The stamp only ever says Signed after a person signed in BAND. */
export function SignOffCard({ room }: { room: AcademicRoom }) {
  const { side, mode, busy, error } = room;
  const [note, setNote] = useState('');

  if (mode === 'off') return <p className="signoff-plain">Not signed: marked by the AI examiner only.</p>;
  if (!side) {
    if (mode === 'checking') return null;
    return (
      <section className="signoff" aria-label="Faculty signature">
        <div className="signoff-sheet">
          <p className="signoff-state">No faculty member has signed this result.</p>
          <div className="signoff-actions">
            <button type="button" className="btn btn-secondary btn-sm" onClick={room.open} disabled={mode === 'open'}>
              {mode === 'open' ? 'Opening the room' : 'Send to the examiner'}
            </button>
          </div>
          {error && <p className="signoff-error" role="alert">{error}</p>}
        </div>
      </section>
    );
  }

  const stamp = stampOf(side);
  const step = nextStep(side);
  const signed = isSigned(side);
  const asking = busy || !!side.inviting;
  return (
    <section className="signoff" aria-labelledby="signoff-title">
      <h2 id="signoff-title" className="section-title">Faculty signature</h2>
      <div className="signoff-sheet">
        <div className={`signoff-stamp signoff-stamp--${stamp.tone}`} aria-hidden="true" key={stamp.word}>
          {stamp.word}
        </div>

        <div className="signoff-note">
          <p className="signoff-who">Examiner Kulkarni</p>
          <p>{side.examinerComment || (side.status === 'unavailable' ? 'No note yet.' : 'Reading the marks.')}</p>
        </div>

        <div className="signoff-line" role="status" aria-live="polite">
          <span className={`signoff-name${signed ? ' is-signed' : ''}`}>{signed ? side.signedBy : ' '}</span>
          <span className="signoff-state">{statusLine(side)}</span>
        </div>

        {side.status === 'revised' && (
          <p className="signoff-score">
            <b>{finalScore(side)}</b>
            <small>/100</small>
            <span>
              the marking gave <s>{side.total}</s>
            </span>
          </p>
        )}
        {side.facultyComment && (signed || side.status === 'sent_back') && (
          <blockquote className="signoff-comment">
            <p>{side.facultyComment}</p>
            <footer>{side.decidedBy || side.signedBy}</footer>
          </blockquote>
        )}

        {(step || side.url) && (
          <div className="signoff-actions no-print">
            {step?.action === 'invite' && (
              <label className="signoff-ask">
                <span className="sr-only">A line for faculty, optional</span>
                <input
                  className="input"
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="Add a line for faculty (optional)"
                  maxLength={280}
                  disabled={asking}
                />
              </label>
            )}
            {step && (
              <button
                type="button"
                className="btn btn-primary btn-sm"
                disabled={asking}
                onClick={() => void room.act(step.action, step.action === 'invite' ? note : undefined).then(() => setNote(''))}
              >
                {asking ? 'Asking' : step.label}
              </button>
            )}
            {side.url && (
              <a className="step-link" href={side.url} target="_blank" rel="noreferrer noopener">
                Open in BAND
              </a>
            )}
          </div>
        )}
        {side.inviting && !busy && <p className="muted-note">The examiner is writing to {side.facultyName || 'faculty'}.</p>}
        {side.verified === false && !signed && (
          <p className="muted-note">The server did not mark this result in this session, so faculty will see the marks as not verified.</p>
        )}
        {(error || side.askFailed) && (
          <p className="signoff-error" role="alert">
            {error || 'The examiner did not answer. Ask again in a moment.'}
          </p>
        )}

        {(side.audit?.length ?? 0) > 0 && (
          <details className="signoff-audit" open={signed || side.status === 'sent_back'}>
            <summary>Who did what</summary>
            <ol>{side.audit!.map((a, i) => <Row key={i} a={a} />)}</ol>
          </details>
        )}
      </div>
    </section>
  );
}
