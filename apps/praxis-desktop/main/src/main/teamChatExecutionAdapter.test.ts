import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { TeamChatExecutionParams } from '@praxis/core';
import { createTeamChatExecutionAdapter, createProductionTeamChatExecutionAdapter } from './teamChatExecutionAdapter';

test('dispatch consumes prepared context unchanged and preserves attempt usage', async () => {
  const adapter = createTeamChatExecutionAdapter(async (_params, prompt) => {
    assert.equal(prompt, 'x'.repeat(4000));
    return { text: 'reply', usage: { inputTokens: 10 }, usageReferences: ['attempt:a'] };
  });
  const result = await adapter.execute({ preparedPrompt: 'x'.repeat(4000) } as TeamChatExecutionParams);
  assert.equal(result.usage?.inputTokens, 10);
  assert.deepEqual(result.usageReferences, ['attempt:a']);
});
test('missing context or pre-dispatch cancellation invokes no provider', async () => {
  let calls = 0;
  const adapter = createTeamChatExecutionAdapter(async () => { calls++; return { text: 'unexpected' }; });
  await assert.rejects(adapter.execute({} as TeamChatExecutionParams), /not prepared/);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(adapter.execute({ preparedPrompt: 'ready', signal: controller.signal } as TeamChatExecutionParams), /cancelled/);
  assert.equal(calls, 0);
});

test('current policy is revalidated immediately before provider dispatch', async () => {
  let calls = 0;
  const adapter = createTeamChatExecutionAdapter(async () => { calls++; return { text: 'unexpected' }; }, async () => ({ conversationId: 'chat', participantId: 'lead', providerRuntime: 'fixture', accountReference: 'account', endpoint: 'endpoint', model: 'model', reasoning: 'medium', instructionVersion: '1', canonicalFolder: '/fixture', executionMode: 'chat', toolPolicy: 'project-only', permissionPolicy: 'manual' }));
  await assert.rejects(adapter.execute({ conversation: { bindings: [{ id: 'binding', status: 'valid', compatibilityDigest: 'old-full-access-policy' }] }, attempt: { bindingId: 'binding' }, preparedPrompt: 'ready' } as TeamChatExecutionParams), /policy changed/);
  assert.equal(calls, 0);
});

test('effective capability evidence is durable before runtime dispatch; evidence failure prevents launch', async () => {
  const { DEFAULT_APP_SETTINGS, conversationPayloadDigest } = await import('@praxis/core');
  let launches = 0;
  const adapter = createProductionTeamChatExecutionAdapter({
    settings: () => structuredClone(DEFAULT_APP_SETTINGS),
    resolveRuntimeConfiguration: async () => 'fixture-runtime',
    resolveConnectionOptions: async () => ({}),
    completeWithTools: async () => { launches++; return 'reply'; }
  });
  const params = {
    conversation: { id: 'c', bindings: [], messages: [] },
    participant: { id: 'p', role: 'lead', instructionVersion: '1', instructions: 'help', defaults: {} },
    turn: { id: 't', plan: { runtimeOptions: { provider: 'claude-code-cli', toolMode: 'read-only' } } },
    attempt: { id: 'a', bindingId: 'b', coordinatorEpoch: 'epoch' },
    preparedPrompt: 'prepared',
    onEvidence: async () => { throw new Error('evidence write failed'); }
  } as unknown as TeamChatExecutionParams;
  const configuration = await adapter.prepare!(params);
  params.conversation.bindings.push({ id: 'b', status: 'valid', compatibilityDigest: conversationPayloadDigest(configuration) } as never);
  await assert.rejects(adapter.execute(params), /evidence write failed/);
  assert.equal(launches, 0);
  let observed = false;
  params.onEvidence = async evidence => {
    assert.equal(evidence.kind, 'runtime_identity');
    assert.equal(evidence.data?.toolCapable, true);
    assert.equal(launches, 0);
    observed = true;
  };
  await adapter.execute(params);
  assert.equal(observed, true);
  assert.equal(launches, 1);
});


test('unverified CLI identity cannot be stabilized by turn or participant account references', async () => {
  const { DEFAULT_APP_SETTINGS } = await import('@praxis/core');
  const adapter = createProductionTeamChatExecutionAdapter({
    settings: () => structuredClone(DEFAULT_APP_SETTINGS),
    resolveRuntimeConfiguration: async () => 'fixture-runtime',
    resolveConnectionOptions: async () => ({}),
    completeWithTools: async () => { throw new Error('prepare must not dispatch'); }
  });
  for (const source of ['defaults', 'runtimeOptions'] as const) {
    const params = {
      conversation: { id: 'chat' },
      participant: { id: 'lead', instructionVersion: '1', instructions: 'help',
        defaults: source === 'defaults' ? { accountReference: 'claimed-account' } : {} },
      turn: { id: 'first', plan: { runtimeOptions: { provider: 'claude-code-cli',
        ...(source === 'runtimeOptions' ? { accountReference: 'claimed-account' } : {}) } } }
    } as unknown as TeamChatExecutionParams;
    const first = await adapter.prepare!(params);
    assert.deepEqual(await adapter.prepare!(params), first, 'same-turn dispatch revalidation stays stable');
    params.turn.id = 'second';
    const second = await adapter.prepare!(params);
    assert.notEqual(second.accountReference, first.accountReference, 'unverified identity forces reconstruction across turns');
    assert.equal(second.providerRuntime, first.providerRuntime);
  }
});
