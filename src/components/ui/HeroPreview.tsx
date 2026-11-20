import { ThinkingOrb } from 'thinking-orbs';
import type { NurseRun } from '../../agents/nurseAgent';
import { RunCard } from '../encounter/NurseFeed';

// A worked example rendered with the real encounter components, so the
// landing shows exactly what the doctor sees in the room. Fixed timestamps
// keep it stable across renders.
const T0 = Date.UTC(2026, 0, 1, 9, 14, 2);

const EXAMPLE: NurseRun = {
  id: 'example',
  caseId: 'example',
  utterance: 'Let’s get a full blood count, and check if she’s allergic to anything',
  source: 'voice',
  status: 'done',
  startedAt: T0,
  finishedAt: T0 + 1700,
  intent: 'order',
  steps: [
    { tool: 'order_test', args: { test_id: 'cbc' }, ok: true, summary: 'Full blood count ordered; result filed to the chart.' },
    { tool: 'check_allergies', args: { patient: 'Mary Smith' }, ok: true, summary: 'No drug allergies recorded.' },
  ],
  spokenConfirmation: 'Bloods are in, doctor. No allergies on file.',
};

export function HeroPreview() {
  return (
    <div className="hero-preview" aria-label="Example: the patient speaks, then the nurse agent runs a spoken order" role="img">
      <div className="preview-voice" aria-hidden="true">
        <ThinkingOrb state="composing" size={32} theme="dark" />
        <p className="subtitle">
          <span className="subtitle-who">Mary</span>
          <span className="subtitle-line">“It’s the stairs that get me. Two flights and I have to stop.”</span>
        </p>
      </div>
      <ol className="feed preview-feed" aria-hidden="true">
        <RunCard run={EXAMPLE} />
      </ol>
    </div>
  );
}
