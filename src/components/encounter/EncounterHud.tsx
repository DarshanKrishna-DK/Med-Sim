import { useState } from 'react';
import { Brand, Kbd } from '../ui/chrome';
import { LangToggle } from '../ui/LangToggle';
import { PatientCard } from './PatientCard';
import { VoicePanel } from './VoicePanel';
import { AgentPanel } from './AgentPanel';
import { AgentRoomPanel } from './AgentRoomPanel';
import { useCoachWatch } from './useCoachWatch';
import type { EncounterController } from './useEncounterController';
import type { RoomControls } from './Scene';
import type { ActivePatient } from '../../game/types';
import { OsceTimer } from './OsceTimer';
import { Icon, OverflowMenu, type MenuEntry } from './HudControls';
import { useOsceLive, useStore } from '../../game/store';
import { pendingCounts } from '../../room/chart';
import { ObserverInvite } from '../observer/ObserverInvite';

/** What is still with a department, in the words the End dialog uses. */
function pendingLines(p: ActivePatient): string[] {
  const n = pendingCounts(p);
  return [
    n.results ? `${n.results} result${n.results === 1 ? '' : 's'} still pending` : '',
    n.checks ? `${n.checks} drug${n.checks === 1 ? '' : 's'} still with the pharmacist, not prescribed` : '',
    n.holds ? `${n.holds} drug${n.holds === 1 ? '' : 's'} on hold, not prescribed` : '',
  ].filter(Boolean);
}

/** The encounter HUD as a pure overlay layer. Position it over any
 *  full-bleed canvas inside a `position: relative|fixed` parent; empty
 *  regions pass pointer events through to the scene underneath.
 *
 *  Layout: one top bar (case + chart toggle, timer, End, overflow menu),
 *  one bottom voice dock, Nurse Asha as the right column. `room` (from the
 *  3D scene) adds Next patient / Leave room to the overflow menu. */
export function EncounterHud({
  ctl,
  compact = false,
  room = null,
}: {
  ctl: EncounterController;
  compact?: boolean;
  room?: RoomControls | null;
}) {
  // compact: the chart collapses behind the case name so the 3D room stays in view.
  const [chartOpen, setChartOpen] = useState(!compact);
  const { patient, voice, elapsed, pointerLocked, ending, confirmEnd, setConfirmEnd, endConsultation } = ctl;
  const c = patient?.case;
  useCoachWatch(voice.messages, c?.id ?? null);
  const osceLive = useOsceLive();
  const osce = useStore((s) => s.osce);

  const menuItems: MenuEntry[] = room
    ? [
        {
          label: 'Next patient',
          kbd: 'N',
          disabled: !room.canNext || ending,
          note: room.canNext ? 'Finish this case, call the next one' : 'Once the patient is seated',
          onSelect: room.nextPatient,
        },
        { label: 'Leave room', note: 'Back to the corridor', disabled: ending, onSelect: room.leaveRoom },
      ]
    : [];

  return (
    <>
      {pointerLocked && <div className="crosshair" aria-hidden="true" />}
      <ObserverInvite caseId={c?.id ?? null} voiceStatus={voice.status} />

      <div className={compact ? 'hud hud--compact' : 'hud'}>
        <header className="hud-top hud-panel">
          <Brand />
          {c ? (
            <button
              type="button"
              className="hud-case"
              aria-expanded={chartOpen}
              aria-controls="hud-chart"
              onClick={() => setChartOpen((o) => !o)}
            >
              <span className="hud-case-name">{c.name}, {c.age}{c.gender}</span>
              <span className="hud-case-cc">{c.chiefComplaint}</span>
              <span className="hud-case-toggle">
                {chartOpen ? 'Hide chart' : 'Chart'}
                {Icon.chevron(chartOpen)}
              </span>
            </button>
          ) : (
            <div className="hud-case">
              <span className="hud-case-name">The patient is on their way in…</span>
            </div>
          )}
          {osceLive && osce?.startedAt ? (
            <OsceTimer startedAt={osce.startedAt} durationMs={osce.durationMs} onTimeUp={() => void ctl.endConsultation()} />
          ) : (
            <span className="hud-timer" aria-label={`Elapsed ${elapsed}`}>
              <svg width="14" height="14" viewBox="0 0 14 14" aria-hidden="true"><circle cx="7" cy="7.5" r="5.2" fill="none" stroke="currentColor" strokeWidth="1.3" /><path d="M7 4.8v2.9l1.8 1.1M5.5 1.2h3" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" /></svg>
              {elapsed}
            </span>
          )}
          <button
            type="button"
            className="btn btn-end"
            disabled={!patient || ending}
            onClick={() => setConfirmEnd(true)}
          >
            {osceLive ? 'End station' : 'End consultation'}
          </button>
          <OverflowMenu
            label="More options"
            items={menuItems}
            extra={
              <div className="hud-menu-lang">
                <span className="hud-menu-label">Voice language</span>
                <LangToggle />
              </div>
            }
          />
        </header>

        {patient && (
          <>
            <div className="hud-left" id="hud-chart">
              {chartOpen && <PatientCard patient={patient} bare={compact} />}
              <AgentRoomPanel patient={patient} />
            </div>
            <div className="hud-bottom">
              <VoicePanel
                voice={voice}
                patientName={patient.case.name}
                footer={
                  <p className="voice-keys" aria-hidden="true">
                    <span><Kbd>T</Kbd> Voice on/off</span>
                    {room && <span><Kbd>N</Kbd> Next patient</span>}
                    {pointerLocked ? (
                      <span><Kbd>Esc</Kbd> Free cursor</span>
                    ) : (
                      <>
                        <span><Kbd>Esc</Kbd> Pause</span>
                        <span>Click the room to look around</span>
                      </>
                    )}
                  </p>
                }
              />
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
              {pendingLines(patient).map((l) => (
                <li key={l}>{l}</li>
              ))}
            </ul>
            <div className="modal-actions">
              <button type="button" className="btn btn-ghost" onClick={() => setConfirmEnd(false)} autoFocus>
                Keep going
              </button>
              <button type="button" className="btn btn-primary" onClick={endConsultation}>
                {pendingLines(patient).length ? 'End anyway and get debrief' : 'End and get debrief'}
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
