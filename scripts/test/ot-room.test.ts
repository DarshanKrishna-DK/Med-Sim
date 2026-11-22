/**
 * The operation theatre with its BAND room: blood that waits for the laboratory,
 * sign-in that waits for pharmacy, calling for help, every fallback, and the
 * proof that without a room nothing changed. Pure and deterministic.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseOTCommand } from '../../src/ot/commands.ts';
import {
  BLOOD_WAIT_S,
  RX_WAIT_S,
  act,
  answerChecklist,
  buildReport,
  checklistCorrect,
  connectRoom,
  createOT,
  currentChecklistItem,
  sbarLine,
  theatreEvent,
  tick,
  vitalsAt,
  type OTState,
  type OutItem,
} from '../../src/ot/engine.ts';
import { bloodLine, eventsBetween, parseSide, rxLine } from '../../src/ot/roomState.ts';
import { OT_SCENARIOS, type OTAction } from '../../src/ot/scenarios.ts';

const BLOOD: OTAction = { kind: 'fluid-bolus', fluid: 'blood', volumeMl: 500 };
const ONEG: OTAction = { kind: 'fluid-bolus', fluid: 'blood', volumeMl: 250, emergency: true };

function run(s: OTState, seconds: number, step = 0.5): OTState {
  let cur = s;
  for (let t = 0; t < seconds; t += step) cur = tick(cur, step);
  return cur;
}

function answerAll(s: OTState): OTState {
  let cur = s;
  for (let i = 0; i < 20; i++) {
    const item = currentChecklistItem(cur);
    if (!item) break;
    cur = answerChecklist(cur, checklistCorrect(cur, item)).state;
  }
  return cur;
}

/** At the caesarean, with the blood-loss call just made. */
function bleeding(room = true): OTState {
  let s = createOT('ot-lscs', 7, { room });
  s = act(s, { kind: 'allergy-check' }, { station: 'patient' }).state;
  s = act(s, { kind: 'drug', drug: 'cefazolin', dose: 2 }, { station: 'drugs' }).state;
  s = answerAll(s);
  if (room) s = theatreEvent(s, { kind: 'rx', verdict: 'release', text: 'Cefazolin can be given.' });
  s = run(s, 5);
  s = answerAll(s);
  for (let i = 0; i < 800 && s.events.find((e) => e.id === 'cs-fluid')?.status !== 'active'; i++) s = tick(s, 0.5);
  assert.equal(s.events.find((e) => e.id === 'cs-fluid')?.status, 'active');
  return s;
}

const out = (s: OTState, kind: OutItem['kind']) => s.outbox.filter((o) => o.kind === kind);
const said = (s: OTState, who: string) => s.log.filter((l) => l.who === who).map((l) => l.text);
const fluid = (s: OTState) => s.events.find((e) => e.id === 'cs-fluid')!;

test('without a room blood runs at once, as before, and nothing is asked of anybody', () => {
  let s = bleeding(false);
  const r = act(s, BLOOD, { station: 'iv' });
  s = r.state;
  assert.equal(s.equipment.bolusMl, 500);
  assert.equal(fluid(s).status, 'resolved');
  assert.deepEqual(s.outbox, []);
  assert.equal(s.blood, null);
  assert.equal(buildReport(s).blood.length, 0);
  assert.equal(parseOTCommand('send blood'), null);
  assert.equal(parseOTCommand('call for help'), null);
  assert.match(act(s, { kind: 'call-help' }).feedback.text, /No consultant/);
});

test('a room that never answers changes nothing about the marks of a normal run', () => {
  const play = (room: boolean) => {
    let s = createOT('ot-appendix', 5, { room });
    s = act(s, { kind: 'allergy-check' }, { station: 'patient' }).state;
    s = act(s, { kind: 'drug', drug: 'cefazolin', dose: 2 }, { station: 'drugs' }).state;
    s = answerAll(s);
    for (let i = 0; i < 60 && s.stage === 'induction'; i++) s = tick(s, 0.5);
    s = answerAll(s);
    for (let i = 0; i < 2000 && s.stage === 'operating'; i++) s = tick(s, 0.5);
    s = answerAll(s);
    return buildReport(s);
  };
  const a = play(false);
  const b = play(true);
  assert.deepEqual([a.score, a.eventPct, a.checklistPct], [b.score, b.eventPct, b.checklistPct]);
});

test('packed cells wait for the lab, and the effect starts when the release arrives', () => {
  let s = bleeding();
  const r = act(s, BLOOD, { station: 'iv' });
  s = r.state;
  assert.match(r.feedback.text, /Waiting for Lab cross-match/);
  assert.equal(s.equipment.bolusMl, 0);
  assert.equal(fluid(s).status, 'active');
  assert.equal(out(s, 'blood').length, 1);
  const { id: _id, ...asked } = out(s, 'blood')[0];
  assert.deepEqual(asked, { kind: 'blood', n: 1, units: 2, emergency: false });
  // asking again does not ask twice
  assert.match(act(s, BLOOD, { station: 'iv' }).feedback.text, /Already waiting/);
  s = run(s, 5);
  assert.equal(s.equipment.bolusMl, 0);
  const askedAt = s.blood!.askedAt;
  const before = vitalsAt(s);
  s = theatreEvent(s, { kind: 'blood', n: 1, status: 'released', group: 'O negative', units: ['K1041', 'K1042'] });
  assert.equal(s.blood!.status, 'released');
  assert.equal(s.equipment.bolusMl, 500);
  assert.equal(fluid(s).status, 'resolved');
  assert.ok(said(s, 'leela').some((t) => t.includes('K1041') && t.includes('O negative')));
  s = run(s, 20);
  assert.ok(vitalsAt(s).sbp > before.sbp, 'the pressure comes up after the release');
  // the response time counts from the order, not from the laboratory
  const score = buildReport(s).events.find((e) => e.id === 'cs-fluid')!;
  assert.equal(score.responseS, Math.round((askedAt - fluid(s).callAt!) * 10) / 10);
  assert.equal(buildReport(s).blood[0].how, 'crossmatched');
  // more of the same patient's cross-matched cells need no second wait
  const again = act(s, BLOOD, { station: 'iv' });
  assert.ok(again.state.equipment.bolusMl > 0);
  assert.equal(out(again.state, 'blood').length, 1);
});

test('no answer in 12 s: issued without cross-match confirmation, clearly marked', () => {
  let s = act(bleeding(), BLOOD, { station: 'iv' }).state;
  s = run(s, BLOOD_WAIT_S - 1);
  assert.equal(s.blood!.status, 'waiting');
  s = run(s, 1.5);
  assert.equal(s.blood!.status, 'unconfirmed');
  assert.equal(s.equipment.infusedMl > 0 || s.equipment.bolusMl > 0, true);
  assert.equal(out(s, 'unconfirmed').length, 1);
  assert.ok(said(s, 'leela').some((t) => /without cross-match confirmation/.test(t)));
  assert.equal(buildReport(s).blood[0].how, 'unconfirmed');
  assert.equal(s.safety.length, 0);
  // the lab answers after all: noted, never applied twice
  const ml = s.equipment.bolusMl;
  s = theatreEvent(s, { kind: 'blood', n: 1, status: 'released', group: 'O negative', units: ['K1041'] });
  assert.equal(s.equipment.bolusMl, ml);
  assert.ok(said(s, 'leela').some((t) => /confirms afterwards/.test(t)));
});

test('the lab asks for a sample: the clock restarts once for it and once when it is sent', () => {
  let s = act(bleeding(), BLOOD, { station: 'iv' }).state;
  assert.match(act(s, { kind: 'send-sample' }).feedback.text, /has not asked/);
  s = run(s, 6);
  s = theatreEvent(s, { kind: 'blood', n: 1, status: 'sample' });
  s = run(s, 8);
  assert.equal(s.blood!.status, 'sample');
  const r = act(s, { kind: 'send-sample' }, { station: 'iv' });
  s = r.state;
  assert.equal(s.blood!.status, 'matching');
  assert.equal(out(s, 'sample').length, 1);
  s = theatreEvent(s, { kind: 'blood', n: 1, status: 'sample' }); // a replay changes nothing
  assert.equal(s.blood!.status, 'matching');
  s = run(s, 6);
  s = theatreEvent(s, { kind: 'blood', n: 1, status: 'released', group: 'B positive', units: ['K1301'] });
  assert.equal(s.blood!.status, 'released');
});

test('a sample that is never sent ends in the fallback too, so no drill stalls', () => {
  let s = act(bleeding(), BLOOD).state;
  s = theatreEvent(s, { kind: 'blood', n: 1, status: 'sample' });
  s = run(s, BLOOD_WAIT_S + 1);
  assert.equal(s.blood!.status, 'unconfirmed');
  assert.match(buildReport(s).blood[0].text, /no sample was sent/);
});

test('cells ordered in time keep their problem open while the lab works', () => {
  let s = bleeding();
  const deadline = OT_SCENARIOS.find((x) => x.id === 'ot-lscs')!.events.find((e) => e.id === 'cs-fluid')!.deadlineS;
  while (s.t - fluid(s).callAt! < deadline - 3) s = tick(s, 0.5);
  s = act(s, BLOOD, { station: 'iv' }).state;
  s = run(s, 6);
  assert.equal(fluid(s).status, 'active', 'not missed while waiting');
  s = theatreEvent(s, { kind: 'blood', n: 1, status: 'released' });
  assert.equal(fluid(s).outcome, 'partial');
});

test('emergency O negative is immediate, recorded, and only in the narrative', () => {
  const base = bleeding();
  let s = act(base, ONEG, { station: 'iv' }).state;
  assert.equal(s.equipment.bolusMl, 250);
  assert.equal(s.blood!.status, 'emergency');
  assert.equal(out(s, 'blood')[0].emergency, true);
  s = theatreEvent(s, { kind: 'blood', n: 1, status: 'recorded', units: ['K1041'] });
  assert.ok(said(s, 'leela').some((t) => /recorded the emergency issue \(K1041\)/.test(t)));
  assert.equal(buildReport(s).blood[0].how, 'emergency');
  assert.deepEqual(s.safety, []);
  // same marks as the same bolus without a room
  const plain = act({ ...base, room: false }, { kind: 'fluid-bolus', fluid: 'blood', volumeMl: 250 }, { station: 'iv' }).state;
  assert.equal(buildReport(s).score, buildReport(plain).score);
  // it also ends a wait that is already running, and the old answer is ignored
  let w = act(bleeding(), BLOOD).state;
  w = act(w, ONEG).state;
  assert.equal(w.blood!.n, 2);
  assert.equal(theatreEvent(w, { kind: 'blood', n: 1, status: 'released' }), w);
});

test('blood the lab refuses does not run', () => {
  let s = act(bleeding(), BLOOD).state;
  s = theatreEvent(s, { kind: 'blood', n: 1, status: 'refused', text: 'NOT RELEASED. A positive red cells are incompatible.' });
  s = run(s, BLOOD_WAIT_S + 2);
  assert.equal(s.blood!.status, 'refused');
  assert.equal(s.equipment.bolusMl, 0);
  assert.equal(act(s, BLOOD).state.blood!.n, 2, 'it can be asked for again');
});

test('sign-in waits for the pharmacist, at most 12 s', () => {
  let s = createOT('ot-lscs', 3, { room: true });
  s = answerAll(s);
  assert.equal(out(s, 'allergy').length, 1);
  assert.equal(s.stage, 'induction');
  s = run(s, 6);
  assert.equal(s.stage, 'induction', 'still waiting for pharmacy');
  const cleared = run(theatreEvent(s, { kind: 'rx', verdict: 'release', text: 'Cefazolin can be given. Avoid metoclopramide.' }), 1);
  assert.equal(cleared.stage, 'time-out');
  assert.match(rxLine(cleared)!.text, /Avoid metoclopramide/);
  const silent = run(s, RX_WAIT_S);
  assert.equal(silent.stage, 'time-out');
  assert.equal(silent.rx.status, 'unconfirmed');
  assert.equal(rxLine(silent)!.tone, 'warn');
  // a late verdict still counts
  assert.equal(theatreEvent(silent, { kind: 'rx', verdict: 'hold', text: 'HOLD Cefazolin.' }).rx.status, 'hold');
  // the question does not give the allergy away before it is answered
  const fresh = createOT('ot-lscs', 3, { room: true });
  assert.equal(rxLine(fresh), null);
  assert.equal(fresh.outbox.length, 0);
});

test('call for help carries one line without the patient name, and the reply is shown', () => {
  let s = bleeding();
  const r = act(s, { kind: 'call-help' });
  s = r.state;
  const item = out(s, 'help')[0];
  assert.ok(item.sbar!.startsWith('S: ') && item.sbar!.includes(' B: ') && item.sbar!.includes(' A: ') && item.sbar!.includes(' R: '));
  assert.ok(!item.sbar!.includes('\n'));
  for (const sc of OT_SCENARIOS) {
    const line = sbarLine(createOT(sc.id, 1, { room: true }));
    for (const part of sc.patient.name.split(' ')) assert.ok(!line.includes(part), line);
  }
  assert.match(act(s, { kind: 'call-help' }).feedback.text, /already been called/);
  s = theatreEvent(s, { kind: 'help', status: 'called', name: 'Dr Rao' });
  s = theatreEvent(s, { kind: 'help', status: 'replied', name: 'Dr Rao', text: 'Give a second litre.' });
  assert.deepEqual([s.help!.status, s.help!.text], ['replied', 'Give a second litre.']);
  assert.ok(said(s, 'leela').includes('Dr Rao: Give a second litre.'));
  s = run(s, 25);
  assert.equal(out(act(s, { kind: 'call-help' }).state, 'help').length, 2);
});

test('events are ignored once the case is over, and for questions nobody asked', () => {
  const s = createOT('ot-lscs', 1, { room: true });
  assert.equal(theatreEvent(s, { kind: 'blood', n: 1, status: 'released' }), s);
  assert.equal(theatreEvent(s, { kind: 'rx', verdict: 'release' }), s);
  assert.equal(theatreEvent(s, { kind: 'help', status: 'replied', text: 'x' }), s);
  const done = { ...s, stage: 'done' as const };
  assert.equal(theatreEvent(done, { kind: 'rx', verdict: 'release' }), done);
  assert.equal(connectRoom(s, true), s);
  assert.equal(connectRoom(s, false).room, false);
});

test('same seed, same inputs, same events: the same run', () => {
  const play = () => {
    let s = act(bleeding(), BLOOD, { station: 'iv' }).state;
    s = run(s, 4);
    s = theatreEvent(s, { kind: 'blood', n: 1, status: 'released', group: 'O negative', units: ['K1041'] });
    return JSON.stringify(run(s, 30));
  };
  assert.equal(play(), play());
});

test('room states become engine events exactly once', () => {
  const side = (blood: unknown, rx: unknown = null, help: unknown = null) =>
    parseSide({ kind: 'theatre', refId: 'd', status: 'new', final: false, url: 'https://app.band.ai/rooms/r', blood, rx, help });
  const wait = side({ n: 1, status: 'waiting', units: [] });
  const rel = side({ n: 1, status: 'released', group: 'A positive', units: [{ unit: 'K1212', group: 'A positive' }], text: 'ok' });
  assert.deepEqual(eventsBetween(null, wait), []);
  assert.deepEqual(eventsBetween(wait, rel), [{ kind: 'blood', n: 1, group: 'A positive', units: ['K1212'], text: 'ok', status: 'released' }]);
  assert.deepEqual(eventsBetween(rel, rel), []);
  assert.deepEqual(eventsBetween(wait, side({ n: 1, status: 'no_reply' })), []);
  assert.equal((eventsBetween(wait, side({ n: 1, status: 'incompatible', text: 'no' }))[0] as { status: string }).status, 'refused');
  assert.equal((eventsBetween(wait, side({ n: 2, status: 'emergency' }))[0] as { status: string }).status, 'recorded');
  assert.deepEqual(eventsBetween(null, side(null, { status: 'hold', text: 'HOLD' })), [{ kind: 'rx', verdict: 'hold', text: 'HOLD' }]);
  const one = side(null, null, { status: 'replied', name: 'Dr Rao', text: 'a', n: 1 });
  const two = side(null, null, { status: 'replied', name: 'Dr Rao', text: 'b', n: 2 });
  assert.equal(eventsBetween(one, two).length, 1);
  // whatever arrives, nothing throws and nothing is invented
  for (const junk of [null, 5, 'x', [], { n: 'one' }, { n: 1, status: 'given' }, { n: 1, status: 'released', units: 'K' }]) {
    const p = side(junk, junk, junk);
    assert.ok(Array.isArray(eventsBetween(null, p)));
  }
  assert.equal(side({ n: 1, status: 'given' }).blood, null);
});

test('the strip says what the drill waits for', () => {
  let s = act(bleeding(), BLOOD).state;
  assert.deepEqual(bloodLine(s, BLOOD_WAIT_S), { text: 'Waiting for Lab cross-match', left: 12, tone: 'wait' });
  s = run(s, 4);
  assert.equal(bloodLine(s, BLOOD_WAIT_S)!.left, 8);
  s = run(s, 9);
  assert.equal(bloodLine(s, BLOOD_WAIT_S)!.tone, 'warn');
  assert.equal(bloodLine(createOT('ot-lscs', 1), BLOOD_WAIT_S), null);
});

test('room orders by voice in every language, only when a room is connected', () => {
  const p = (t: string) => parseOTCommand(t, { room: true });
  for (const t of ['call for help', 'Call the consultant please', 'I need help here', 'madad chahiye', 'मदद चाहिए', 'ಸಹಾಯ ಬೇಕು', 'உதவி வேண்டும்', 'సహాయం కావాలి', 'मदत हवी', 'সাহায্য চাই']) {
    assert.deepEqual(p(t), { kind: 'call-help' }, t);
  }
  for (const t of ['send the cross match sample', 'sending a labelled sample', 'सैंपल भेजो', 'sample bhejo', 'ಸ್ಯಾಂಪಲ್ ಕಳುಹಿಸಿ', 'மாதிரி அனுப்புங்கள்', 'శాంపిల్ పంపండి', 'नमुना पाठवा', 'নমুনা পাঠান']) {
    assert.deepEqual(p(t), { kind: 'send-sample' }, t);
  }
  for (const t of ['send blood', 'send for packed cells', 'hang the blood now', 'खून भेजो', 'khoon bhejo', 'ರಕ್ತ ಕಳುಹಿಸಿ', 'இரத்தம் அனுப்புங்கள்', 'రక్తం పంపండి', 'रक्त पाठवा', 'রক্ত পাঠান']) {
    assert.deepEqual(p(t), { kind: 'fluid-bolus', fluid: 'blood', volumeMl: 250 }, t);
  }
  for (const t of ['give emergency O negative blood', 'o negative now', 'इमरजेंसी ओ नेगेटिव खून दो', 'ತುರ್ತು ರಕ್ತ ಕೊಡಿ', 'அவசர இரத்தம் கொடுங்கள்', 'అత్యవసర రక్తం ఇవ్వండి', 'जरुरी नाही आपत्कालीन रक्त द्या', 'জরুরি রক্ত দিন']) {
    assert.deepEqual(p(t), { kind: 'fluid-bolus', fluid: 'blood', volumeMl: 250, emergency: true }, t);
  }
  assert.deepEqual(p('500 ml blood bolus'), { kind: 'fluid-bolus', fluid: 'blood', volumeMl: 500 });
  assert.deepEqual(p('blood at 125 ml per hour'), { kind: 'fluid-rate', fluid: 'blood', rateMlH: 125 });
  // everything that worked before still does
  assert.deepEqual(p('starting 500 ml RL bolus'), { kind: 'fluid-bolus', fluid: 'RL', volumeMl: 500 });
  assert.deepEqual(p('suction on at 150'), { kind: 'suction', on: true, pressure: 150 });
  assert.deepEqual(p('field is full of blood suction on at 150'), { kind: 'suction', on: true, pressure: 150 });
  assert.deepEqual(p('blood pressure is low give phenylephrine 100'), { kind: 'drug', drug: 'phenylephrine', dose: 100 });
  assert.deepEqual(p('giving atropine 0.6'), { kind: 'drug', drug: 'atropine', dose: 0.6 });
  assert.equal(p('stop the blood')?.kind, 'fluid-stop');
});
