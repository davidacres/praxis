import test from 'node:test';
import assert from 'node:assert/strict';
import type * as acp from '@agentclientprotocol/sdk' with { 'resolution-mode': 'import' };
import { AcpAgentHost, acpTurnTelemetry, resolveAcpReasoningValue } from './acpAgentHost';
import { AcpClientWrapper, pickPermissionOptionId } from './acpClient';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentEventSummary, AgentToolMode } from '../agentTypes';

function permissionHost(toolMode: AgentToolMode, autoApprove = true) {
  const events: AgentEventSummary[] = [];
  const agentHost = new AcpAgentHost({
    getAgentSession: () => ({ toolMode }),
    appendAgentEvents: (_key: string, added: AgentEventSummary[]) => events.push(...added),
    updateAgentState: () => {}
  } as never, { appendLine: () => {} });
  const active = { ...task('permission-test'), allowPermissionsForTask: autoApprove, autoAllowSafePermissions: true };
  (agentHost as unknown as HostInternals).activeTasks.set('permission-test', active);
  return { agentHost, events, active };
}

test('read-only ACP denies mutations and unclassified tools regardless of their title or auto-approval', async () => {
  for (const autoApprove of [true, false]) {
    for (const kind of ['edit', 'delete', 'move', 'execute', 'switch_mode', 'other', '', 'unknown']) {
      const { agentHost, events, active } = permissionHost('read-only', autoApprove);
      assert.equal(await agentHost.promptExternalPermission('permission-test', 'Read and list project context', kind), 'deny', kind);
      assert.equal(active.pendingPermissions.length, 0);
      assert.match(events[0]?.summary ?? '', /Blocked by read-only tools/);
    }
    const { agentHost } = permissionHost('read-only', autoApprove);
    const internals = agentHost as unknown as { requestPermission(key: string, request: unknown): Promise<string> };
    assert.equal(await internals.requestPermission('permission-test', { toolCallId: 'opaque', title: 'Read context', options: [] }), 'deny');
  }
});

test('read-only ACP permits classified safe tools even with opaque or misleading titles', async () => {
  for (const kind of ['read', 'search', 'think', 'fetch']) {
    const { agentHost } = permissionHost('read-only');
    assert.equal(await agentHost.promptExternalPermission('permission-test', 'Update context', kind), 'allow_always', kind);
  }
});

test('full ACP retains explicit auto-approval and project-only denies every kind', async () => {
  for (const kind of ['read', 'edit', 'move', 'execute', 'other', '', 'browser-navigate']) {
    assert.equal(await permissionHost('full').agentHost.promptExternalPermission('permission-test', 'Context', kind), 'allow_always');
    assert.equal(await permissionHost('project-only').agentHost.promptExternalPermission('permission-test', 'Context', kind), 'deny');
  }
});

test('ACP model discovery preserves existing login and honors explicit authentication', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'praxis-acp-auth-'));
  const fixture = join(folder, 'agent.mjs');
  const calls = join(folder, 'calls.jsonl');
  await writeFile(fixture, `
import { createInterface } from 'node:readline';
import { appendFileSync } from 'node:fs';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  appendFileSync(process.env.AUTH_PROBE_CALLS, JSON.stringify(request) + '\\n');
  let result = {};
  if (request.method === 'initialize') result = {
    protocolVersion: 1, agentCapabilities: {},
    authMethods: [{ id: 'api-key', name: 'API Key' }, { id: 'chat-gpt', name: 'ChatGPT' }]
  };
  if (request.method === 'session/new') result = {
    sessionId: 'probe', configOptions: [{ id: 'model', category: 'model', name: 'Model',
      type: 'select', currentValue: 'discovered-model',
      options: [{ value: 'discovered-model', name: 'Discovered model', _meta: { copilotUsage: '14x' } }] }]
  };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
}
`);
  try {
    for (const authMethod of [undefined, 'chat-gpt']) {
      await writeFile(calls, '');
      const client = new AcpClientWrapper({
        command: process.execPath, args: [fixture], workingDirectory: folder,
        env: { AUTH_PROBE_CALLS: calls }, authMethod,
        requestPermission: async () => 'deny', onSessionUpdate: () => {}
      });
      try {
        await client.connect();
        assert.equal((await client.getModelOption())?.currentValue, 'discovered-model');
      } finally {
        await client.shutdown();
      }
      const requests = (await readFile(calls, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
      const authentication = requests.filter(request => request.method === 'authenticate');
      assert.deepEqual(authentication.map(request => request.params.methodId), authMethod ? [authMethod] : []);
      assert.ok(requests.some(request => request.method === 'session/new'));
    }
    const agentHost = new AcpAgentHost({} as never, { appendLine: () => {} });
    const choices = await agentHost.listAvailableModels({ command: process.execPath, args: [fixture], workingDirectory: folder, env: { AUTH_PROBE_CALLS: calls } });
    assert.equal(choices?.options[0].pricingLabel, '14× premium requests', 'ACP billing metadata is retained when a native catalog has no matching row');
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

/**
 * The ACP SDK settles a response the moment it is read, but routes notifications
 * through an async handler chain. When an agent's last reply chunk and the end of
 * its turn arrive in one read, a resumed follow-up used to close its update gate
 * first and drop the reply, so the turn completed with no answer.
 */
test('a resumed ACP turn keeps a reply chunk that arrives together with the end of the turn', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'praxis-acp-resume-'));
  const fixture = join(folder, 'agent.mjs');
  await writeFile(fixture, `
import { createInterface } from 'node:readline';
const send = message => JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n';
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    process.stdout.write(send({ id: request.id, result: { protocolVersion: 1, agentCapabilities: { sessionCapabilities: { resume: true } } } }));
  } else if (request.method === 'session/prompt') {
    if (request.params.prompt[0].text !== 'Follow-up question') throw new Error('Replayed history on native resume');
    const chunk = send({ method: 'session/update', params: { sessionId: request.params.sessionId,
      update: { sessionUpdate: 'agent_message_chunk', content: { type: 'text', text: 'Fresh answer.' } } } });
    // One write, so the client reads the chunk and the turn's end together.
    process.stdout.write(chunk + send({ id: request.id, result: { stopReason: 'end_turn' } }));
  } else if (request.id !== undefined) {
    process.stdout.write(send({ id: request.id, result: {} }));
  }
}
`);
  try {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      let reply = '';
      const client = new AcpClientWrapper({
        command: process.execPath, args: [fixture], workingDirectory: folder, resumeSessionId: 'resumed-session',
        requestPermission: async () => 'deny',
        onSessionUpdate: update => {
          if (update.sessionUpdate === 'agent_message_chunk' && update.content.type === 'text') reply += update.content.text;
        }
      });
      try {
        await client.connect();
        await client.prompt('Old history'.repeat(110_000), undefined, 'Follow-up question');
      } finally {
        await client.shutdown();
      }
      assert.equal(reply, 'Fresh answer.', `attempt ${attempt + 1} lost the reply`);
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});

/**
 * A workflow stage that hits a usage limit is retried on another AI under the same
 * session key about half a second later — sooner than the failed attempt's client can
 * finish shutting down. The failed attempt's cleanup must not then forget the new one.
 * (A real Governed delivery run: Implement failed on Codex, restarted on Claude Code,
 * and every Claude update was dropped from then on while the agent kept working.)
 */

interface FakeTask {
  issueKey: string;
  client: { shutdown: () => Promise<void> };
  pendingPermissions: [];
  allowPermissionsForTask: boolean;
  messageBuffer: string;
}

interface HostInternals {
  activeTasks: Map<string, FakeTask>;
  cleanupTask(issueKey: string, task?: FakeTask): Promise<void>;
}

function host(): { host: AcpAgentHost; internals: HostInternals } {
  const instance = new AcpAgentHost({} as never, { appendLine: () => {} } as never);
  return { host: instance, internals: instance as unknown as HostInternals };
}

function task(issueKey: string, shutdown: () => Promise<void> = async () => {}): FakeTask {
  return { issueKey, client: { shutdown }, pendingPermissions: [], allowPermissionsForTask: false, messageBuffer: '' };
}

test('a failed attempt that finishes shutting down late does not forget the retry that replaced it', async () => {
  const { host: agentHost, internals } = host();
  const key = 'WF-8B14FE21-implement';

  let finishShutdown!: () => void;
  const failedAttempt = task(key, () => new Promise<void>(resolve => (finishShutdown = resolve)));
  internals.activeTasks.set(key, failedAttempt);

  // The failed attempt starts cleaning up; its client is slow to close.
  const cleanup = internals.cleanupTask(key, failedAttempt);

  // Meanwhile the stage is retried on another AI under the same key.
  const retry = task(key);
  internals.activeTasks.set(key, retry);

  finishShutdown();
  await cleanup;

  assert.equal(agentHost.hasActiveTask(key), true, 'the retry is still the active task');
  assert.equal(internals.activeTasks.get(key), retry);
});

test('cleaning up the task that is still registered forgets it', async () => {
  const { host: agentHost, internals } = host();
  const key = 'WF-1-plan';
  let shutdowns = 0;
  const only = task(key, async () => {
    shutdowns += 1;
  });
  internals.activeTasks.set(key, only);

  await internals.cleanupTask(key, only);

  assert.equal(shutdowns, 1);
  assert.equal(agentHost.hasActiveTask(key), false);
  // With no task named, the registered one is cleaned up (the stop/abort path).
  internals.activeTasks.set(key, only);
  await internals.cleanupTask(key);
  assert.equal(agentHost.hasActiveTask(key), false);
});

test('maps normalized reasoning effort to ACP thought-level values', () => {
  const option: acp.SessionConfigOption = {
    id: 'effort',
    name: 'Effort',
    category: 'thought_level',
    type: 'select',
    currentValue: 'high',
    options: [
      { value: 'default', name: 'Default' },
      { value: 'low', name: 'Low' },
      { value: 'medium', name: 'Medium' },
      { value: 'high', name: 'High' },
      { value: 'max', name: 'Max' }
    ]
  };

  assert.equal(resolveAcpReasoningValue(option, 'off'), 'default');
  assert.equal(resolveAcpReasoningValue(option, 'low'), 'low');
  assert.equal(resolveAcpReasoningValue(option, 'medium'), 'medium');
  assert.equal(resolveAcpReasoningValue(option, 'high'), 'high');
  assert.equal(resolveAcpReasoningValue(option, undefined), undefined);
});


test('a continuation waits for completed ACP client cleanup without closing it twice', async () => {
  const key = 'review~APP-209';
  const manager = { getAgentSession: () => ({ state: 'completed' }) };
  const agentHost = new AcpAgentHost(manager as never, { appendLine: () => {} });
  const internals = agentHost as unknown as HostInternals;
  let finishShutdown!: () => void;
  let shutdowns = 0;
  const completed = task(key, () => {
    shutdowns += 1;
    return new Promise<void>(resolve => { finishShutdown = resolve; });
  });
  internals.activeTasks.set(key, completed);
  const cleanup = internals.cleanupTask(key, completed);
  // Blank input isolates the readiness gate: it must reach input validation
  // only after cleanup, rather than reject a completed task as still working.
  let settled = false;
  const continuation = agentHost.continueTask(key, '', { command: 'fixture' });
  const validation = assert.rejects(continuation, /Enter a follow-up message/).then(() => { settled = true; });
  await Promise.resolve();
  assert.equal(settled, false);
  assert.equal(shutdowns, 1);
  finishShutdown();
  await Promise.all([cleanup, validation]);
  assert.equal(agentHost.hasActiveTask(key), false);
});

test('an executing ACP turn still refuses a concurrent continuation', async () => {
  const key = 'APP-209';
  const manager = { getAgentSession: () => ({ state: 'executing' }) };
  const agentHost = new AcpAgentHost(manager as never, { appendLine: () => {} });
  const internals = agentHost as unknown as HostInternals;
  let shutdowns = 0;
  internals.activeTasks.set(key, task(key, async () => { shutdowns += 1; }));
  await assert.rejects(agentHost.continueTask(key, 'next turn', { command: 'fixture' }), /still working/);
  assert.equal(shutdowns, 0);
  assert.equal(agentHost.hasActiveTask(key), true);
});

/**
 * Response shapes below are copied from live probes of the installed agents (Claude
 * Code, Codex, Copilot), not invented: what a reply's chips can show is exactly what
 * these carry.
 */
const CLAUDE_TURN = {
  usage: { inputTokens: 2, outputTokens: 5, cachedReadTokens: 10_434, cachedWriteTokens: 9_472, totalTokens: 19_913 },
  _meta: {
    quota: {
      model_usage: [
        { model: 'claude-haiku-4-5-20251001', token_count: { totalTokens: 913 } },
        { model: 'claude-sonnet-5-5', token_count: { totalTokens: 19_913 } }
      ]
    }
  }
};

test('an ACP reply reports the turn\'s tokens, the model that did the work, and its duration', () => {
  const telemetry = acpTurnTelemetry({ response: CLAUDE_TURN, startedAt: 1_000, endedAt: 3_500 });

  assert.equal(telemetry.durationMs, 2_500);
  assert.equal(telemetry.modelId, 'claude-sonnet-5-5', 'the small internal Haiku call is not the reply\'s model');
  assert.deepEqual(telemetry.tokenUsage, { inputTokens: 2, outputTokens: 5, totalTokens: 19_913, cachedInputTokens: 10_434 });
});

test('a turn\'s cost is what the session\'s cumulative cost grew by', () => {
  const telemetry = acpTurnTelemetry({
    response: CLAUDE_TURN,
    startedAt: 0,
    endedAt: 1,
    costBefore: { amount: 0.0393, currency: 'USD' },
    costAfter: { amount: 0.0793, currency: 'USD' }
  });

  assert.equal(telemetry.cost?.currency, 'USD');
  assert.ok(telemetry.cost && Math.abs(telemetry.cost.amount - 0.04) < 1e-9);
});

test('the first turn\'s cost is the whole cumulative cost, and a cost that did not grow is not shown', () => {
  const first = acpTurnTelemetry({ response: CLAUDE_TURN, startedAt: 0, endedAt: 1, costAfter: { amount: 0.039, currency: 'USD' } });
  assert.equal(first.cost?.amount, 0.039);

  const unchanged = acpTurnTelemetry({
    response: CLAUDE_TURN,
    startedAt: 0,
    endedAt: 1,
    costBefore: { amount: 0.05, currency: 'USD' },
    costAfter: { amount: 0.05, currency: 'USD' }
  });
  assert.equal(unchanged.cost, undefined);

  const otherCurrency = acpTurnTelemetry({
    response: CLAUDE_TURN,
    startedAt: 0,
    endedAt: 1,
    costBefore: { amount: 9, currency: 'EUR' },
    costAfter: { amount: 0.04, currency: 'USD' }
  });
  assert.equal(otherCurrency.cost?.amount, 0.04, 'a baseline in another currency is not subtracted');
});

test('an agent that reports no cost, no model rows or no usage leaves those chips off', () => {
  // Copilot: tokens, but no cost and no per-model rows.
  const copilot = acpTurnTelemetry({
    response: { usage: { inputTokens: 27_069, outputTokens: 5, totalTokens: 27_074, thoughtTokens: 0, cachedReadTokens: 27_011, cachedWriteTokens: 56 } },
    startedAt: 0,
    endedAt: 1_800,
    fallbackModel: 'auto'
  });
  assert.equal(copilot.cost, undefined);
  assert.equal(copilot.modelId, 'auto', 'falls back to the model the session was asked for');
  assert.equal(copilot.tokenUsage?.reasoningTokens, undefined, 'a zero thought count is not a reasoning chip');

  // Nothing to read: only the duration, which Praxis measures itself.
  const bare = acpTurnTelemetry({ response: {}, startedAt: 10, endedAt: 25 });
  assert.deepEqual(bare, { durationMs: 15 });
});

test('Codex reports its last turn, which is used as given', () => {
  const telemetry = acpTurnTelemetry({
    response: {
      usage: { totalTokens: 23_498, inputTokens: 197, cachedReadTokens: 23_296, outputTokens: 5, thoughtTokens: 0 },
      _meta: { quota: { model_usage: [{ model: 'gpt-6.1-sol', token_count: { totalTokens: 23_498 } }] } }
    },
    startedAt: 0,
    endedAt: 2_600
  });

  assert.equal(telemetry.modelId, 'gpt-6.1-sol');
  assert.equal(telemetry.tokenUsage?.inputTokens, 197);
  assert.equal(telemetry.tokenUsage?.totalTokens, 23_498);
});

test('pickPermissionOptionId matches hyphenated optionIds from Cursor ACP', () => {
  const options = [
    { optionId: 'allow-once', name: 'Allow Once', kind: 'allow_once' },
    { optionId: 'allow-always', name: 'Always Allow', kind: 'allow_always' },
    { optionId: 'reject-once', name: 'Reject', kind: 'reject_once' }
  ];

  assert.equal(pickPermissionOptionId('allow_once', options), 'allow-once');
  assert.equal(pickPermissionOptionId('allow_always', options), 'allow-always');
  assert.equal(pickPermissionOptionId('deny', options), 'reject-once');

  // Even if kind is not normalized:
  const rawCursorOptions = [
    { optionId: 'allow-once', name: 'Allow', kind: 'other' },
    { optionId: 'reject-once', name: 'Reject', kind: 'other' }
  ];
  assert.equal(pickPermissionOptionId('allow_once', rawCursorOptions), 'allow-once');
  assert.equal(pickPermissionOptionId('deny', rawCursorOptions), 'reject-once');
});

test('ACP denial cancels when there is no rejection option, including misleading option IDs', () => {
  assert.equal(pickPermissionOptionId('deny', []), undefined);
  assert.equal(pickPermissionOptionId('deny', [{ optionId: 'allow', kind: 'allow_once' }]), undefined);
  assert.equal(pickPermissionOptionId('deny', [{ optionId: 'reject-once', kind: 'allow_always' }]), undefined);
  assert.equal(pickPermissionOptionId('deny', [
    { optionId: 'reject-once', kind: 'allow_once' },
    { optionId: 'actual-denial', kind: 'reject_once' }
  ]), 'actual-denial');
});

test('handleCursorCreatePlan records plan, sets task list, and returns accepted', async () => {
  let recordedPlan: string | undefined;
  let recordedTasks: unknown[] = [];
  const fakeSessionManager = {
    setAgentPlan: (_key: string, plan: string) => { recordedPlan = plan; },
    setAgentTaskList: (_key: string, tasks: unknown[]) => { recordedTasks = tasks; },
    appendAgentEvents: () => {}
  };
  const agentHost = new AcpAgentHost(fakeSessionManager as never, { appendLine: () => {} });
  const internals = agentHost as unknown as {
    handleCursorCreatePlan: (key: string, req: unknown) => Promise<{ outcome: { outcome: string } }>;
  };

  const res = await internals.handleCursorCreatePlan('TICK-1', {
    toolCallId: 'call_1',
    name: 'Refactor layout',
    overview: 'Clean up layout',
    plan: '1. Step one\n2. Step two',
    todos: [
      { id: '1', content: 'Step one', status: 'completed' },
      { id: '2', content: 'Step two', status: 'in_progress' }
    ]
  });

  assert.equal(res.outcome.outcome, 'accepted');
  assert.equal(recordedPlan, '1. Step one\n2. Step two');
  assert.deepEqual(recordedTasks, [
    { content: 'Step one', status: 'completed', priority: 'medium' },
    { content: 'Step two', status: 'in_progress', priority: 'medium' }
  ]);
});

test('handleCursorUpdateTodos replaces or merges tasks', () => {
  let storedSession = { taskList: [{ content: 'Initial task', status: 'completed', priority: 'medium' }] };
  const fakeSessionManager = {
    getAgentSession: () => storedSession,
    setAgentTaskList: (_key: string, tasks: unknown[]) => {
      storedSession = { taskList: tasks as never };
    }
  };
  const agentHost = new AcpAgentHost(fakeSessionManager as never, { appendLine: () => {} });
  const internals = agentHost as unknown as {
    handleCursorUpdateTodos: (key: string, req: unknown) => void;
  };

  // merge = false replaces
  internals.handleCursorUpdateTodos('TICK-1', {
    toolCallId: 'call_2',
    merge: false,
    todos: [{ id: '1', content: 'Fresh task', status: 'pending' }]
  });
  assert.deepEqual(storedSession.taskList, [{ content: 'Fresh task', status: 'pending', priority: 'medium' }]);

  // merge = true updates existing and appends new
  internals.handleCursorUpdateTodos('TICK-1', {
    toolCallId: 'call_3',
    merge: true,
    todos: [
      { id: '1', content: 'Fresh task', status: 'in_progress' },
      { id: '2', content: 'Second task', status: 'pending' }
    ]
  });
  assert.deepEqual(storedSession.taskList, [
    { content: 'Fresh task', status: 'in_progress', priority: 'medium' },
    { content: 'Second task', status: 'pending', priority: 'medium' }
  ]);
});

test('handleCursorAskQuestion auto-answers when unattended/auto-approve, skips otherwise', async () => {
  const agentHost = new AcpAgentHost({} as never, { appendLine: () => {} });
  const internals = agentHost as unknown as {
    activeTasks: Map<string, unknown>;
    handleCursorAskQuestion: (key: string, req: unknown) => Promise<{ outcome: unknown }>;
  };

  const req = {
    toolCallId: 'call_q',
    questions: [
      { id: 'q1', prompt: 'Which framework?', options: [{ id: 'opt1', label: 'React' }, { id: 'opt2', label: 'Vue' }] }
    ]
  };

  // Without autoApprove, skips
  internals.activeTasks.set('TICK-1', { allowPermissionsForTask: false });
  const skipped = await internals.handleCursorAskQuestion('TICK-1', req);
  assert.deepEqual(skipped.outcome, { outcome: 'skipped', reason: 'Unattended turn' });

  // With autoApprove, answers first option
  internals.activeTasks.set('TICK-1', { allowPermissionsForTask: true });
  const answered = await internals.handleCursorAskQuestion('TICK-1', req);
  assert.deepEqual(answered.outcome, {
    outcome: 'answered',
    answers: [{ questionId: 'q1', selectedOptionIds: ['opt1'] }]
  });
});


test('Antigravity rejects restricted tools and missing explicit unrestricted consent before spawning', async () => {
  const host = new AcpAgentHost({} as never, { appendLine: () => {} });
  for (const toolMode of ['read-only', 'project-only', 'full'] as const) {
    for (const permissionMode of ['manual', 'autopilot'] as const) {
      if (toolMode === 'full' && permissionMode === 'autopilot') continue;
      await assert.rejects(host.startTask({ key: 'security-antigravity' } as never, { kind: 'coding' } as never, 'antigravity-cli', { command: '/must-not-spawn', toolMode, permissionMode }), /Antigravity.*Full tools.*Autopilot/);
    }
  }
});


test('an ACP tool published initially as completed or failed never emits a running event', () => {
  for (const status of ['completed', 'failed'] as const) {
    const events: AgentEventSummary[] = [];
    const host = new AcpAgentHost({ appendAgentEvents: (_key: string, added: AgentEventSummary[]) => events.push(...added) } as never, { appendLine: () => {} });
    const handler = host as unknown as { handleSessionUpdate(key: string, update: unknown, task: unknown): void };
    handler.handleSessionUpdate('session', { sessionUpdate: 'tool_call', toolCallId: 'notification', title: 'Complete subagent reviewer', status, kind: 'other', content: [] }, task('session'));
    assert.equal(events.length, 1);
    assert.equal(events[0].type, 'tool_complete');
    assert.equal(events[0].data?.ok, status === 'completed');
  }
});


test('ACP fallback replay bounds old history and retains recent conversation', () => {
  const host = new AcpAgentHost({} as never, { appendLine: () => {} });
  const transcript = (host as unknown as {
    buildConversationTranscript(events: AgentEventSummary[]): string | undefined;
  }).buildConversationTranscript([
    { type: 'message', detail: 'old'.repeat(400_000) },
    { type: 'user_input_completed', detail: 'Latest question' },
    { type: 'message', detail: 'Latest answer' }
  ] as AgentEventSummary[]);
  assert.ok(transcript && transcript.length < 129_000);
  assert.match(transcript, /Earlier conversation omitted/);
  assert.ok(transcript.endsWith('User:\nLatest question\n\nAssistant:\nLatest answer'));
});

test('ACP rejects oversized current input with an actionable error before sending', async () => {
  const client = new AcpClientWrapper({
    command: process.execPath, workingDirectory: tmpdir(),
    requestPermission: async () => 'deny', onSessionUpdate: () => {}
  });
  await assert.rejects(client.prompt('x'.repeat(1_000_001)), /ACP prompt is too large.*Shorten the message/);
});


test('ACP sends reconstructed context when native resume fails or is unavailable', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'praxis-acp-fallback-'));
  const fixture = join(folder, 'agent.mjs');
  await writeFile(fixture, `
import { createInterface } from 'node:readline';
const send = message => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...message }) + '\\n');
for await (const line of createInterface({ input: process.stdin })) {
  const request = JSON.parse(line);
  if (request.method === 'initialize') {
    send({ id: request.id, result: { protocolVersion: 1,
      agentCapabilities: process.env.RESUME_FAILS ? { sessionCapabilities: { resume: true } } : {} } });
  } else if (request.method === 'session/resume') {
    send({ id: request.id, error: { code: -32603, message: 'Session no longer exists' } });
  } else if (request.method === 'session/new') {
    send({ id: request.id, result: { sessionId: 'new-session' } });
  } else if (request.method === 'session/prompt') {
    if (request.params.prompt[0].text !== 'Reconstructed conversation and current request') throw new Error('Lost fallback history');
    send({ id: request.id, result: { stopReason: 'end_turn' } });
  }
}
`);
  try {
    for (const fails of ['', '1']) {
      const client = new AcpClientWrapper({
        command: process.execPath, args: [fixture], workingDirectory: folder,
        env: { RESUME_FAILS: fails }, resumeSessionId: 'old-session',
        requestPermission: async () => 'deny', onSessionUpdate: () => {}
      });
      try {
        await client.connect();
        const result = await client.prompt('Reconstructed conversation and current request', undefined, 'Current request only');
        assert.equal(result.stopReason, 'end_turn');
        assert.equal(client.sessionId, 'new-session');
      } finally {
        await client.shutdown();
      }
    }
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
});
