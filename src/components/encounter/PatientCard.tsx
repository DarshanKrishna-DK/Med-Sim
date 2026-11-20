import { useState } from 'react';
import type { ActivePatient } from '../../game/types';
import { CLINIC_LABELS } from '../../game/clinic';
import { getCaseClinic } from '../../data/cases';
import { VitalsRow } from '../ui/Vitals';

const SEVERITY: Record<string, string | null> = { critical: 'Red flag', urgent: 'Urgent', stable: null };

/** `bare`: the HUD top bar already toggles the chart, so the card drops its
 *  own collapse control and just shows the chart. */
export function PatientCard({ patient, bare = false }: { patient: ActivePatient; bare?: boolean }) {
  const c = patient.case;
  const [open, setOpen] = useState(true);
  const clinic = getCaseClinic(c.id);
  const sev = SEVERITY[c.severity];
  if (bare) {
    return (
      <section className="patient-card hud-panel" aria-label="Patient chart">
        <div className="patient-head patient-head--static">
          <span className="patient-id">
            <span className="patient-name">{c.name}</span>
            <span className="patient-demo">
              {c.age} {c.gender === 'F' ? 'F' : 'M'}
              {clinic ? ` · ${CLINIC_LABELS[clinic]}` : ''}
            </span>
          </span>
          {sev && <span className={`tag tag--${c.severity}`}>{sev}</span>}
        </div>
        <div className="patient-body">
          <p className="patient-cc">{c.chiefComplaint}</p>
          <VitalsRow vitals={c.vitals} compact />
        </div>
      </section>
    );
  }
  return (
    <section className="patient-card hud-panel" aria-label="Patient">
      <button
        type="button"
        className="patient-head"
        aria-expanded={open}
        aria-controls="patient-card-body"
        onClick={() => setOpen((o) => !o)}
      >
        <span className="patient-id">
          <span className="patient-name">{c.name}</span>
          <span className="patient-demo">
            {c.age} {c.gender === 'F' ? 'F' : 'M'}
            {clinic ? ` · ${CLINIC_LABELS[clinic]}` : ''}
          </span>
        </span>
        {sev && <span className={`tag tag--${c.severity}`}>{sev}</span>}
        <svg className={`chev ${open ? 'is-open' : ''}`} width="14" height="14" viewBox="0 0 14 14" aria-hidden="true">
          <path d="m3.5 5.5 3.5 3.5 3.5-3.5" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div id="patient-card-body" className="patient-body">
          <p className="patient-cc">{c.chiefComplaint}</p>
          <VitalsRow vitals={c.vitals} compact />
        </div>
      )}
    </section>
  );
}
