/**
 * Operation theatre drill: scenario data, deterministic engine (checklist,
 * event timeline, vitals, judging, safety errors) and the report card.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { DRUGS, OT_SCENARIOS, PROBLEMS, STATION_OF, scenarioById } from '../../src/ot/scenarios.ts';
import {
  ABX_EVENT_ID,
  act,
  activeCalls,
  answerChecklist,
  buildReport,
  createOT,
  currentChecklistItem,
  checklistCorrect,
  tick,
  vitalsAt,
  type OTState,
} from '../../src/ot/engine.ts';

/** Answer every waiting checklist prompt correctly (or with `pick`). */
function answerAll(s: OTState, pick?: (id: string) => string | undefined): OTState {
  let cur = s;
  for (let i = 0; i < 20; i++) {
    const item = currentChecklistItem(cur);
    if (!item) break;
    const right = checklistCorrect(cur, item);
    let ans = pick?.(item.id) ?? right;
    if (ans === 'WRONG') ans = item.options.find((o) => o.id !== right)!.id;
    cur = answerChecklist(cur, ans).state;
  }
  return cur;
}

function run(s: OTState, seconds: number, step = 0.5): OTState {
  let cur = s;
  for (let t = 0; t < seconds; t += step) cur = tick(cur, step);
  return cur;
}

/** Walk the case to skin incision with everything answered correctly. */
function toIncision(id: string, seed = 7, giveAbxFirst = false): OTState {
  let s = createOT(id, seed);
  s = act(s, { kind: 'allergy-check' }, { station: 'patient' }).state;
  if (giveAbxFirst) s = act(s, { kind: 'drug', drug: 'cefazolin', dose: 2 }, { station: 'drugs' }).state;
  s = answerAll(s);
  s = run(s, 5);
  s = answerAll(s);
  if (s.stage === 'pre-incision') s = act(s, { kind: 'drug', drug: 'cefazolin', dose: 2 }, { station: 'drugs' }).state;
  return s;
}

test('every scenario has 5 to 7 events, valid problems and a full WHO checklist', () => {
  assert.equal(OT_SCENARIOS.length, 3);
  for (const sc of OT_SCENARIOS) {
    assert.ok(sc.events.length >= 5 && sc.events.length <= 7, sc.id);
    for (const e of sc.events) {
      assert.ok(PROBLEMS[e.problem], `${sc.id}/${e.id}`);
      assert.ok(e.atS > 0 && e.atS < sc.endS, `${e.id} inside the operation`);
      assert.ok(!/[\u2014\u2013]/.test(e.line + e.ack + e.remind), `${e.id} has no em or en dash`);
    }
    const stages = new Set(sc.checklist.map((c) => c.stage));
    assert.deepEqual([...stages].sort(), ['sign-in', 'sign-out', 'time-out']);
    for (const c of sc.checklist) {
      if (c.correct !== 'antibiotic') assert.ok(c.options.some((o) => o.id === c.correct), `${sc.id}/${c.id}`);
    }
    // scenario length: 3 to 4 minutes of operating
    assert.ok(sc.endS >= 180 && sc.endS <= 240);
  }
});

test('drug table: textbook doses are inside the range and every cart has one tenfold option', () => {
  assert.deepEqual(DRUGS.phenylephrine.range, [50, 100]);
  assert.equal(DRUGS.atropine.ideal, 0.6);
  assert.equal(DRUGS.cefazolin.ideal, 2);
  assert.equal(DRUGS.ondansetron.ideal, 4);
  for (const [id, d] of Object.entries(DRUGS)) {
    assert.ok(d.ideal >= d.range[0] && d.ideal <= d.range[1], id);
    assert.ok(d.options.includes(d.ideal), id);
    assert.ok(d.options.some((o) => o >= d.range[1] * 5), `${id} has a tenfold trap`);
  }
  assert.equal(STATION_OF.drug, 'drugs');
  assert.equal(PROBLEMS['cautery-fail'].station, 'cautery');
});

test('sign-in, induction and time-out flow; missing antibiotic holds the incision', () => {
  let s = createOT('ot-appendix', 3);
  assert.equal(s.stage, 'sign-in');
  assert.equal(currentChecklistItem(s)?.id, 'identity');
  s = answerAll(s);
  assert.equal(s.stage, 'induction');
  s = run(s, 5);
  assert.equal(s.stage, 'time-out');
  s = answerAll(s);
  assert.equal(s.stage, 'pre-incision', 'antibiotic was not given');
  assert.equal(s.checklist.antibiotic.answer, 'no');
  assert.ok(s.checklist.antibiotic.ok);
  const calls = activeCalls(s);
  assert.equal(calls[0].run.id, ABX_EVENT_ID);
  const r = act(s, { kind: 'drug', drug: 'cefazolin', dose: 2 }, { station: 'drugs' });
  assert.equal(r.feedback.tone, 'good');
  assert.equal(r.state.stage, 'operating');
  assert.ok(r.state.incisionAt !== null);
  // Drug before any allergy confirmation is a safety error... but the sign-in
  // allergy question was answered correctly, so here it is not.
  assert.ok(!r.state.safety.some((x) => x.code === 'no-allergy-check'));
});

test('lying at time-out about the antibiotic is a safety error', () => {
  let s = createOT('ot-lap-chole', 1);
  s = answerAll(s);
  s = run(s, 5);
  s = answerAll(s, (id) => (id === 'antibiotic' ? 'yes' : undefined));
  assert.ok(s.safety.some((x) => x.code === 'false-checklist'));
  assert.equal(s.stage, 'pre-incision');
});

test('antibiotic given before the time-out goes straight to incision', () => {
  const s = toIncision('ot-lscs', 5, true);
  assert.equal(s.stage, 'operating');
  assert.ok(!s.events.some((e) => e.id === ABX_EVENT_ID));
  assert.equal(s.checklist.antibiotic.answer, 'yes');
});

test('the same seed gives the same run; vitals deteriorate when an event is ignored', () => {
  const a = run(toIncision('ot-appendix', 11), 60);
  const b = run(toIncision('ot-appendix', 11), 60);
  assert.deepEqual(vitalsAt(a), vitalsAt(b));
  assert.deepEqual(a.log.map((l) => l.text), b.log.map((l) => l.text));

  let s = toIncision('ot-appendix', 11);
  const bp = s.events.find((e) => e.id === 'app-bp')!;
  const callAt = bp.callAt!;
  s = run(s, callAt - s.t + 0.5);
  assert.equal(s.events.find((e) => e.id === 'app-bp')!.status, 'active');
  const atCall = vitalsAt(s).sbp;
  assert.ok(atCall <= 84, `SBP at the call ${atCall}`);
  const later = run(s, 15);
  assert.ok(vitalsAt(later).sbp < atCall, 'BP keeps falling while unhandled');
});

test('correct vasopressor resolves hypotension, BP recovers, the surgeon acknowledges', () => {
  let s = toIncision('ot-appendix', 2);
  const callAt = s.events.find((e) => e.id === 'app-bp')!.callAt!;
  s = run(s, callAt - s.t + 3);
  const r = act(s, { kind: 'drug', drug: 'phenylephrine', dose: 100 }, { station: 'drugs' });
  const ev = r.state.events.find((e) => e.id === 'app-bp')!;
  assert.equal(ev.outcome, 'correct');
  assert.ok(ev.atStation);
  assert.ok(r.state.log.some((l) => l.who === 'anaesthetist' && /better/.test(l.text)));
  const after = run(r.state, 25);
  assert.ok(vitalsAt(after).sbp >= 112, `recovered SBP ${vitalsAt(after).sbp}`);
});

test('wrong drug: atropine for hypotension with a fast heart rate is wrong and has a consequence', () => {
  let s = toIncision('ot-appendix', 2);
  const callAt = s.events.find((e) => e.id === 'app-bp')!.callAt!;
  s = run(s, callAt - s.t + 1);
  const hrBefore = vitalsAt(s).hr;
  const r = act(s, { kind: 'drug', drug: 'atropine', dose: 0.6 }, { station: 'drugs' });
  assert.equal(r.feedback.tone, 'bad');
  assert.equal(r.state.events.find((e) => e.id === 'app-bp')!.status, 'active');
  assert.ok(vitalsAt(run(r.state, 10)).hr > hrBefore + 10, 'tachycardia after atropine');
});

test('tenfold phenylephrine is a safety error; atropine under 0.5 mg is wrong for bradycardia', () => {
  let s = toIncision('ot-appendix', 2);
  s = run(s, s.events.find((e) => e.id === 'app-bp')!.callAt! - s.t + 1);
  const r = act(s, { kind: 'drug', drug: 'phenylephrine', dose: 1000 }, { station: 'drugs' });
  assert.ok(r.state.safety.some((x) => x.code === 'tenfold'));

  let l = toIncision('ot-lap-chole', 4);
  l = run(l, l.events.find((e) => e.id === 'lc-brady')!.callAt! - l.t + 1);
  assert.ok(vitalsAt(l).hr <= 50, `brady HR ${vitalsAt(l).hr}`);
  const low = act(l, { kind: 'drug', drug: 'atropine', dose: 0.2 }, { station: 'drugs' });
  assert.equal(low.feedback.tone, 'bad');
  assert.match(low.state.log.at(-1)!.text, /paradoxically/);
  const ok = act(low.state, { kind: 'drug', drug: 'atropine', dose: 0.6 }, { station: 'drugs' });
  const ev = ok.state.events.find((e) => e.id === 'lc-brady')!;
  assert.equal(ev.outcome, 'correct');
  assert.equal(ev.attempts.filter((a) => a.verdict === 'wrong').length, 1);
});

test('drug before the allergy status is confirmed is flagged once', () => {
  let s = createOT('ot-lscs', 1);
  s = act(s, { kind: 'drug', drug: 'cefazolin', dose: 2 }, { station: 'drugs' }).state;
  s = act(s, { kind: 'drug', drug: 'paracetamol', dose: 1 }, { station: 'drugs' }).state;
  assert.equal(s.safety.filter((x) => x.code === 'no-allergy-check').length, 1);
  const band = act(s, { kind: 'allergy-check' }, { station: 'patient' });
  assert.match(band.feedback.text, /Metoclopramide/);
});

test('equipment events: cautery needs the return pad, suction pressure, warmer, lead-off needs a pulse check', () => {
  let s = toIncision('ot-appendix', 9);
  const caut = s.events.find((e) => e.id === 'app-cautery')!;
  s = run(s, caut.callAt! - s.t + 1);
  assert.equal(s.equipment.padOk, false);
  const noPad = act(s, { kind: 'cautery', on: true, mode: 'coag' }, { station: 'cautery' });
  assert.equal(noPad.feedback.tone, 'bad');
  const fixed = act(noPad.state, { kind: 'cautery', on: true, mode: 'coag', padChecked: true }, { station: 'cautery' });
  assert.equal(fixed.state.events.find((e) => e.id === 'app-cautery')!.outcome, 'correct');

  let l = toIncision('ot-lap-chole', 9);
  l = run(l, l.events.find((e) => e.id === 'lc-lead')!.callAt! - l.t + 1);
  assert.equal(l.equipment.leadOff, true);
  const treatMonitor = act(l, { kind: 'drug', drug: 'atropine', dose: 0.6 }, { station: 'drugs' });
  assert.ok(treatMonitor.state.safety.some((x) => x.code === 'monitor-not-patient'));
  const pulse = act(l, { kind: 'pulse-check' }, { station: 'patient' });
  assert.equal(pulse.state.events.find((e) => e.id === 'lc-lead')!.outcome, 'correct');
  assert.equal(pulse.state.equipment.leadOff, false);

  let c = toIncision('ot-lscs', 9);
  c = run(c, c.events.find((e) => e.id === 'cs-suction')!.callAt! - c.t + 1);
  const tooHigh = act(c, { kind: 'suction', on: true, pressure: 400 }, { station: 'suction' });
  assert.equal(tooHigh.feedback.tone, 'bad');
  const right = act(tooHigh.state, { kind: 'suction', on: true, pressure: 150 }, { station: 'suction' });
  assert.equal(right.state.events.find((e) => e.id === 'cs-suction')!.outcome, 'correct');
});

test('anticipation: warmer already on prevents the hypothermia call', () => {
  let s = toIncision('ot-lap-chole', 6);
  s = act(s, { kind: 'warmer', on: true, tempC: 43 }, { station: 'warmer' }).state;
  s = run(s, 100);
  const ev = s.events.find((e) => e.id === 'lc-temp')!;
  assert.equal(ev.outcome, 'prevented');
  assert.ok(vitalsAt(s).temp >= 36.5);
});

test('ignored event: a senior takes over at the deadline and it scores zero', () => {
  let s = toIncision('ot-lap-chole', 8);
  s = run(s, s.events.find((e) => e.id === 'lc-spo2')!.callAt! - s.t + 40);
  const ev = s.events.find((e) => e.id === 'lc-spo2')!;
  assert.equal(ev.outcome, 'missed');
  assert.equal(s.equipment.fio2, 100);
  assert.ok(s.log.some((l) => /I will do it myself/.test(l.text)));
  const rep = buildReport(s);
  assert.equal(rep.events.find((e) => e.id === 'lc-spo2')!.points, 0);
});

/** Play the whole case with the textbook answer at each call. */
function playPerfect(id: string, seed: number): OTState {
  let s = toIncision(id, seed);
  const fix: Record<string, Parameters<typeof act>[1]> = {
    maintenance: { kind: 'fluid-rate', fluid: 'RL', rateMlH: 100 },
    hypotension: { kind: 'drug', drug: 'phenylephrine', dose: 100 },
    bradycardia: { kind: 'drug', drug: 'atropine', dose: 0.6 },
    hypoxia: { kind: 'oxygen', fio2: 100 },
    hypothermia: { kind: 'warmer', on: true, tempC: 43 },
    'bleeding-field': { kind: 'suction', on: true, pressure: 150 },
    'cautery-fail': { kind: 'cautery', on: true, mode: 'coag', padChecked: true },
    'lead-off': { kind: 'pulse-check' },
    'fluid-loss': { kind: 'fluid-bolus', fluid: 'RL', volumeMl: 500 },
    ooze: { kind: 'drug', drug: 'tranexamic', dose: 1 },
    ponv: { kind: 'drug', drug: 'ondansetron', dose: 4 },
    analgesia: { kind: 'drug', drug: 'paracetamol', dose: 1 },
  };
  for (let i = 0; i < 1200 && s.stage !== 'sign-out' && s.stage !== 'done'; i++) {
    s = tick(s, 0.5);
    for (const c of activeCalls(s)) {
      if (s.t - (c.run.callAt ?? 0) < 4) continue; // a few seconds to walk over
      const a = fix[c.run.problem];
      s = act(s, a, { station: STATION_OF[a.kind] }).state;
    }
  }
  return answerAll(s);
}

test('a textbook run scores excellent with no safety errors in every scenario', () => {
  for (const sc of OT_SCENARIOS) {
    const s = playPerfect(sc.id, 21);
    assert.equal(s.stage, 'done', sc.id);
    const rep = buildReport(s);
    assert.equal(rep.safety.length, 0, `${sc.id}: ${rep.safety.map((x) => x.text).join('; ')}`);
    assert.ok(rep.score >= 90, `${sc.id} score ${rep.score}`);
    assert.equal(rep.grade, 'excellent');
    assert.equal(rep.checklistPct, 100);
    assert.ok(rep.events.every((e) => e.outcome === 'correct' || e.outcome === 'prevented'));
    assert.ok(rep.events.every((e) => e.teaching.length > 40));
    assert.ok(rep.durationS >= 180 && rep.durationS <= 300, `${sc.id} lasted ${rep.durationS}s`);
  }
});

test('a run that ignores everything fails and lists every missed event', () => {
  let s = createOT('ot-appendix', 2);
  s = answerAll(s, () => 'WRONG');
  s = run(s, 6);
  s = answerAll(s, () => 'WRONG');
  for (let i = 0; i < 1000 && s.stage !== 'sign-out'; i++) s = tick(s, 0.5);
  s = answerAll(s, () => 'WRONG');
  const rep = buildReport(s);
  assert.equal(s.stage, 'done');
  assert.ok(rep.score < 25, `score ${rep.score}`);
  assert.equal(rep.grade, 'clear-fail');
  assert.ok(rep.events.filter((e) => e.outcome === 'missed').length >= 5);
  assert.ok(rep.safety.some((x) => x.code === 'incision-no-abx'));
  assert.equal(scenarioById('nope').id, 'ot-appendix');
});
