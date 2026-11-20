/**
 * Teacher Portal: topic detection ("teach me X") and the whiteboard layout
 * engine (every visual kind produces drawable, in-bounds, timed shapes).
 */

import test from 'node:test';
import assert from 'node:assert/strict';

import { FALLBACK_LESSON, detectTopicRequest, estimateSpeechMs, isLesson } from '../../src/components/teach/lesson.ts';
import { BOARD_H, BOARD_W, DIAGRAM, buildStepDrawing, wrap } from '../../src/components/teach/layout.ts';

test('detectTopicRequest pulls the topic out of natural requests', () => {
  assert.equal(detectTopicRequest('Teach me the cardiac cycle please'), 'Cardiac cycle');
  assert.equal(detectTopicRequest('can you explain acid-base balance?'), 'Acid-base balance');
  assert.equal(detectTopicRequest('What is diabetic ketoacidosis'), 'Diabetic ketoacidosis');
  assert.equal(detectTopicRequest('give me a lesson on ECG basics'), 'ECG basics');
  assert.equal(detectTopicRequest('Teach me about asthma vs COPD.'), 'Asthma vs COPD');
});

test('detectTopicRequest ignores chit-chat and vague requests', () => {
  assert.equal(detectTopicRequest('hello doctor'), null);
  assert.equal(detectTopicRequest('can you explain that again'), null);
  assert.equal(detectTopicRequest('explain it'), null);
  assert.equal(detectTopicRequest(''), null);
});

test('during a lesson only explicit requests start a new one', () => {
  assert.equal(detectTopicRequest('what is the PR interval', true), null);
  assert.equal(detectTopicRequest('teach me heart failure', true), 'Heart failure');
});

test('speech estimate grows with length', () => {
  assert.ok(estimateSpeechMs('one two three four five six seven eight') > estimateSpeechMs('one two'));
});

test('fallback lesson is valid and covers several visual kinds', () => {
  assert.ok(isLesson(FALLBACK_LESSON));
  const kinds = new Set(FALLBACK_LESSON.steps.map((s) => s.visual.kind));
  assert.ok(kinds.size >= 4);
});

test('every step lays out timed shapes inside the board', () => {
  const kinds = ['flow', 'cycle', 'compare', 'labelled', 'timeline', 'graph'] as const;
  const extra = [
    { heading: 'Parts', points: ['a'], narration: 'n.', visual: { kind: 'labelled' as const, center: 'Nephron', labels: [{ label: 'Glomerulus', note: 'filters' }, { label: 'Loop of Henle' }, { label: 'Collecting duct' }] } },
    { heading: 'Big flow', points: [], narration: 'n.', visual: { kind: 'flow' as const, nodes: 'abcdef'.split('').map((id) => ({ id, label: `Node ${id}` })), edges: [{ from: 'a', to: 'b' }, { from: 'e', to: 'f', label: 'then' }] } },
  ];
  const steps = [...FALLBACK_LESSON.steps, ...extra];
  const seen = new Set<string>();
  steps.forEach((step, i) => {
    const d = buildStepDrawing(step, i);
    seen.add(step.visual.kind);
    assert.ok(d.shapes.length > 4, `${step.visual.kind}: too few shapes`);
    assert.ok(d.total > 0.5 && d.total < 20, `${step.visual.kind}: draw time ${d.total}`);
    assert.ok(d.shapes.some((s) => s.diagram), `${step.visual.kind}: no diagram`);
    for (const s of d.shapes) {
      if (s.t !== 'text') {
        assert.ok(!/NaN|Infinity/.test(s.d), `${step.visual.kind}: bad path ${s.d.slice(0, 60)}`);
        continue;
      }
      const x = s.diagram ? s.x + DIAGRAM.x : s.x;
      const y = s.diagram ? s.y + DIAGRAM.y : s.y;
      assert.ok(x >= 0 && x <= BOARD_W && y >= 0 && y <= BOARD_H, `${step.visual.kind}: "${s.text}" at ${x},${y} off board`);
    }
  });
  for (const k of kinds) assert.ok(seen.has(k), `kind ${k} not exercised`);
});

test('wrap keeps words whole', () => {
  assert.deepEqual(wrap('Isovolumic contraction phase', 12), ['Isovolumic', 'contraction', 'phase']);
});
