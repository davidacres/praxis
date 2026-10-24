import nodeChildProcess from 'node:child_process';
import { readProcessGroupMembers, stopProcessGroup } from './tools/processTree';
import test from 'node:test';
import assert from 'node:assert/strict';
import { AcpAgentHost } from './acp/acpAgentHost';
import { AiSessionManager } from './aiSessionManager';
import { readProviderBackgroundUpdate, readUnobservedBackgroundLaunch } from './backgroundTasks';
import type { BackgroundTask } from './agentTypes';

function fixture() {
  const data: Record<string, unknown> = {};
  const store = { get: <T>(key: string) => data[key] as T | undefined, update: async (key: string, value: unknown) => { data[key] = value; } };
  const manager = new AiSessionManager(store);
  manager.createAgentSession('s', 'one', { goal: 'Background test', scope: '', definitionOfDone: '' });
  return { manager, store };
}
const task = (state: BackgroundTask['state']): BackgroundTask => ({ id: 'b1', source: 'provider', label: 'Tests', state, startedAt: '2026-01-01', updatedAt: '2026-01-01' });

test('background lifecycle remains independent of a completed foreground turn, deduplicates and survives reload', async () => {
  const { manager, store } = fixture();
  manager.updateBackgroundTask('s', task('running'));
  manager.updateAgentState('s', 'completed');
  assert.equal(manager.getAgentSession('s')?.backgroundTasks?.[0].state, 'running');
  manager.updateBackgroundTask('s', task('completed'));
  manager.updateBackgroundTask('s', task('completed'));
  manager.updateBackgroundTask('s', task('running'));
  assert.equal(manager.getAgentSession('s')?.backgroundTasks?.[0].state, 'completed');
  assert.equal(manager.getAgentSession('s')?.events.filter(event => event.type === 'background_task').length, 2);
  await new Promise(resolve => setTimeout(resolve, 0));
  const restored = new AiSessionManager(store).getAgentSession('s');
  assert.equal(restored?.backgroundTasks?.[0].state, 'completed');
});

test('restart leaves unfinished background work unknown rather than completed', async () => {
  const { manager, store } = fixture();
  manager.updateBackgroundTask('s', task('running'));
  manager.updateAgentState('s', 'completed');
  await new Promise(resolve => setTimeout(resolve, 0));
  const restored = new AiSessionManager(store).getAgentSession('s');
  assert.equal(restored?.state, 'completed');
  assert.equal(restored?.backgroundTasks?.[0].state, 'unknown');
  assert.match(restored?.backgroundTasks?.[0].detail ?? '', /restarted/);
});

test('AIR callbacks validate identity and state; progress cannot manufacture an outcome', () => {
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'async_task_spawned' }), undefined);
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'async_task_state_update', asyncTaskId: '1', state: 'maybe' }), undefined);
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'async_task_spawned', asyncTaskId: '1', description: 'Build' })?.state, 'running');
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'async_task_progress', asyncTaskId: '1', summary: 'working' })?.state, undefined);
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'async_task_state_update', asyncTaskId: '1', state: 'failed' })?.state, 'failed');
});

test('native subagent spawn completion is running until a separate lifecycle completion', () => {
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'tool_call', title: 'Start subagent reviewer', status: 'completed' })?.state, 'running');
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'tool_call_update', title: 'Complete subagent reviewer', status: 'completed' })?.state, 'completed');
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'tool_call', title: 'echo Start subagent reviewer', status: 'completed' }), undefined);
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'tool_call', title: 'Complete subagent reviewer', status: 'in_progress' }), undefined);
});

test('an older adapter returning a background id has an unknown outcome, never a successful completion', () => {
  assert.equal(readUnobservedBackgroundLaunch({ sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: { backgroundTaskId: 'bg1' } })?.state, 'unknown');
  assert.equal(readUnobservedBackgroundLaunch({ sessionUpdate: 'tool_call_update', status: 'completed', rawOutput: 'backgroundTaskId: fake' }), undefined);
});


test('AIR native child sessions distinguish successful completion, cancellation and disconnection', () => {
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'subagent_spawned', subagentSessionId: 'child', name: 'Reviewer', task: 'Review' })?.state, 'running');
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'completed' })?.state, 'completed');
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'disconnected' })?.state, 'unknown');
  assert.equal(readProviderBackgroundUpdate({ sessionUpdate: 'subagent_state_update', subagentSessionId: 'child', state: 'cancelled' })?.state, 'stopped');
});


test('background observer releases the foreground slot and expires to unknown after one hour', async context => {
  context.mock.timers.enable({ apis: ['setTimeout'] });
  const { manager } = fixture();
  manager.updateBackgroundTask('s', { ...task('running'), producerId: '10' });
  let shutdowns = 0;
  const host = new AcpAgentHost(manager, { appendLine: () => {} });
  const active = { issueKey: 's', startedAt: 10, ownerSessionId: 'one', client: { shutdown: async () => { shutdowns += 1; } } };
  const internals = host as unknown as { activeTasks: Map<string, unknown>; cleanupTask(key: string, task: unknown): Promise<void> };
  internals.activeTasks.set('s', active);
  await internals.cleanupTask('s', active);
  assert.equal(internals.activeTasks.has('s'), false);
  assert.equal(shutdowns, 0);
  context.mock.timers.tick(60 * 60 * 1000);
  assert.equal(manager.getAgentSession('s')?.backgroundTasks?.[0].state, 'unknown');
  assert.match(manager.getAgentSession('s')?.backgroundTasks?.[0].detail ?? '', /one-hour limit/);
  assert.equal(shutdowns, 1);
});


test('failed process observation is not proof that a process exited or stopped', { skip: process.platform === 'win32' }, async context => {
  context.mock.method(nodeChildProcess, 'execFileSync', () => { throw new Error('observation unavailable'); });
  context.mock.method(process, 'kill', () => true);
  assert.equal(readProcessGroupMembers(424242), undefined);
  assert.equal(await stopProcessGroup(424242, 0), false);
});


test('cancelling an idle foreground session also closes its provider background observer', async () => {
  const { manager } = fixture();
  manager.updateBackgroundTask('s', { ...task('running'), producerId: '20' });
  manager.updateAgentState('s', 'completed');
  let shutdowns = 0;
  let stops = 0;
  const host = new AcpAgentHost(manager, { appendLine: () => {} });
  const active = { issueKey: 's', startedAt: 20, ownerSessionId: 'one', client: { shutdown: async () => { shutdowns += 1; }, terminateProcessTree: async () => { stops += 1; } } };
  const internals = host as unknown as { activeTasks: Map<string, unknown>; cleanupTask(key: string, task: unknown): Promise<void> };
  internals.activeTasks.set('s', active);
  await internals.cleanupTask('s', active);
  assert.equal(host.hasBackgroundTasks('s'), true);
  await host.abortTask('s');
  assert.equal(host.hasBackgroundTasks('s'), false);
  assert.equal(shutdowns, 1);
  assert.equal(stops, 1);
  assert.equal(manager.getAgentSession('s')?.backgroundTasks?.[0].state, 'unknown');
});
