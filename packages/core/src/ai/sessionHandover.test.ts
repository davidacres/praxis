import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AgentSessionRecord } from './agentTypes';
import {
  applyHandoverBriefUserEdits,
  buildDeterministicHandoverBrief,
  buildHandoverEnvelope,
  canChangeSessionRuntime,
  emptyHandoverBrief,
  hydrateSessionHandoverFields,
  purposeFromTask,
  redactHandoverSecrets,
  StaleHandoverBriefRevisionError
} from './sessionHandover';

function record(overrides: Partial<AgentSessionRecord> = {}): AgentSessionRecord {
  return {
    issueKey: 'FX-BE-115',
    sessionId: 's1',
    state: 'completed',
    taskDefinition: {
      kind: 'general',
      goal: 'Hand the session over',
      scope: 'Session inspector',
      definitionOfDone: 'Receiving AI can continue'
    },
    events: [],
    stepCount: 0,
    startedAt: '2026-09-14T00:00:00.000Z',
    ...overrides
  };
}

test('purpose falls back to the task definition', () => {
  const purpose = purposeFromTask(record().taskDefinition, 'FX-BE-115', 'Handover');
  assert.equal(purpose.goal, 'Hand the session over');
  assert.equal(purpose.title, 'Handover');
});

test('user edits keep notes and reject a stale revision', () => {
  const previous = emptyHandoverBrief();
  const edited = applyHandoverBriefUserEdits(previous, 0, { userNotes: 'Keep the worktree' });
  assert.equal(edited.userNotes, 'Keep the worktree');
  assert.equal(edited.revision, 1);
  assert.throws(
    () => applyHandoverBriefUserEdits(edited, 0, { userNotes: 'lost' }),
    StaleHandoverBriefRevisionError
  );
});

test('deterministic brief lists touched files and last message', () => {
  const content = buildDeterministicHandoverBrief(record({
    events: [
      { timestamp: '2026-09-14T00:00:01.000Z', type: 'message', summary: 'Assistant', detail: 'Added the purpose block.' },
      {
        timestamp: '2026-09-14T00:00:02.000Z',
        type: 'tool_complete',
        summary: 'wrote file',
        data: { fileChanges: [{ path: 'SessionInspector.tsx' }] }
      }
    ]
  }));
  assert.match(content.progress, /purpose block/);
  assert.deepEqual(content.touchedFiles, ['SessionInspector.tsx']);
});

test('deterministic brief does not copy markdown tables from the last reply', () => {
  const content = buildDeterministicHandoverBrief(record({
    events: [{
      timestamp: '2026-09-14T00:00:01.000Z',
      type: 'message',
      summary: 'Assistant',
      detail: 'Here is a table:\n\n| Story | State |\n| --- | --- |\n| FX-BE-097 | Done |'
    }]
  }));
  assert.match(content.progress, /Here is a table/);
  assert.doesNotMatch(content.progress, /FX-BE-097/);
  assert.equal(content.decisions, '');
});

test('handover envelope redacts secrets and asks the receiver to inspect files', () => {
  const envelope = buildHandoverEnvelope(
    record({
      provider: 'anthropic',
      model: 'claude-sonnet',
      handoverBrief: { ...emptyHandoverBrief(), progress: 'token: sk-abcdefghijk', nextSteps: 'Continue' },
      events: [{ timestamp: '2026-09-14T00:00:01.000Z', type: 'message', summary: 'Assistant', detail: 'api_key=supersecret' }]
    }),
    { provider: 'openai', model: 'gpt-4.1' }
  );
  assert.match(envelope.text, /taking over this Praxis session/);
  assert.match(envelope.text, /Inspect the current files/);
  assert.doesNotMatch(envelope.text, /supersecret/);
  assert.doesNotMatch(redactHandoverSecrets('token: abc'), /abc/);
});

test('busy states cannot change runtime', () => {
  assert.equal(canChangeSessionRuntime('executing'), false);
  assert.equal(canChangeSessionRuntime('completed'), true);
});

test('old records hydrate purpose, brief and a single epoch', () => {
  const loaded = hydrateSessionHandoverFields(record({ provider: 'openai', model: 'gpt-4.1' }));
  assert.equal(loaded.purpose?.goal, 'Hand the session over');
  assert.equal(loaded.handoverBrief?.revision, 0);
  assert.equal(loaded.runtimeEpochs?.length, 1);
  assert.equal(loaded.runtimeEpochs?.[0].model, 'gpt-4.1');
});
