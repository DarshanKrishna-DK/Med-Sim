import { useEffect, useRef, useState } from 'react';
import { store, useStore } from '../../game/store';
import { CASES, getCaseClinic, getPatientCase } from '../../data/cases';
import { CLINIC_IDS, CLINIC_LABELS, type ClinicId } from '../../game/clinic';
import { AppHeader } from '../ui/chrome';
import { VitalsRow } from '../ui/Vitals';
import '../../styles/osce.css';

const CANDIDATE_KEY = 'medsim:osceCandidate';

const COUNTS: Record<string, number> = CASES.reduce<Record<string, number>>((acc, c) => {
  acc[c.clinic] = (acc[c.clinic] ?? 0) + 1;
  return acc;
}, {});

const POOLS: ClinicId[] = CLINIC_IDS.filter((id) => id === 'all-specialties' || (COUNTS[id] ?? 0) > 0);

function readCandidate(): string {
  try {
    return localStorage.getItem(CANDIDATE_KEY) ?? '';
  } catch {
    return '';
  }
}

function writeCandidate(v: string) {
  try {
    localStorage.setItem(CANDIDATE_KEY, v);
  } catch {
    /* storage blocked, non-fatal */
  }
}

/** "medicine OPD" for internal medicine, "<specialty> OPD" otherwise. */
export function opdName(clinic: ClinicId | undefined): string {
  if (!clinic || clinic === 'internal-medicine' || clinic === 'all-specialties') return 'medicine';
  return CLINIC_LABELS[clinic].toLowerCase();
}

export function OsceScreen() {
  const osce = useStore((s) => s.osce);
  const lastClinic = useStore((s) => s.polyclinic.clinic);
  const [pool, setPool] = useState<ClinicId>(osce?.specialty ?? (POOLS.includes(lastClinic) ? lastClinic : 'all-specialties'));
  const [name, setName] = useState(osce?.candidateName ?? readCandidate);

  // A station that already rang (or one never started) is not resumable here.
  const drawn = osce && osce.startedAt === null ? osce : null;

  const draw = () => {
    writeCandidate(name.trim());
    store.drawOsceStation(pool, name);
  };

  return (
    <div className="page paper dots">
      <AppHeader />
      <main className="osce wrap">
        <div className="library-head">
          <p className="kicker">OSCE exam mode</p>
          <h1 className="page-title">One station. Eight minutes.</h1>
          <p className="page-lede">
            A timed outpatient station like the real exam. No hints from the nurse while the clock runs; the
            examiner marks you against a checklist at the bell.
          </p>
        </div>

        {drawn ? (
          <InstructionsCard key={drawn.caseId} />
        ) : (
          <section className="osce-setup" aria-labelledby="osce-setup-title">
            <h2 id="osce-setup-title" className="section-title">Set up your station</h2>
            <div className="osce-fields">
              <div>
                <label className="field-label" htmlFor="osce-pool">Station pool</label>
                <select id="osce-pool" className="input" value={pool} onChange={(e) => setPool(e.target.value as ClinicId)}>
                  {POOLS.map((id) => (
                    <option key={id} value={id}>
                      {id === 'all-specialties' ? 'Mixed (any specialty)' : CLINIC_LABELS[id]} ({id === 'all-specialties' ? CASES.length : COUNTS[id]})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="field-label" htmlFor="osce-name">Candidate name (optional)</label>
                <input
                  id="osce-name"
                  className="input"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder="Printed on your report only"
                  autoComplete="name"
                  maxLength={60}
                />
              </div>
            </div>
            <ul className="osce-rules">
              <li>A random patient is drawn from the pool. You see the candidate brief before the clock starts.</li>
              <li>8 minutes on the clock, a chime at 1 minute left, and the station ends itself at the bell.</li>
              <li>The nurse still carries out your orders, but her mistake alerts stay hidden until marking.</li>
              <li>Marked like an OSCE: checklist items met, partly met or not met, plus a global rating.</li>
            </ul>
            <div className="row-actions">
              <button type="button" className="btn btn-primary btn-lg" onClick={draw}>
                Draw a station
              </button>
              <button type="button" className="btn btn-ghost btn-lg" onClick={() => store.exitOsce('library')}>
                Back to practice
              </button>
            </div>
          </section>
        )}
      </main>
    </div>
  );
}

function InstructionsCard() {
  const osce = useStore((s) => s.osce);
  const startRef = useRef<HTMLButtonElement>(null);
  useEffect(() => startRef.current?.focus(), []);
  if (!osce) return null;
  const p = getPatientCase(osce.caseId);
  if (!p) return null;
  const clinic = getCaseClinic(osce.caseId);
  const minutes = Math.round(osce.durationMs / 60000);

  return (
    <section className="osce-card" aria-labelledby="osce-card-title">
      <header className="osce-card-head">
        <p className="kicker">Candidate instructions</p>
        <span className="osce-card-clock" aria-label={`${minutes} minutes`}>{minutes}:00</span>
      </header>
      <h2 id="osce-card-title" className="osce-card-title">Station brief</h2>
      <p className="osce-card-brief">
        You are an intern in the {opdName(clinic)} OPD. Take a focused history, examine, order investigations,
        and explain the plan. {minutes} minutes.
      </p>
      <dl className="osce-card-patient">
        <div>
          <dt>Patient</dt>
          <dd>
            {p.name}, {p.age} years, {p.gender === 'F' ? 'female' : 'male'}
          </dd>
        </div>
        <div>
          <dt>Presenting with</dt>
          <dd>{p.chiefComplaint}</dd>
        </div>
      </dl>
      <div>
        <p className="field-label">Triage vitals</p>
        <VitalsRow vitals={p.vitals} />
      </div>
      <ol className="brief-steps">
        <li><strong>Talk to the patient</strong> by voice (press T). Introduce yourself first.</li>
        <li><strong>Say your examination and orders out loud</strong>; the nurse runs them, results land in the chart.</li>
        <li><strong>Commit to a diagnosis</strong> in the chart and explain the plan before the bell.</li>
      </ol>
      <div className="row-actions">
        <button ref={startRef} type="button" className="btn btn-primary btn-lg" onClick={() => store.startOsceStation()}>
          Start station ({minutes}:00)
        </button>
        <button type="button" className="btn btn-ghost btn-lg" onClick={() => store.drawOsceStation(osce.specialty, osce.candidateName, osce.durationMs)}>
          Draw another
        </button>
        <button type="button" className="btn btn-quiet" onClick={() => store.exitOsce('osce')}>
          Change pool
        </button>
      </div>
      <p className="muted-note">The clock starts when you press Start. Your browser will ask for the microphone.</p>
    </section>
  );
}
