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

test('a provider handover reaches the phone as a notice, never as the brief with its workspace paths', () => {
  const brief = '# Session handover\n## Workspace\nWorking directory: /Users/someone/repo\nContinue the work described in Next steps.';
  const snapshot = mobileSessionSnapshot(record({
    state: 'completed',
    events: [
      { timestamp: '2026-09-22T09:00:01.000Z', type: 'message', summary: 'Earlier answer' },
      { timestamp: '2026-09-22T09:00:02.000Z', type: 'model_change', summary: 'Model changed to sonnet', detail: 'Previous model: haiku' },
      { timestamp: '2026-09-22T09:00:03.000Z', type: 'provider_handover', summary: 'Handed over to Codex CLI (local)', detail: brief },
      { timestamp: '2026-09-22T09:00:04.000Z', type: 'user_input_completed', summary: brief },
      { timestamp: '2026-09-22T09:00:05.000Z', type: 'message', summary: 'Picked up from the brief.' },
    ],
  }));
  assert.deepEqual(snapshot.messages.map(message => [message.role, message.text]), [
    ['user', 'Help'],
    ['assistant', 'Earlier answer'],
    ['system', 'Model changed to sonnet'],
    ['system', 'Handed over to Codex CLI (local)'],
    ['assistant', 'Picked up from the brief.'],
  ]);
  assert.doesNotMatch(JSON.stringify(snapshot), /Working directory|\/Users\/someone/);
});

const GADGET_REPLY = [
  'Two ways to fix it.',
  '```praxis-gadget',
  '{"kind":"choice","payload":{"question":"Which fix?","options":[{"value":"a","label":"Patch"}]},"actions":[]}',
  '```',
].join('\n');

test('a gadget reply reaches the phone as prose plus the gadget, keyed as the desktop keys it', () => {
  const seen: Array<[string, string]> = [];
  const snapshot = mobileSessionSnapshot(
    record({
      state: 'completed',
      responseText: undefined,
      events: [
        { timestamp: '2026-09-22T09:00:00.000Z', type: 'user_input_completed', summary: 'Hello' },
        { timestamp: '2026-09-22T09:00:00.500Z', type: 'tool_start', summary: 'read file' },
        { timestamp: '2026-09-22T09:00:01.000Z', type: 'message', summary: 'Looking', detail: 'Looking' },
        { timestamp: '2026-09-22T09:00:02.000Z', type: 'message', summary: 'Two ways', detail: GADGET_REPLY },
      ],
    }),
    3,
    (sessionId, key) => {
      seen.push([sessionId, key]);
      return {
        gadgets: [{
          state: 'active',
          gadget: {
            version: 1, gadgetId: `${key}-1`, kind: 'choice', scope: { hostId: 'h', sessionId }, issuedAt: '2026-09-22T09:00:02.000Z', fallbackText: 'Which fix?',
            payload: { question: 'Which fix?', options: [{ value: 'a', label: 'Patch' }] }, actions: [],
          },
        }],
        unrendered: 0,
      };
    },
  );
  // The desktop counts only conversation events: Hello = 0, Looking = 1, the gadget reply = 2 (the tool event is not counted).
  assert.deepEqual(seen, [['s1', 'msg-2']]);
  const last = snapshot.messages[snapshot.messages.length - 1];
  assert.equal(last.text, 'Two ways to fix it.');
  assert.equal(last.gadgets?.length, 1);
  assert.equal(last.gadgets?.[0].gadget.gadgetId, 'msg-2-1');
});

test('a gadget the host could not render leaves a note instead of vanishing', () => {
  const snapshot = mobileSessionSnapshot(
    record({ state: 'completed', responseText: undefined, events: [{ timestamp: '2026-09-22T09:00:02.000Z', type: 'message', summary: 'x', detail: GADGET_REPLY }] }),
    1,
    () => ({ gadgets: [], unrendered: 1 }),
  );
  assert.match(snapshot.messages[snapshot.messages.length - 1].text, /could not be shown on the phone/);
});

test('a streaming reply hides a gadget fence that is still being written', () => {
  const snapshot = mobileSessionSnapshot(record({ responseText: 'Here is the choice.\n```praxis-gadget\n{"kind":"cho' }), 2);
  const streaming = snapshot.messages.find(message => message.status === 'streaming');
  assert.equal(streaming?.text, 'Here is the choice.');
});
