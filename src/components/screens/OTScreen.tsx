import { Suspense, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from 'react';
import { Canvas, useFrame } from '@react-three/fiber';
import { PerformanceMonitor } from '@react-three/drei';
import { store, useStore } from '../../game/store';
import { LangToggle } from '../ui/LangToggle';
import { OTWorld, OT_COLLIDERS, OT_EXIT, OT_PLAYER_LOOK, OT_SPAWN, OT_STATIONS, STATION_REACH, type MonitorView } from '../world/OperatingTheatre';
import { ThirdPersonPlayer, isTypingTarget, makeRuntime, type PlayerRuntime } from '../world/ThirdPersonPlayer';
import { PostFX, WorldEnvironment, type FxQuality } from '../world/WorldFX';
import { Fade, KeyCap, MenuButton, PauseMenu, PromptPill, UI, labelStyle, panel } from '../world/worldUi';
import { loadSignFonts } from '../world/hindi';
import { LANG_LOCALE, readLang } from '../../game/lang';
import {
  DRUGS,
  DRUG_IDS,
  FLUID_LABEL,
  OT_SCENARIOS,
  SPEAKER_NAME,
  SPEAKER_SHORT,
  STATION_LABEL,
  STATION_OF,
  scenarioById,
  type CauteryMode,
  type DrugId,
  type FluidId,
  type OTAction,
  type Speaker,
  type StationId,
} from '../../ot/scenarios';
import {
  act,
  activeCalls,
  alarmOf,
  allergyConfirmed,
  answerChecklist,
  buildReport,
  createOT,
  currentChecklistItem,
  fmtDose,
  phaseLabel,
  tick,
  vitalsAt,
  type Feedback,
  type OTReport,
  type OTState,
} from '../../ot/engine';
import { parseChecklistAnswer, parseOTCommand } from '../../ot/commands';
import { cancelOTSpeech, setOTSpeakingListener, speakOT } from '../../ot/speech';
import { otHistoryPayload } from '../../ot/history';
import { saveEvalHistory } from '../../data/evalHistory';

const CAMERA_RIG = { distance: 2.7, minDistance: 1.2, maxDistance: 5, pivotHeight: 1.58, shoulder: 0.4, ceiling: 3.15 };
const TICK_MS = 250;
const VOICE_KEY = 'medsim:ot-voice';
const GOOD = '#7fe0a0';
const BAD = '#ff7a6b';

const SPEAKER_COLOR: Record<Speaker, string> = {
  surgeon: '#a8e27c',
  assistant: '#7fd6c8',
  anaesthetist: '#9cc4ff',
  nurse: '#ffc46b',
};

function pickQuality(): FxQuality | null {
  try {
    const q = new URLSearchParams(window.location.search).get('fx');
    if (q === 'low' || q === 'high') return q;
  } catch {
    /* ignore */
  }
  return null;
}

function readVoicePref(): boolean {
  try {
    return window.localStorage.getItem(VOICE_KEY) !== '0';
  } catch {
    return true;
  }
}

const btn: CSSProperties = {
  ...labelStyle,
  fontSize: 11,
  padding: '8px 10px',
  border: `2px solid ${UI.line}`,
  background: UI.bg,
  color: UI.text,
  boxShadow: '2px 2px 0 0 #061431',
  cursor: 'pointer',
  borderRadius: 0,
};
const btnOn: CSSProperties = { ...btn, background: UI.primary, color: '#0b1f4b' };
const field: CSSProperties = {
  boxSizing: 'border-box',
  fontFamily: UI.label,
  fontSize: 14,
  padding: '8px 10px',
  border: `2px solid ${UI.line}`,
  background: UI.bg,
  color: UI.text,
  outline: 'none',
  borderRadius: 0,
};
const small: CSSProperties = { fontFamily: UI.label, fontSize: 12.5, lineHeight: 1.4 };

// Browser speech recognition (Chrome/Edge). Typed loosely: not in lib.dom.
type SpeechRec = {
  lang: string;
  interimResults: boolean;
  continuous: boolean;
  onresult: ((e: { results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null;
  onend: (() => void) | null;
  onerror: (() => void) | null;
  start: () => void;
  stop: () => void;
};
function makeRecognizer(): SpeechRec | null {
  const w = window as unknown as { SpeechRecognition?: new () => SpeechRec; webkitSpeechRecognition?: new () => SpeechRec };
  const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition;
  return Ctor ? new Ctor() : null;
}

// ───────── probes ─────────

function Probe({ runtime, onStation, onExit }: { runtime: PlayerRuntime; onStation: (s: StationId | null) => void; onExit: (near: boolean) => void }) {
  const cur = useRef<{ st: StationId | null; exit: boolean }>({ st: null, exit: false });
  useFrame(() => {
    let best: StationId | null = null;
    let bestD = STATION_REACH;
    for (const s of OT_STATIONS) {
      const d = Math.hypot(runtime.pos.x - s.x, runtime.pos.z - s.z);
      if (d < bestD) {
        bestD = d;
        best = s.id;
      }
    }
    if (best !== cur.current.st) {
      cur.current.st = best;
      onStation(best);
    }
    const exit = Math.hypot(runtime.pos.x - OT_EXIT.x, runtime.pos.z - OT_EXIT.z) < 1.3;
    if (exit !== cur.current.exit) {
      cur.current.exit = exit;
      onExit(exit);
    }
  });
  return null;
}

// ───────── small pieces ─────────

function Section({ title, children, tone }: { title: ReactNode; children: ReactNode; tone?: string }) {
  return (
    <div style={{ background: UI.bg, border: `2px solid ${tone ?? UI.line}`, padding: '8px 10px', display: 'grid', gap: 6 }}>
      <div style={{ ...labelStyle, fontSize: 10, color: tone ?? UI.primary }}>{title}</div>
      {children}
    </div>
  );
}

function VitalsHud({ s }: { s: OTState }) {
  const v = vitalsAt(s);
  const leadOff = s.equipment.leadOff;
  const al = alarmOf(v, leadOff);
  const col = al.level === 'crit' ? BAD : al.level === 'warn' ? UI.amber : GOOD;
  const cell = (label: string, value: string, color: string, bad: boolean) => (
    <div style={{ minWidth: 58 }}>
      <div style={{ ...labelStyle, fontSize: 9, color, opacity: 0.85 }}>{label}</div>
      <div style={{ fontFamily: UI.heading, fontSize: 30, lineHeight: 0.95, color: bad ? BAD : color }}>{value}</div>
    </div>
  );
  return (
    <div style={{ ...panel, background: '#030807', padding: '8px 10px', display: 'grid', gap: 6, borderColor: col, boxShadow: `0 0 0 2px ${col}, 4px 4px 0 0 #061431` }} aria-label="Patient monitor">
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ width: 10, height: 10, background: col, boxShadow: al.level === 'ok' ? 'none' : `0 0 8px ${col}` }} aria-hidden="true" />
        <span style={{ ...labelStyle, fontSize: 10, color: col }}>{al.level === 'ok' ? 'Monitor' : al.reasons.join(' · ')}</span>
      </div>
      <div style={{ display: 'flex', gap: 10, flexWrap: 'wrap' }}>
        {cell('HR', leadOff ? '---' : String(v.hr), '#39d96b', !leadOff && (v.hr < 50 || v.hr > 120))}
        {cell('NIBP', `${v.sbp}/${v.dbp}`, '#ff8f8f', v.sbp < 90)}
        {cell('SpO2', `${v.spo2}`, '#4fd6ff', v.spo2 < 92)}
        {cell('EtCO2', v.etco2 === null ? '--' : String(v.etco2), '#ffd84a', false)}
        {cell('Temp', v.temp.toFixed(1), '#e8ecf0', v.temp < 36)}
        {cell('FiO2', `${s.equipment.fio2}`, '#c9d2dc', false)}
      </div>
    </div>
  );
}

// ───────── station panels ─────────

interface PanelProps {
  s: OTState;
  doAct: (a: OTAction) => void;
  result: string | null;
}

function IVPanel({ s, doAct }: PanelProps) {
  const eq = s.equipment;
  const [fluid, setFluid] = useState<FluidId>(eq.ivFluid);
  const [rate, setRate] = useState(String(eq.ivRate || 100));
  return (
    <>
      <Section title="Infusion pump">
        <div style={small}>
          {eq.ivRunning ? `Running: ${FLUID_LABEL[eq.ivFluid]} at ${eq.ivRate} mL/h` : 'Pump stopped'} · infused {Math.round(eq.infusedMl)} mL
          {eq.bolusMl > 0 ? ` · bolus ${Math.round(eq.bolusMl)} mL to go` : ''}
        </div>
      </Section>
      <Section title="Fluid">
        <div style={{ display: 'flex', gap: 6 }} role="radiogroup" aria-label="Fluid">
          {(['RL', 'NS', 'blood'] as FluidId[]).map((f) => (
            <button key={f} type="button" role="radio" aria-checked={fluid === f} onClick={() => setFluid(f)} style={fluid === f ? btnOn : btn}>
              {f === 'blood' ? 'PRBC' : f}
            </button>
          ))}
        </div>
        <div style={{ ...small, opacity: 0.8 }}>{FLUID_LABEL[fluid]}</div>
      </Section>
      <Section title="Rate">
        <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
          <input aria-label="Rate in mL per hour" type="number" min={0} max={2000} value={rate} onChange={(e) => setRate(e.target.value)} style={{ ...field, width: 90 }} />
          <span style={small}>mL/h</span>
          <button type="button" style={btnOn} onClick={() => doAct({ kind: 'fluid-rate', fluid, rateMlH: Math.max(0, Number(rate) || 0) })}>
            Set and start
          </button>
        </div>
        <button type="button" style={btn} onClick={() => doAct({ kind: 'fluid-stop' })}>
          Stop the drip
        </button>
      </Section>
      <Section title="Bolus (pressure bag)">
        <div style={{ display: 'flex', gap: 6 }}>
          {[250, 500, 1000].map((v) => (
            <button key={v} type="button" style={btn} onClick={() => doAct({ kind: 'fluid-bolus', fluid, volumeMl: v })}>
              {v} mL
            </button>
          ))}
        </div>
      </Section>
    </>
  );
}

function DrugPanel({ s, doAct }: PanelProps) {
  const [drug, setDrug] = useState<DrugId>('phenylephrine');
  const [custom, setCustom] = useState('');
  const info = DRUGS[drug];
  const confirmed = allergyConfirmed(s);
  return (
    <>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 4 }} role="radiogroup" aria-label="Drug">
        {DRUG_IDS.map((d) => (
          <button
            key={d}
            type="button"
            role="radio"
            aria-checked={drug === d}
            onClick={() => {
              setDrug(d);
              setCustom('');
            }}
            style={{ ...(drug === d ? btnOn : btn), textTransform: 'none', letterSpacing: '.02em', fontSize: 12, textAlign: 'left' }}
          >
            {DRUGS[d].label}
          </button>
        ))}
      </div>
      <Section title={`Syringe label: ${info.label}`}>
        <div style={{ ...small, opacity: 0.85 }}>{info.prep}</div>
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          {info.options.map((o) => (
            <button key={o} type="button" style={btn} onClick={() => doAct({ kind: 'drug', drug, dose: o })}>
              Give {fmtDose(drug, o)}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            const n = Number(custom);
            if (n > 0) doAct({ kind: 'drug', drug, dose: n });
          }}
          style={{ display: 'flex', gap: 6, alignItems: 'center' }}
        >
          <input aria-label={`Other dose in ${info.unit}`} value={custom} onChange={(e) => setCustom(e.target.value)} inputMode="decimal" placeholder="Other dose" style={{ ...field, width: 110 }} />
          <span style={small}>{info.unit}</span>
          <button type="submit" style={btn} disabled={!(Number(custom) > 0)}>
            Give
          </button>
        </form>
      </Section>
      <div style={{ ...small, color: confirmed ? GOOD : UI.amber }}>{confirmed ? 'Allergy status confirmed.' : 'Allergy status not confirmed yet.'}</div>
      {s.drugs.length > 0 && (
        <Section title="Drug chart">
          {s.drugs.slice(-6).map((d, i) => (
            <div key={i} style={small}>
              {Math.floor(d.t / 60)}:{String(Math.floor(d.t % 60)).padStart(2, '0')} · {DRUGS[d.drug].label} {fmtDose(d.drug, d.dose)}
            </div>
          ))}
        </Section>
      )}
    </>
  );
}

function SuctionPanel({ s, doAct }: PanelProps) {
  const eq = s.equipment;
  const [p, setP] = useState(eq.suctionPressure || 0);
  return (
    <>
      <Section title="Status">
        <div style={small}>
          Suction {eq.suctionOn ? 'ON' : 'OFF'} · regulator {eq.suctionPressure} mmHg
        </div>
      </Section>
      <Section title="Vacuum regulator">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="range" min={0} max={400} step={10} value={p} onChange={(e) => setP(Number(e.target.value))} aria-label="Suction pressure in mmHg" style={{ flex: 1 }} />
          <span style={{ fontFamily: UI.heading, fontSize: 26, minWidth: 92, textAlign: 'right' }}>{p} mmHg</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" style={btnOn} onClick={() => doAct({ kind: 'suction', on: true, pressure: p })}>
            Suction on
          </button>
          <button type="button" style={btn} onClick={() => doAct({ kind: 'suction', on: false })}>
            Off
          </button>
        </div>
      </Section>
    </>
  );
}

function CauteryPanel({ s, doAct }: PanelProps) {
  const eq = s.equipment;
  const [mode, setMode] = useState<CauteryMode>(eq.cauteryMode);
  return (
    <>
      <Section title="Generator" tone={eq.padOk ? undefined : BAD}>
        <div style={small}>
          {eq.cauteryOn ? 'ON' : 'OFF'} · {eq.cauteryMode.toUpperCase()} 40 W
        </div>
        {!eq.padOk && <div style={{ ...small, color: BAD, fontWeight: 700 }}>REM alarm: return electrode fault</div>}
      </Section>
      <Section title="Return electrode (patient plate)">
        <button type="button" style={btn} onClick={() => doAct({ kind: 'cautery', on: eq.cauteryOn, mode: eq.cauteryMode, padChecked: true })}>
          Check and re-apply the pad
        </button>
      </Section>
      <Section title="Mode">
        <div style={{ display: 'flex', gap: 6 }} role="radiogroup" aria-label="Mode">
          {(['cut', 'coag', 'bipolar'] as CauteryMode[]).map((m) => (
            <button key={m} type="button" role="radio" aria-checked={mode === m} onClick={() => setMode(m)} style={mode === m ? btnOn : btn}>
              {m}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" style={btnOn} onClick={() => doAct({ kind: 'cautery', on: true, mode })}>
            Power on
          </button>
          <button type="button" style={btn} onClick={() => doAct({ kind: 'cautery', on: false })}>
            Off
          </button>
        </div>
      </Section>
    </>
  );
}

function WarmerPanel({ s, doAct }: PanelProps) {
  const eq = s.equipment;
  const [t, setT] = useState(eq.warmerTemp);
  return (
    <>
      <Section title="Forced-air warmer">
        <div style={small}>
          {eq.warmerOn ? `ON at ${eq.warmerTemp} C` : 'OFF'} · patient {vitalsAt(s).temp.toFixed(1)} C
        </div>
      </Section>
      <Section title="Set temperature">
        <div style={{ display: 'flex', gap: 6 }} role="radiogroup" aria-label="Warmer temperature">
          {[32, 38, 43].map((v) => (
            <button key={v} type="button" role="radio" aria-checked={t === v} onClick={() => setT(v)} style={t === v ? btnOn : btn}>
              {v} C
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          <button type="button" style={btnOn} onClick={() => doAct({ kind: 'warmer', on: true, tempC: t })}>
            Warmer on
          </button>
          <button type="button" style={btn} onClick={() => doAct({ kind: 'warmer', on: false })}>
            Off
          </button>
        </div>
      </Section>
    </>
  );
}

function OxygenPanel({ s, doAct }: PanelProps) {
  const eq = s.equipment;
  const [f, setF] = useState(eq.fio2);
  const v = vitalsAt(s);
  return (
    <>
      <Section title="Ventilator">
        <div style={small}>
          FiO2 {eq.fio2}% · SpO2 {v.spo2}% · EtCO2 {v.etco2 === null ? 'not monitored (spinal)' : `${v.etco2} mmHg`}
        </div>
      </Section>
      <Section title="FiO2 knob">
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input type="range" min={21} max={100} value={f} onChange={(e) => setF(Number(e.target.value))} aria-label="FiO2 percent" style={{ flex: 1 }} />
          <span style={{ fontFamily: UI.heading, fontSize: 26, minWidth: 60, textAlign: 'right' }}>{f}%</span>
        </div>
        <div style={{ display: 'flex', gap: 6 }}>
          {[30, 50, 100].map((v2) => (
            <button key={v2} type="button" style={btn} onClick={() => setF(v2)}>
              {v2}%
            </button>
          ))}
          <button type="button" style={btnOn} onClick={() => doAct({ kind: 'oxygen', fio2: f })}>
            Set FiO2
          </button>
        </div>
      </Section>
    </>
  );
}

function PatientPanel({ doAct, result }: PanelProps) {
  return (
    <>
      <div style={{ display: 'grid', gap: 6 }}>
        <button type="button" style={btn} onClick={() => doAct({ kind: 'pulse-check' })}>
          Feel the radial pulse
        </button>
        <button type="button" style={btn} onClick={() => doAct({ kind: 'cap-refill' })}>
          Capillary refill
        </button>
        <button type="button" style={btn} onClick={() => doAct({ kind: 'allergy-check' })}>
          Read the ID and allergy band
        </button>
      </div>
      {result && (
        <Section title="Finding">
          <div style={small}>{result}</div>
        </Section>
      )}
    </>
  );
}

function StationPanel({ station, s, doAct, result, onClose }: PanelProps & { station: StationId; onClose: () => void }) {
  const props = { s, doAct, result };
  return (
    <aside
      aria-label={STATION_LABEL[station]}
      style={{ ...panel, position: 'absolute', right: 16, top: 184, width: 340, maxHeight: 'calc(100vh - 270px)', overflow: 'auto', padding: 12, display: 'grid', gap: 8, zIndex: 12, boxSizing: 'border-box' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <div style={{ fontFamily: UI.heading, fontSize: 28, lineHeight: 1, flex: 1 }}>{STATION_LABEL[station]}</div>
        <button type="button" onClick={onClose} style={btn} aria-label="Close panel">
          Close · E
        </button>
      </div>
      {station === 'iv' && <IVPanel {...props} />}
      {station === 'drugs' && <DrugPanel {...props} />}
      {station === 'suction' && <SuctionPanel {...props} />}
      {station === 'cautery' && <CauteryPanel {...props} />}
      {station === 'warmer' && <WarmerPanel {...props} />}
      {station === 'oxygen' && <OxygenPanel {...props} />}
      {station === 'patient' && <PatientPanel {...props} />}
    </aside>
  );
}

// ───────── checklist + case sheet ─────────

function CaseSheet({ s }: { s: OTState }) {
  const sc = scenarioById(s.scenarioId);
  const p = sc.patient;
  const rows: Array<[string, string]> = [
    ['Patient', `${p.name}, ${p.age}${p.sex}, ${p.weightKg} kg`],
    ['Procedure', p.procedure],
    ['Anaesthesia', sc.anaesthesia === 'GA' ? 'General (endotracheal)' : 'Spinal'],
    ['Consent', p.consent],
    ['Fasting', p.fasting],
    ['Allergy', s.allergyChecked ? p.allergy : 'On the wrist band: check the patient'],
    ['Notes', p.notes],
  ];
  return (
    <Section title="OT list · case sheet">
      {rows.map(([k, v]) => (
        <div key={k} style={{ ...small, display: 'grid', gridTemplateColumns: '84px 1fr', gap: 6 }}>
          <span style={{ ...labelStyle, fontSize: 9, opacity: 0.75, paddingTop: 2 }}>{k}</span>
          <span style={k === 'Allergy' && !s.allergyChecked ? { color: UI.amber } : undefined}>{v}</span>
        </div>
      ))}
    </Section>
  );
}

function ChecklistCard({ s, onAnswer }: { s: OTState; onAnswer: (id: string) => void }) {
  const item = currentChecklistItem(s);
  if (!item) return null;
  const sc = scenarioById(s.scenarioId);
  const stageItems = sc.checklist.filter((c) => c.stage === item.stage);
  return (
    <div style={{ ...panel, position: 'absolute', left: 16, bottom: 92, width: 420, padding: 12, display: 'grid', gap: 8, zIndex: 11 }} role="region" aria-label="WHO surgical safety checklist">
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 8 }}>
        <span style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>WHO checklist · {item.stage.replace('-', ' ')}</span>
        <span style={{ ...labelStyle, fontSize: 10, opacity: 0.7, marginLeft: 'auto' }}>
          {s.checklistIdx + 1} / {stageItems.length}
        </span>
      </div>
      <div style={{ fontFamily: UI.label, fontSize: 15, lineHeight: 1.35 }}>
        <span style={{ ...labelStyle, fontSize: 10, color: SPEAKER_COLOR[item.speaker], display: 'block' }}>{SPEAKER_NAME[item.speaker]}</span>
        {item.ask}
      </div>
      <div style={{ display: 'grid', gap: 4 }}>
        {item.options.map((o, i) => (
          <button key={o.id} type="button" onClick={() => onAnswer(o.id)} style={{ ...btn, textTransform: 'none', letterSpacing: '.02em', fontSize: 12.5, textAlign: 'left', display: 'flex', gap: 8 }}>
            <span style={{ color: UI.primary }}>{i + 1}</span> {o.label}
          </button>
        ))}
      </div>
      <div style={{ ...small, opacity: 0.75 }}>Click, press 1 to {item.options.length}, or say / type your answer.</div>
      <CaseSheet s={s} />
    </div>
  );
}

// ───────── report card ─────────

const GRADE_WORD: Record<OTReport['grade'], string> = {
  excellent: 'Excellent',
  good: 'Good',
  satisfactory: 'Satisfactory',
  borderline: 'Borderline',
  'clear-fail': 'Clear fail',
};

const OUTCOME_COLOR: Record<string, string> = { correct: GOOD, prevented: GOOD, partial: UI.amber, missed: BAD };

function ReportCard({
  report,
  onAgain,
  onPick,
  onLeave,
  onExplain,
  explain,
}: {
  report: OTReport;
  onAgain: () => void;
  onPick: () => void;
  onLeave: () => void;
  onExplain: (id: string) => void;
  explain: Record<string, { loading: boolean; text: string }>;
}) {
  const tone = report.score >= 70 ? GOOD : report.score >= 45 ? UI.amber : BAD;
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(5,11,26,.72)', display: 'grid', placeItems: 'center', zIndex: 45, padding: 16, boxSizing: 'border-box' }} role="dialog" aria-modal="true" aria-label="Operation theatre report card">
      <div style={{ ...panel, width: 'min(860px, 100%)', maxHeight: '100%', overflow: 'auto', padding: 18, boxSizing: 'border-box', display: 'grid', gap: 12 }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexWrap: 'wrap' }}>
          <div style={{ fontFamily: UI.heading, fontSize: 72, lineHeight: 0.85, color: tone }}>{report.score}</div>
          <div style={{ flex: 1, minWidth: 220 }}>
            <div style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>OT report card · {report.title}</div>
            <div style={{ fontFamily: UI.heading, fontSize: 34, lineHeight: 1 }}>{GRADE_WORD[report.grade]}</div>
            <div style={{ ...small, opacity: 0.85 }}>
              {report.patient} · problems {report.eventPct}% · WHO checklist {report.checklistPct}%
              {report.avgResponseS !== null ? ` · average response ${report.avgResponseS} s` : ''} · {Math.floor(report.durationS / 60)} min {report.durationS % 60} s
            </div>
          </div>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button type="button" style={btnOn} onClick={onAgain} autoFocus>
              Run it again
            </button>
            <button type="button" style={btn} onClick={onPick}>
              Another operation
            </button>
            <button type="button" style={btn} onClick={onLeave}>
              Leave theatre
            </button>
          </div>
        </div>

        {report.safety.length > 0 && (
          <Section title={`Safety errors (${report.safety.length})`} tone={BAD}>
            {report.safety.map((x, i) => (
              <div key={i} style={small}>
                {x.text}
              </div>
            ))}
          </Section>
        )}

        <div style={{ display: 'grid', gap: 6 }}>
          <div style={{ ...labelStyle, fontSize: 11, color: UI.primary }}>Call-outs</div>
          {report.events.map((e) => (
            <div key={e.id} style={{ background: UI.bg, borderLeft: `4px solid ${OUTCOME_COLOR[e.outcome]}`, padding: '8px 10px', display: 'grid', gap: 4 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', flexWrap: 'wrap' }}>
                <span style={{ fontFamily: UI.heading, fontSize: 22, lineHeight: 1 }}>{e.label}</span>
                <span style={{ ...labelStyle, fontSize: 9, color: '#0b1f4b', background: OUTCOME_COLOR[e.outcome], padding: '1px 6px' }}>{e.outcome}</span>
                <span style={{ ...small, opacity: 0.8 }}>
                  {e.points}/{e.max}
                  {e.responseS !== null ? ` · ${e.responseS} s` : ''}
                  {e.outcome === 'correct' || e.outcome === 'partial' ? (e.atStation ? ' · at the right station' : ' · by voice from elsewhere') : ''}
                  {e.wrongAttempts ? ` · ${e.wrongAttempts} wrong attempt${e.wrongAttempts > 1 ? 's' : ''}` : ''}
                </span>
                {(e.outcome === 'missed' || e.outcome === 'partial' || e.wrongAttempts > 0) && (
                  <button type="button" style={{ ...btn, padding: '3px 8px', fontSize: 10, marginLeft: 'auto' }} onClick={() => onExplain(e.id)} disabled={explain[e.id]?.loading}>
                    {explain[e.id]?.loading ? 'Explaining...' : 'Explain'}
                  </button>
                )}
              </div>
              <div style={{ ...small, opacity: 0.8 }}>
                <span style={{ color: SPEAKER_COLOR[e.speaker] }}>{SPEAKER_SHORT[e.speaker]}:</span> "{e.line}"
              </div>
              {e.attempts.length > 0 && <div style={{ ...small, opacity: 0.8 }}>You: {e.attempts.join('; ')}</div>}
              <div style={small}>
                <strong>Do:</strong> {e.model}. {e.teaching}
              </div>
              {explain[e.id]?.text && <div style={{ ...small, color: UI.primary }}>{explain[e.id].text}</div>}
            </div>
          ))}
        </div>

        <div style={{ display: 'grid', gap: 4 }}>
          <div style={{ ...labelStyle, fontSize: 11, color: UI.primary }}>WHO surgical safety checklist</div>
          {report.checklist.map((c) => (
            <div key={c.id} style={{ ...small, borderLeft: `4px solid ${c.ok ? GOOD : BAD}`, paddingLeft: 8 }}>
              <span style={{ ...labelStyle, fontSize: 9, opacity: 0.7 }}>{c.stage}</span> {c.ask} <em>{c.answer ?? 'not answered'}</em>
              {!c.ok && <span style={{ color: UI.amber }}> · Correct: {c.correctLabel}. {c.teaching}</span>}
            </div>
          ))}
        </div>
        <div style={{ ...small, opacity: 0.65 }}>Saved to your progress history. Synthetic training scenario, not clinical advice.</div>
      </div>
    </div>
  );
}

// ───────── start overlay ─────────

function StartCard({ onStart, onLeave }: { onStart: (id: string) => void; onLeave: () => void }) {
  return (
    <div style={{ position: 'absolute', inset: 0, background: 'rgba(5,11,26,.6)', display: 'grid', placeItems: 'center', zIndex: 45, padding: 16, boxSizing: 'border-box' }} role="dialog" aria-modal="true" aria-label="Choose an operation">
      <div style={{ ...panel, width: 'min(820px, 100%)', maxHeight: '100%', overflow: 'auto', padding: 18, display: 'grid', gap: 12, boxSizing: 'border-box' }}>
        <div>
          <div style={{ ...labelStyle, fontSize: 11, color: UI.primary }}>Operation theatre drill · ऑपरेशन थिएटर</div>
          <div style={{ fontFamily: UI.heading, fontSize: 40, lineHeight: 1 }}>You are the junior. Keep the patient safe.</div>
          <p style={{ ...small, fontSize: 14, margin: '6px 0 0', opacity: 0.9 }}>
            You do not operate. Run the WHO checklist, then when the surgeon or anaesthetist calls a problem, walk to the right station (E to use it) and set it up, or say / type the order. About 4 minutes, 6 call-outs.
          </p>
        </div>
        <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(220px, 1fr))', gap: 10 }}>
          {OT_SCENARIOS.map((sc) => (
            <button key={sc.id} type="button" onClick={() => onStart(sc.id)} style={{ ...btn, textTransform: 'none', letterSpacing: 0, textAlign: 'left', padding: 12, display: 'grid', gap: 6, alignContent: 'start' }}>
              <span style={{ fontFamily: UI.heading, fontSize: 26, lineHeight: 1 }}>{sc.title}</span>
              <span style={{ fontFamily: UI.label, fontSize: 13, opacity: 0.8 }}>{sc.hindi}</span>
              <span style={{ ...labelStyle, fontSize: 10, color: UI.primary }}>
                {sc.anaesthesia === 'GA' ? 'General anaesthesia' : 'Spinal'} · {sc.events.length} call-outs
              </span>
              <span style={{ fontFamily: UI.label, fontSize: 12.5, lineHeight: 1.35, opacity: 0.9 }}>{sc.summary}</span>
              <span style={{ ...labelStyle, fontSize: 11, color: '#0b1f4b', background: UI.primary, padding: '6px 8px', justifySelf: 'start' }}>Scrub in</span>
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', ...small, opacity: 0.85 }}>
          <span>
            <KeyCap>WASD</KeyCap>walk
          </span>
          <span>
            <KeyCap>E</KeyCap>use station
          </span>
          <span>
            <KeyCap>V</KeyCap>speak an order
          </span>
          <span>
            <KeyCap>1-3</KeyCap>checklist answer
          </span>
          <span>
            <KeyCap>Esc</KeyCap>menu
          </span>
        </div>
        <button type="button" style={{ ...btn, justifySelf: 'start' }} onClick={onLeave}>
          Back to the corridor
        </button>
      </div>
    </div>
  );
}

// ───────── screen ─────────

export function OTScreen() {
  const forced = useMemo(pickQuality, []);
  const [quality, setQuality] = useState<FxQuality>(forced ?? 'high');
  const [dpr, setDpr] = useState(1);
  const runtime = useMemo(() => makeRuntime(OT_SPAWN.x, OT_SPAWN.z, OT_SPAWN.yaw), []);
  const lang = useStore((st) => st.lang);
  const [fade, setFade] = useState(1);
  const [menu, setMenu] = useState(false);
  const leaving = useRef(false);

  const simRef = useRef<OTState | null>(null);
  const [, setVer] = useState(0);
  const bump = useCallback(() => setVer((v) => (v + 1) % 1_000_000), []);
  const [scenarioId, setScenarioId] = useState(OT_SCENARIOS[0].id);
  const [picking, setPicking] = useState(true);
  const [near, setNear] = useState<StationId | null>(null);
  const [nearExit, setNearExit] = useState(false);
  const [openPanel, setOpenPanel] = useState<StationId | null>(null);
  const [feedback, setFeedback] = useState<(Feedback & { id: number }) | null>(null);
  const [result, setResult] = useState<string | null>(null);
  const [cmd, setCmd] = useState('');
  const [heard, setHeard] = useState('');
  const [listening, setListening] = useState(false);
  const [voiceOn, setVoiceOn] = useState(readVoicePref);
  const [speaking, setSpeaking] = useState<Speaker | null>(null);
  const [report, setReport] = useState<OTReport | null>(null);
  const [explain, setExplain] = useState<Record<string, { loading: boolean; text: string }>>({});
  const lastLogId = useRef(0);
  const reported = useRef(false);
  const recRef = useRef<SpeechRec | null>(null);
  const voiceRef = useRef(voiceOn);
  voiceRef.current = voiceOn;
  const langRef = useRef(lang);
  langRef.current = lang;
  const nearRef = useRef(near);
  nearRef.current = near;

  const s = simRef.current;
  const sc = scenarioById(s?.scenarioId ?? scenarioId);

  useEffect(() => {
    void loadSignFonts();
    const t = window.setTimeout(() => setFade(0), 120);
    setOTSpeakingListener(setSpeaking);
    if (import.meta.env.DEV) (window as unknown as { __medsimPlayer?: PlayerRuntime }).__medsimPlayer = runtime;
    return () => {
      window.clearTimeout(t);
      setOTSpeakingListener(null);
      cancelOTSpeech();
      recRef.current?.stop();
    };
  }, [runtime]);

  useEffect(() => {
    runtime.inputEnabled = !menu && !leaving.current && !picking && !report && !openPanel;
  }, [menu, picking, report, openPanel, runtime]);

  /** Voice and finish handling for any new log lines. */
  const afterChange = useCallback(() => {
    const cur = simRef.current;
    if (!cur) return;
    for (const l of cur.log) {
      if (l.id <= lastLogId.current) continue;
      lastLogId.current = l.id;
      if (voiceRef.current && l.who !== 'you' && l.who !== 'system') speakOT(l.text, l.who, langRef.current);
    }
    if (cur.stage === 'done' && !reported.current) {
      reported.current = true;
      const rep = buildReport(cur);
      setReport(rep);
      setOpenPanel(null);
      try {
        saveEvalHistory(otHistoryPayload(rep));
      } catch {
        /* storage blocked: the card still shows */
      }
    }
    bump();
  }, [bump]);

  // Simulation clock.
  useEffect(() => {
    const id = window.setInterval(() => {
      const cur = simRef.current;
      if (!cur || menu || picking || cur.stage === 'done') return;
      simRef.current = tick(cur, TICK_MS / 1000);
      afterChange();
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [menu, picking, afterChange]);

  useEffect(() => {
    if (!feedback) return;
    const t = window.setTimeout(() => setFeedback(null), 6000);
    return () => window.clearTimeout(t);
  }, [feedback]);

  const start = useCallback(
    (id: string) => {
      cancelOTSpeech();
      const seed = (Date.now() % 100000) + 1;
      simRef.current = createOT(id, seed);
      lastLogId.current = 0;
      reported.current = false;
      setScenarioId(id);
      setPicking(false);
      setReport(null);
      setExplain({});
      setResult(null);
      setFeedback(null);
      setOpenPanel(null);
      runtime.pos.set(OT_SPAWN.x, 0, OT_SPAWN.z);
      runtime.yaw = OT_SPAWN.yaw;
      runtime.camYaw = OT_SPAWN.yaw + Math.PI;
      afterChange();
    },
    [afterChange, runtime],
  );

  const doAct = useCallback(
    (a: OTAction, station: StationId | null) => {
      const cur = simRef.current;
      if (!cur) return;
      const r = act(cur, a, { station });
      simRef.current = r.state;
      setFeedback({ ...r.feedback, id: Date.now() });
      if (a.kind === 'pulse-check' || a.kind === 'cap-refill' || a.kind === 'allergy-check') {
        const last = [...r.state.log].reverse().find((l) => l.who === 'system');
        setResult(last?.text ?? null);
      }
      afterChange();
    },
    [afterChange],
  );

  const doAnswer = useCallback(
    (optionId: string) => {
      const cur = simRef.current;
      if (!cur) return;
      const r = answerChecklist(cur, optionId);
      simRef.current = r.state;
      setFeedback({ ...r.feedback, id: Date.now() });
      afterChange();
    },
    [afterChange],
  );

  const submitCommand = useCallback(
    (raw: string) => {
      const text = raw.trim();
      const cur = simRef.current;
      if (!text || !cur) return;
      setHeard(text);
      const item = currentChecklistItem(cur);
      if (item) {
        const opt = parseChecklistAnswer(item, text);
        if (opt) {
          doAnswer(opt);
          return;
        }
      }
      const a = parseOTCommand(text);
      if (a) {
        const here = nearRef.current;
        doAct(a, here && STATION_OF[a.kind] === here ? here : null);
      } else {
        setFeedback({ tone: 'warn', text: `Did not catch "${text}". Try "suction on at 150", "giving atropine 0.6" or "500 ml RL bolus".`, id: Date.now() });
      }
    },
    [doAct, doAnswer],
  );

  const toggleMic = useCallback(() => {
    if (listening) {
      recRef.current?.stop();
      return;
    }
    const rec = makeRecognizer();
    if (!rec) {
      setFeedback({ tone: 'warn', text: 'Voice orders need Chrome or Edge. Type the order instead.', id: Date.now() });
      return;
    }
    rec.lang = LANG_LOCALE[readLang()];
    rec.interimResults = false;
    rec.continuous = true;
    rec.onresult = (e) => {
      const r = e.results[e.results.length - 1];
      if (r?.isFinal) submitCommand(String(r[0].transcript));
    };
    rec.onend = () => setListening(false);
    rec.onerror = () => setListening(false);
    recRef.current = rec;
    try {
      rec.start();
      setListening(true);
    } catch {
      setListening(false);
    }
  }, [listening, submitCommand]);

  const leave = useCallback(() => {
    if (leaving.current) return;
    leaving.current = true;
    runtime.inputEnabled = false;
    cancelOTSpeech();
    recRef.current?.stop();
    setMenu(false);
    setFade(1);
    window.setTimeout(() => store.exitOTToCorridor(), 600);
  }, [runtime]);

  const openStation = useCallback((st: StationId) => {
    setOpenPanel(st);
    setResult(null);
    try {
      if (document.pointerLockElement) document.exitPointerLock();
    } catch {
      /* ignore */
    }
  }, []);

  const explainEvent = useCallback(async (id: string) => {
    const rep = buildReport(simRef.current!);
    const e = rep.events.find((x) => x.id === id);
    if (!e) return;
    setExplain((m) => ({ ...m, [id]: { loading: true, text: m[id]?.text ?? '' } }));
    let text = `${e.model}. ${e.teaching}`;
    try {
      const r = await fetch('/agent/ot/explain', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scenario: rep.title, problem: e.label, callout: e.line, outcome: e.outcome, attempts: e.attempts, model: e.model, teaching: e.teaching, lang: langRef.current }),
      });
      if (r.ok) {
        const j = (await r.json()) as { explanation?: string };
        if (j.explanation) text = j.explanation;
      }
    } catch {
      /* offline: the textbook teaching point stands */
    }
    setExplain((m) => ({ ...m, [id]: { loading: false, text } }));
    if (voiceRef.current) speakOT(text, 'surgeon', langRef.current);
  }, []);

  // Keyboard.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (isTypingTarget(e.target) || e.repeat) return;
      if (e.code === 'Escape') {
        if (openPanel) setOpenPanel(null);
        else if (!leaving.current && !picking && !report) setMenu((m) => !m);
        return;
      }
      if (menu || picking || report) return;
      if (e.code === 'KeyE') {
        e.preventDefault();
        if (openPanel) setOpenPanel(null);
        else if (near) openStation(near);
        else if (nearExit) leave();
      } else if (e.code === 'KeyV') {
        e.preventDefault();
        toggleMic();
      } else if (/^Digit[1-9]$/.test(e.code) && simRef.current) {
        const item = currentChecklistItem(simRef.current);
        const opt = item?.options[Number(e.code.slice(5)) - 1];
        if (opt) {
          e.preventDefault();
          doAnswer(opt.id);
        }
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menu, picking, report, openPanel, near, nearExit, leave, openStation, toggleMic, doAnswer]);

  // Dev / coordinator hooks: drive the drill without the 3D walk.
  useEffect(() => {
    const w = window as unknown as { __ot?: unknown };
    w.__ot = {
      get state() {
        return simRef.current;
      },
      start,
      act: (a: OTAction, station: StationId | null = null) => doAct(a, station),
      answer: doAnswer,
      say: submitCommand,
      /** Fast-forward the sim clock by `sec` seconds. */
      skip: (sec: number) => {
        let cur = simRef.current;
        if (!cur) return;
        for (let t = 0; t < sec && cur.stage !== 'done'; t += 0.5) cur = tick(cur, 0.5);
        simRef.current = cur;
        afterChange();
      },
      report: () => (simRef.current ? buildReport(simRef.current) : null),
    };
    return () => {
      delete w.__ot;
    };
  }, [start, doAct, doAnswer, submitCommand, afterChange]);

  const getView = useCallback((): MonitorView => {
    const cur = simRef.current;
    if (!cur) return { v: { hr: 80, sbp: 120, dbp: 75, spo2: 99, etco2: 35, temp: 36.6 }, leadOff: false, alarm: 'ok', fio2: 50 };
    const v = vitalsAt(cur);
    return { v, leadOff: cur.equipment.leadOff, alarm: alarmOf(v, cur.equipment.leadOff).level, fio2: cur.equipment.fio2 };
  }, []);
  const getEquipment = useCallback(() => {
    const cur = simRef.current;
    const eq = cur?.equipment;
    const since = cur && cur.incisionAt !== null ? cur.t - cur.incisionAt : 0;
    return {
      ivRunning: !!eq && (eq.ivRunning || eq.bolusMl > 0),
      suctionOn: !!eq?.suctionOn,
      suctionLevel: eq?.suctionOn ? 0.15 + Math.min(0.6, since / 400) : 0.12,
      cauteryOn: !!eq?.cauteryOn,
      padOk: eq?.padOk ?? true,
      warmerOn: !!eq?.warmerOn,
    };
  }, []);

  const calls = s ? activeCalls(s) : [];
  const recent = s ? s.log.slice(-5) : [];
  const lastSpoken = s ? [...s.log].reverse().find((l) => l.who !== 'you' && l.who !== 'system') : undefined;
  const showBubble = !!lastSpoken && !!s && s.t - lastSpoken.t < 9;
  const checklistOpen = !!s && !!currentChecklistItem(s);
  const elapsed = s ? Math.floor(s.t) : 0;

  return (
    <div style={{ position: 'fixed', inset: 0, background: '#050b1a', overflow: 'hidden' }}>
      <Canvas
        shadows
        dpr={dpr}
        gl={{ antialias: false, powerPreference: 'high-performance', stencil: false }}
        camera={{ fov: 56, near: 0.05, far: 60, position: [OT_SPAWN.x, 1.9, OT_SPAWN.z + 2.5] }}
        style={{ position: 'absolute', inset: 0 }}
        onCreated={(st) => {
          if (import.meta.env.DEV) (window as unknown as { __r3f?: unknown }).__r3f = st;
        }}
      >
        <color attach="background" args={['#06080c']} />
        <PerformanceMonitor
          bounds={() => [45, 58]}
          flipflops={3}
          onDecline={() => {
            if (!forced && quality === 'high') setQuality('low');
            else setDpr((d) => Math.max(0.6, d - 0.15));
          }}
          onIncline={() => setDpr((d) => Math.min(1.25, d + 0.1))}
        />
        <Suspense fallback={null}>
          <WorldEnvironment intensity={0.3} />
          <OTWorld runtime={runtime} kind={sc.kind} spinal={sc.anaesthesia === 'spinal'} near={near} getView={getView} getEquipment={getEquipment} />
          <ThirdPersonPlayer runtime={runtime} colliders={OT_COLLIDERS} rig={CAMERA_RIG} look={OT_PLAYER_LOOK} />
          <Probe runtime={runtime} onStation={setNear} onExit={setNearExit} />
          <PostFX quality={quality} />
        </Suspense>
      </Canvas>

      {/* location + phase */}
      <div style={{ ...panel, position: 'absolute', top: 16, left: 16, padding: '8px 12px', pointerEvents: 'none', zIndex: 5, maxWidth: 360 }}>
        <div style={{ ...labelStyle, color: UI.primary, fontSize: 11 }}>Operation Theatre · ऑपरेशन थिएटर</div>
        <div style={{ fontFamily: UI.heading, fontSize: 28, lineHeight: 1, marginTop: 2 }}>{s ? sc.title : 'Choose an operation'}</div>
        {s && (
          <div style={{ ...labelStyle, fontSize: 10, marginTop: 4, opacity: 0.9 }}>
            {phaseLabel(s)} · {Math.floor(elapsed / 60)}:{String(elapsed % 60).padStart(2, '0')}
          </div>
        )}
      </div>

      <div style={{ position: 'absolute', top: 16, right: 16, display: 'flex', gap: 8, zIndex: 6 }}>
        <button
          type="button"
          onClick={() => {
            const next = !voiceOn;
            setVoiceOn(next);
            if (!next) cancelOTSpeech();
            try {
              window.localStorage.setItem(VOICE_KEY, next ? '1' : '0');
            } catch {
              /* ignore */
            }
          }}
          aria-pressed={voiceOn}
          style={{ ...panel, ...labelStyle, padding: '10px 12px', cursor: 'pointer' }}
        >
          Team voice {voiceOn ? 'on' : 'off'}
        </button>
        <button type="button" onClick={() => setMenu(true)} style={{ ...panel, ...labelStyle, padding: '10px 14px', cursor: 'pointer' }}>
          Menu · Esc
        </button>
      </div>

      {/* monitor mirror */}
      {s && (
        <div style={{ position: 'absolute', top: 68, right: 16, zIndex: 6, width: 340 }}>
          <VitalsHud s={s} />
        </div>
      )}

      {/* call-out bubble + active problems */}
      {s && (showBubble || calls.length > 0) && (
        <div style={{ position: 'absolute', top: 16, left: '50%', transform: 'translateX(-50%)', width: 'min(520px, calc(100vw - 820px))', minWidth: 300, zIndex: 7, display: 'grid', gap: 6, pointerEvents: 'none' }} aria-live="polite">
          {showBubble && lastSpoken && lastSpoken.who !== 'you' && lastSpoken.who !== 'system' && (
            <div style={{ ...panel, padding: '10px 14px', borderColor: SPEAKER_COLOR[lastSpoken.who], boxShadow: `0 0 0 2px ${SPEAKER_COLOR[lastSpoken.who]}, 4px 4px 0 0 #061431` }}>
              <div style={{ ...labelStyle, fontSize: 10, color: SPEAKER_COLOR[lastSpoken.who], display: 'flex', gap: 6 }}>
                {SPEAKER_NAME[lastSpoken.who]}
                {speaking === lastSpoken.who && <span aria-hidden="true">· speaking</span>}
              </div>
              <div style={{ fontFamily: UI.heading, fontSize: 28, lineHeight: 1.05 }}>{lastSpoken.text}</div>
            </div>
          )}
          {calls.map((c) => {
            const left = Math.max(0, 1 - c.sinceS / c.def.deadlineS);
            return (
              <div key={c.run.id} style={{ ...panel, padding: '6px 10px', display: 'grid', gap: 4, borderColor: left < 0.4 ? BAD : UI.amber }}>
                <div style={{ display: 'flex', gap: 8, alignItems: 'baseline' }}>
                  <span style={{ ...labelStyle, fontSize: 9, color: UI.amber }}>Open problem</span>
                  <span style={{ fontFamily: UI.label, fontSize: 13, flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{c.def.line}</span>
                  <span style={{ fontFamily: UI.heading, fontSize: 20 }}>{Math.floor(c.sinceS)} s</span>
                </div>
                <div style={{ height: 5, background: UI.bg }}>
                  <div style={{ height: '100%', width: `${left * 100}%`, background: left < 0.4 ? BAD : UI.amber }} />
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* theatre log */}
      {s && !checklistOpen && (
        <div style={{ ...panel, position: 'absolute', left: 16, top: 104, width: 340, padding: '8px 10px', zIndex: 5, display: 'grid', gap: 3, pointerEvents: 'none', opacity: 0.94 }} aria-label="Theatre log">
          <div style={{ ...labelStyle, fontSize: 9, color: UI.primary }}>Theatre log</div>
          {recent.map((l) => (
            <div key={l.id} style={{ ...small, fontSize: 12, color: l.tone === 'bad' ? BAD : l.tone === 'good' ? GOOD : undefined }}>
              <span style={{ ...labelStyle, fontSize: 9, color: l.who === 'you' ? UI.amber : l.who === 'system' ? '#c9d2dc' : SPEAKER_COLOR[l.who] }}>
                {l.who === 'you' ? 'You' : l.who === 'system' ? 'Note' : SPEAKER_SHORT[l.who]}
              </span>{' '}
              {l.text}
            </div>
          ))}
        </div>
      )}

      {s && checklistOpen && !report && <ChecklistCard s={s} onAnswer={doAnswer} />}

      {s && openPanel && !report && (
        <StationPanel station={openPanel} s={s} doAct={(a) => doAct(a, openPanel)} result={result} onClose={() => setOpenPanel(null)} />
      )}

      {/* feedback toast */}
      {feedback && !report && (
        <div
          role="status"
          style={{
            ...panel,
            position: 'absolute',
            left: '50%',
            bottom: 150,
            transform: 'translateX(-50%)',
            maxWidth: 520,
            padding: '10px 14px',
            zIndex: 13,
            borderColor: feedback.tone === 'good' ? GOOD : feedback.tone === 'bad' ? BAD : UI.amber,
            boxShadow: `0 0 0 2px ${feedback.tone === 'good' ? GOOD : feedback.tone === 'bad' ? BAD : UI.amber}, 4px 4px 0 0 #061431`,
            fontFamily: UI.label,
            fontSize: 14,
            lineHeight: 1.4,
            pointerEvents: 'none',
          }}
        >
          {feedback.text}
        </div>
      )}

      {/* command bar */}
      {s && !report && (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            submitCommand(cmd);
            setCmd('');
          }}
          style={{ ...panel, position: 'absolute', left: 16, bottom: 16, padding: 8, display: 'flex', gap: 6, alignItems: 'center', zIndex: 10, width: 'min(560px, calc(100vw - 32px))', boxSizing: 'border-box' }}
        >
          <button type="button" onClick={toggleMic} aria-pressed={listening} style={listening ? btnOn : btn} title="Speak an order (V)">
            {listening ? 'Listening' : 'Speak · V'}
          </button>
          <input
            value={cmd}
            onChange={(e) => setCmd(e.target.value)}
            aria-label="Type an order or a checklist answer"
            placeholder={checklistOpen ? 'Answer: "no known allergy", "yes, site marked"...' : 'Order: "500 ml RL bolus", "atropine 0.6", "suction on 150"'}
            style={{ ...field, flex: 1, minWidth: 0 }}
          />
          <button type="submit" style={btnOn} disabled={!cmd.trim()}>
            Do it
          </button>
          {heard && <span style={{ ...small, fontSize: 11, opacity: 0.7, maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={heard}>"{heard}"</span>}
        </form>
      )}

      {!menu && !openPanel && !picking && !report && near && (
        <div style={{ position: 'absolute', left: 0, right: 0, bottom: 0, top: 0, pointerEvents: 'none', zIndex: 8 }}>
          <PromptPill title={STATION_LABEL[near]} sub="Use station" />
        </div>
      )}
      {!menu && !openPanel && !picking && !report && !near && nearExit && (
        <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 8 }}>
          <PromptPill title="Return to corridor" sub="Operation Theatre" />
        </div>
      )}

      {picking && <StartCard onStart={start} onLeave={leave} />}
      {report && (
        <ReportCard
          report={report}
          explain={explain}
          onExplain={(id) => void explainEvent(id)}
          onAgain={() => start(report.scenarioId)}
          onPick={() => {
            setReport(null);
            simRef.current = null;
            setPicking(true);
          }}
          onLeave={leave}
        />
      )}

      {menu && (
        <PauseMenu title="Theatre paused">
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <span style={{ ...labelStyle, fontSize: 11, color: UI.primary }}>Voice language</span>
            <LangToggle className="lang-toggle--end" />
          </div>
          <MenuButton primary autoFocus onClick={() => setMenu(false)}>
            Resume
          </MenuButton>
          <MenuButton
            onClick={() => {
              setMenu(false);
              cancelOTSpeech();
              simRef.current = null;
              setReport(null);
              setPicking(true);
            }}
          >
            Choose another operation
          </MenuButton>
          <MenuButton onClick={leave}>Leave theatre (back to corridor)</MenuButton>
        </PauseMenu>
      )}
      <div style={{ position: 'absolute', inset: 0, pointerEvents: 'none', zIndex: 60 }}>
        <Fade opacity={fade} />
      </div>
    </div>
  );
}

export default OTScreen;
