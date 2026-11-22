import { useEffect, useRef, useState } from 'react';
import { useStore } from '../../game/store';
import type { ActivePatient } from '../../game/types';
import { LANGS, LANG_LABEL, LANG_NAME, normLang, LANG_LOCALE, type Lang } from '../../game/lang';
import { medicationById } from '../../data/medications';
import { POLYCLINIC_DIAGNOSIS_LABELS } from '../../data/polyclinicPatients';
import { acquireAudio } from '../../voice/speech';

interface RxAudioResult {
  script: string;
  audioBase64: string;
  mime: string;
  voiceId: string;
  locale: string;
}

export function rxAudioFileName(caseId: string): string {
  return `voice-prescription-${caseId.replace(/[^a-zA-Z0-9_-]+/g, '-')}.mp3`;
}

export function buildRxAudioRequest(patient: ActivePatient, lang: Lang) {
  const c = patient.case;
  const dx = patient.submittedDiagnosisId;
  return {
    caseId: c.id,
    patient: { name: c.name, age: c.age, gender: c.gender },
    prescriptions: (patient.prescriptions ?? []).map((rx) => ({
      name: medicationById(rx.medicationId)?.name ?? rx.medicationId,
      dose: rx.dose,
      duration: rx.duration,
    })),
    ...(patient.followUp ? { followUp: patient.followUp } : {}),
    // Only a diagnosis the trainee already submitted: never leak the answer.
    ...(dx ? { diagnosisLabel: POLYCLINIC_DIAGNOSIS_LABELS[dx] ?? dx.replace(/-/g, ' ') } : {}),
    lang,
  };
}

function toBlobUrl(r: RxAudioResult): string {
  const bin = atob(r.audioBase64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return URL.createObjectURL(new Blob([bytes], { type: r.mime || 'audio/mpeg' }));
}

/** Player for the counselling audio. While it plays it owns the room: staff
 *  lines wait, the patient stops talking and the doctor's mic is held. */
function RoomAudio({ src }: { src: string }) {
  const el = useRef<HTMLAudioElement>(null);
  const release = useRef<(() => void) | null>(null);
  const stop = () => {
    release.current?.();
    release.current = null;
  };
  const start = () => {
    release.current ??= acquireAudio('voice-prescription', {
      interruptPatient: true,
      onPreempt: () => {
        el.current?.pause();
        stop();
      },
    });
  };
  useEffect(() => {
    const audio = el.current;
    return () => {
      audio?.pause();
      release.current?.();
      release.current = null;
    };
  }, [src]);
  return <audio ref={el} controls src={src} style={{ width: '100%' }} onPlay={start} onPause={stop} onEnded={stop} onError={stop} />;
}

/** Take-home counselling audio: a plain-language script of the prescription
 *  in the patient's language, spoken with Murf Falcon. */
export function VoiceRx({ patient }: { patient: ActivePatient }) {
  const sessionLang = useStore((s) => s.lang);
  const [lang, setLang] = useState<Lang>(sessionLang);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [script, setScript] = useState('');
  const [url, setUrl] = useState('');
  const urlRef = useRef('');
  const rxCount = patient.prescriptions?.length ?? 0;
  // A recalled and a replaced drug can leave the count unchanged.
  const rxKey = (patient.prescriptions ?? []).map((r) => `${r.medicationId}|${r.dose}|${r.duration}`).join(';');

  useEffect(() => setLang(sessionLang), [sessionLang]);
  useEffect(() => () => { if (urlRef.current) URL.revokeObjectURL(urlRef.current); }, []);
  // A new prescription or language makes the old audio stale.
  useEffect(() => {
    setScript('');
    setErr('');
    setUrl('');
    if (urlRef.current) URL.revokeObjectURL(urlRef.current);
    urlRef.current = '';
  }, [patient.case.id, rxKey, lang]);

  if (rxCount === 0) return null;

  async function generate() {
    setBusy(true);
    setErr('');
    try {
      const r = await fetch('/voice/rx-audio', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(buildRxAudioRequest(patient, lang)),
      });
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const data = (await r.json()) as RxAudioResult;
      const next = toBlobUrl(data);
      if (urlRef.current) URL.revokeObjectURL(urlRef.current);
      urlRef.current = next;
      setUrl(next);
      setScript(data.script);
    } catch {
      setErr('Could not make the voice prescription. Try again in a moment.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="voice-rx">
      <h3 className="block-title">Voice prescription</h3>
      <p className="muted-note">Counselling audio the patient can keep, in their language.</p>
      <div className="voice-rx-row">
        <select
          className="input"
          aria-label="Voice prescription language"
          value={lang}
          onChange={(e) => setLang(normLang(e.target.value))}
        >
          {LANGS.map((l) => (
            <option key={l} value={l} lang={LANG_LOCALE[l]}>
              {LANG_NAME[l]} {l === 'en' ? '' : LANG_LABEL[l]}
            </option>
          ))}
        </select>
        <button type="button" className="btn btn-quiet btn-sm" disabled={busy} onClick={generate}>
          {busy ? 'Creating...' : script ? 'Regenerate' : 'Voice prescription'}
        </button>
      </div>
      {err && <p className="muted-note" role="alert">{err}</p>}
      {script && (
        <>
          <p className="voice-rx-script subtitle-line" lang={LANG_LOCALE[lang]} style={{ fontFamily: 'var(--font-indic)' }}>
            {script}
          </p>
          {url && <RoomAudio src={url} />}
          {url && (
            <a className="btn btn-quiet btn-sm" href={url} download={rxAudioFileName(patient.case.id)}>
              Download MP3
            </a>
          )}
        </>
      )}
    </div>
  );
}
