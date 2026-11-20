/**
 * Operation theatre voice / typed command classifier and checklist answers.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { parseChecklistAnswer, parseOTCommand } from '../../src/ot/commands.ts';
import { scenarioById } from '../../src/ot/scenarios.ts';

test('fluids: bolus, rate, stop, fluid names', () => {
  assert.deepEqual(parseOTCommand('starting 500 ml RL bolus'), { kind: 'fluid-bolus', fluid: 'RL', volumeMl: 500 });
  assert.deepEqual(parseOTCommand('Give a 250 mL bolus of normal saline'), { kind: 'fluid-bolus', fluid: 'NS', volumeMl: 250 });
  assert.deepEqual(parseOTCommand('five hundred of Ringer lactate stat'), { kind: 'fluid-bolus', fluid: 'RL', volumeMl: 500 });
  assert.deepEqual(parseOTCommand('RL at 100 ml per hour'), { kind: 'fluid-rate', fluid: 'RL', rateMlH: 100 });
  assert.deepEqual(parseOTCommand('set maintenance 110 ml/h'), { kind: 'fluid-rate', fluid: 'RL', rateMlH: 110 });
  assert.deepEqual(parseOTCommand('stop the drip'), { kind: 'fluid-stop' });
  assert.deepEqual(parseOTCommand('packed cells, one unit, 300 ml bolus'), { kind: 'fluid-bolus', fluid: 'blood', volumeMl: 300 });
});

test('drugs: names, brands, units and spoken decimals', () => {
  assert.deepEqual(parseOTCommand('giving atropine 0.6'), { kind: 'drug', drug: 'atropine', dose: 0.6 });
  assert.deepEqual(parseOTCommand('atropine point six milligrams'), { kind: 'drug', drug: 'atropine', dose: 0.6 });
  assert.deepEqual(parseOTCommand('phenylephrine 100 micrograms'), { kind: 'drug', drug: 'phenylephrine', dose: 100 });
  assert.deepEqual(parseOTCommand('phenyl 0.1 mg'), { kind: 'drug', drug: 'phenylephrine', dose: 100 });
  assert.deepEqual(parseOTCommand('phenylephrine 1 mg'), { kind: 'drug', drug: 'phenylephrine', dose: 1000 });
  assert.deepEqual(parseOTCommand('ephedrine 6'), { kind: 'drug', drug: 'ephedrine', dose: 6 });
  assert.deepEqual(parseOTCommand('Emeset 4 mg IV'), { kind: 'drug', drug: 'ondansetron', dose: 4 });
  assert.deepEqual(parseOTCommand('PCM 1000'), { kind: 'drug', drug: 'paracetamol', dose: 1 });
  assert.deepEqual(parseOTCommand('tranexamic acid 1 gram slowly'), { kind: 'drug', drug: 'tranexamic', dose: 1 });
  assert.deepEqual(parseOTCommand('TXA 1,000 mg'), { kind: 'drug', drug: 'tranexamic', dose: 1 });
  assert.deepEqual(parseOTCommand('cefazolin 2 grams'), { kind: 'drug', drug: 'cefazolin', dose: 2 });
  // no dose spoken -> textbook dose
  assert.deepEqual(parseOTCommand('give ondansetron'), { kind: 'drug', drug: 'ondansetron', dose: 4 });
});

test('equipment: suction, cautery, warmer, oxygen', () => {
  assert.deepEqual(parseOTCommand('suction on'), { kind: 'suction', on: true });
  assert.deepEqual(parseOTCommand('suction on at 150'), { kind: 'suction', on: true, pressure: 150 });
  assert.deepEqual(parseOTCommand('turn the suction off'), { kind: 'suction', on: false });
  assert.deepEqual(parseOTCommand('check the return pad and diathermy on coag'), { kind: 'cautery', on: true, mode: 'coag', padChecked: true });
  assert.deepEqual(parseOTCommand('cautery off'), { kind: 'cautery', on: false });
  assert.deepEqual(parseOTCommand('bair hugger on at 43 degrees'), { kind: 'warmer', on: true, tempC: 43 });
  assert.deepEqual(parseOTCommand('warmer off'), { kind: 'warmer', on: false });
  assert.deepEqual(parseOTCommand('FiO2 100%'), { kind: 'oxygen', fio2: 100 });
  assert.deepEqual(parseOTCommand('increase oxygen'), { kind: 'oxygen', fio2: 100 });
  assert.deepEqual(parseOTCommand('oxygen to 60'), { kind: 'oxygen', fio2: 60 });
});

test('patient checks and Hindi', () => {
  assert.deepEqual(parseOTCommand('check the pulse'), { kind: 'pulse-check' });
  assert.deepEqual(parseOTCommand('feel the radial pulse'), { kind: 'pulse-check' });
  assert.deepEqual(parseOTCommand('capillary refill'), { kind: 'cap-refill' });
  assert.deepEqual(parseOTCommand('read the wrist band for allergies'), { kind: 'allergy-check' });
  assert.deepEqual(parseOTCommand('सक्शन चालू करो'), { kind: 'suction', on: true });
  assert.deepEqual(parseOTCommand('suction band karo'), { kind: 'suction', on: false });
  assert.deepEqual(parseOTCommand('एट्रोपिन 0.6 दो'), { kind: 'drug', drug: 'atropine', dose: 0.6 });
  assert.deepEqual(parseOTCommand('नब्ज़ देखो'), { kind: 'pulse-check' });
  assert.equal(parseOTCommand('hello doctor'), null);
  assert.equal(parseOTCommand(''), null);
});

test('checklist answers map to option ids', () => {
  const sc = scenarioById('ot-lap-chole');
  const item = (id: string) => sc.checklist.find((c) => c.id === id)!;
  assert.equal(parseChecklistAnswer(item('identity'), 'Sunita Sharma, laparoscopic cholecystectomy, consent signed'), 'right');
  assert.equal(parseChecklistAnswer(item('identity'), 'consent is not signed'), 'no-consent');
  assert.equal(parseChecklistAnswer(item('site'), 'not applicable'), 'na');
  assert.equal(parseChecklistAnswer(item('allergy'), 'she is allergic to sulfa'), 'sulfa');
  assert.equal(parseChecklistAnswer(item('allergy'), 'no known allergies'), 'none');
  assert.equal(parseChecklistAnswer(item('airway'), 'no, fasted, mallampati 2'), 'no');
  assert.equal(parseChecklistAnswer(item('antibiotic'), 'not given yet'), 'no');
  assert.equal(parseChecklistAnswer(item('antibiotic'), 'haan'), 'yes');
  assert.equal(parseChecklistAnswer(item('counts'), 'yes counts correct'), 'yes');
  const app = scenarioById('ot-appendix');
  assert.equal(parseChecklistAnswer(app.checklist.find((c) => c.id === 'confirm')!, 'right iliac fossa'), 'right');
  assert.equal(parseChecklistAnswer(app.checklist.find((c) => c.id === 'confirm')!, 'left iliac fossa'), 'wrong');
  assert.equal(parseChecklistAnswer(item('identity'), 'banana'), null);
});
