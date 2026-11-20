/**
 * Tests for the physical-exam voice classifier in
 * `src/agents/examClassifier.ts`: English, Hindi and Kannada exam requests map
 * to a body system; history questions and test orders do not.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { EXAM_SYSTEMS, classifyExam } from '../../src/agents/examClassifier.ts';

test('English exam requests map to a body system', () => {
  const cases: Array<[string, string]> = [
    ['Let me examine your chest.', 'resp'],
    ["I'll listen to your lungs now.", 'resp'],
    ['Auscultate the heart, please.', 'cardio'],
    ['Let me listen to your heart and chest.', 'cardio'],
    ['Okay, let me check the abdomen.', 'abdomen'],
    ['I am going to press on your tummy, tell me if it hurts.', 'abdomen'],
    ['Let me check your pulse and blood pressure.', 'vitals'],
    ['Let me look in your throat.', 'ent'],
    ['I want to look at your eyes.', 'eye'],
    ['Let me test your reflexes.', 'neuro'],
    ['Let me examine your knee.', 'msk'],
    ['I will look at the rash on your skin.', 'skin'],
    ["Let's do a general examination.", 'general'],
  ];
  for (const [text, want] of cases) assert.equal(classifyExam(text), want, text);
});

test('Hindi and Kannada exam requests map to a body system', () => {
  assert.equal(classifyExam('छाती की जाँच करते हैं'), 'resp');
  assert.equal(classifyExam('मैं आपका पेट देखूँगा'), 'abdomen');
  assert.equal(classifyExam('दिल की धड़कन सुनता हूँ'), 'cardio');
  assert.equal(classifyExam('ಎದೆ ಪರೀಕ್ಷೆ ಮಾಡುತ್ತೇನೆ'), 'resp');
  assert.equal(classifyExam('ನಿಮ್ಮ ಹೊಟ್ಟೆ ಪರೀಕ್ಷಿಸುತ್ತೇನೆ'), 'abdomen');
  assert.equal(classifyExam('ಹೃದಯ ಪರೀಕ್ಷೆ'), 'cardio');
});

test('history questions and test orders are not exams', () => {
  for (const text of [
    'Does your chest hurt when you breathe?',
    'How long have you had the stomach pain?',
    'Let me check the chest X-ray.',
    'Order a CBC and check the urine.',
    'खून की जाँच करवाइए',
    'ಎದೆ ಎಕ್ಸ್-ರೇ ಮಾಡಿಸಿ',
    'ok',
  ]) {
    assert.equal(classifyExam(text), null, text);
  }
});

test('every exam system has a label and a body-part phrase', () => {
  assert.equal(new Set(EXAM_SYSTEMS.map((s) => s.id)).size, EXAM_SYSTEMS.length);
  for (const s of EXAM_SYSTEMS) assert.ok(s.label && s.part, s.id);
});
