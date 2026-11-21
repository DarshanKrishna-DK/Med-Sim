/**
 * Autonomous voice agents: applying the events their server-side tools publish
 * (backend/agent_events.py) and the 1.5 s poller.
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import {
  mergeEvents,
  startAgentEventPoller,
  teacherAction,
  toolLine,
  upsertGrade,
  vivaAction,
  type AgentEvent,
} from '../../src/agents/agentEvents.ts';

const ev = (seq: number, type: string, data: Record<string, unknown> = {}): AgentEvent => ({ seq, type, data, at: seq });

test('mergeEvents keeps order, drops old and duplicate seqs, advances the cursor', () => {
  const page = { events: [ev(4, 'a'), ev(2, 'b'), ev(3, 'c'), ev(3, 'c'), ev(1, 'old')], next: 4 };
  const { fresh, cursor } = mergeEvents(1, page);
  assert.deepEqual(fresh.map((e) => e.seq), [2, 3, 4]);
  assert.equal(cursor, 4);
  assert.deepEqual(mergeEvents(4, { events: [], next: 4 }), { fresh: [], cursor: 4 });
});

test('mergeEvents survives junk and follows a reset server cursor', () => {
  assert.deepEqual(mergeEvents(3, null), { fresh: [], cursor: 3 });
  assert.deepEqual(mergeEvents(3, { events: [{ nope: 1 }, 'x'] }), { fresh: [], cursor: 3 });
  assert.deepEqual(mergeEvents(9, { events: [], next: 2 }), { fresh: [], cursor: 2 });
});

test('toolLine summarises a tool event', () => {
  assert.deepEqual(toolLine(ev(1, 'tool', { tool: 'send_to_my_phone', ok: true, summary: 'Sent to +91****3210' })), {
    summary: 'Sent to +91****3210',
    ok: true,
  });
  assert.equal(toolLine(ev(1, 'quiz', {})), null);
});

test('teacherAction: whiteboard, quiz, assignment toast, calendar', () => {
  assert.deepEqual(teacherAction(ev(1, 'whiteboard', { topic: 'ECG basics', preset: 'ecg-normal' })), {
    kind: 'board',
    topic: 'ECG basics (ecg normal)',
  });
  assert.deepEqual(teacherAction(ev(1, 'whiteboard', { topic: 'Cardiac cycle', preset: null })), { kind: 'board', topic: 'Cardiac cycle' });
  const q = teacherAction(ev(2, 'quiz', { question: 'Which wave?', options: ['P', 'QRS', 'T'], answerIndex: 0, why: 'atria' }));
  assert.deepEqual(q, { kind: 'quiz', quiz: { question: 'Which wave?', options: ['P', 'QRS', 'T'], answerIndex: 0, why: 'atria' } });
  assert.equal(teacherAction(ev(2, 'quiz', { question: 'x', options: ['a', 'b'], answerIndex: 5 })), null);
  assert.deepEqual(teacherAction(ev(3, 'assignment', { code: 'ABC234', link: '/?assignment=ABC234' })), {
    kind: 'toast',
    text: 'Assignment created: ABC234',
    code: 'ABC234',
    link: '/?assignment=ABC234',
  });
  assert.equal(teacherAction(ev(4, 'calendar', { title: 'Revise: renal', startText: 'Sun 22 Nov, 9:00 AM', booked: true }))?.kind, 'toast');
  assert.equal(teacherAction(ev(5, 'viva_end', {})), null);
});

test('vivaAction and upsertGrade', () => {
  const g = vivaAction(ev(1, 'viva_grade', { question: 'Define shock', score: 12, hit: ['hypoperfusion'], missed: [] }));
  assert.deepEqual(g, { kind: 'grade', grade: { question: 'Define shock', score: 10, hit: ['hypoperfusion'], missed: [] } });
  assert.deepEqual(vivaAction(ev(2, 'viva_question', { index: 2 })), { kind: 'question', index: 2 });
  assert.equal(vivaAction(ev(2, 'viva_question', { index: -1 })), null);
  assert.deepEqual(vivaAction(ev(3, 'viva_end', { summary: 'ok' })), { kind: 'end', summary: 'ok' });
  let grades = upsertGrade([], { question: 'Define shock', score: 6, hit: [], missed: [] });
  grades = upsertGrade(grades, { question: 'define  SHOCK?', score: 8, hit: [], missed: [] });
  grades = upsertGrade(grades, { question: 'Types of shock', score: 5, hit: [], missed: [] });
  assert.deepEqual(grades.map((x) => x.score), [8, 5]);
});

test('poller delivers new events once, backs off on errors, stops cleanly', async () => {
  const timers: Array<() => void> = [];
  const delays: number[] = [];
  const pages: unknown[] = [
    { events: [ev(1, 'tool'), ev(2, 'quiz')], next: 2 },
    new Error('down'),
    { events: [ev(2, 'quiz'), ev(3, 'whiteboard')], next: 3 },
  ];
  const afters: number[] = [];
  const got: number[][] = [];
  const stop = startAgentEventPoller('medsim-ch-1', (evs) => got.push(evs.map((e) => e.seq)), {
    intervalMs: 1500,
    deps: {
      fetchPage: async (_ch, after) => {
        afters.push(after);
        const p = pages.shift();
        if (p instanceof Error) throw p;
        return p ?? { events: [], next: after };
      },
      setTimer: (fn, ms) => {
        delays.push(ms);
        timers.push(fn);
        return timers.length;
      },
      clearTimer: () => undefined,
    },
  });
  for (let i = 0; i < 3; i++) {
    timers.shift()!();
    await new Promise((r) => setImmediate(r));
  }
  assert.deepEqual(got, [[1, 2], [3]]);
  assert.deepEqual(afters, [0, 2, 2]);
  assert.deepEqual(delays, [1500, 1500, 3000, 1500]);
  stop();
  timers.shift()?.();
  await new Promise((r) => setImmediate(r));
  assert.equal(afters.length, 3);
});
