import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpAgentHost } from './acpAgentHost';

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
