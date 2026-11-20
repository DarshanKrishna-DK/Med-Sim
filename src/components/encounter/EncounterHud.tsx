import { useState } from 'react';
import { Brand, Kbd, ThemeToggle } from '../ui/chrome';
import { PatientCard } from './PatientCard';
import { VoicePanel } from './VoicePanel';
import { AgentPanel } from './AgentPanel';
import { useCoachWatch } from './useCoachWatch';
import type { EncounterController } from './useEncounterController';
import { OsceTimer } from './OsceTimer';
import { useOsceLive, useStore } from '../../game/store';

/** The encounter HUD as a pure overlay layer. Position it over any
 *  full-bleed canvas inside a `position: relative|fixed` parent; empty
 *  regions pass pointer events through to the scene underneath. */
export function EncounterHud({ ctl, compact = false }: { ctl: EncounterController; compact?: boolean }) {
  // compact: the chart collapses to a tab so the 3D room stays in view;
  // the nurse panel (Nurse Asha) is always shown as a slim right column.
  const [chartOpen, setChartOpen] = useState(!compact);
  const { patient, voice, elapsed, pointerLocked, ending, confirmEnd, setConfirmEnd, endConsultation } = ctl;
  const c = patient?.case;
  useCoachWatch(voice.messages, c?.id ?? null);
  const osceLive = useOsceLive();
  const osce = useStore((s) => s.osce);
  return (
    <>
      {pointerLocked && <div className="crosshair" aria-hidden="true" />}

      <div className={compact ? 'hud hud--compact' : 'hud'}>
        <header className="hud-top hud-panel">
          <Brand />
          <div className="hud-case">
            {c ? (
              <>
                <span className="hud-case-name">{c.name}, {c.age}{c.gender}</span>
                <span className="hud-case-cc">{c.chiefComplaint}</span>
              </>
            ) : (
              <span className="hud-case-name">The patient is on their way in…</span>
            )}
          </div>
          {osceLive && osce?.startedAt ? (
            <OsceTimer startedAt={osce.startedAt} durationMs={osce.durationMs} onTimeUp={() => void ctl.endConsultation()} />
          ) : (
            <span className="hud-timer" aria-label={`Elapsed ${elapsed}`}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7.5" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M7 4.8v2.9l1.8 1.1M5.5 1.2h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
              {elapsed}
            </span>
          )}
          <ThemeToggle />
          <button
            type="button"
            className="btn btn-end"
            disabled={!patient || ending}
            onClick={() => setConfirmEnd(true)}
          >
            {osceLive ? 'End station' : 'End consultation'}
          </button>
        </header>

        {patient && (
          <>
            <div className="hud-left">
              {compact && (
                <button type="button" className="hud-tab hud-panel" aria-expanded={chartOpen} onClick={() => setChartOpen((o) => !o)}>
                  {chartOpen ? 'Hide chart' : 'Patient chart'}
                </button>
              )}
              {chartOpen && <PatientCard patient={patient} />}
            </div>
            <div className="hud-bottom">
              <VoicePanel voice={voice} patientName={patient.case.name} />
              <p className="hud-hint">
                {pointerLocked ? (
                  <>Mouse look · <Kbd>Esc</Kbd> free cursor · <Kbd>T</Kbd> voice on/off</>
                ) : (
                  <>Click the room for mouse look · <Kbd>T</Kbd> voice on/off</>
                )}
              </p>
            </div>
            <div className="hud-right">
              <AgentPanel patient={patient} voiceStatus={voice.status} />
            </div>
          </>
        )}
      </div>

      {confirmEnd && patient && (
        <div className="modal-layer" role="dialog" aria-modal="true" aria-labelledby="end-title">
          <div className="modal">
            <h2 id="end-title" className="modal-title">End the consultation?</h2>
            <p className="modal-body">
              {patient.case.name.split(' ')[0]} will say goodbye and leave. The attending then grades
              what you asked, ordered, diagnosed and prescribed.
            </p>
            <ul className="modal-checks">
              <li className={patient.submittedDiagnosisId ? 'is-done' : ''}>
                {patient.submittedDiagnosisId ? 'Diagnosis submitted' : 'No diagnosis submitted yet'}
              </li>
              <li className={(patient.prescriptions?.length ?? 0) > 0 ? 'is-done' : ''}>
                {(patient.prescriptions?.length ?? 0) > 0
                  ? `${patient.prescriptions?.length} prescription${patient.prescriptions?.length === 1 ? '' : 's'}`
                  : 'Nothing prescribed'}
              </li>
              <li className={patient.orderedTestIds.length > 0 ? 'is-done' : ''}>
                {patient.orderedTestIds.length} test{patient.orderedTestIds.length === 1 ? '' : 's'} ordered
              </li>
            </ul>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmEnd(false)} autoFocus>
                Keep going
              </button>
              <button type="button" className="btn btn-primary" onClick={endConsultation}>
                End and get debrief
              </button>
            </div>
          </div>
        </div>
      )}

      {ending && (
        <div className="modal-layer modal-layer--quiet" role="status">
          <div className="ending-chip">Saying goodbye to {c?.name.split(' ')[0] ?? 'the patient'}…</div>
        </div>
      )}
    </>
  );
}
