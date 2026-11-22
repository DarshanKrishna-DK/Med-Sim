import type { StudyPlan } from '../../room/academicCore';
import { openLesson, openPractice } from '../../room/lessonLink';
import { getCaseClinic } from '../../data/cases';
import { RoomAvatar } from '../encounter/RoomAvatar';
import '../../styles/academic.css';

/** Teacher Iyer's answer: one lesson, then one patient. */
export function StudyPlanCard({ plan, onRetry, compact }: { plan: StudyPlan; onRetry?: () => void; compact?: boolean }) {
  if (plan.status === 'failed') {
    return (
      <section className="plan" aria-label="Your plan from Dr Iyer">
        <RoomAvatar role="teacher" size={compact ? 32 : 44} />
        <div className="plan-body">
          <p>Dr Iyer has not answered, so there is no plan yet.</p>
          {onRetry && (
            <button type="button" className="btn btn-secondary btn-sm" onClick={onRetry}>
              Ask Dr Iyer again
            </button>
          )}
        </div>
      </section>
    );
  }
  if (plan.status === 'planning' || !plan.topic) {
    return (
      <section className="plan plan--waiting" aria-label="Your plan from Dr Iyer" aria-busy="true">
        <RoomAvatar role="teacher" size={compact ? 32 : 44} />
        <div className="plan-body">
          <p role="status">Dr Iyer is choosing a lesson and a practice patient for you.</p>
        </div>
      </section>
    );
  }
  // The server checked the case against its own catalogue; this browser must have it too.
  const caseId = plan.caseId && getCaseClinic(plan.caseId) ? plan.caseId : '';
  return (
    <section className={`plan${compact ? ' plan--compact' : ''}`} aria-labelledby="plan-title">
      <RoomAvatar role="teacher" size={compact ? 32 : 44} />
      <div className="plan-body">
        <h2 id="plan-title" className={compact ? 'plan-title plan-title--compact' : 'section-title'}>
          Your plan from Dr Iyer
        </h2>
        {plan.reason && <p className="plan-reason">{plan.reason}</p>}
        <ol className="plan-steps no-print">
          <li>
            <button type="button" className="plan-step" onClick={() => openLesson(plan.topic!, plan.level ?? 'student')}>
              <span className="plan-step-what">Learn in the classroom</span>
              <span className="plan-step-name">{plan.topic}</span>
            </button>
          </li>
          {caseId && (
            <li>
              <button type="button" className="plan-step" onClick={() => openPractice(caseId)}>
                <span className="plan-step-what">Then practise in the clinic</span>
                <span className="plan-step-name">A {plan.clinicLabel || 'clinic'} patient</span>
              </button>
            </li>
          )}
        </ol>
        {plan.updated && <p className="muted-note">Planned again after the faculty comment.</p>}
      </div>
    </section>
  );
}
