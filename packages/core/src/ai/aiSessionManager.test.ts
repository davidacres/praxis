import { test } from 'node:test';
import assert from 'node:assert/strict';
import { AiSessionManager } from './aiSessionManager';
import { InMemorySessionTranscriptStore } from './sessionTranscriptStore';
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

  mgr.updateAgentRuntime('SESSION-abc', {
    runtimeLaunch: { adapter: 'acp', transport: 'acp', hostId: 'praxis-reviewer', command: '/agents/reviewer' }
  });

  test('updateAgentRuntime persists an ACP capability manifest and provider version', () => {
    const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('not_started') }));
    mgr.updateAgentRuntime('SESSION-abc', {
      providerVersion: '1.2.3',
      providerCapabilities: {
        protocol: 'acp',
        sessionResume: true,
        sessionLoad: false,
        sessionClose: true,
        mcpHttp: true
      }
    });

    assert.deepEqual(mgr.getAgentSession('SESSION-abc')?.providerCapabilities, {
      protocol: 'acp',
      sessionResume: true,
      sessionLoad: false,
      sessionClose: true,
      mcpHttp: true
    });
    assert.equal(mgr.getAgentSession('SESSION-abc')?.providerVersion, '1.2.3');
  });
  assert.deepEqual(record?.runtimeLaunch, {
    adapter: 'acp',
    transport: 'acp',
    hostId: 'praxis-reviewer',
    command: '/agents/reviewer'
  });

  mgr.updateAgentRuntime('SESSION-abc', { activeSkills: [] });
  assert.equal(mgr.getAgentSession('SESSION-abc')?.activeSkills, undefined);
});

test('updateAgentRuntime persists governed workflow controller linkage', () => {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('not_started') }));
  mgr.updateAgentRuntime('SESSION-abc', {
    workflowRunId: 'run-1',
    workflowId: 'delivery',
    workflowVersion: 3,
    workflowRole: 'controller'
  });
  assert.deepEqual(mgr.getAgentSession('SESSION-abc') && {
    workflowRunId: mgr.getAgentSession('SESSION-abc')?.workflowRunId,
    workflowId: mgr.getAgentSession('SESSION-abc')?.workflowId,
    workflowVersion: mgr.getAgentSession('SESSION-abc')?.workflowVersion,
    workflowRole: mgr.getAgentSession('SESSION-abc')?.workflowRole
  }, {
    workflowRunId: 'run-1',
    workflowId: 'delivery',
    workflowVersion: 3,
    workflowRole: 'controller'
  });

  mgr.updateAgentRuntime('SESSION-abc', { workflowRunIds: ['run-1', 'run-2', 'run-1'] });
  assert.deepEqual(mgr.getAgentSession('SESSION-abc')?.workflowRunIds, ['run-1', 'run-2']);
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

test('an ACP turn adds to the token total without disturbing the context occupancy', () => {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('executing') }));
  mgr.setAgentContextUsage('SESSION-abc', { contextTokens: 17_741, contextLimit: 1_000_000 });

  // `inputTokens` can exclude cached reads, so it is not the window's occupancy.
  mgr.addAgentTokenUsage('SESSION-abc', { inputTokens: 2, outputTokens: 4, totalTokens: 17_741 }, { updateContext: false });

  const record = mgr.getAgentSession('SESSION-abc');
  assert.equal(record?.tokenUsage?.totalTokens, 17_741);
  assert.equal(record?.contextTokens, 17_741, 'occupancy stays what usage_update said');
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

test('a priced API provider accumulates an estimated cost across turns', () => {
  const mgr = new AiSessionManager(
    storeWith({ 'SESSION-abc': { ...baseRecord('executing'), provider: 'z-ai', model: 'glm-5.3' } })
  );

  mgr.addAgentTokenUsage('SESSION-abc', { inputTokens: 1_000_000, outputTokens: 1_000_000 });
  mgr.addAgentTokenUsage('SESSION-abc', { inputTokens: 1_000_000, outputTokens: 0 });

  // GLM-5.3: $1.40/M input, $4.40/M output — two turns of 1M input + one of 1M output.
  const cost = mgr.getAgentSession('SESSION-abc')?.cost;
  assert.equal(cost?.currency, 'USD');
  assert.ok(cost && Math.abs(cost.amount - (1.4 + 4.4 + 1.4)) < 1e-9, `unexpected cost ${cost?.amount}`);
});

test('an unpriced provider or model leaves cost unset rather than reading as free', () => {
  const mgr = new AiSessionManager(
    storeWith({ 'SESSION-abc': { ...baseRecord('executing'), provider: 'openai', model: 'gpt-4o-mini' } })
  );

  mgr.addAgentTokenUsage('SESSION-abc', { inputTokens: 1000, outputTokens: 1000 });

  assert.equal(mgr.getAgentSession('SESSION-abc')?.cost, undefined);
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

test('a provider handover clears a stale limit flag from the old provider', () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'do a thing', scope: '', definitionOfDone: ''
  }, 'openai', 'gpt-4.1');
  mgr.updateAgentState('SESSION-abc', 'failed', 'You have exceeded your current quota');
  const failed = mgr.getAgentSession('SESSION-abc');
  assert.equal(failed?.providerLimitReached, true, 'setup: the old provider should read as limited');

  // Handing over to a fresh provider must not carry the old provider's
  // limit forward — it hasn't been called yet, so it can't be limited.
  const next = mgr.transitionAgentRuntime('SESSION-abc', {
    provider: 'z-ai',
    model: 'glm-5.3',
    reason: 'provider_handover',
    eventSummary: 'Handed over to Z.ai'
  });
  assert.equal(next.providerLimitReached, undefined);
  assert.equal(next.lastError, undefined);
});

test('changing model on the same provider also clears a stale limit flag', () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'do a thing', scope: '', definitionOfDone: ''
  }, 'openai', 'gpt-4.1');
  mgr.updateAgentState('SESSION-abc', 'failed', 'Rate limit reached, please try again later.');
  assert.equal(mgr.getAgentSession('SESSION-abc')?.providerLimitReached, true);

  const next = mgr.transitionAgentRuntime('SESSION-abc', {
    model: 'gpt-5',
    reason: 'model_change',
    eventSummary: 'Model changed to gpt-5'
  });
  assert.equal(next.providerLimitReached, undefined);
  assert.equal(next.lastError, undefined);
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

test('a human conversation message queues for its chosen participant without duplicating transcript events', () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'review', scope: '', definitionOfDone: ''
  }, 'openai', 'gpt-host', { toolMode: 'full' });
  mgr.updateAgentState('SESSION-abc', 'completed');
  mgr.startAgentConversation('SESSION-abc', { provider: 'anthropic', model: 'claude-guest', mode: 'consult', turnCap: 3 });
  const before = mgr.getAgentSession('SESSION-abc')!.events.length;
  mgr.queueAgentConversationMessage('SESSION-abc', 'host', 'Check the guest response for risks.');
  mgr.queueAgentConversationMessage('SESSION-abc', 'guest', 'Also compare the proposed fix.');
  assert.equal(mgr.getAgentSession('SESSION-abc')!.events.length, before, 'the host appends the user event when the turn starts');
  const pending = mgr.takeAgentConversationMessage('SESSION-abc');
  assert.deepEqual(pending, { participantId: 'host', message: 'Check the guest response for risks.' });
  assert.deepEqual(mgr.takeAgentConversationMessage('SESSION-abc'), { participantId: 'guest', message: 'Also compare the proposed fix.' });
  mgr.setAgentConversationSpeaker('SESSION-abc', pending!.participantId);
  assert.equal(mgr.getAgentSession('SESSION-abc')?.conversation?.currentSpeakerId, 'host');
});

test('a queued conversation message carries its staged images through to the turn', () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'review', scope: '', definitionOfDone: ''
  }, 'openai', 'gpt-host', { toolMode: 'full' });
  mgr.updateAgentState('SESSION-abc', 'completed');
  mgr.startAgentConversation('SESSION-abc', { provider: 'anthropic', model: 'claude-guest', mode: 'consult', turnCap: 3 });
  const images = [{ mimeType: 'image/png', dataBase64: 'aGVsbG8=' }];
  mgr.queueAgentConversationMessage('SESSION-abc', 'host', 'What is in this screenshot?', images);
  const record = mgr.getAgentSession('SESSION-abc')!;
  assert.deepEqual(record.conversation?.pendingUserMessages?.[0], { participantId: 'host', message: 'What is in this screenshot?', images });
  const pending = mgr.takeAgentConversationMessage('SESSION-abc');
  assert.equal(pending?.images?.[0].mimeType, 'image/png');
  assert.equal(pending?.images?.[0].dataBase64, 'aGVsbG8=');
});

test('an image-only conversation message queues without a text body', () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'review', scope: '', definitionOfDone: ''
  }, 'openai', 'gpt-host', { toolMode: 'full' });
  mgr.updateAgentState('SESSION-abc', 'completed');
  mgr.startAgentConversation('SESSION-abc', { provider: 'anthropic', model: 'claude-guest', mode: 'consult', turnCap: 3 });
  const images = [{ mimeType: 'image/jpeg', dataBase64: 'aGVsbG8=' }];
  mgr.queueAgentConversationMessage('SESSION-abc', 'host', '', images);
  assert.equal(mgr.getAgentSession('SESSION-abc')?.conversation?.pendingUserMessages?.[0].images?.length, 1);
});

test('an image-only queue attempt without any attachments is still rejected', () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'review', scope: '', definitionOfDone: ''
  }, 'openai', 'gpt-host', { toolMode: 'full' });
  mgr.updateAgentState('SESSION-abc', 'completed');
  mgr.startAgentConversation('SESSION-abc', { provider: 'anthropic', model: 'claude-guest', mode: 'consult', turnCap: 3 });
  assert.throws(() => mgr.queueAgentConversationMessage('SESSION-abc', 'host', '', []), /Enter a message/);
});

test('token usage is attributed to the open epoch', () => {
  const mgr = new AiSessionManager(storeWith({}));
  mgr.createAgentSession('SESSION-abc', 's1', {
    kind: 'general', goal: 'do a thing', scope: '', definitionOfDone: ''
  }, 'openai', 'gpt-4.1');
  mgr.addAgentTokenUsage('SESSION-abc', { inputTokens: 10, outputTokens: 2, totalTokens: 12 });
  assert.equal(mgr.getAgentSession('SESSION-abc')?.runtimeEpochs?.[0].tokenUsage?.totalTokens, 12);
});

test('setAgentSessionArchived toggles and clears, leaving the record otherwise untouched', () => {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('completed') }));
  const before = mgr.getAgentSession('SESSION-abc');
  assert.equal(before?.archived, undefined);

  const archived = mgr.setAgentSessionArchived('SESSION-abc', true);
  assert.equal(archived.archived, true);
  const persisted = mgr.getAgentSession('SESSION-abc');
  assert.equal(persisted?.archived, true);
  assert.equal(persisted?.state, 'completed');
  assert.equal(persisted?.events.length, before?.events.length, 'archiving must not append events');

  const restored = mgr.setAgentSessionArchived('SESSION-abc', false);
  assert.equal(restored.archived, undefined, 'unarchive deletes the flag so old records stay byte-identical');
  assert.equal(mgr.getAgentSession('SESSION-abc')?.archived, undefined);
});

test('setAgentSessionArchived throws for an unknown session', () => {
  const mgr = new AiSessionManager(storeWith({}));
  assert.throws(() => mgr.setAgentSessionArchived('SESSION-missing', true), /No agent session found/);
});

test('setAgentSessionArchived fires the session-changed event', () =>  {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('completed') }));
  const seen: Array<Record<string, unknown>> = [];
  mgr.onDidChangeAgentSession(record => seen.push(record as unknown as Record<string, unknown>));
  mgr.setAgentSessionArchived('SESSION-abc', true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0]?.archived, true);
});

test('updateAgentSessionToolAccess updates workingDirectory and toolMode', () => {
  const mgr = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('completed') }));
  const initial = mgr.getAgentSession('SESSION-abc')!;
  initial.toolMode = 'project-only';

  // Cannot elevate to full without a workingDirectory
  assert.throws(
    () => mgr.updateAgentSessionToolAccess('SESSION-abc', { toolMode: 'full' }),
    /A working folder is required for file tools/
  );

  // Attach a working directory and elevate to full
  const updated = mgr.updateAgentSessionToolAccess('SESSION-abc', {
    workingDirectory: '/path/to/project',
    toolMode: 'full'
  });
  assert.equal(updated.workingDirectory, '/path/to/project');
  assert.equal(updated.toolMode, 'full');

  // Detaching folder coerces toolMode to project-only
  const detached = mgr.updateAgentSessionToolAccess('SESSION-abc', {
    workingDirectory: null
  });
  assert.equal(detached.workingDirectory, undefined);
  assert.equal(detached.toolMode, 'project-only');
});

test('startup recovery is explicit, excludes workflow stages, and dismissal persists', async () => {
  const store = storeWith({
    'SESSION-a': { ...baseRecord('executing'), issueKey: 'SESSION-a' },
    'SESSION-b': { ...baseRecord('completed'), issueKey: 'SESSION-b' },
    'STAGE-a': { ...baseRecord('executing'), issueKey: 'STAGE-a', workflowNodeId: 'node-a' },
    'ARCHIVED-a': { ...baseRecord('executing'), issueKey: 'ARCHIVED-a', archived: true }
  });
  const manager = new AiSessionManager(store);
  assert.deepEqual(manager.getInterruptedAgentSessions().map(record => record.issueKey), ['SESSION-a']);
  assert.equal(manager.getAgentSession('SESSION-a')?.state, 'aborted');
  await manager.dismissInterruptedAgentSessions(['SESSION-a']);
  assert.equal(new AiSessionManager(store).getInterruptedAgentSessions().length, 0);
  assert.equal(manager.getAgentSession('SESSION-a')?.state, 'aborted');
});

test('starting an approved turn clears the restart recovery marker', () => {
  const manager = new AiSessionManager(storeWith({ 'SESSION-abc': baseRecord('executing') }));
  assert.equal(manager.getInterruptedAgentSessions().length, 1);
  manager.updateAgentState('SESSION-abc', 'executing');
  assert.equal(manager.getAgentSession('SESSION-abc')?.interruptedByRestart, undefined);
});

test('lazy session transcripts migrate on load and hydrate on demand', async () => {
  const transcriptStore = new InMemorySessionTranscriptStore();
  const rawStore = storeWith({
    'SESSION-lazy': {
      ...baseRecord('completed'),
      issueKey: 'SESSION-lazy',
      sessionId: 's-lazy-1',
      events: [
        { timestamp: '2026-01-01T00:00:00.000Z', type: 'session_start', summary: 'started' },
        { timestamp: '2026-01-01T00:00:01.000Z', type: 'message', summary: 'hello world' }
      ]
    }
  });

  const manager = new AiSessionManager(rawStore, transcriptStore);
  // On load, metadata is present but events array is unloaded
  const initial = manager.getAgentSession('SESSION-lazy');
  assert.ok(initial);
  assert.equal(initial.eventsLoaded, false);
  assert.equal(initial.events.length, 0);
  assert.equal(initial.eventCount, 2);

  // listAgentSessionSummaries leaves idle session events empty
  const summaries = manager.listAgentSessionSummaries();
  const summary = summaries.find(s => s.issueKey === 'SESSION-lazy');
  assert.ok(summary);
  assert.equal(summary.events.length, 0);
  assert.equal(summary.eventsLoaded, false);
  assert.equal(summary.eventCount, 2);

  // ensureSessionTranscript hydrates events from transcript store
  const hydrated = await manager.ensureSessionTranscript('SESSION-lazy');
  assert.ok(hydrated);
  assert.equal(hydrated.eventsLoaded, true);
  assert.equal(hydrated.events.length, 2);
  assert.equal(hydrated.events[1].summary, 'hello world');

  // Appending an event updates and persists both index and transcript store
  manager.appendAgentEvents('SESSION-lazy', [
    { timestamp: '2026-01-01T00:00:02.000Z', type: 'message', summary: 'third event' }
  ]);
  assert.equal(manager.getAgentSession('SESSION-lazy')?.events.length, 3);
  const storedTranscript = await transcriptStore.loadTranscript('s-lazy-1');
  assert.ok(storedTranscript);
  assert.equal(storedTranscript.events.length, 3);

  // Removing session purges transcript from store
  manager.removeAgentSession('SESSION-lazy');
  assert.equal(manager.getAgentSession('SESSION-lazy'), undefined);
  const deletedTranscript = await transcriptStore.loadTranscript('s-lazy-1');
  assert.equal(deletedTranscript, undefined);
});

