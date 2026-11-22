import { useAcademicRoom } from '../../room/academic';
import type { AcademicInput } from '../../room/academicCore';
import { signedByOf, useSignOff } from '../../room/academicStore';
import { SignOffCard } from './SignOffCard';
import { StudyPlanCard } from './StudyPlanCard';
import '../../styles/academic.css';

/** Signature and study plan of one result, under its marks. `auto` for a result
 *  that has just been made: the examiner drafts at once. */
export function AcademicSection({ input, auto }: { input: AcademicInput; auto: boolean }) {
  const room = useAcademicRoom(input, auto);
  const plan = room.side?.plan;
  return (
    <div className="academic">
      <SignOffCard room={room} />
      {plan && room.mode !== 'off' && (
        <StudyPlanCard plan={plan} onRetry={room.side?.inviting ? undefined : () => void room.act('retry')} />
      )}
    </div>
  );
}

/** A small mark for lists: shown only when a person signed. */
export function SignedMark({ resultKey }: { resultKey: string }) {
  const by = signedByOf(useSignOff(resultKey));
  if (!by) return null;
  return (
    <span className="signed-mark" title={`Signed by ${by}`}>
      Signed<span className="sr-only"> by {by}</span>
    </span>
  );
}
