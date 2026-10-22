import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createSessionChangeEncoder } from './sessionChangeEncoder';
import type { AgentEventSummary, AgentSessionRecord } from './agentTypes';

function event(summary: string): AgentEventSummary {
  return { timestamp: '2026-10-21T12:00:00.000Z', type: 'message', summary };
}

function session(events: AgentEventSummary[], eventsLoaded = true): AgentSessionRecord {
  return { issueKey: 'SESSION-1', sessionId: 's1', state: 'executing', events, eventsLoaded } as unknown as AgentSessionRecord;
}

test('the first push for a session carries its events whole', () => {
  const encoder = createSessionChangeEncoder();
  const change = encoder.encode(session([event('a')]));
  assert.deepEqual(change.events?.map(e => e.summary), ['a']);
  assert.equal('eventsDelta' in change, false);
});

test('later pushes carry only the events appended since the last one', () => {
  const encoder = createSessionChangeEncoder();
  const record = session([event('a')]);
  encoder.encode(record);
  const unchanged = encoder.encode(record);
  assert.deepEqual('eventsDelta' in unchanged && unchanged.eventsDelta, { base: 1, appended: [] });
  assert.equal(unchanged.events, undefined);
  record.events.push(event('b'), event('c'));
  const grown = encoder.encode(record);
  assert.ok('eventsDelta' in grown);
  assert.equal(grown.eventsDelta.base, 1);
  assert.deepEqual(grown.eventsDelta.appended.map(e => e.summary), ['b', 'c']);
});

test('a replaced events array is sent whole again', () => {
  const encoder = createSessionChangeEncoder();
  const record = session([event('a')]);
  encoder.encode(record);
  record.events = [event('reloaded')];
  const change = encoder.encode(record);
  assert.deepEqual(change.events?.map(e => e.summary), ['reloaded']);
});

test('an unloaded transcript is always sent whole', () => {
  const encoder = createSessionChangeEncoder();
  const record = session([], false);
  encoder.encode(record);
  const change = encoder.encode(record);
  assert.deepEqual(change.events, []);
});

test('forgetting a session makes its next push whole', () => {
  const encoder = createSessionChangeEncoder();
  const record = session([event('a')]);
  encoder.encode(record);
  encoder.forget('SESSION-1');
  assert.deepEqual(encoder.encode(record).events?.map(e => e.summary), ['a']);
});
