import type { ReactNode } from 'react';
import type { ActivePatient, ExamFinding, ExamResult, ExamSystem } from '../../game/types';
import { EXAM_SYSTEMS, examLabel, runExam, useExamUi } from '../../agents/examAgent';
import { SOUND_LABELS, isRecordedSound, toggleAuscultation, useAuscultationPlaying } from '../../voice/auscultation';

// 16px pixel-style stroke icons, one per body system.
const ICONS: Record<ExamSystem, ReactNode> = {
  general: <><circle cx="8" cy="4" r="2.2" /><path d="M4 14v-3.5A3 3 0 0 1 7 7.5h2a3 3 0 0 1 3 3V14" /></>,
  vitals: <path d="M1.5 8.5h3l1.5-4 2.5 8 2-5.5 1 1.5h3" />,
  cardio: <path d="M8 13.5 2.6 8.2A3 3 0 0 1 8 4.4a3 3 0 0 1 5.4 3.8Z" />,
  resp: <><path d="M8 2v5M8 7 5.5 9M8 7l2.5 2" /><path d="M5.5 4.5C3 5 2 8 2 11.5c0 1.5 1 2 2.5 1.5L6.5 12V6" /><path d="M10.5 4.5C13 5 14 8 14 11.5c0 1.5-1 2-2.5 1.5L9.5 12V6" /></>,
  abdomen: <><rect x="3" y="2.5" width="10" height="11" rx="3" /><circle cx="8" cy="8.5" r="0.8" /></>,
  neuro: <path d="M9.5 1.5 4 9h4l-1.5 5.5L12 7H8Z" />,
  msk: <path d="M4.5 3.5a1.5 1.5 0 1 0-1 2.5l6.5 6.5a1.5 1.5 0 1 0 2.5-1l-6.5-6.5a1.5 1.5 0 0 0-1.5-1.5Z" />,
  skin: <><rect x="2.5" y="2.5" width="11" height="11" rx="1" /><circle cx="6" cy="6" r="1" /><circle cx="10" cy="9.5" r="1.2" /><circle cx="6.5" cy="10.5" r="0.6" /></>,
  ent: <path d="M5 13c1.5 0 2-1 2.5-2.5S10.5 8.5 11 6.5A3.5 3.5 0 0 0 4.5 5M7 6.5a1.5 1.5 0 0 1 2 1.2" />,
  eye: <><path d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle cx="8" cy="8" r="2" /></>,
  obgyn: <><circle cx="8" cy="6" r="3.5" /><path d="M8 9.5v5M5.5 12.5h5" /></>,
  paeds: <path d="M2 14h12M4 14v-3M7 14V8.5M10 14V6M13 14V3" />,
};

const AUSC = /auscult|heart sounds?|breath sounds?|breathing|murmur|crackle|crepitation|wheez|rhonchi|bronchial|air entry|rub|s3|gallop/i;

/** Finding that gets the stethoscope button: the auscultation line, else the last. */
function soundIndex(findings: ExamFinding[]): number {
  const i = findings.findIndex((f) => AUSC.test(`${f.label} ${f.value}`));
  return i >= 0 ? i : findings.length - 1;
}

export function ExamTab({ patient }: { patient: ActivePatient }) {
  const caseId = patient.case.id;
  const ui = useExamUi(caseId);
  const done = patient.examsPerformed ?? [];
  const results = patient.examResults ?? {};
  // Most recent first; the system just examined (voice or click) on top.
  const order = [...done].reverse();
  if (ui.focus && order.includes(ui.focus.system)) {
    order.splice(order.indexOf(ui.focus.system), 1);
    order.unshift(ui.focus.system);
  }

  return (
    <div className="tab-scroll">
      <div className="exam-picker" role="group" aria-label="Examine a body system">
        {EXAM_SYSTEMS.map((s) => {
          const busy = ui.pending.includes(s.id);
          return (
            <button
              key={s.id}
              type="button"
              className={`exam-sys ${done.includes(s.id) ? 'is-done' : ''} ${busy ? 'is-busy' : ''}`}
              aria-pressed={done.includes(s.id)}
              aria-label={`Examine: ${s.label}`}
              onClick={() => void runExam(s.id, 'click')}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                {ICONS[s.id]}
              </svg>
              <span className="exam-sys-label">{s.label}</span>
            </button>
          );
        })}
      </div>

      {order.length === 0 ? (
        <p className="muted-note">
          Tap a system, or say it: “let me listen to your chest”, “check the abdomen”, “छाती की जाँच”, “ಎದೆ ಪರೀಕ್ಷೆ”.
        </p>
      ) : (
        <ul className="results exam-results">
          {order.map((sys) => (
            <ExamBlock key={sys} system={sys} result={results[sys]} pending={ui.pending.includes(sys)} error={ui.errors[sys]} />
          ))}
        </ul>
      )}
    </div>
  );
}

function ExamBlock({ system, result, pending, error }: { system: ExamSystem; result?: ExamResult; pending: boolean; error?: string }) {
  const abnormal = !!result?.findings.some((f) => f.abnormal);
  const sIdx = result?.sound ? soundIndex(result.findings) : -1;
  return (
    <li className={`result ${abnormal ? 'result--abn' : ''}`}>
      <div className="result-head">
        <span className="result-name">{examLabel(system)}</span>
        {abnormal && <span className="tag tag--critical">Abnormal</span>}
      </div>
      {result ? (
        <>
          {result.summary && <p className="result-text">{result.summary}</p>}
          <dl className="exam-findings">
            {result.findings.map((f, i) => (
              <div key={`${f.label}-${i}`} className={`exam-finding ${f.abnormal ? 'is-abn' : ''}`}>
                <dt>{f.label}</dt>
                <dd>
                  {f.value}
                  {i === sIdx && result.sound && <StethButton sound={result.sound} />}
                </dd>
              </div>
            ))}
          </dl>
        </>
      ) : pending ? (
        <p className="result-text">Examining…</p>
      ) : error ? (
        <p className="result-text">
          {error}{' '}
          <button type="button" className="btn btn-quiet btn-sm exam-retry" onClick={() => void runExam(system, 'click')}>
            Retry
          </button>
        </p>
      ) : (
        <p className="result-text">Pending…</p>
      )}
    </li>
  );
}

function StethButton({ sound }: { sound: NonNullable<ExamResult['sound']> }) {
  const playing = useAuscultationPlaying() === sound;
  const label = `${playing ? 'Stop' : 'Play'} ${SOUND_LABELS[sound].toLowerCase()}${isRecordedSound(sound) ? '' : ' (simulated)'}`;
  return (
    <button
      type="button"
      className={`exam-steth ${playing ? 'is-playing' : ''}`}
      aria-label={label}
      title={label}
      onClick={() => void toggleAuscultation(sound)}
    >
      <svg width="14" height="14" viewBox="0 0 16 16" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
        <path d="M3 1.5v4a3 3 0 0 0 6 0v-4M6 8.5v2a3.5 3.5 0 0 0 7 0V9" />
        <circle cx="13" cy="7.5" r="1.5" />
      </svg>
    </button>
  );
}
