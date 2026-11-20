/** Agora ConvoAI runtime message parsing + per-turn latency maths. */
import test from 'node:test';
import assert from 'node:assert/strict';

import { VoiceMetricsTracker, fmtMs, isFillerText, parseAgoraRtm } from '../../src/voice/voiceMetrics.ts';

const metric = (module: string, metric_name: string, latency_ms: number) =>
  ({ object: 'message.metrics', module, metric_name, latency_ms, send_ts: 1 });

test('parses message.metrics, message.error and message.interrupt payloads', () => {
  assert.deepEqual(parseAgoraRtm(metric('tts', 'tts_ttfb', 212)), {
    kind: 'metric', module: 'tts', name: 'tts_ttfb', valueMs: 212, turnId: undefined,
  });
  assert.equal(parseAgoraRtm(metric('bogus', 'x', 1)), null);
  assert.equal(parseAgoraRtm({ object: 'message.metrics', module: 'llm', metric_name: 'llm_ttfb' }), null);
  assert.deepEqual(parseAgoraRtm({ object: 'message.error', module: 'llm', code: 429, message: 'rate limited', send_ts: 5 }), {
    kind: 'error', module: 'llm', code: 429, message: 'rate limited',
  });
  assert.deepEqual(parseAgoraRtm({ object: 'message.interrupt', turn_id: 4, start_ms: 900 }), { kind: 'interrupt', turnId: 4 });
  assert.equal(parseAgoraRtm({ object: 'something.else' }), null);
  assert.equal(parseAgoraRtm('nope'), null);
});

test('Agora metrics fill the turn and browser timestamps give the response time', () => {
  const t = new VoiceMetricsTracker();
  t.ingest(parseAgoraRtm({ object: 'user.transcription', text: 'where does it hurt', final: true, turn_id: 1 })!, 1000);
  t.ingest(parseAgoraRtm(metric('asr', 'asr_ttlw', 180))!, 1010);
  t.ingest(parseAgoraRtm(metric('llm', 'llm_ttfb', 420))!, 1500);
  t.ingest(parseAgoraRtm({ object: 'assistant.transcription', text: 'Here, doctor', turn_status: 0, turn_id: 1 })!, 2400);
  t.ingest(parseAgoraRtm(metric('tts', 'tts_ttfb', 260))!, 2410);
  const turn = t.turns[0];
  assert.equal(turn.asrMs, 180);
  assert.equal(turn.asrSource, 'agora');
  assert.equal(turn.llmMs, 420);
  assert.equal(turn.ttsMs, 260);
  assert.equal(turn.e2eMs, 1400);
  assert.equal(turn.e2eSource, 'browser');
  assert.equal(t.summary().avgE2eMs, 1400);
});

test('without Agora metrics the ASR time is measured in the browser', () => {
  const t = new VoiceMetricsTracker();
  t.ingest(parseAgoraRtm({ object: 'user.transcription', text: 'hello', final: false })!, 100);
  t.ingest(parseAgoraRtm({ object: 'user.transcription', text: 'hello doctor', final: true })!, 340);
  t.ingest(parseAgoraRtm({ object: 'assistant.transcription', text: 'Hello', turn_status: 1 })!, 1340);
  assert.equal(t.turns[0].asrMs, 240);
  assert.equal(t.turns[0].asrSource, 'browser');
  assert.equal(t.turns[0].e2eMs, 1000);
  assert.equal(t.agoraMetricsSeen, false);
});

test('fillers are counted, not treated as the answer; interrupts dedupe per turn', () => {
  const t = new VoiceMetricsTracker();
  t.ingest(parseAgoraRtm({ object: 'user.transcription', text: 'any allergies', final: true })!, 0);
  t.ingest(parseAgoraRtm({ object: 'assistant.transcription', text: 'Hmm...', turn_status: 1, turn_id: 2 })!, 900);
  t.ingest(parseAgoraRtm({ object: 'assistant.transcription', text: 'No allergies, doctor.', turn_status: 1, turn_id: 2 })!, 1800);
  assert.equal(t.fillers, 1);
  assert.equal(t.turns[0].e2eMs, 1800);
  t.ingest(parseAgoraRtm({ object: 'message.interrupt', turn_id: 2, start_ms: 10 })!, 1900);
  t.ingest(parseAgoraRtm({ object: 'assistant.transcription', text: 'No', turn_status: 2, turn_id: 2 })!, 1901);
  assert.equal(t.interruptions, 1);
  assert.equal(isFillerText('हम्म...'), true);
  assert.equal(isFillerText('Hmm, my chest hurts'), false);
});

test('estimates the response time from module metrics when the transcript timing is missing', () => {
  const t = new VoiceMetricsTracker();
  t.ingest(parseAgoraRtm({ object: 'user.transcription', text: 'hi', final: true })!, 0);
  t.ingest(parseAgoraRtm(metric('asr', 'asr_ttlw', 100))!, 5);
  t.ingest(parseAgoraRtm(metric('llm', 'llm_ttfb', 300))!, 6);
  t.ingest(parseAgoraRtm(metric('tts', 'tts_ttfb', 200))!, 7);
  assert.equal(t.turns[0].e2eMs, 600);
  assert.equal(t.turns[0].e2eSource, 'estimated');
});

test('formats milliseconds for the debrief line', () => {
  assert.equal(fmtMs(1400), '1.4 s');
  assert.equal(fmtMs(420), '420 ms');
  assert.equal(fmtMs(null), 'n/a');
});
