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
  utterance: 'Nurse, get a CBC and start amoxicillin 500 three times a day',
  source: 'voice',
  status: 'done',
  startedAt: T0,
  finishedAt: T0 + 6400,
  intent: 'order',
  steps: [
    { tool: 'order_test', args: { testId: 'cbc' }, ok: true, summary: 'CBC sent to the laboratory, result pending' },
    {
      tool: 'check_allergies_and_interactions',
      args: { medicationId: 'amoxicillin-500' },
      ok: true,
      summary: 'NIH RxClass: amoxicillin is a penicillin; documented penicillin allergy. Held.',
      result: {
        realCheck: {
          ok: true,
          classes: ['Penicillins with extended spectrum'],
          sources: [
            { name: 'RxNorm/RxClass (NIH NLM)', url: 'https://rxnav.nlm.nih.gov/' },
            { name: 'openFDA drug label', url: 'https://open.fda.gov/apis/drug/label/' },
          ],
        },
      },
    },
    {
      tool: 'record_to_ehr',
      args: { server: 'HL7 FHIR R4' },
      ok: true,
      summary: 'Saved to the FHIR health record: ServiceRequest',
      result: { records: [{ resourceType: 'ServiceRequest', id: 'demo', url: 'https://hapi.fhir.org/baseR4/ServiceRequest' }] },
    },
  ],
  spokenConfirmation: 'CBC is sent, doctor... but I’ve held the amoxicillin. NIH and the FDA label flag his penicillin allergy.',
};

export function HeroPreview() {
  return (
    <div className="hero-preview" aria-label="Example: the patient speaks, then the nurse agent runs a spoken order" role="img">
      <div className="preview-voice" aria-hidden="true">
        <ThinkingOrb state="composing" size={32} theme="dark" />
        <p className="subtitle">
          <span className="subtitle-who">Bhaskar</span>
          <span className="subtitle-line">“This cough with yellow phlegm won’t stop, doctor. Five days now, with fever.”</span>
        </p>
      </div>
      <ol className="feed preview-feed" aria-hidden="true">
        <RunCard run={EXAMPLE} />
      </ol>
    </div>
  );
}
