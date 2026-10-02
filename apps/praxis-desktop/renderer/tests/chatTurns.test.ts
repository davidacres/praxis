import assert from 'node:assert/strict';
import test from 'node:test';
import { collectMessageRuns, isNarration, messageRunCovering, messageRunStartingAt } from '../src/ai/chatTurns.ts';

type Event = Parameters<typeof collectMessageRuns>[0][number];

function message(text: string, extra: Record<string, unknown> = {}): Event {
  return { type: 'message', detail: text, ...extra } as Event;
}

const identity = (event: Event) => (event.detail as string) ?? '';

test('narration claims the self-addressed first-person opener', () => {
  assert.equal(isNarration('Let me find the actual details pane summary.'), true);
  assert.equal(isNarration("I'll check the Sessions header's exact pattern."), true);
  assert.equal(isNarration('Now I have a clear picture.'), true);
});

test('narration leaves anything addressed to the user alone', () => {
  assert.equal(isNarration('Shall I apply the fix?'), false);
  assert.equal(isNarration('Want me to continue?'), false);
});

test('narration leaves structured content alone', () => {
  assert.equal(isNarration('- one\n- two'), false);
  assert.equal(isNarration('1. first\n2. second'), false);
  assert.equal(isNarration('```ts\nconst x = 1;\n```'), false);
  assert.equal(isNarration('## Findings'), false);
});

test('narration leaves a long message alone even when it opens the same way', () => {
  const long = `Let me explain. ${'detail '.repeat(40)}`;
  assert.equal(isNarration(long), false);
});

test('narration leaves a multi-clause opener alone', () => {
  assert.equal(isNarration("I'll check the diff, then summarise what I found and flag the risks."), false);
});

test('merges one turn into a single card', () => {
  const events = [
    message('Here is the summary you asked for.'),
    message('Let me find the actual details pane summary.'),
    message('SessionInspector.tsx is the details pane.')
  ];
  const runs = collectMessageRuns(events, identity);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].memberIndices, [0, 1, 2]);
  assert.deepEqual(runs[0].narration, ['Let me find the actual details pane summary.']);
  // A statement that does not open on a first-person clause is a finding, so
  // it stays in the transcript even though it sits mid-turn.
  assert.deepEqual(runs[0].parts, ['Here is the summary you asked for.', 'SessionInspector.tsx is the details pane.']);
});

test('a user message starts a new card', () => {
  const events = [message('First.'), { type: 'user_input_completed', detail: 'more' } as Event, message('Second.')];
  const runs = collectMessageRuns(events, identity);
  assert.equal(runs.length, 2);
  assert.deepEqual(runs[0].memberIndices, [0]);
  assert.deepEqual(runs[1].memberIndices, [2]);
});

test('a card renders at the first event of its run', () => {
  const runs = collectMessageRuns([message('a'), message('b')], identity);
  assert.equal(messageRunStartingAt(runs, 0)?.memberIndices.length, 2);
  assert.equal(messageRunStartingAt(runs, 1), undefined);
});

test('keeps a turn whose text is all narration, so it does not vanish', () => {
  const runs = collectMessageRuns([message('Let me check the tests.')], identity);
  assert.equal(runs.length, 1);
  assert.deepEqual(runs[0].parts, []);
  assert.deepEqual(runs[0].narration, ['Let me check the tests.']);
});

test('takes the latest running totals rather than summing them', () => {
  const events = [
    message('One.', { durationMs: 3700, tokenUsage: { inputTokens: 100, outputTokens: 20, totalTokens: 120 } }),
    message('Two.', { durationMs: 1100, tokenUsage: { inputTokens: 200, outputTokens: 30, totalTokens: 230 } })
  ];
  const run = collectMessageRuns(events, identity)[0];
  assert.equal(run.durationMs, 1100);
  assert.deepEqual(run.tokenUsage, { inputTokens: 200, outputTokens: 30, totalTokens: 230 });
});

test('takes the latest cost, since each message already carries the turn total', () => {
  const events = [
    message('One.', { cost: { amount: 0.01, currency: 'USD' } }),
    message('Two.', { cost: { amount: 0.02, currency: 'USD' } })
  ];
  assert.deepEqual(collectMessageRuns(events, identity)[0].cost, { amount: 0.02, currency: 'USD' });
});

test('dedupes tool names across the run', () => {
  const events = [message('One.', { toolNames: ['grep'] }), message('Two.', { toolNames: ['grep', 'read'] })];
  assert.deepEqual(collectMessageRuns(events, identity)[0].toolNames, ['grep', 'read']);
});

test('drops a card made only of empty messages', () => {
  const runs = collectMessageRuns([message('   '), message('')], identity);
  assert.equal(runs.length, 0);
});

test('two separate turns with identical timestamps still get separate cards', () => {
  const events = [
    message('First turn.'),
    { type: 'user_input_completed', detail: 'next' } as Event,
    message('Second turn.')
  ];
  assert.equal(collectMessageRuns(events, identity).length, 2);
});

test('a change of speaker starts a new card even mid-turn', () => {
  const events = [
    { type: 'message', detail: 'Host reply.', speaker: { participantId: 'host', provider: 'p' } } as Event,
    { type: 'message', detail: 'Guest reply.', speaker: { participantId: 'guest', provider: 'p' } } as Event
  ];
  const runs = collectMessageRuns(events, identity);
  assert.equal(runs.length, 2);
  assert.equal(runs[0].speaker?.participantId, 'host');
  assert.equal(runs[1].speaker?.participantId, 'guest');
});

test('the same speaker keeps accumulating into one card', () => {
  const events = [
    { type: 'message', detail: 'One.', speaker: { participantId: 'host', provider: 'p' } } as Event,
    { type: 'message', detail: 'Two.', speaker: { participantId: 'host', provider: 'p' } } as Event
  ];
  assert.equal(collectMessageRuns(events, identity).length, 1);
});

test('run lookups agree with the runs and stay stable as events append', () => {
  const ev = (type: string, text = '') => ({ type, summary: text, detail: text, timestamp: '2026-01-01T00:00:00Z' }) as never;
  const events = [ev('user_input_completed', 'go'), ev('message', 'Let me look'), ev('message', 'Done, here is the answer.')];
  const vis = (e: { detail?: string }) => e.detail ?? '';
  const runs = collectMessageRuns(events, vis);
  assert.equal(messageRunStartingAt(runs, 1)?.startIndex, 1);
  assert.equal(messageRunCovering(runs, 2)?.startIndex, 1);
  assert.equal(messageRunCovering(runs, 1), undefined);
  assert.equal(messageRunStartingAt(runs, 0), undefined);

  const before = runs[0].parts.slice();
  const more = collectMessageRuns([...events, ev('message', 'One more point.')], vis);
  assert.deepEqual(more[0].parts.slice(0, before.length), before);
});

test('a message followed by tool calls is folded into the thought however it is worded', () => {
  const events = [
    message('SessionInspector.tsx is the details pane.'),
    message('Here is the answer.')
  ];
  const runs = collectMessageRuns(events, identity, { isIntermediate: event => event === events[0] });
  assert.deepEqual(runs[0].narration, ['SessionInspector.tsx is the details pane.']);
  assert.deepEqual(runs[0].parts, ['Here is the answer.']);
});

test('an intermediate message with structure still stays in the transcript', () => {
  const events = [message('Findings:\n- one\n- two'), message('Done.')];
  const runs = collectMessageRuns(events, identity, { isIntermediate: event => event === events[0] });
  assert.equal(runs[0].parts.length, 2);
  assert.equal(runs[0].narration.length, 0);
});
