import test from 'node:test';
import assert from 'node:assert/strict';
import { entryBeadState, formatMoney, formatMs, formatTokens, shortKey, stageTime, stepNumbers } from '../src/schedule/spotlightFormat.ts';

/* FX-BE-193: the display helpers behind the Spotlight monitor's beads and task rows. */

const entry = (id: string, status?: string, withPrevious?: true) => ({ id, sequence: 0, ticket: { connectionId: 'c', issueKey: id, title: id }, ...(withPrevious ? { withPrevious } : {}), ...(status ? { outcome: { status } } : {}) }) as never;

test('steps number from 1 and a ticket sharing the previous step keeps its number', () => {
  const steps = stepNumbers([entry('a'), entry('b'), entry('c', undefined, true), entry('d')]);
  assert.deepEqual([...steps.values()], [1, 2, 2, 3]);
  // The first entry always starts step 1, even if marked as sharing.
  assert.equal(stepNumbers([entry('a', undefined, true)]).get('a'), 1);
});

test('a bead says what its ticket is doing; the ticket a pause is about needs you even before it starts', () => {
  assert.equal(entryBeadState(entry('a')), 'queued');
  assert.equal(entryBeadState(entry('a', 'running')), 'running');
  assert.equal(entryBeadState(entry('a', 'paused')), 'waiting');
  assert.equal(entryBeadState(entry('a', 'failed')), 'failed');
  assert.equal(entryBeadState(entry('a', 'done')), 'done');
  assert.equal(entryBeadState(entry('a', 'skipped')), 'skipped');
  assert.equal(entryBeadState(entry('a'), 'a'), 'waiting');
});

test('a running task shows time since its reported start; a finished one its duration; nothing else is invented', () => {
  const now = Date.parse('2026-11-03T22:10:00.000Z');
  const stage = (over: object) => ({ nodeId: 'n', name: 'N', type: 'agent-task', lane: 'idle', attempts: 0, ...over }) as never;
  assert.equal(stageTime(stage({ lane: 'running', startedAt: '2026-11-03T22:07:30.000Z' }), now), '2m 30s');
  assert.equal(stageTime(stage({ lane: 'done', durationMs: 42000 }), now), '42s');
  assert.equal(stageTime(stage({ lane: 'awaiting', startedAt: '2026-11-03T21:00:00.000Z' }), now), '1h 10m');
  assert.equal(stageTime(stage({ lane: 'idle' }), now), '');
  assert.equal(stageTime(stage({ lane: 'running' }), now), '');
});

test('keys, tokens, money and durations read short', () => {
  assert.equal(shortKey('PRX-T111-487'), '487');
  assert.equal(shortKey('SCH-12'), 'SCH-12');
  assert.equal(formatTokens(10_051_796), '10.1M');
  assert.equal(formatTokens(4200), '4k');
  assert.equal(formatTokens(undefined), '');
  assert.match(formatMoney(4.3, 'USD'), /4\.30/);
  assert.equal(formatMoney(undefined, 'USD'), '');
  assert.equal(formatMs(-1), '');
  assert.equal(formatMs(3_900_000), '1h 05m');
});
