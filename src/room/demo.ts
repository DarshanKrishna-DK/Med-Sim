// Development fixture: plays a scripted room into the real reducer and panel
// (`?roomdemo=1`, dev server only, loaded behind import.meta.env.DEV so it is
// not in the production bundle). `&demostop=lab|hold|question|faculty|end`
// jumps straight to that point, for screenshots.

import type { RoomSession } from './session';
import type { Delegation, RoomEvent, RoomMessage, RoomParticipant, RoomRole } from './types';

type Body = Record<string, unknown>;
type Step = { after: number; mark?: string; e: Body };

const P: Record<RoomRole, RoomParticipant> = {
  nurse: { id: 'p-asha', role: 'nurse', name: 'Nurse Asha', title: 'Charge nurse', human: false, online: true },
  pharmacist: { id: 'p-meera', role: 'pharmacist', name: 'Pharmacist Meera', title: 'Clinical pharmacist', human: false, online: true },
  lab: { id: 'p-dev', role: 'lab', name: 'Lab Officer Dev', title: 'Laboratory', human: false, online: true },
  radiology: { id: 'p-vikram', role: 'radiology', name: 'Radiologist Vikram', title: 'Radiology', human: false, online: true },
  examiner: { id: 'p-kulkarni', role: 'examiner', name: 'Examiner Kulkarni', title: 'Examiner', human: false, online: true },
  faculty: { id: 'p-rao', role: 'faculty', name: 'Dr Anand Rao', title: 'Faculty', human: true, online: true },
};

const ROOM_ID = '7c1e4b90-5d2f-4a11-9f3e-0b6a2c8d1e55';
const room = (...roles: RoomRole[]): Body => ({
  type: 'room',
  roomId: ROOM_ID,
  url: `https://app.band.ai/rooms/${ROOM_ID}`,
  title: 'MedSim encounter',
  participants: roles.map((r) => P[r]),
});

let n = 0;
const msg = (from: RoomRole, to: RoomRole[], text: string, over: Partial<RoomMessage> = {}): Body => ({
  type: 'message',
  message: {
    id: over.id ?? `dm-${++n}`,
    from,
    fromName: P[from].name,
    to,
    text,
    type: 'text',
    human: P[from].human,
    at: new Date().toISOString(),
    delivery: to.length ? 'sent' : undefined,
    ...over,
  },
});

const rxPayload = {
  caseId: 'demo',
  medicationId: 'amoxicillin-clavulanate-1g',
  medication: 'Co-amoxiclav',
  dose: '1 g twice a day',
  duration: '7 days',
  patient: { age: 34, gender: 'F', allergies: 'Penicillin: rash as a child', chiefComplaint: 'Sore throat for 4 days', history: 'Asthma' },
  current: [{ medicationId: 'salbutamol', name: 'Salbutamol inhaler', dose: 'as needed' }],
};
const started: Record<string, string> = {};
const del = (d: Partial<Delegation> & Pick<Delegation, 'ref' | 'action' | 'target' | 'status' | 'label'>): Body => {
  started[d.ref] ??= new Date().toISOString();
  const open = d.status === 'sent' || d.status === 'working' || d.status === 'waiting';
  return { type: 'delegation', delegation: { startedAt: started[d.ref], ...(open ? {} : { finishedAt: new Date().toISOString() }), ...d } };
};
const RX = { ref: 'rx_4f2a91', action: 'verify_rx', target: 'pharmacist', label: 'Co-amoxiclav 1 g', medicationId: 'amoxicillin-clavulanate-1g', dose: '1 g twice a day', duration: '7 days' } as const;
type Order = Pick<Delegation, 'ref' | 'action' | 'target' | 'label' | 'testIds'>;
const LAB: Order = { ref: 'lab_77b1', action: 'run_test', target: 'lab', label: 'CBC, CRP', testIds: ['cbc', 'crp'] };
const IMG: Order = { ref: 'img_90cc', action: 'run_imaging', target: 'radiology', label: 'Chest X-ray', testIds: ['cxr'] };
const speak = (speaker: RoomRole, text: string, priority: string, ref: string): Body => ({
  type: 'speak',
  speak: { id: `sp-${++n}`, speaker, text, lang: 'en', priority, ref },
});

function script(): Step[] {
  const ask = { id: 'dm-ask', payload: rxPayload, kind: 'request', action: 'verify_rx', ref: RX.ref };
  const askText = 'Please verify co-amoxiclav 1 g twice a day for 7 days before it goes on the prescription.';
  const renal = { id: 'dm-renal', kind: 'query', action: 'renal_function', ref: RX.ref, payload: { caseId: 'demo' } };
  return [
    { after: 2500, e: room('nurse') },
    { after: 300, e: { type: 'message', message: { ...(msg('nurse', [], 'Looked up the hospital peers: only the pharmacist is needed for this order.', { type: 'thought' }).message as object) } } },
    { after: 500, e: room('nurse', 'pharmacist') },
    { after: 100, e: del({ ...RX, status: 'sent' }) },
    { after: 50, e: msg('nurse', ['pharmacist'], askText, ask) },
    { after: 900, e: msg('nurse', ['pharmacist'], askText, { ...ask, delivery: 'processing' }) },
    { after: 100, e: del({ ...RX, status: 'working' }) },
    { after: 900, e: msg('pharmacist', [], 'check_label(drug="amoxicillin")', { type: 'tool_call' }) },
    { after: 900, e: msg('pharmacist', [], 'openFDA label: contraindicated after a serious penicillin reaction', { type: 'tool_result' }) },
    { after: 300, e: room('nurse', 'pharmacist', 'lab') },
    { after: 200, e: msg('pharmacist', ['lab'], 'Does this patient have a recent creatinine or eGFR? I need it for the dose.', renal) },
    { after: 100, mark: 'lab', e: del({ ...RX, status: 'waiting', waitingOn: 'lab' }) },
    { after: 1800, e: msg('lab', ['pharmacist'], 'eGFR 94, creatinine 0.8 mg/dL. Normal renal function.', { kind: 'answer', action: 'renal_function', ref: RX.ref, payload: { available: true, creatinine: 0.8, egfr: 94, text: 'Normal' }, delivery: 'processed' }) },
    { after: 800, e: del({ ...RX, status: 'working' }) },
    {
      after: 1200,
      e: msg('pharmacist', ['nurse'], 'Hold co-amoxiclav. The chart records a rash with penicillin and amoxicillin is a penicillin.', {
        kind: 'verdict', action: 'verify_rx', ref: RX.ref, delivery: 'processed',
        payload: {
          verdict: 'hold', severity: 'hard', medicationId: 'amoxicillin-clavulanate-1g', reason: 'Documented penicillin allergy; amoxicillin is a penicillin.',
          suggestion: { medicationId: 'azithromycin', name: 'Azithromycin', dose: '500 mg once a day' },
          evidence: [{ source: 'Allergy record', detail: 'Penicillin: rash as a child' }, { source: 'openFDA label', detail: 'Contraindicated in penicillin hypersensitivity' }, { source: 'Lab', detail: 'eGFR 94, so renal dosing is not the problem' }],
        },
      }),
    },
    { after: 50, e: msg('nurse', ['pharmacist'], askText, { ...ask, delivery: 'processed' }) },
    { after: 50, e: del({ ...RX, status: 'held', summary: 'Documented penicillin allergy; amoxicillin is a penicillin.' }) },
    { after: 50, mark: 'hold', e: speak('pharmacist', 'Doctor, I am holding co-amoxiclav. The patient has a penicillin allergy.', 'urgent', RX.ref) },
    { after: 2500, e: del({ ...LAB, status: 'sent' }) },
    { after: 50, e: msg('nurse', ['lab'], 'Please run CBC and CRP.', { kind: 'request', action: 'run_test', ref: LAB.ref, payload: { caseId: 'demo', tests: [{ testId: 'cbc', name: 'CBC' }, { testId: 'crp', name: 'CRP' }], patient: { age: 34, gender: 'F' } }, delivery: 'delivered' }) },
    { after: 900, e: del({ ...LAB, status: 'working' }) },
    { after: 100, e: room('nurse', 'pharmacist', 'lab', 'radiology') },
    { after: 50, e: del({ ...IMG, status: 'sent' }) },
    { after: 50, e: msg('nurse', ['radiology'], 'Chest X-ray please. Indication: cough and fever.', { kind: 'request', action: 'run_imaging', ref: IMG.ref, payload: { caseId: 'demo', tests: [{ testId: 'cxr', name: 'Chest X-ray' }], patient: { age: 34, gender: 'F' }, indication: 'Cough and fever', pregnancy: 'unknown' }, delivery: 'processing' }) },
    { after: 900, e: msg('radiology', ['nurse'], 'Before I expose: could this patient be pregnant?', { kind: 'query', action: 'safety_question', ref: IMG.ref, payload: { question: 'Could this patient be pregnant?' }, delivery: 'processed' }) },
    { after: 50, e: del({ ...IMG, status: 'waiting', waitingOn: 'nurse' }) },
    { after: 50, mark: 'question', e: { type: 'question', ref: IMG.ref, from: 'radiology', text: 'Could this patient be pregnant?' } },
    { after: 2600, e: { type: 'apply', apply: { ref: LAB.ref, results: [{ testId: 'cbc', name: 'CBC', result: 'WBC 14.2, Hb 12.8, platelets 260', abnormal: true, critical: false }, { testId: 'crp', name: 'CRP', result: '86 mg/L', abnormal: true, critical: false }] } } },
    { after: 50, e: msg('lab', ['nurse'], 'CBC and CRP are back: white cells and CRP are raised.', { kind: 'result', action: 'run_test', ref: LAB.ref, payload: { results: [{ testId: 'cbc' }, { testId: 'crp' }] }, delivery: 'processed' }) },
    { after: 50, e: del({ ...LAB, status: 'done', summary: 'WBC 14.2, CRP 86 mg/L' }) },
    { after: 2000, e: { type: 'faculty', faculty: { action: 'invited', name: 'Dr Anand Rao', text: 'review the co-amoxiclav hold' } } },
    { after: 1200, e: room('nurse', 'pharmacist', 'lab', 'radiology', 'faculty') },
    { after: 50, e: { type: 'faculty', faculty: { action: 'joined', name: 'Dr Anand Rao', text: '' } } },
    { after: 1200, e: msg('faculty', ['nurse'], 'I am here. What exactly was the reaction to penicillin, and how old was she?', { delivery: 'processed' }) },
    { after: 50, mark: 'faculty', e: { type: 'faculty', faculty: { action: 'question', name: 'Dr Anand Rao', text: 'What exactly was the reaction to penicillin, and how old was she?', ref: RX.ref } } },
    { after: 5200, e: msg('faculty', ['nurse'], 'Childhood rash only, tolerated amoxicillin since. Approve.', { delivery: 'processed' }) },
    { after: 50, e: { type: 'faculty', faculty: { action: 'approve', name: 'Dr Anand Rao', text: 'Childhood rash only, tolerated since. Approve.', ref: RX.ref } } },
    { after: 50, e: del({ ...RX, status: 'overridden', summary: 'Released by Dr Anand Rao' }) },
    { after: 50, e: { type: 'apply', apply: { ref: RX.ref, addPrescription: { medicationId: 'amoxicillin-clavulanate-1g', dose: '1 g twice a day', duration: '7 days' } } } },
    { after: 400, e: room('nurse', 'pharmacist', 'lab', 'radiology', 'examiner', 'faculty') },
    {
      after: 300,
      mark: 'end',
      e: {
        type: 'score',
        score: {
          status: 'awaiting_signoff', total: 78,
          domains: [
            { name: 'Right department, right time', score: 22, max: 25, note: 'Pharmacy before the drug, radiology with an indication.' },
            { name: 'Minimum disclosure', score: 20, max: 25, note: 'Lab never saw the allergy list.' },
            { name: 'Answering safety questions', score: 14, max: 25, note: 'The pregnancy question waited.' },
            { name: 'Escalation to a human', score: 22, max: 25, note: 'Override asked with a reason.' },
          ],
          strengths: ['Did not argue with the hold; asked a human to review it.'],
          improvements: ['Answer radiology before moving on.'],
        },
      },
    },
  ];
}

export function playDemo(session: RoomSession): void {
  n = 0;
  for (const k of Object.keys(started)) delete started[k];
  const stop = new URLSearchParams(window.location.search).get('demostop');
  let seq = 0;
  const emit = (e: Body) => session.handle({ seq: ++seq, at: new Date().toISOString(), ...e } as unknown as RoomEvent);
  session.handle({ seq: 0, at: new Date().toISOString(), type: 'status', enabled: true, departments: { pharmacist: true, lab: true, radiology: true, examiner: true } });
  const steps = script();
  if (stop) {
    for (const s of steps) {
      emit(s.e);
      if (s.mark === stop) return;
    }
    return;
  }
  let i = 0;
  const next = () => {
    const s = steps[i++];
    if (!s || session.isStopped()) return;
    window.setTimeout(() => {
      if (session.isStopped()) return;
      emit(s.e);
      next();
    }, s.after);
  };
  next();
}
