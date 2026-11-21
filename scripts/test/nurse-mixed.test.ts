import test from 'node:test';
import assert from 'node:assert/strict';
import { looksLikeOrder, isAddressedToNurse } from '../../src/agents/nurseIntent.ts';

test('mixed-language and native-script orders reach the nurse', () => {
  for (const t of ['ಒಂದು ECG ಮಾಡಿಸಿ', 'ಪ್ಯಾರಸಿಟಮಾಲ್ ಕೊಡಿ', 'एक CBC करवा दो', 'पैरासिटामोल दे दो', 'sugar test maadi', 'ಶುಗರ್ ಟೆಸ್ಟ್', 'ek x-ray karwa do']) {
    assert.ok(looksLikeOrder(t), t);
  }
});

test('nurse addressed in Indian scripts', () => {
  for (const t of ['ನರ್ಸ್, ಒಂದು ಟೆಸ್ಟ್ ಮಾಡಿ', 'आशा, ईसीजी करा दो', 'சிஸ்டர் ஊசி போடுங்க']) assert.ok(isAddressedToNurse(t), t);
});

test('native-script history questions to the patient are not orders', () => {
  for (const t of ['ನಿಮಗೆ ಎಷ್ಟು ದಿನದಿಂದ ಜ್ವರ ಇದೆ?', 'आपको कब से बुखार है?', 'how long have you had the fever?']) {
    assert.equal(looksLikeOrder(t), false, t);
  }
});
