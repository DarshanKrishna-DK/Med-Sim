/**
 * Session language (en / hi / kn): normalisation, locale map, script detection
 * and the persona language blocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { LANGS, LANG_LABEL, LANG_LOCALE, langOfText, normLang } from '../../src/game/lang.ts';
import { languageBlock, withLanguage } from '../../src/voice/language.ts';

test('normLang falls back to English for anything unknown', () => {
  assert.equal(normLang('hi'), 'hi');
  assert.equal(normLang('kn'), 'kn');
  assert.equal(normLang('fr'), 'en');
  assert.equal(normLang(null), 'en');
});

test('locales and toggle labels cover every language', () => {
  assert.deepEqual([...LANGS], ['en', 'hi', 'kn']);
  assert.equal(LANG_LOCALE.hi, 'hi-IN');
  assert.equal(LANG_LOCALE.kn, 'kn-IN');
  assert.equal(LANG_LOCALE.en, 'en-IN');
  assert.equal(LANG_LABEL.en, 'EN');
});

test('langOfText detects Devanagari and Kannada script', () => {
  assert.equal(langOfText('मुझे सीने में दर्द है'), 'hi');
  assert.equal(langOfText('ನನಗೆ ಎದೆ ನೋವು ಇದೆ'), 'kn');
  assert.equal(langOfText('Chest pain since morning'), 'en');
  assert.equal(langOfText('BP बढ़ा हुआ है'), 'hi');
});

test('English adds no language block; hi and kn name their script', () => {
  assert.equal(languageBlock('en'), '');
  assert.equal(withLanguage('base', 'en'), 'base');
  const hi = withLanguage('base', 'hi', { female: true });
  assert.match(hi, /Devanagari/);
  assert.match(hi, /feminine Hindi/);
  assert.match(hi, /language the doctor last spoke/);
  assert.match(languageBlock('hi', { female: false }), /masculine Hindi/);
  const kn = withLanguage('base', 'kn');
  assert.match(kn, /Kannada script/);
  assert.doesNotMatch(kn, /feminine Hindi/);
  assert.match(languageBlock('kn', { role: 'teacher' }), /whole lesson/);
});
