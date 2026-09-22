import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSessionRecord } from '@praxis/core';
import { mobileSessionSnapshot } from './mobileSessionProjection';

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    issueKey: 'SESSION-1', sessionId: 's1', title: 'Mobile session', provider: 'openai', model: 'gpt-5',
    state: 'executing', taskDefinition: { goal: 'Help', scope: 'repo', definitionOfDone: 'done' },
    mode: 'chat', stepCount: 1, startedAt: '2026-09-22T09:00:00.000Z',
    events: [
      { timestamp: '2026-09-22T09:00:00.000Z', type: 'user_input_completed', summary: 'Hello' },
      { timestamp: '2026-09-22T09:00:01.000Z', type: 'message', summary: 'Earlier answer' },
    ],
    responseText: 'Streaming now',
    ...overrides,
  };
}

test('projects historical events and one active streaming response', () => {
  const snapshot = mobileSessionSnapshot(record(), 12);
  assert.equal(snapshot.sequence, 12);
  assert.deepEqual(snapshot.messages.map(message => [message.role, message.text, message.status]), [
    ['user', 'Help', 'complete'],
    ['user', 'Hello', 'complete'],
    ['assistant', 'Earlier answer', 'complete'],
    ['assistant', 'Streaming now', 'streaming'],
  ]);
  assert.equal(snapshot.canCancel, true);
  assert.deepEqual(snapshot.pendingPermissions, []);
  assert.equal(snapshot.canContinue, false);
});

test('reopened history does not treat responseText as transcript truth', () => {
  const snapshot = mobileSessionSnapshot(record({ state: 'completed', responseText: 'transient buffer' }));
  assert.equal(snapshot.messages.some(message => message.text === 'transient buffer'), false);
  assert.equal(snapshot.canContinue, true);
  assert.equal(snapshot.canCancel, false);
});

test('bounds large histories so a mobile snapshot stays transportable', () => {
  const events = Array.from({ length: 120 }, (_, index) => ({
    timestamp: `2026-09-22T09:${String(Math.floor(index / 60)).padStart(2, '0')}:${String(index % 60).padStart(2, '0')}.000Z`,
    type: 'message' as const,
    summary: 'x'.repeat(20_000),
    reasoning: 'r'.repeat(10_000),
  }));
  const snapshot = mobileSessionSnapshot(record({ events, responseText: 'y'.repeat(30_000) }));
  assert.equal(snapshot.messages.length, 80);
  assert.ok(snapshot.messages.every(message => message.text.length <= 8_000 || message.status === 'streaming'));
  assert.ok(snapshot.messages.some(message => message.text.includes('content truncated for mobile')));
  assert.ok(snapshot.responseText?.includes('content truncated for mobile'));
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') < 1_000_000);
});
