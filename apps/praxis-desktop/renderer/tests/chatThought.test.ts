import assert from 'node:assert/strict';
import test from 'node:test';
import { captionText, collectThoughtRuns, mergeReasoningStep, thoughtCaption } from '../src/ai/chatThought.ts';

type Event = Parameters<typeof collectThoughtRuns>[0][number];

function message(extra: Partial<Record<string, unknown>> = {}): Event {
  return { type: 'message', detail: 'reply', ...extra } as Event;
}

test('merges a cumulative reasoning buffer without repeating the opening', () => {
  assert.deepEqual(mergeReasoningStep(['Let me check the diff.'], 'Let me check the diff. Now the tests.'), [
    'Let me check the diff. Now the tests.'
  ]);
});

test('drops reasoning that is already contained in the previous step', () => {
  assert.deepEqual(mergeReasoningStep(['First thought.'], 'First thought.'), ['First thought.']);
});

test('keeps genuinely new reasoning as a separate step', () => {
  assert.deepEqual(mergeReasoningStep(['First thought.'], 'A different thought.'), [
    'First thought.',
    'A different thought.'
  ]);
});

test('groups consecutive reasoning messages into a single thought run', () => {
  const events = [message({ reasoning: 'One.' }), message({ reasoning: 'One. Two.' }), message({ reasoning: 'One. Two. Three.' })];
  const runs = collectThoughtRuns(events);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].memberIndices, [0, 1, 2]);
  assert.deepEqual(runs[0].steps, ['One. Two. Three.']);
});

test('starts a new run after a user message', () => {
  const events = [
    message({ reasoning: 'One.' }),
    { type: 'user_input_completed', detail: 'more' } as Event,
    message({ reasoning: 'Two.' })
  ];
  const runs = collectThoughtRuns(events);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].memberIndices, [0]);
  assert.deepEqual(runs[1].memberIndices, [2]);
});

test('does not break a run for an assistant message carrying no reasoning', () => {
  const events = [message({ reasoning: 'One.' }), message({}), message({ reasoning: 'One. Two.' })];
  const runs = collectThoughtRuns(events);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].steps, ['One. Two.']);
});

test('ignores reasoning on non-assistant events', () => {
  const events = [{ type: 'user_input_completed', detail: 'x', reasoning: 'nope' } as Event];
  assert.equal(collectThoughtRuns(events).length, 0);
});

test('caption prefers a counted number of calls over distinct names', () => {
  const events = [message({ reasoning: 'One.', durationMs: 4000, toolNames: ['read_file'] })];
  const runs = collectThoughtRuns(events);
  assert.equal(thoughtCaption(runs[0], events, () => 4), '4s · 4 tool calls');
});

test('caption reads the turn totals from the last event', () => {
  const events = [
    message({ reasoning: 'One.', durationMs: 55_000, toolNames: ['read_file'] }),
    message({ reasoning: 'One. Two.', durationMs: 80_000, toolNames: ['grep', 'read_file'] })
  ];
  const runs = collectThoughtRuns(events);
  assert.equal(thoughtCaption(runs[0], events), '1m 20s · 2 tool calls');
});

test('caption omits the tool count when the turn used no tools', () => {
  const events = [message({ reasoning: 'One.', durationMs: 16_000 })];
  assert.equal(thoughtCaption(collectThoughtRuns(events)[0], events), '16s');
});

test('caption uses the singular form for a single tool call', () => {
  const events = [message({ reasoning: 'One.', durationMs: 4000, toolNames: ['read_file'] })];
  assert.equal(thoughtCaption(collectThoughtRuns(events)[0], events), '4s · 1 tool call');
});

test('a sub-second turn reads as under a second, not 0s', () => {
  assert.equal(captionText(300, undefined), '<1s');
});
