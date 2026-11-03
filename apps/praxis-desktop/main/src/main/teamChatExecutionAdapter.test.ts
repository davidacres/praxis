import { test } from 'node:test';
import * as assert from 'node:assert/strict';
import type { TeamChatExecutionParams } from '@praxis/core';
import { createTeamChatExecutionAdapter } from './teamChatExecutionAdapter';

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
