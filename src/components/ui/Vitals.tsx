import type { PatientCase } from '../../game/types';

type Vitals = PatientCase['vitals'];

interface VitalSpec {
  key: keyof Vitals;
  label: string;
  unit: string;
  abnormal: (v: Vitals) => boolean;
  format?: (v: Vitals) => string;
}

function systolic(bp: string): number {
  const n = parseInt(bp.split('/')[0] ?? '', 10);
  return Number.isFinite(n) ? n : 120;
}

function diastolic(bp: string): number {
  const n = parseInt(bp.split('/')[1] ?? '', 10);
  return Number.isFinite(n) ? n : 80;
}

/** Adult outpatient reference ranges, only used to flag a reading, not
 *  to grade anything. */
const SPECS: VitalSpec[] = [
  { key: 'hr', label: 'HR', unit: 'bpm', abnormal: (v) => v.hr > 100 || v.hr < 50 },
  {
    key: 'bp',
    label: 'BP',
    unit: 'mmHg',
    abnormal: (v) => systolic(v.bp) >= 140 || systolic(v.bp) < 90 || diastolic(v.bp) >= 90,
  },
  { key: 'spo2', label: 'SpO₂', unit: '%', abnormal: (v) => v.spo2 < 94 },
  { key: 'temp', label: 'Temp', unit: '°C', abnormal: (v) => v.temp >= 38 || v.temp < 35.5, format: (v) => v.temp.toFixed(1) },
  { key: 'rr', label: 'RR', unit: '/min', abnormal: (v) => v.rr > 20 || v.rr < 10 },
];

export function VitalsRow({ vitals, compact = false }: { vitals: Vitals; compact?: boolean }) {
  return (
    <dl className={`vitals ${compact ? 'vitals--compact' : ''}`}>
      {SPECS.map((s) => {
        const off = s.abnormal(vitals);
        return (
          <div key={s.key} className={`vital ${off ? 'vital--off' : ''}`}>
            <dt>{s.label}</dt>
            <dd>
              <span className="vital-value">{s.format ? s.format(vitals) : String(vitals[s.key])}</span>
              <span className="vital-unit">{s.unit}</span>
              {off && <span className="sr-only"> (outside normal range)</span>}
            </dd>
          </div>
        );
      })}
    </dl>
  );
}
