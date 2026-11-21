import { useEffect } from 'react';
import { dismissFacultyToast, useObserverLink, type FacultyToast } from '../../observer/studentLink';
import '../../styles/observer.css';

const WHISPER_MS = 12_000;
const MARKS_MS = 9_000;

/** Student side: faculty whispers and "marks received" notices, on any screen. */
export function FacultyToasts() {
  const { toasts } = useObserverLink();
  if (!toasts.length) return null;
  return (
    <div className="faculty-toasts" role="status" aria-live="polite">
      {toasts.map((t) => (
        <Toast key={t.id} toast={t} />
      ))}
    </div>
  );
}

function Toast({ toast }: { toast: FacultyToast }) {
  useEffect(() => {
    const id = window.setTimeout(() => dismissFacultyToast(toast.id), toast.kind === 'marks' ? MARKS_MS : WHISPER_MS);
    return () => window.clearTimeout(id);
  }, [toast.id, toast.kind]);
  return (
    <div className={`faculty-toast faculty-toast--${toast.kind}`}>
      <p className="faculty-toast-text">
        {toast.kind === 'call' ? (
          <>
            <span className="faculty-toast-who">Message from {toast.examiner || 'your observer'}:</span> {toast.text}
          </>
        ) : toast.kind === 'whisper' ? (
          <>
            <span className="faculty-toast-who">Faculty{toast.examiner ? ` (${toast.examiner})` : ''}:</span> {toast.text}
          </>
        ) : (
          <>
            <span className="faculty-toast-who">{toast.text}</span>
            {toast.examiner ? ` from ${toast.examiner}` : ''}. Saved with your debrief.
          </>
        )}
      </p>
      <button type="button" className="faculty-toast-close" aria-label="Dismiss" onClick={() => dismissFacultyToast(toast.id)}>
        <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
          <path d="m2.5 2.5 7 7M9.5 2.5l-7 7" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" />
        </svg>
      </button>
    </div>
  );
}
