/**
 * Session language (en / hi / kn / ta / te / mr / bn): normalisation, locale map,
 * script detection and the persona language blocks.
 */

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { LANGS, LANG_LABEL, LANG_LOCALE, LANG_NAME, QUICK_LANGS, langOfText, normLang } from '../../src/game/lang.ts';
import { languageBlock, withLanguage } from '../../src/voice/language.ts';

test('normLang falls back to English for anything unknown', () => {
  assert.equal(normLang('hi'), 'hi');
  assert.equal(normLang('kn'), 'kn');
  assert.equal(normLang('ta'), 'ta');
  assert.equal(normLang('te'), 'te');
  assert.equal(normLang('mr'), 'mr');
  assert.equal(normLang('bn'), 'bn');
  assert.equal(normLang('fr'), 'en');
  assert.equal(normLang(null), 'en');
});

test('locales and toggle labels cover every language', () => {
  assert.deepEqual([...LANGS], ['en', 'hi', 'kn', 'ta', 'te', 'mr', 'bn']);
  assert.deepEqual([...QUICK_LANGS], ['en', 'hi', 'kn']);
  for (const l of LANGS) {
    assert.ok(LANG_LABEL[l] && LANG_NAME[l], l);
    assert.equal(LANG_LOCALE[l], `${l}-IN`);
  }
  assert.equal(LANG_LABEL.en, 'EN');
  assert.equal(LANG_LABEL.ta, 'தமிழ்');
  assert.equal(LANG_NAME.bn, 'Bengali');
});

test('langOfText detects each Indic script', () => {
  assert.equal(langOfText('मुझे सीने में दर्द है'), 'hi');
  assert.equal(langOfText('ನನಗೆ ಎದೆ ನೋವು ಇದೆ'), 'kn');
  assert.equal(langOfText('Chest pain since morning'), 'en');
  assert.equal(langOfText('BP बढ़ा हुआ है'), 'hi');
  assert.equal(langOfText('எனக்கு நெஞ்சு வலி'), 'ta');
  assert.equal(langOfText('నాకు ఛాతి నొప్పి ఉంది'), 'te');
  assert.equal(langOfText('আমার বুকে ব্যথা'), 'bn');
});

test('Devanagari resolves to Marathi by session language or the letter ळ', () => {
  assert.equal(langOfText('मला छातीत दुखतंय', 'mr'), 'mr');
  assert.equal(langOfText('मला छातीत दुखतंय', 'hi'), 'hi');
  assert.equal(langOfText('मला छातीत दुखतंय'), 'hi');
  assert.equal(langOfText('डोळे दुखतात ळ'), 'mr');
});

test('English gets only the mixed-speech rule; hi and kn name their script', () => {
  assert.match(languageBlock('en'), /MIXED LANGUAGES/);
  assert.match(languageBlock('en'), /Indian English/);
  assert.match(withLanguage('base', 'en'), /^base\n\nMIXED LANGUAGES/);
  const hi = withLanguage('base', 'hi', { female: true });
  assert.match(hi, /Devanagari/);
  assert.match(hi, /feminine Hindi/);
  assert.match(hi, /Reply in Hindi by default/);
  assert.match(hi, /MIXED LANGUAGES/);
  assert.match(languageBlock('hi', { female: false }), /masculine Hindi/);
  const kn = withLanguage('base', 'kn');
  assert.match(kn, /Kannada script/);
  assert.doesNotMatch(kn, /feminine Hindi/);
  assert.match(languageBlock('kn', { role: 'teacher' }), /whole lesson/);
});

test('each language block names only its own language', () => {
  for (const l of LANGS) {
    if (l === 'en') continue;
    for (const opts of [{}, { female: true }, { role: 'teacher' as const }]) {
      const rule = languageBlock(l, opts).split('\n')[0];
      assert.match(rule, new RegExp(`everyday spoken ${LANG_NAME[l]}\\b`), l);
      assert.match(rule, new RegExp(`Reply in ${LANG_NAME[l]} by default`), l);
      for (const other of LANGS) {
        if (other !== l) assert.doesNotMatch(rule, new RegExp(`[Rr]eply in ${LANG_NAME[other]}\\b`), `${l} block says ${other}`);
      }
    }
  }
});

test('personas follow a lasting language switch, understand mixes and never contradict the language rule', () => {
  for (const l of LANGS) {
    const b = languageBlock(l);
    assert.match(b, /last two turns in a row/, l);
    assert.match(b, /Never say you did not understand/, l);
    assert.match(b, /Keep medical terms recognisable/, l);
  }
  const src = readFileSync(new URL('../../src/voice/patientPersona.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /spoken English only/);
  assert.doesNotMatch(src, /just say "I don't understand"/);
  assert.match(src, /NOT FOR YOU/);
});

test('new Indian languages name their script and Marathi has gendered verbs', () => {
  assert.match(languageBlock('ta'), /Tamil script/);
  assert.match(languageBlock('te'), /Telugu script/);
  assert.match(languageBlock('bn'), /Bengali script/);
  const mr = withLanguage('base', 'mr', { female: true });
  assert.match(mr, /Devanagari script/);
  assert.match(mr, /feminine Marathi/);
  assert.match(languageBlock('mr', { female: false }), /masculine Marathi/);
  assert.match(languageBlock('ta', { role: 'teacher' }), /whole lesson/);
  assert.doesNotMatch(languageBlock('ta'), /feminine/);
});
