import test from 'node:test';
import assert from 'node:assert/strict';
import type * as acp from '@agentclientprotocol/sdk' with { 'resolution-mode': 'import' };
import { AcpAgentHost, resolveAcpReasoningValue } from './acpAgentHost';

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
