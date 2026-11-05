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

test('production API compatibility follows credentials, model and policy without exposing credentials', async () => {
  const { DEFAULT_APP_SETTINGS, resolveTeamChatBinding } = await import('@praxis/core');
  let apiKey = 'fixture-key-first';
  const adapter = createProductionTeamChatExecutionAdapter({
    settings: () => structuredClone(DEFAULT_APP_SETTINGS),
    resolveRuntimeConfiguration: async () => 'fixture-runtime',
    resolveConnectionOptions: async () => ({ apiKey, model: 'fixture-model' }),
    completeWithTools: async () => { throw new Error('prepare must not dispatch'); }
  });
  const params = {
    conversation: { id: 'chat' },
    participant: { id: 'lead', instructionVersion: '1', instructions: 'help', defaults: {} },
    turn: { id: 'first', plan: { runtimeOptions: { provider: 'vercel-gateway', toolMode: 'project-only', permissionMode: 'manual' } } }
  } as unknown as TeamChatExecutionParams;
  const first = await adapter.prepare!(params);
  const bindings: import('@praxis/core').ConversationBinding[] = [];
  const initial = resolveTeamChatBinding(bindings, first, 'first-binding');
  params.turn.id = 'second';
  assert.equal(resolveTeamChatBinding(bindings, await adapter.prepare!(params), 'unused'), initial);
  assert.ok(!JSON.stringify(first).includes(apiKey), 'resolved identity must not contain the API key');
  apiKey = 'fixture-key-second';
  const changedAccount = await adapter.prepare!(params);
  assert.notEqual(changedAccount.accountReference, first.accountReference);
  assert.equal(resolveTeamChatBinding(bindings, changedAccount, 'replacement').id, 'replacement');
  assert.equal(initial.status, 'invalid');
  const changes: Record<string, string>[] = [{ model: 'changed-model' }, { permissionMode: 'auto' }, { toolMode: 'read-only' }];
  for (const change of changes) {
    const original = params.turn.plan.runtimeOptions;
    params.turn.plan.runtimeOptions = { ...original, ...change };
    assert.notDeepEqual(await adapter.prepare!(params), changedAccount);
    params.turn.plan.runtimeOptions = original;
  }
});

test('a changed provider or working folder invalidates the compatible binding', async () => {
  const { DEFAULT_APP_SETTINGS, resolveTeamChatBinding } = await import('@praxis/core');
  const { mkdtemp, mkdir } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'team-chat-binding-'));
  const folderA = join(root, 'a');
  const folderB = join(root, 'b');
  await mkdir(folderA);
  await mkdir(folderB);
  const adapter = createProductionTeamChatExecutionAdapter({
    settings: () => structuredClone(DEFAULT_APP_SETTINGS),
    resolveRuntimeConfiguration: async () => 'fixture-runtime',
    resolveConnectionOptions: async () => ({ apiKey: 'fixture-key', model: 'fixture-model' }),
    completeWithTools: async () => { throw new Error('prepare must not dispatch'); }
  });
  const params = {
    conversation: { id: 'chat' },
    participant: { id: 'lead', instructionVersion: '1', instructions: 'help', defaults: {} },
    turn: { id: 'first', plan: { runtimeOptions: { provider: 'vercel-gateway', workingDirectory: folderA } } }
  } as unknown as TeamChatExecutionParams;
  const bindings: import('@praxis/core').ConversationBinding[] = [];
  const initial = resolveTeamChatBinding(bindings, await adapter.prepare!(params), 'initial');
  assert.equal(resolveTeamChatBinding(bindings, await adapter.prepare!(params), 'unused'), initial);
  for (const [id, change] of [['folder', { workingDirectory: folderB }], ['provider', { provider: 'openai' }]] as const) {
    const original = params.turn.plan.runtimeOptions;
    params.turn.plan.runtimeOptions = { ...original, ...change };
    assert.equal(resolveTeamChatBinding(bindings, await adapter.prepare!(params), `replacement-${id}`).id, `replacement-${id}`);
    params.turn.plan.runtimeOptions = original;
  }
  assert.equal(initial.status, 'invalid');
});

async function prodAdapter(overrides: Partial<Parameters<typeof createProductionTeamChatExecutionAdapter>[0]> = {}) {
  const { DEFAULT_APP_SETTINGS } = await import('@praxis/core');
  return createProductionTeamChatExecutionAdapter({
    settings: () => structuredClone(DEFAULT_APP_SETTINGS),
    resolveRuntimeConfiguration: async () => 'fixture-runtime',
    resolveConnectionOptions: async () => ({ apiKey: 'fixture-key', model: 'fixture-model' }),
    completeWithTools: async () => { throw new Error('unexpected dispatch'); },
    ...overrides
  });
}
function execParams(runtimeOptions: Record<string, unknown>, ids: { conversation: string; participant: string; turn: string; binding: string; attempt: string }, bindings: import('@praxis/core').ConversationBinding[] = []) {
  return {
    conversation: { id: ids.conversation, bindings, messages: [] },
    participant: { id: ids.participant, instructionVersion: '1', instructions: 'help', defaults: {} },
    turn: { id: ids.turn, plan: { runtimeOptions, context: {} } },
    attempt: { id: ids.attempt, bindingId: ids.binding },
    preparedPrompt: 'prompt', nativePrompt: 'delta'
  } as unknown as TeamChatExecutionParams;
}

test('TASK-480 AC1: two compatible API tool members reuse provider sessions per binding across turns; another chat shares none', async () => {
  const { resolveTeamChatBinding } = await import('@praxis/core');
  const prefixes: string[] = [];
  const adapter = await prodAdapter({
    completeWithTools: async runtime => { prefixes.push(runtime.toolSessionPrefix ?? ''); return 'ok'; }
  });
  const opts = { provider: 'vercel-gateway', toolMode: 'full', permissionMode: 'manual' };
  const bindings: import('@praxis/core').ConversationBinding[] = [];
  const bindingFor = async (chat: string, member: string, turn: string) =>
    resolveTeamChatBinding(bindings, await adapter.prepare!(execParams(opts, { conversation: chat, participant: member, turn, binding: '', attempt: '' })), `b-${chat}-${member}-${turn}`);
  const results: string[] = [];
  for (const turn of ['t1', 't2']) {
    for (const member of ['a', 'b']) {
      const binding = await bindingFor('chat1', member, turn);
      results.push(binding.id);
      const params = execParams(opts, { conversation: 'chat1', participant: member, turn, binding: binding.id, attempt: `${member}-${turn}` }, bindings);
      await adapter.execute(params);
    }
  }
  assert.equal(prefixes.length, 4, 'four attempts');
  assert.equal(new Set(results).size, 2, 'two bindings reused across two turns');
  assert.equal(new Set(prefixes).size, 2, 'two provider session keys');
  const other = await bindingFor('chat2', 'a', 't1');
  assert.ok(!results.includes(other.id), 'another chat shares no binding');
});

test('TASK-480 AC2: a no-tools API member completes without a tool session; attempt usage stays attributable', async () => {
  const http = await import('node:http');
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'hello' } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 7, completion_tokens: 3, total_tokens: 10 } })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as import('node:net').AddressInfo;
  let toolCalls = 0;
  try {
    const adapter = await prodAdapter({
      resolveConnectionOptions: async () => ({ apiKey: 'fixture-key', model: 'fixture-model', gatewayUrl: `http://127.0.0.1:${port}` }),
      completeWithTools: async () => { toolCalls++; return 'unexpected'; }
    });
    const params = execParams({ provider: 'vercel-gateway', toolMode: 'project-only', permissionMode: 'manual' },
      { conversation: 'c', participant: 'p', turn: 't', binding: 'b', attempt: 'attempt-1' });
    params.conversation.bindings = [{ id: 'b', status: 'valid', compatibilityDigest: (await import('@praxis/core')).conversationPayloadDigest(await adapter.prepare!(params)) } as import('@praxis/core').ConversationBinding];
    const result = await adapter.execute(params);
    assert.equal(toolCalls, 0, 'no agent session path used');
    assert.equal(result.providerSessionId, undefined);
    assert.ok(result.text.includes('hello'));
    assert.ok(result.usage, 'usage reported');
    assert.deepEqual(result.usageReferences, ['attempt:attempt-1']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});

test('TASK-480 AC3: endpoint, instruction version and folder realpath each change the binding digest', async () => {
  const { conversationPayloadDigest } = await import('@praxis/core');
  const { mkdtemp, mkdir, symlink } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const root = await mkdtemp(join(tmpdir(), 'task-480-ac3-'));
  const real = join(root, 'real');
  await mkdir(real);
  const link = join(root, 'link');
  await symlink(real, link);
  let gatewayUrl = 'https://one.example';
  const adapter = await prodAdapter({ resolveConnectionOptions: async () => ({ apiKey: 'k', model: 'm', gatewayUrl }) });
  const ids = { conversation: 'c', participant: 'p', turn: 't', binding: '', attempt: '' };
  const digest = async (opts: Record<string, unknown>, instructions = 'help', version = '1') => {
    const params = execParams({ provider: 'vercel-gateway', ...opts }, ids);
    Object.assign(params.participant, { instructions, instructionVersion: version });
    return conversationPayloadDigest(await adapter.prepare!(params));
  };
  const base = await digest({ workingDirectory: real });
  assert.equal(await digest({ workingDirectory: link }), base, 'symlinked folder resolves to the same realpath');
  assert.notEqual(await digest({ workingDirectory: real }, 'different'), base, 'instruction text');
  assert.notEqual(await digest({ workingDirectory: real }, 'help', '2'), base, 'instruction version');
  gatewayUrl = 'https://two.example';
  assert.notEqual(await digest({ workingDirectory: real }), base, 'endpoint');
});

test('TASK-480 AC3: a runtime without native resume reconstructs from the bounded context', async () => {
  const { resolveTeamChatBinding } = await import('@praxis/core');
  const delivered: string[] = [];
  const adapter = await prodAdapter({
    completeWithTools: async runtime => { delivered.push(runtime.durableContext?.reconstruction ?? ''); return 'ok'; }
  });
  const params = execParams({ provider: 'vercel-gateway', toolMode: 'full' }, { conversation: 'c', participant: 'p', turn: 't', binding: 'b', attempt: 'a' });
  const binding = resolveTeamChatBinding([], await adapter.prepare!(params), 'b');
  params.conversation.bindings = [binding];
  const result = await adapter.execute(params);
  assert.equal(result.contextDelivery ?? 'reconstruction', 'reconstruction');
  assert.deepEqual(delivered, ['prompt']);
});

test('TASK-480 AC4: changed permissions invalidate an old binding before dispatch and it is never revalidated', async () => {
  const { resolveTeamChatBinding } = await import('@praxis/core');
  let calls = 0;
  const adapter = await prodAdapter({ completeWithTools: async () => { calls++; return 'ok'; } });
  const full = { provider: 'vercel-gateway', toolMode: 'full', permissionMode: 'auto' };
  const ids = { conversation: 'c', participant: 'p', turn: 't', binding: 'old', attempt: 'a' };
  const bindings: import('@praxis/core').ConversationBinding[] = [];
  const old = resolveTeamChatBinding(bindings, await adapter.prepare!(execParams(full, ids)), 'old');
  for (const revoked of [{ permissionMode: 'manual' }, { toolMode: 'read-only' }]) {
    const params = execParams({ ...full, ...revoked }, ids, [old]);
    await assert.rejects(adapter.execute(params), /changed before dispatch/);
    const replacement = resolveTeamChatBinding(bindings, await adapter.prepare!(params), `new-${Object.keys(revoked)[0]}`);
    assert.notEqual(replacement.id, 'old');
  }
  assert.equal(calls, 0, 'no provider invoked with revoked policy');
  const restored = resolveTeamChatBinding(bindings, await adapter.prepare!(execParams(full, ids)), 'restored');
  assert.equal(old.status, 'invalid');
  assert.notEqual(restored.id, 'old', 'switching back never revives an invalidated binding');
  await assert.rejects(adapter.execute(execParams(full, ids, [old])), /changed before dispatch/);
});

test('TASK-480 AC5: tool-runtime usage is attributed once per attempt and context occupancy is not spend', async () => {
  const adapter = await prodAdapter({
    completeWithTools: async runtime => {
      runtime.onTerminal?.({ sessionId: 's', runtimeSessionId: 'rs', teamChatContextDelivery: 'native', events: [
        { type: 'message', tokenUsage: { inputTokens: 5, outputTokens: 2, contextTokens: 9000 }, cost: 0.01 }
      ] } as unknown as import('@praxis/core').AgentSessionRecord);
      return 'ok';
    }
  });
  const { resolveTeamChatBinding } = await import('@praxis/core');
  const params = execParams({ provider: 'vercel-gateway', toolMode: 'full' }, { conversation: 'c', participant: 'p', turn: 't', binding: 'b', attempt: 'a1' });
  params.conversation.bindings = [resolveTeamChatBinding([], await adapter.prepare!(params), 'b')];
  const result = await adapter.execute(params);
  assert.deepEqual(result.usageReferences, ['attempt:a1'], 'exactly one attribution reference');
  assert.equal(result.providerSessionId, 'rs');
  assert.equal(result.contextDelivery, 'native');
});
