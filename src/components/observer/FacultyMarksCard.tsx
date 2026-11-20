import { useSyncExternalStore } from 'react';
import { allFacultyMarks, subscribeFacultyMarks } from '../../observer/facultyMarks';
import { marksAverage, OSCE_DOMAINS, type FacultyMarks } from '../../observer/messages';
import '../../styles/observer.css';

/** Marks a live faculty observer sent for this encounter (debrief and OSCE
 *  result pages). Renders nothing when there are none. `saved` (from an
 *  evalHistory row) is the fallback when this browser's mark store is empty. */
export function FacultyMarksCard({
  caseId,
  encounterAt,
  saved,
}: {
  caseId: string;
  encounterAt?: number;
  saved?: FacultyMarks[];
}) {
  const all = useSyncExternalStore(subscribeFacultyMarks, allFacultyMarks);
  const live = all.filter((m) => m.caseId === caseId && (encounterAt === undefined || m.encounterAt === encounterAt));
  const marks = live.length ? live : saved ?? [];
  if (!marks.length) return null;
  return (
    <section className="faculty-marks" aria-label="Faculty observer marks">
      <p className="field-label">Faculty observer marks</p>
      {marks.map((m) => (
        <div key={m.id} className="faculty-marks-sheet">
          <div className="faculty-marks-head">
            <span className="faculty-marks-who">{m.examiner || 'Faculty observer'}</span>
            <span className="faculty-marks-avg">{marksAverage(m).toFixed(1)}<small>/5</small></span>
          </div>
          <ul className="faculty-marks-list">
            {OSCE_DOMAINS.map((d) => (
              <li key={d.key}>
                <span>{d.label}</span>
                <span className="faculty-marks-pips" aria-label={`${m.scores[d.key]} of 5`}>
                  {[1, 2, 3, 4, 5].map((n) => (
                    <i key={n} className={n <= m.scores[d.key] ? 'is-on' : ''} />
                  ))}
                </span>
              </li>
            ))}
          </ul>
          {m.comment && <p className="faculty-marks-comment">{m.comment}</p>}
        </div>
      ))}
    </section>
  );
}
