import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiSessionManager } from './aiSessionManager';
import type { KeyValueStore } from '../host/stateStore';

function storeWith(agentSessions: Record<string, unknown>): KeyValueStore {
  const data: Record<string, unknown> = { 'praxis.agentSessions': agentSessions };
  return {
    get: <T>(key: string) => data[key] as T | undefined,
    update: async (key: string, value: unknown) => { data[key] = value; }
  };
}

const baseRecord = (state: string) => ({
  issueKey: 'SESSION-abc',
  sessionId: 's1',
  state,
  taskDefinition: { kind: 'general', goal: 'do a thing', scope: '', definitionOfDone: '' },
  events: [{ timestamp: '2026-01-01T00:00:00.000Z', type: 'session_start', summary: 'started' }],
  stepCount: 1,
  startedAt: '2026-01-01T00:00:00.000Z'
});

test('an interrupted session is settled to aborted on load', () => {
  for (const state of ['planning', 'executing', 'awaiting_approval', 'awaiting_input']) {
    const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord(state) }));
    const loaded = mgr.getAgentSession('SESSION-abc');
    assert.equal(loaded?.state, 'aborted', `state ${state} should load as aborted`);
    assert.ok(loaded?.completedAt, 'completedAt is stamped');
    assert.equal(
      loaded?.events.at(-1)?.summary,
      'Session interrupted by an app restart'
    );
  }
});

test('a terminal or idle session loads unchanged', () => {
  for (const state of ['completed', 'failed', 'aborted', 'paused', 'not_started']) {
    const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord(state) }));
    assert.equal(mgr.getAgentSession('SESSION-abc')?.state, state);
    assert.equal(mgr.getAgentSession('SESSION-abc')?.events.length, 1, `${state}: no extra event`);
  }
});

test('updateAgentRuntime persists Agent Hub attribution', () => {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('not_started') }));
  mgr.updateAgentRuntime('SESSION-abc', { agentId: 'praxis-reviewer', activeSkills: ['code-audit'] });
  const record = mgr.getAgentSession('SESSION-abc');
  assert.equal(record?.agentId, 'praxis-reviewer');
  assert.deepEqual(record?.activeSkills, ['code-audit']);

  mgr.updateAgentRuntime('SESSION-abc', { activeSkills: [] });
  assert.equal(mgr.getAgentSession('SESSION-abc')?.activeSkills, undefined);
});

test('token usage accumulates across a session\'s turns', () => {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('executing') }));

  // A session with tools makes several model calls; each reports its own usage.
  mgr.addAgentTokenUsage('SESSION-abc', { inputTokens: 900, outputTokens: 50, totalTokens: 950 });
  mgr.addAgentTokenUsage('SESSION-abc', { inputTokens: 1200, outputTokens: 80, totalTokens: 1280 });

  assert.deepEqual(mgr.getAgentSession('SESSION-abc')?.tokenUsage, {
    inputTokens: 2100,
    outputTokens: 130,
    totalTokens: 2230
  });
});

test('a session with no reported usage keeps tokenUsage unset', () => {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('executing') }));

  // Nothing reported means nothing shown — a zero would read as "this was free".
  assert.equal(mgr.getAgentSession('SESSION-abc')?.tokenUsage, undefined);
});

test('a provider reporting only some fields does not invent the others', () => {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('executing') }));

  mgr.addAgentTokenUsage('SESSION-abc', { outputTokens: 42 });

  const usage = mgr.getAgentSession('SESSION-abc')?.tokenUsage;
  assert.equal(usage?.outputTokens, 42);
  assert.equal(usage?.inputTokens, undefined, 'an unreported input count stays unreported');
});

test('createAgentSession starts a purpose, brief and runtime epoch', () => {
  const mgr = new AiSessionManager(storeWith({}));
  const created = mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general',
    goal: 'do a thing',
    scope: 'core',
    definitionOfDone: 'done'
  }, 'openai', 'gpt-4.1');
  assert.equal(created.purpose?.goal, 'do a thing');
  assert.equal(created.handoverBrief?.revision, 0);
  assert.equal(created.runtimeEpochs?.length, 1);
  assert.equal(created.runtimeEpochs?.[0].reason, 'started');
  assert.equal(created.runtimeEpochs?.[0].model, 'gpt-4.1');
});

test('an interrupted updating brief loads as stale', () => {
  const mgr = new AiSessionManager(storeWith({
    'SESSION-abc': {
      ...baseRecord('executing'),
      handoverBrief: {
        schemaVersion: 1,
        revision: 2,
        updatedAt: '2026-01-01T00:00:00.000Z',
        sourceEventCount: 1,
        freshness: 'updating',
        progress: 'Working',
        changes: '',
        decisions: '',
        risks: '',
        openQuestions: '',
        nextSteps: '',
        userNotes: 'keep me',
        touchedFiles: []
      }
    }
  }));
  const loaded = mgr.getAgentSession('SESSION-abc');
  assert.equal(loaded?.handoverBrief?.freshness, 'stale');
  assert.equal(loaded?.handoverBrief?.userNotes, 'keep me');
});

test('brief refresh preserves user notes and ignores a stale completion', async () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'do a thing', scope: '', definitionOfDone: ''
  });
  mgr.appendAgentEvents('SESSION-abc', [
    { timestamp: '2026-01-01T00:00:01.000Z', type: 'message', summary: 'Assistant', detail: 'Wrote the helper.' }
  ]);
  const expected = mgr.beginHandoverBriefRefresh('SESSION-abc');
  mgr.editHandoverBrief('SESSION-abc', expected!, { userNotes: 'Do not drop this' });
  mgr.completeHandoverBriefRefresh('SESSION-abc', expected!);
  const brief = mgr.getAgentSession('SESSION-abc')?.handoverBrief;
  assert.equal(brief?.userNotes, 'Do not drop this');
  assert.notEqual(brief?.freshness, 'updating');
});

test('model change is rejected while executing and records an epoch when idle', () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'do a thing', scope: '', definitionOfDone: ''
  }, 'openai', 'gpt-4.1');
  mgr.updateAgentState('SESSION-abc', 'executing');
  assert.throws(() => mgr.transitionAgentRuntime('SESSION-abc', {
    model: 'gpt-5',
    reason: 'model_change',
    eventSummary: 'Model changed to gpt-5'
  }));
  mgr.updateAgentState('SESSION-abc', 'completed');
  const next = mgr.transitionAgentRuntime('SESSION-abc', {
    model: 'gpt-5',
    reason: 'model_change',
    eventSummary: 'Model changed to gpt-5'
  });
  assert.equal(next.model, 'gpt-5');
  assert.equal(next.runtimeEpochs?.length, 2);
  assert.equal(next.runtimeEpochs?.[0].endedAt != null, true);
  assert.equal(next.events.at(-1)?.type, 'model_change');
});

test('provider handover clears native ACP state', () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'do a thing', scope: '', definitionOfDone: ''
  }, 'claude-code-cli', 'sonnet');
  mgr.updateAgentRuntime('SESSION-abc', { runtimeSessionId: 'acp-1' });
  mgr.updateAgentState('SESSION-abc', 'completed');
  const next = mgr.transitionAgentRuntime('SESSION-abc', {
    provider: 'openai',
    model: 'gpt-4.1',
    reason: 'provider_handover',
    eventSummary: 'Handed over to OpenAI'
  });
  assert.equal(next.provider, 'openai');
  assert.equal(next.runtimeSessionId, undefined);
  assert.equal(next.events.at(-1)?.type, 'provider_handover');
});

test('a conversation attributes assistant messages and caps sequential turns', () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'compare options', scope: '', definitionOfDone: ''
  }, 'openai', 'gpt-host', { toolMode: 'full' });
  mgr.updateAgentState('SESSION-abc', 'completed');
  mgr.startAgentConversation('SESSION-abc', {
    provider: 'anthropic', model: 'claude-guest', mode: 'consult', turnCap: 2
  });

  let current = mgr.prepareAgentConversationTurn('SESSION-abc');
  assert.equal(current.provider, 'anthropic');
  assert.equal(current.toolMode, 'read-only', 'consult never grants tools');
  mgr.appendAgentEvents('SESSION-abc', [{ timestamp: '2026-01-01T00:00:01.000Z', type: 'message', summary: 'Guest', detail: 'Consider A.' }]);
  assert.equal(mgr.getAgentSession('SESSION-abc')?.events.at(-1)?.speaker?.participantId, 'guest');

  current = mgr.completeAgentConversationTurn('SESSION-abc');
  assert.equal(current.conversation?.turnsUsed, 1);
  assert.equal(current.conversation?.currentSpeakerId, 'host');
  current = mgr.prepareAgentConversationTurn('SESSION-abc');
  assert.equal(current.provider, 'openai');
  mgr.appendAgentEvents('SESSION-abc', [{ timestamp: '2026-01-01T00:00:02.000Z', type: 'message', summary: 'Host', detail: 'A is best.' }]);
  assert.equal(mgr.getAgentSession('SESSION-abc')?.events.at(-1)?.speaker?.participantId, 'host');

  current = mgr.completeAgentConversationTurn('SESSION-abc');
  assert.equal(current.conversation?.state, 'capped');
  assert.equal(current.provider, 'openai', 'the host remains the ordinary follow-up runtime');
  assert.equal(current.toolMode, 'full', 'the original tool mode is restored after the conversation');
});

test('pair mode grants tools only to the selected owner between turns', () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'pair', scope: '', definitionOfDone: ''
  }, 'openai', 'gpt-host', { toolMode: 'full' });
  mgr.updateAgentState('SESSION-abc', 'completed');
  mgr.startAgentConversation('SESSION-abc', { provider: 'anthropic', model: 'claude-guest', mode: 'pair', turnCap: 3 });
  let current = mgr.prepareAgentConversationTurn('SESSION-abc');
  assert.equal(current.toolMode, 'read-only', 'the guest is not the initial owner');
  mgr.completeAgentConversationTurn('SESSION-abc');
  mgr.setAgentConversationToolOwner('SESSION-abc', 'guest');
  current = mgr.prepareAgentConversationTurn('SESSION-abc');
  assert.equal(current.toolMode, 'read-only', 'the host no longer owns tools');
  mgr.completeAgentConversationTurn('SESSION-abc');
  current = mgr.prepareAgentConversationTurn('SESSION-abc');
  assert.equal(current.toolMode, 'full', 'only the promoted guest receives tools');
});

test('token usage is attributed to the open epoch', () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'do a thing', scope: '', definitionOfDone: ''
  }, 'openai', 'gpt-4.1');
  mgr.addAgentTokenUsage('SESSION-abc', { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  assert.equal(mgr.getAgentSession('SESSION-abc')?.runtimeEpochs?.[0].tokenUsage?.totalTokens, 12);
});
