import { useEffect, useMemo, useRef, useState, type KeyboardEvent, type FormEvent, type ReactNode } from 'react';
import { setPatientContact, usePatientContact } from '../../game/patientContact';
import { isHintRequest, requestHint } from '../../agents/coach';
import { store, useAgentRuns } from '../../game/store';
import type { ActivePatient } from '../../game/types';
import { runNurseAction } from '../../agents/nurseAgent';
import { TESTS, testById } from '../../data/tests';
import { getTestReport } from '../../data/defaultTestResults';
import { MEDICATIONS, medicationById } from '../../data/medications';
import { POLYCLINIC_DIAGNOSIS_LABELS } from '../../data/polyclinicPatients';
import { NurseFeed, visibleRuns } from './NurseFeed';
import { AshaExplain, NurseAshaHeader } from './NurseAsha';
import type { CoachAlert } from '../../game/types';
import { coachAfterDiagnosis, coachAfterManualPrescription, coachAfterManualTest } from '../../agents/coach';
import { useExamUi } from '../../agents/examAgent';
import { ExamTab } from './ExamTab';
import { VoiceRx } from './VoiceRx';
import { FollowUpCallReports } from './FollowUpCallReports';
import { Icon, IconButton } from './HudControls';

type Tab = 'nurse' | 'exam' | 'results' | 'diagnosis' | 'rx';

// 16px stroke icons for the segmented tab control.
const TAB_ICON: Record<Tab, ReactNode> = {
  nurse: <><path d="M3.5 14v-2.5A3.5 3.5 0 0 1 7 8h2a3.5 3.5 0 0 1 3.5 3.5V14" /><path d="M5 2.5h6V6a3 3 0 0 1-6 0Z" /><path d="M8 3v2M7 4h2" /></>,
  exam: <><path d="M3 1.5v4a3 3 0 0 0 6 0v-4" /><path d="M6 8.5v2a3.5 3.5 0 0 0 7 0V9" /><circle cx="13" cy="7.5" r="1.5" /></>,
  results: <><path d="M6 1.5h4M6.5 1.5v4.5L3 13a1 1 0 0 0 .9 1.5h8.2A1 1 0 0 0 13 13L9.5 6V1.5" /><path d="M4.5 10.5h7" /></>,
  diagnosis: <><rect x="3" y="2.5" width="10" height="12" /><path d="M6 1.5h4v2H6ZM5.5 9l2 2 3-3.5" /></>,
  rx: <><rect x="2" y="6" width="12" height="5" rx="2.5" transform="rotate(-35 8 8.5)" /><path d="m6.6 6.3 2.9 4.2" /></>,
};

const dxLabel = (id: string) =>
  POLYCLINIC_DIAGNOSIS_LABELS[id] ?? id.replace(/-/g, ' ').replace(/^\w/, (m) => m.toUpperCase());

function sinceArrival(p: ActivePatient, ts: number | undefined): string {
  if (typeof ts !== 'number') return '';
  const s = Math.max(0, Math.round((ts - p.arrivedAt) / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function AgentPanel({ patient, voiceStatus }: { patient: ActivePatient; voiceStatus?: string }) {
  const [tab, setTab] = useState<Tab>('nurse');
  const [explaining, setExplaining] = useState<CoachAlert | null>(null);
  const runs = useAgentRuns();
  const shown = visibleRuns(runs);
  const running = shown.some((r) => r.status === 'running');

  const tabs: Array<{ id: Tab; label: string; count?: number }> = [
    { id: 'nurse', label: 'Nurse', count: shown.length },
    { id: 'exam', label: 'Exam', count: patient.examsPerformed?.length ?? 0 },
    { id: 'results', label: 'Results', count: patient.orderedTestIds.length },
    { id: 'diagnosis', label: 'Diagnosis' },
    { id: 'rx', label: 'Plan', count: (patient.prescriptions?.length ?? 0) + (patient.followUp ? 1 : 0) },
  ];
  const tabRefs = useRef<Record<Tab, HTMLButtonElement | null>>({ nurse: null, exam: null, results: null, diagnosis: null, rx: null });

  // A new exam (voice or click) opens the Exam tab.
  const examFocus = useExamUi(patient.case.id).focus;
  const seenFocus = useRef(examFocus?.at ?? 0);
  useEffect(() => {
    if (!examFocus || examFocus.at <= seenFocus.current) return;
    seenFocus.current = examFocus.at;
    setTab('exam');
  }, [examFocus]);

  const onTabKey = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft') return;
    const i = tabs.findIndex((t) => t.id === tab);
    const next = tabs[(i + (e.key === 'ArrowRight' ? 1 : tabs.length - 1)) % tabs.length].id;
    setTab(next);
    tabRefs.current[next]?.focus();
    e.preventDefault();
  };

  return (
    <aside className="agent-panel hud-panel" aria-label="Chart and nurse agent">
      <NurseAshaHeader voiceStatus={voiceStatus} onExplain={setExplaining} />
      <div className="agent-body">
        <div className="tabs tabs--seg" role="tablist" aria-label="Chart sections" onKeyDown={onTabKey}>
          {tabs.map((t) => (
            <button
              key={t.id}
              ref={(el) => { tabRefs.current[t.id] = el; }}
              type="button"
              role="tab"
              id={`tab-${t.id}`}
              aria-selected={tab === t.id}
              aria-controls={`panel-${t.id}`}
              tabIndex={tab === t.id ? 0 : -1}
              className="tab"
              onClick={() => setTab(t.id)}
            >
              <span className="tab-icon" aria-hidden="true">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round">
                  {TAB_ICON[t.id]}
                </svg>
                {t.id === 'nurse' && running && <span className="nurse-dot is-busy" />}
                {t.count ? <span className="tab-count">{t.count}</span> : null}
              </span>
              <span className="tab-label">{t.label}</span>
              {t.count ? <span className="sr-only">, {t.count}</span> : null}
            </button>
          ))}
        </div>

        <div className="tab-panels">
          <div role="tabpanel" id={`panel-${tab}`} aria-labelledby={`tab-${tab}`} className="tab-panel">
            {tab === 'nurse' && <NurseFeed runs={runs} />}
            {tab === 'exam' && <ExamTab patient={patient} />}
            {tab === 'results' && <ResultsTab patient={patient} />}
            {tab === 'diagnosis' && <DiagnosisTab patient={patient} />}
            {tab === 'rx' && <PlanTab patient={patient} />}
          </div>
        </div>

        {tab === 'nurse' && <NurseCommand />}
        {explaining && explaining.caseId === patient.case.id && <AshaExplain alert={explaining} onClose={() => setExplaining(null)} />}
      </div>
    </aside>
  );
}

// ── Nurse command box ────────────────────────────────────────────────

function NurseCommand() {
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    const t = text.trim();
    if (!t || busy) return;
    setBusy(true);
    setText('');
    try {
      if (isHintRequest(t)) await requestHint();
      else await runNurseAction(t, 'typed');
    } finally {
      setBusy(false);
    }
  };
  return (
    <form className="command" onSubmit={submit}>
      <label htmlFor="nurse-command" className="sr-only">Order for the nurse</label>
      <input
        id="nurse-command"
        className="input command-input"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="Order, e.g. “CBC and urine dip”"
        autoComplete="off"
      />
      <IconButton tip="top-end" type="submit" label="Send order to Asha" className="icon-btn--nurse" disabled={!text.trim() || busy}>
        {Icon.send}
      </IconButton>
    </form>
  );
}

// ── Results ──────────────────────────────────────────────────────────

function ResultsTab({ patient }: { patient: ActivePatient }) {
  const c = patient.case;
  const [q, setQ] = useState('');
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return TESTS.filter((t) => t.name.toLowerCase().includes(s) && !patient.orderedTestIds.includes(t.id)).slice(0, 5);
  }, [q, patient.orderedTestIds]);

  const ordered = [...patient.orderedTestIds].reverse();

  return (
    <div className="tab-scroll">
      {ordered.length === 0 ? (
        <p className="muted-note">No tests yet. Ask the nurse, or order one directly below.</p>
      ) : (
        <ul className="results">
          {ordered.map((tid) => {
            const t = testById(tid);
            const caseResult = c.testResults.find((r) => r.testId === tid);
            const done = patient.completedTestIds.includes(tid);
            const report = done ? getTestReport(tid, caseResult?.result, !!caseResult?.abnormal) : null;
            return (
              <li key={tid} className={`result ${report?.abnormal ? 'result--abn' : ''}`}>
                <div className="result-head">
                  <span className="result-name">{t?.name ?? tid}</span>
                  {report?.abnormal && <span className="tag tag--critical">Abnormal</span>}
                  <span className="result-time">at {sinceArrival(patient, patient.testOrderedAt[tid])}</span>
                </div>
                <p className="result-text">{report ? report.text : 'Pending…'}</p>
              </li>
            );
          })}
        </ul>
      )}

      <div className="manual">
        <label className="field-label" htmlFor="test-search">Order a test yourself</label>
        <input
          id="test-search"
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search tests, e.g. troponin"
          autoComplete="off"
        />
        {matches.length > 0 && (
          <ul className="pick-list">
            {matches.map((t) => (
              <li key={t.id}>
                <span>{t.name}</span>
                <button type="button" className="btn btn-quiet btn-sm" onClick={() => { store.orderPolyclinicTest(t.id); coachAfterManualTest(t.id); setQ(''); }}>
                  Order
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

// ── Diagnosis ────────────────────────────────────────────────────────

function DiagnosisTab({ patient }: { patient: ActivePatient }) {
  const [picked, setPicked] = useState<string | null>(null);
  const submitted = patient.submittedDiagnosisId;
  const options = patient.case.diagnosisOptions;

  if (submitted) {
    return (
      <div className="tab-scroll">
        <div className="dx-locked">
          <p className="field-label">Your working diagnosis</p>
          <p className="dx-locked-name">{dxLabel(submitted)}</p>
          <p className="muted-note">Locked in. The attending will compare it with the case at the debrief.</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tab-scroll">
      <fieldset className="dx-options">
        <legend className="field-label">Pick the most likely diagnosis</legend>
        {options.map((id) => (
          <label key={id} className="dx-option">
            <input type="radio" name="dx" value={id} checked={picked === id} onChange={() => setPicked(id)} />
            <span>{dxLabel(id)}</span>
          </label>
        ))}
      </fieldset>
      <button
        type="button"
        className="btn btn-primary btn-block"
        disabled={!picked}
        onClick={() => {
          if (!picked) return;
          store.submitPolyclinicDiagnosis(picked);
          coachAfterDiagnosis(picked);
        }}
      >
        Submit diagnosis
      </button>
      <p className="muted-note">You can submit once. Take a history first.</p>
    </div>
  );
}

// ── Plan: prescriptions + follow-up ──────────────────────────────────

type NotifyStatus = { channels: string[]; telegram: { username: string; link: string } | null };

function PatientContactField() {
  const contact = usePatientContact();
  const [draft, setDraft] = useState(contact);
  const [status, setStatus] = useState<NotifyStatus | null>(null);
  useEffect(() => {
    const ctl = new AbortController();
    fetch('/agent/notify/status', { signal: ctl.signal })
      .then((r) => (r.ok ? r.json() : null))
      .then((d: NotifyStatus | null) => d && setStatus(d))
      .catch(() => undefined);
    return () => ctl.abort();
  }, []);
  useEffect(() => setDraft(contact), [contact]);
  const tg = status?.telegram;
  return (
    <div className="manual contact-field">
      <label className="field-label" htmlFor="patient-contact">Send to the patient (demo)</label>
      <input
        id="patient-contact"
        className="input"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => setPatientContact(draft)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') setPatientContact(draft);
        }}
        placeholder="telegram, @username, +91 98765 43210 or name@gmail.com"
        autoComplete="off"
      />
      {tg && (
        <p className="contact-tg">
          <a href={tg.link} target="_blank" rel="noreferrer noopener" className="step-link">
            Open @{tg.username} and press Start
          </a>
          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setPatientContact('telegram')}>
            Use Telegram
          </button>
        </p>
      )}
      <p className="muted-note">
        Then say "Nurse, send the prescription to the patient". Asha sends the medicines, a Murf voice note in the patient's
        language and the follow-up calendar invite
        {status ? ` (ready: ${status.channels.join(', ') || 'no channel configured yet'})` : ''}.
      </p>
    </div>
  );
}

function PlanTab({ patient }: { patient: ActivePatient }) {
  const [q, setQ] = useState('');
  const rx = patient.prescriptions ?? [];
  const matches = useMemo(() => {
    const s = q.trim().toLowerCase();
    if (!s) return [];
    return MEDICATIONS.filter((m) => m.name.toLowerCase().includes(s) || m.class.toLowerCase().includes(s)).slice(0, 5);
  }, [q]);

  return (
    <div className="tab-scroll">
      <h3 className="block-title">Prescriptions</h3>
      {rx.length === 0 ? (
        <p className="muted-note">Nothing prescribed. Say “Start her on…” or add one below.</p>
      ) : (
        <ul className="rx-list">
          {rx.map((r, i) => {
            const m = medicationById(r.medicationId);
            return (
              <li key={`${r.medicationId}-${i}`} className="rx">
                <span className="rx-name">{m?.name ?? r.medicationId}</span>
                <span className="rx-dose">{r.dose} · {r.duration}</span>
              </li>
            );
          })}
        </ul>
      )}

      <h3 className="block-title">Follow-up</h3>
      {patient.followUp ? (
        <p className="followup">
          In {patient.followUp.inDays} {patient.followUp.inDays === 1 ? 'day' : 'days'}: {patient.followUp.reason}
        </p>
      ) : (
        <p className="muted-note">None booked. Ask the nurse to schedule one.</p>
      )}

      <FollowUpCallReports caseId={patient.case.id} />

      <VoiceRx patient={patient} />

      <PatientContactField />

      <div className="manual">
        <label className="field-label" htmlFor="med-search">Prescribe yourself</label>
        <input
          id="med-search"
          className="input"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search medicines, e.g. amlodipine"
          autoComplete="off"
        />
        {matches.length > 0 && (
          <ul className="pick-list">
            {matches.map((m) => (
              <li key={m.id}>
                <span>
                  {m.name}
                  <span className="pick-sub">{m.defaultDose}, {m.defaultDuration}</span>
                </span>
                <button
                  type="button"
                  className="btn btn-quiet btn-sm"
                  onClick={() => {
                    store.addPolyclinicPrescription({ medicationId: m.id, dose: m.defaultDose, duration: m.defaultDuration });
                    coachAfterManualPrescription(m.id, m.defaultDose, m.defaultDuration);
                    setQ('');
                  }}
                >
                  Prescribe
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
