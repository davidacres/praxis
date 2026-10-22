import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentEventSummary, AgentSessionChange, AgentSessionRecord } from '@praxis/core';
import { createSessionChangeAssembler } from '../src/ai/sessionChangeStream.ts';

const ev = (summary: string): AgentEventSummary => ({ timestamp: '2026-10-21T12:00:00.000Z', type: 'message', summary });
const whole = (events: AgentEventSummary[], key = 'S1'): AgentSessionChange =>
  ({ issueKey: key, sessionId: key, state: 'executing', events, eventsLoaded: true }) as unknown as AgentSessionChange;
const delta = (base: number, appended: AgentEventSummary[], key = 'S1'): AgentSessionChange =>
  ({ issueKey: key, sessionId: key, state: 'executing', eventsLoaded: true, eventsDelta: { base, appended } }) as unknown as AgentSessionChange;
const summaries = (record: AgentSessionRecord) => record.events.map(event => event.summary);

function harness(fetched?: AgentSessionRecord) {
  const delivered: AgentSessionRecord[] = [];
  const fetches: string[] = [];
  let release: () => void = () => undefined;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const assembler = createSessionChangeAssembler({
    fetchSession: async issueKey => { fetches.push(issueKey); await gate; return fetched; },
    deliver: record => delivered.push(record),
    maxCachedSessions: 2
  });
  return { assembler, delivered, fetches, release, settle: () => new Promise(resolve => setTimeout(resolve, 0)) };
}

test('a delta is joined onto the events already held', () => {
  const h = harness();
  h.assembler.receive(whole([ev('a')]));
  h.assembler.receive(delta(1, [ev('b')]));
  h.assembler.receive(delta(2, []));
  assert.deepEqual(h.delivered.map(summaries), [['a'], ['a', 'b'], ['a', 'b']]);
  assert.equal('eventsDelta' in h.delivered[1], false);
  // An empty delta keeps the same array, so React memos over events hold.
  assert.equal(h.delivered[2].events, h.delivered[1].events);
  assert.deepEqual(h.fetches, []);
});

test('a delta with nothing to join onto fetches the session once, then continues', async () => {
  const h = harness(whole([ev('a'), ev('b')]) as AgentSessionRecord);
  h.assembler.receive(delta(2, [ev('c')]));
  h.assembler.receive(delta(3, [ev('d')]));
  assert.deepEqual(h.delivered, []);
  assert.deepEqual(h.fetches, ['S1']);
  h.release();
  await h.settle();
  // Fetched [a, b] doesn't reach the newest delta's base of 3, so nothing to
  // join: it is delivered without events rather than with a hole in them.
  assert.equal(h.delivered.length, 1);
  assert.equal(h.delivered[0].eventsLoaded, false);
});

test('a fetch that covers the delta delivers the joined record', async () => {
  const h = harness(whole([ev('a'), ev('b')]) as AgentSessionRecord);
  h.assembler.receive(delta(1, [ev('b')]));
  h.release();
  await h.settle();
  assert.deepEqual(h.delivered.map(summaries), [['a', 'b']]);
  h.assembler.receive(delta(2, [ev('c')]));
  assert.deepEqual(summaries(h.delivered[1]), ['a', 'b', 'c']);
});

test('a whole record during a fetch wins and the fetch is ignored', async () => {
  const h = harness(whole([ev('stale')]) as AgentSessionRecord);
  h.assembler.receive(delta(5, [ev('x')]));
  h.assembler.receive(whole([ev('fresh')]));
  h.release();
  await h.settle();
  assert.deepEqual(h.delivered.map(summaries), [['fresh']]);
});

test('only a bounded number of sessions keep their events', () => {
  const h = harness();
  h.assembler.receive(whole([ev('1')], 'A'));
  h.assembler.receive(whole([ev('2')], 'B'));
  h.assembler.receive(whole([ev('3')], 'C'));
  h.assembler.receive(delta(1, [ev('x')], 'A'));
  assert.deepEqual(h.fetches, ['A']);
});

test('a plain record injected by a test still reaches listeners unchanged', () => {
  const h = harness();
  const record = whole([ev('a')]);
  h.assembler.receive(record);
  assert.equal(h.delivered[0], record);
});
