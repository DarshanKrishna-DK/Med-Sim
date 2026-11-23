import { useMemo } from 'react';
import { store } from '../../game/store';
import { CASES, getPatientCase } from '../../data/cases';
import { TESTS } from '../../data/tests';
import { MEDICATIONS } from '../../data/medications';
import { CLINIC_IDS, CLINIC_LABELS, type ClinicId } from '../../game/clinic';
import { AppHeader, enterHospital, goToLandingSection } from '../ui/chrome';
import { Pipeline } from '../ui/Pipeline';
import MedSimFigure from '../ui/MedSimFigure';
import { HeroPreview } from '../ui/HeroPreview';
import { HospitalScene } from '../ui/pixel/HospitalScene';
import { SiteFooter } from '../ui/SiteFooter';
import { AttendingPortrait, CLINIC_GLYPH, PixelGlyph } from '../ui/pixel/PixelIcon';
import { ArrowIcon, CountUp, Dither, OrnamentRule } from '../ui/pixel/Bits';
import { BandChip } from '../ui/BandChip';

const SPECIALTIES = CLINIC_IDS.filter((id) => id !== 'all-specialties' && CASES.some((c) => c.clinic === id));

interface SpecialtyStat {
  id: ClinicId;
  count: number;
  minAge: number;
  maxAge: number;
  flagged: number;
}

function specialtyStats(): SpecialtyStat[] {
  return SPECIALTIES.map((id) => {
    const list = CASES.filter((c) => c.clinic === id);
    const ages = list.map((c) => c.age);
    const flagged = list.filter((c) => {
      const s = getPatientCase(c.id)?.severity;
      return s === 'urgent' || s === 'critical';
    }).length;
    return { id, count: list.length, minAge: Math.min(...ages), maxAge: Math.max(...ages), flagged };
  });
}

const NURSE_TOOLS = [
  { name: 'order_test', what: 'Orders labs, imaging and bedside tests; the result lands in the chart and a FHIR record.' },
  { name: 'check_allergies', what: 'Checks the allergy record plus NIH RxClass and the openFDA label, and cites them.' },
  { name: 'prescribe', what: 'Writes the prescription against the formulary; holds anything unsafe.' },
  { name: 'schedule_follow_up', what: 'Books it straight into Google Calendar, recurring if needed, with an Asha call link.' },
  { name: 'send_to_patient', what: 'Sends the Rx and a Murf voice prescription to the patient on Telegram or WhatsApp.' },
  { name: 'refer_patient', what: 'Writes an SBAR referral letter (Google Doc and PDF) and a voice handover.' },
];

/** Every agent a student meets, for the stats row. */
const AGENTS = [
  'Patient', 'Nurse Asha', 'Attending', 'Coach', 'Asha on follow-up calls', 'Asha on observer calls',
  'Priya at Reception', 'Dr. Iyer', 'Dr. Vikram Rao', 'Prof. Kulkarni', 'OSCE examiner', 'Theatre team',
];

const BEYOND = [
  { title: 'Departments in one room', what: 'Pharmacy, Lab, Radiology and the examiner are separate agents on BAND. Asha brings in only the one a case needs, each sees only what it is sent, and a human teacher can join the room to overrule them.' },
  { title: 'Follow-up calls', what: 'At the booked time Asha messages the patient and calls them over Agora. A red flag mid-call alerts the doctor on Telegram.' },
  { title: 'Faculty, by phone', what: '“Asha, invite Dr Rao.” She phones your tutor and texts a link: they listen live, and approve or deny a drug the pharmacy holds.' },
  { title: 'Assignments and Reception', what: 'Teachers assign cases with a code. Priya at the front desk tells you what is pending and emails your report card.' },
  { title: 'Agents with their own tools', what: 'Priya, Dr. Iyer and Prof. Kulkarni decide mid-call when to act: book a study slot, text you the plan, draw on the board, set an assignment, mark your answer.' },
  { title: 'Logbook and referrals', what: 'Every debrief adds a CBME logbook row in Google Sheets; referrals become PDFs in Drive.' },
];

export function LandingScreen() {
  const stats = useMemo(specialtyStats, []);

  return (
    <div className="page landing">
      <AppHeader overlay />
      <main>
        {/* ── Hero ─────────────────────────────────────────────── */}
        <section className="hero" aria-labelledby="hero-title">
          <HospitalScene />
          <div className="hero-inner">
            <div className="hero-copy">
              <div className="hero-logo enter" style={{ ['--enter-delay' as string]: '0.02s' }} aria-hidden="true">
                <img
                  src="/brand/medsim-logo-256.png"
                  width={136}
                  height={136}
                  alt=""
                  draggable={false}
                  className="hero-logo-img"
                />
              </div>
              <p className="kicker enter" style={{ ['--enter-delay' as string]: '0.1s' }}>
                The Voice-First Clinical Simulator
              </p>
              <h1 id="hero-title" className="wordmark enter" style={{ ['--enter-delay' as string]: '0.2s' }}>
                <span className="wordmark-text" data-text="MedSim">MedSim</span>
              </h1>
              <p className="hero-tag enter" style={{ ['--enter-delay' as string]: '0.32s' }}>
                Talk. Order. Get graded.
              </p>
              <div className="enter" style={{ ['--enter-delay' as string]: '0.4s' }}>
                <OrnamentRule />
              </div>
              <p className="hero-sub enter" style={{ ['--enter-delay' as string]: '0.48s' }}>
                {CASES.length} patients · {SPECIALTIES.length} specialties · 7 languages · {AGENTS.length} AI agents
              </p>
              <div className="hero-actions enter" style={{ ['--enter-delay' as string]: '0.56s' }}>
                <button type="button" className="btn btn-primary btn-lg" onClick={enterHospital}>
                  Enter the hospital
                </button>
                <button type="button" className="btn btn-secondary btn-lg" onClick={() => store.setScreen('library')}>
                  Case library <ArrowIcon />
                </button>
              </div>
              <button
                type="button"
                className="text-link enter"
                style={{ ['--enter-delay' as string]: '0.64s' }}
                onClick={() => goToLandingSection('how')}
              >
                How it works <ArrowIcon size={12} />
              </button>
            </div>
          </div>
        </section>

        {/* ── About / how it works ─────────────────────────────── */}
        <section id="how" className="band paper dots" aria-labelledby="how-title">
          <div className="wrap">
            <h2 id="how-title" className="h2">
              MedSim is a hospital that <span className="accent">talks back.</span>
            </h2>

            <div className="about-grid">
              <div className="dialog">
                <div className="dialog-head">
                  <AttendingPortrait size={64} />
                  <div>
                    <p className="kicker">Attending</p>
                    <p className="dialog-sub">Your first ward round starts here.</p>
                  </div>
                </div>
                <p className="dialog-body">
                  Sit down, the patient's already talking. Take the history out loud, tell the charge
                  nurse what you want and she'll run it, then commit to a diagnosis. When you end the
                  consultation I'll mark it against the rubric and show you the guideline behind
                  every point.
                </p>
              </div>
              <figure className="night" style={{ margin: 0 }}>
                <MedSimFigure className="medsim-figure" />
              </figure>
            </div>

            <Pipeline />

            <dl className="stats">
              <div className="stat">
                <dt>Specialties</dt>
                <dd><CountUp value={SPECIALTIES.length} /></dd>
              </div>
              <div className="stat">
                <dt>Patients</dt>
                <dd><CountUp value={CASES.length} /></dd>
              </div>
              <div className="stat">
                <dt>Orderable tests</dt>
                <dd><CountUp value={TESTS.length} /></dd>
              </div>
              <div className="stat">
                <dt>Medicines</dt>
                <dd><CountUp value={MEDICATIONS.length} /></dd>
              </div>
              <div className="stat">
                <dt>AI agents</dt>
                <dd><CountUp value={AGENTS.length} /></dd>
              </div>
            </dl>
          </div>
        </section>

        <Dither from="paper" to="night" />

        {/* ── The nurse agent ──────────────────────────────────── */}
        <section id="nurse" className="band night sky" aria-labelledby="nurse-title">
          <div className="wrap nurse-grid">
            <div>
              <h2 id="nurse-title" className="h2">
                A nurse that <span className="accent">gets things done.</span>
              </h2>
              <p className="lede">
                Say the order the way you would on a ward. The charge-nurse agent hears it in the
                transcript, plans it, calls her tools one by one, and tells you out loud when it's
                done. Her tools reach real systems: drug databases, a FHIR health record, Google
                Calendar and the patient's phone. If a tool refuses, you see why.
              </p>
              <ul className="tool-list">
                {NURSE_TOOLS.map((t) => (
                  <li key={t.name}>
                    <code className="tool-chip">{t.name}</code>
                    <span>{t.what}</span>
                  </li>
                ))}
              </ul>
            </div>
            <HeroPreview />
          </div>
        </section>

        <Dither from="night" to="paper" />

        {/* ── Agents beyond the room ── */}
        <section id="beyond" className="band paper" aria-labelledby="beyond-title">
          <div className="wrap landing-osce">
            <div>
              <h2 id="beyond-title" className="h2">
                Agents that keep <span className="accent">working.</span>
              </h2>
              <p className="lede">
                The consultation ends; the agents keep going. Asha follows up, phones your observer and files the
                paperwork, while Priya at Reception keeps your teacher in the loop. Every voice runs on Agora
                Conversational AI with Murf.
              </p>
              <p><BandChip /></p>
            </div>
            <div className="landing-osce-side">
              <ul className="osce-rules">
                {BEYOND.map((b) => (
                  <li key={b.title}>
                    <strong>{b.title}.</strong> {b.what}
                  </li>
                ))}
              </ul>
            </div>
          </div>
        </section>

        {/* ── Specialties rail ─────────────────────────────────── */}
        <section id="specialties" className="band paper dots" aria-labelledby="spec-title">
          <div className="wrap">
            <div className="band-head">
              <h2 id="spec-title" className="h2">
                Pick a <span className="accent">specialty.</span>
              </h2>
              <button type="button" className="text-link" onClick={() => store.setScreen('library')}>
                All patients <ArrowIcon size={12} />
              </button>
            </div>
          </div>
          <ul className="rail" aria-label="Specialties">
            {stats.map((s) => (
              <li key={s.id}>
                <button
                  type="button"
                  className="spec-card"
                  onClick={() => {
                    store.setPolyclinicClinic(s.id);
                    store.setScreen('library');
                  }}
                >
                  <span className="spec-vignette" aria-hidden="true">
                    <PixelGlyph name={CLINIC_GLYPH[s.id]} size={70} main="var(--primary)" hi="#f3f1e2" />
                  </span>
                  <span className="spec-body">
                    <span className="kicker">{s.count} patients</span>
                    <span className="spec-name">{CLINIC_LABELS[s.id]}</span>
                    <span className="chips">
                      <span className="chip">Ages {s.minAge}–{s.maxAge}</span>
                      {s.flagged > 0 && <span className="chip chip--warn">{s.flagged} urgent</span>}
                    </span>
                    <span className="spec-go" aria-hidden="true">
                      <ArrowIcon />
                    </span>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>

        {/* ── OSCE exam mode + progress ────────────────────────── */}
        <section id="osce" className="band paper" aria-labelledby="osce-title">
          <div className="wrap landing-osce">
            <div>
              <h2 id="osce-title" className="h2">
                Exam day, <span className="accent">rehearsed.</span>
              </h2>
              <p className="lede">
                OSCE mode runs one timed station like the real NExT and university OSCE: a candidate brief, eight
                minutes on the clock, no hints, then an examiner checklist with quotes from what you actually said.
              </p>
            </div>
            <div className="landing-osce-side">
              <ul className="osce-rules">
                <li>Stations drawn at random from one specialty or mixed.</li>
                <li>Met, partly met or not met for every item, plus a global rating.</li>
                <li>Missed safety errors revealed at the bell. Print the report as a PDF.</li>
                <li>My progress tracks scores, weak areas, recurring mistakes and your streak.</li>
              </ul>
              <div className="row-actions">
                <button type="button" className="btn btn-primary btn-lg" onClick={() => store.openOsce()}>
                  Start an OSCE station
                </button>
                <button type="button" className="btn btn-secondary btn-lg" onClick={() => store.setScreen('progress')}>
                  My progress <ArrowIcon />
                </button>
              </div>
            </div>
          </div>
        </section>

        <Dither from="paper" to="night" />
      </main>

      <SiteFooter />
    </div>
  );
}
