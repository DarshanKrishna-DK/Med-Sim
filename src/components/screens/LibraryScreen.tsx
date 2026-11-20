import { useEffect, useMemo, useRef, useState } from 'react';
import { Query } from '@lucasmarkes/hairline/react';
import { store, useStore } from '../../game/store';
import { CASES, getPatientCase, type Case } from '../../data/cases';
import { CLINIC_IDS, CLINIC_LABELS, type ClinicId } from '../../game/clinic';
import type { PatientCase, Severity } from '../../game/types';
import { AppHeader } from '../ui/chrome';
import { VitalsRow } from '../ui/Vitals';

const SEVERITY_LABEL: Record<Severity, string | null> = {
  critical: 'Red flag',
  urgent: 'Urgent',
  stable: null,
};

function clinicLabel(id: ClinicId): string {
  return id === 'all-specialties' ? 'All specialties' : CLINIC_LABELS[id];
}

const COUNTS: Record<string, number> = CASES.reduce<Record<string, number>>((acc, c) => {
  acc[c.clinic] = (acc[c.clinic] ?? 0) + 1;
  return acc;
}, {});

export function LibraryScreen({ briefOpen = false }: { briefOpen?: boolean }) {
  const clinic = useStore((s) => s.polyclinic.clinic);
  const selectedCaseId = useStore((s) => s.selectedCaseId);
  const [query, setQuery] = useState('');

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return CASES.filter((c) => {
      if (clinic !== 'all-specialties' && c.clinic !== clinic) return false;
      if (!q) return true;
      return (
        c.name.toLowerCase().includes(q) ||
        c.complaint.toLowerCase().includes(q) ||
        CLINIC_LABELS[c.clinic].toLowerCase().includes(q)
      );
    });
  }, [clinic, query]);

  const clinics = CLINIC_IDS.filter((id) => id === 'all-specialties' || (COUNTS[id] ?? 0) > 0);

  return (
    <div className="page paper dots">
      <AppHeader />
      <main className="library wrap">
        <div className="library-head">
          <h1 className="page-title">Choose a patient</h1>
          <p className="page-lede">
            Each case is one outpatient consultation. Pick a specialty, open a chart, and start when
            you're ready to talk.
          </p>
          <button type="button" className="btn btn-secondary" onClick={() => store.setScreen('triage')}>
            Triage drill: 5 ED patients in 3 minutes
          </button>
          <button type="button" className="btn btn-primary osce-entry" onClick={() => store.openOsce()}>
            Start OSCE: one timed 8-minute station
          </button>
        </div>

        <div className="library-body">
          <nav className="specialty-rail" aria-label="Specialty">
            <label className="field-label" htmlFor="specialty-select">Specialty</label>
            {/* Compact select for narrow screens; the list below for wide ones. */}
            <select
              id="specialty-select"
              className="input specialty-select"
              value={clinic}
              onChange={(e) => store.setPolyclinicClinic(e.target.value as ClinicId)}
            >
              {clinics.map((id) => (
                <option key={id} value={id}>
                  {clinicLabel(id)} ({id === 'all-specialties' ? CASES.length : COUNTS[id]})
                </option>
              ))}
            </select>
            <ul className="specialty-list">
              {clinics.map((id) => (
                <li key={id}>
                  <button
                    type="button"
                    className="specialty-item"
                    aria-pressed={clinic === id}
                    onClick={() => store.setPolyclinicClinic(id)}
                  >
                    <span>{clinicLabel(id)}</span>
                    <span className="specialty-count">
                      {id === 'all-specialties' ? CASES.length : COUNTS[id]}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </nav>

          <section className="case-area" aria-label="Cases">
            <div className="case-toolbar">
              <div className="search">
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
                  <circle cx="7" cy="7" r="4.6" fill="none" stroke="currentColor" strokeWidth="1.4" />
                  <path d="m10.5 10.5 3.5 3.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" />
                </svg>
                <input
                  className="input search-input"
                  type="search"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search by name or complaint"
                  aria-label="Search cases"
                />
              </div>
              <span className="case-count" aria-live="polite">
                {visible.length} {visible.length === 1 ? 'patient' : 'patients'}
              </span>
            </div>

            {visible.length === 0 ? (
              <div className="empty">
                <div className="empty-figure">
                  <Query intensity={0.5} label="A question mark built from a bent bar and a ball" />
                </div>
                <p className="empty-title">No patients match “{query}”.</p>
                <p className="empty-body">Try a symptom such as “cough” or switch to all specialties.</p>
                <button type="button" className="btn btn-ghost" onClick={() => { setQuery(''); store.setPolyclinicClinic('all-specialties'); }}>
                  Show all patients
                </button>
              </div>
            ) : (
              <ul className="case-grid">
                {visible.map((c) => (
                  <li key={c.id}>
                    <CaseCard c={c} showClinic={clinic === 'all-specialties'} />
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </main>

      {briefOpen && <BriefDrawer caseId={selectedCaseId} />}
    </div>
  );
}

function CaseCard({ c, showClinic }: { c: Case; showClinic: boolean }) {
  const p = getPatientCase(c.id);
  const severity = p?.severity ?? 'stable';
  const sevLabel = SEVERITY_LABEL[severity];
  return (
    <button type="button" className="case-card" onClick={() => store.selectCase(c.id)}>
      <span className="case-card-top">
        <span className="case-name">{c.name}</span>
        <span className="case-demo">
          {c.age} {c.sex === 'F' ? 'F' : 'M'}
        </span>
      </span>
      <span className="case-complaint">{c.complaint}</span>
      <span className="case-meta">
        {showClinic && <span className="case-clinic">{CLINIC_LABELS[c.clinic]}</span>}
        {sevLabel && <span className={`tag tag--${severity}`}>{sevLabel}</span>}
        {p?.source && <span className="chip" title="Adapted from an open-access case report">Based on a published case</span>}
      </span>
    </button>
  );
}

function BriefDrawer({ caseId }: { caseId: string }) {
  const p: PatientCase | undefined = getPatientCase(caseId);
  const c = CASES.find((x) => x.id === caseId);
  const startRef = useRef<HTMLButtonElement>(null);
  const close = () => store.setScreen('library');

  useEffect(() => {
    startRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  if (!p || !c) return null;
  const sevLabel = SEVERITY_LABEL[p.severity];

  return (
    <div className="drawer-layer">
      <button type="button" className="drawer-scrim" aria-label="Close patient brief" onClick={close} />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="brief-title">
        <div className="drawer-head">
          <div>
            <p className="drawer-kicker">{CLINIC_LABELS[c.clinic]}</p>
            <h2 id="brief-title" className="drawer-title">{p.name}</h2>
            <p className="drawer-sub">
              {p.age} years, {p.gender === 'F' ? 'female' : 'male'}
              {sevLabel && <span className={`tag tag--${p.severity}`}>{sevLabel}</span>}
            </p>
          </div>
          <button type="button" className="icon-btn" onClick={close} aria-label="Close">
            <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden="true">
              <path d="m4 4 8 8M12 4l-8 8" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
            </svg>
          </button>
        </div>

        <div className="drawer-body">
          <section className="brief-block">
            <h3 className="block-title">Presenting complaint</h3>
            <p className="brief-complaint">{p.chiefComplaint}</p>
            {p.arrivalBlurb && p.arrivalBlurb !== p.chiefComplaint && (
              <p className="brief-blurb">{p.arrivalBlurb}</p>
            )}
          </section>

          <section className="brief-block">
            <h3 className="block-title">Triage vitals</h3>
            <VitalsRow vitals={p.vitals} />
          </section>

          {p.source && (
            <section className="brief-block">
              <h3 className="block-title">Source</h3>
              <p className="brief-blurb">
                Based on a published case: {p.source.authors}, {p.source.journal}, {p.source.year}. {p.source.license}.{' '}
                <a href={p.source.url} target="_blank" rel="noopener noreferrer">View article</a>
              </p>
            </section>
          )}

          <section className="brief-block">
            <h3 className="block-title">In the room</h3>
            <ol className="brief-steps">
              <li>
                <strong>Connect voice</strong> and greet the patient. Talk normally; they can hear you
                the whole time.
              </li>
              <li>
                <strong>Say your orders out loud.</strong> “Let's get a full blood count and check her
                allergies” goes to the charge nurse, who runs it and tells you when it's done.
              </li>
              <li>
                <strong>Commit to a diagnosis and prescribe</strong>, then end the consultation for
                the attending's debrief.
              </li>
            </ol>
          </section>
        </div>

        <div className="drawer-foot">
          <button ref={startRef} type="button" className="btn btn-primary btn-lg btn-block" onClick={() => store.acceptNextPatient(p.id)}>
            Start consultation
          </button>
          <p className="drawer-note">Your browser will ask for the microphone when you connect voice.</p>
        </div>
      </aside>
    </div>
  );
}
