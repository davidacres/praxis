import assert from 'node:assert/strict';
import test from 'node:test';
import { stripGadgetFences } from './answerText';

test('stripGadgetFences removes a fully closed fence', () => {
  const text = [
    'Here is a choice:',
    '```praxis-gadget',
    '{"version":1,"kind":"choice"}',
    '```',
    'Thanks!'
  ].join('\n');
  assert.equal(stripGadgetFences(text), 'Here is a choice:\n\nThanks!');
});

test('stripGadgetFences hides a fence truncated before its closing marker', () => {
  const text = [
    'Here is a choice:',
    '```praxis-gadget',
    '{"version":1,"kind":"choice","payload":{"question":"Go ahead?"'
  ].join('\n');
  assert.equal(stripGadgetFences(text), 'Here is a choice:');
});

test('stripGadgetFences leaves plain prose with no fence untouched', () => {
  const text = 'Nothing interactive here, just prose.';
  assert.equal(stripGadgetFences(text), text);
});

test('stripGadgetFences strips a closed fence even when another fence trails unterminated', () => {
  const text = [
    'First choice:',
    '```praxis-gadget',
    '{"version":1,"kind":"choice"}',
    '```',
    'Second choice:',
    '```praxis-gadget',
    '{"version":1,"kind":"choice","payload":{"question":"cut off'
  ].join('\n');
  assert.equal(stripGadgetFences(text), 'First choice:\n\nSecond choice:');
});
