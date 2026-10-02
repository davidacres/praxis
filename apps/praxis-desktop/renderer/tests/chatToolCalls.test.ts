import assert from 'node:assert/strict';
import test from 'node:test';
import { collectTurnTools } from '../src/ai/chatToolCalls.ts';

type Event = Parameters<typeof collectTurnTools>[0][number];
const ev = (e: Record<string, unknown>) => e as unknown as Event;

test('counts every call in the turn, not distinct names', () => {
  const m1 = ev({ type: 'message' });
  const m2 = ev({ type: 'message' });
  const events = [
    ev({ type: 'user_input_completed' }),
    ev({ type: 'tool_start', data: { toolName: 'read_file', argsSummary: 'a.ts' } }),
    ev({ type: 'tool_complete', data: { toolName: 'read_file', ok: true } }),
    m1,
    ev({ type: 'tool_start', data: { toolName: 'read_file', argsSummary: 'b.ts' } }),
    ev({ type: 'tool_complete', data: { toolName: 'read_file', ok: false } }),
    m2
  ];
  const map = collectTurnTools(events);
  assert.equal(map.get(m1)?.calls.length, 1);
  assert.equal(map.get(m2)?.calls.length, 2);
  assert.deepEqual(map.get(m2)?.calls.map(c => [c.detail, c.ok]), [['a.ts', true], ['b.ts', false]]);
});

test('a new user turn starts the count again', () => {
  const m = ev({ type: 'message' });
  const events = [
    ev({ type: 'tool_start', data: { toolName: 'grep' } }),
    ev({ type: 'user_input_completed' }),
    m
  ];
  assert.equal(collectTurnTools(events).get(m)?.calls.length, 0);
});

test('a message is an aside only when tool calls follow it', () => {
  const aside = ev({ type: 'message' });
  const answer = ev({ type: 'message' });
  const events = [
    ev({ type: 'user_input_completed' }),
    aside,
    ev({ type: 'tool_start', data: { toolName: 'grep' } }),
    answer
  ];
  const map = collectTurnTools(events);
  assert.equal(map.get(aside)?.followedByTools, true);
  assert.equal(map.get(answer)?.followedByTools, false);
});
