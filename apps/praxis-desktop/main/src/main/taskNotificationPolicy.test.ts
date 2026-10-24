import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_APP_SETTINGS, mergeAppSettings, sanitizeAppSettings, type AgentSessionRecord, type WorkflowRun } from '@praxis/core';
import { TaskNotificationPolicy, shouldNotify } from './taskNotificationPolicy';

const session = (state: AgentSessionRecord['state'], extra: Partial<AgentSessionRecord> = {}): AgentSessionRecord => ({
  issueKey: 'SESSION-abcdef', sessionId: 's1', state, title: 'Check the project',
  taskDefinition: { goal: 'Check the project', scope: '', definitionOfDone: '' }, events: [], stepCount: 0, startedAt: '2026-10-24', ...extra
});
const run = (status: WorkflowRun['status']): WorkflowRun => ({
  runId: 'r1', startedAt: '2026-10-24', status, projectId: 'p1', workflowId: 'w1', nodes: {},
  definition: { id: 'w1', name: 'Delivery', nodes: [], edges: [] }
} as unknown as WorkflowRun);

test('live completion is emitted once even when records mutate; a follow-up can complete again', () => {
  const policy = new TaskNotificationPolicy();
  const record = session('executing');
  assert.equal(policy.session(record), undefined);
  record.state = 'completed';
  assert.equal(policy.session(record)?.category, 'completed');
  assert.equal(policy.session(record), undefined);
  record.title = 'Renamed';
  assert.equal(policy.session(record), undefined);
  record.state = 'executing';
  policy.session(record);
  record.state = 'completed';
  assert.equal(policy.session(record)?.category, 'completed');
});

test('restored terminal and restart-interrupted records never alert', () => {
  const policy = new TaskNotificationPolicy();
  assert.equal(policy.session(session('completed')), undefined);
  policy.session(session('executing'), true);
  assert.equal(policy.session(session('failed', { interruptedByRestart: true })), undefined);
  assert.equal(policy.run(run('succeeded')), undefined);
});

test('completion/failure, permission, input, pause and cancellation are distinguished', () => {
  for (const state of ['failed', 'awaiting_approval', 'awaiting_input', 'paused', 'aborted'] as const) {
    const policy = new TaskNotificationPolicy();
    policy.session(session('executing'));
    assert.equal(policy.session(session(state))?.category, state === 'aborted' ? undefined : state === 'failed' ? 'failed' : 'needsAttention');
    assert.equal(policy.session(session(state)), undefined);
  }
});

test('stage and child tasks alert for attention but leave completion to their owner', () => {
  const policy = new TaskNotificationPolicy();
  const stage = { workflowRunId: 'r1', workflowNodeId: 'n1' };
  policy.session(session('executing', stage));
  assert.equal(policy.session(session('completed', stage)), undefined);
  assert.equal(policy.session(session('awaiting_approval', stage))?.category, 'needsAttention');
});

test('multi-AI intermediate turns stay quiet; the final conversation state alerts once', () => {
  const policy = new TaskNotificationPolicy();
  const conversation = { state: 'running' } as AgentSessionRecord['conversation'];
  policy.session(session('executing', { conversation }));
  assert.equal(policy.session(session('completed', { conversation })), undefined);
  assert.equal(policy.session(session('completed', { conversation: { ...conversation, state: 'capped' } as AgentSessionRecord['conversation'] }))?.category, 'completed');
});

test('run completion, failure and approval are deduplicated', () => {
  for (const [status, category] of [['succeeded', 'completed'], ['failed', 'failed'], ['awaiting-approval', 'needsAttention'], ['cancelled', undefined]] as const) {
    const policy = new TaskNotificationPolicy();
    policy.run(run('running'));
    assert.equal(policy.run(run(status))?.category, category);
    assert.equal(policy.run(run(status)), undefined);
  }
});

test('preferences and matching focused views suppress only relevant alerts', () => {
  const policy = new TaskNotificationPolicy();
  policy.session(session('executing'));
  const notice = policy.session(session('completed'))!;
  const settings = DEFAULT_APP_SETTINGS.notifications;
  assert.equal(shouldNotify(notice, settings, []), true);
  assert.equal(shouldNotify(notice, settings, [{ sessionKey: 'SESSION-abcdef' }]), false);
  assert.equal(shouldNotify(notice, settings, [{ sessionKey: 'another' }]), true);
  assert.equal(shouldNotify(notice, { ...settings, completed: false }, []), false);
  assert.equal(shouldNotify(notice, { ...settings, suppressWhenViewing: false }, [{ sessionKey: 'SESSION-abcdef' }]), true);
});

test('notification settings reject non-booleans, preserve defaults and merge individual preferences', () => {
  const clean = sanitizeAppSettings({ notifications: { completed: false, sound: 'false', needsAttention: null } });
  assert.deepEqual(clean.notifications, { ...DEFAULT_APP_SETTINGS.notifications, completed: false });
  assert.deepEqual(mergeAppSettings(clean, { notifications: { sound: false } }).notifications, { ...clean.notifications, sound: false });
});

test('parallel approval readiness and paused stages notify without repeating when the run status catches up', () => {
  const policy = new TaskNotificationPolicy();
  const current = run('running');
  policy.run(current);
  current.definition.nodes = [{ type: 'approval', id: 'approve', name: 'Approve', inputs: [], requiredGates: [], allowBypass: false, prompt: 'Continue?', x: 0, y: 0 }];
  current.definition.entryNodeId = 'approve';
  current.nodes.approve = { nodeId: 'approve', outcome: 'pending', artifacts: [], attempts: [] };
  assert.equal(policy.run(current)?.category, 'needsAttention');
  current.status = 'awaiting-approval';
  assert.equal(policy.run(current), undefined);
  current.nodes.approve.outcome = 'succeeded';
  current.status = 'running';
  policy.run(current);
  current.nodes.check = { nodeId: 'check', outcome: 'failed', artifacts: [], attempts: [{ pause: 'provider-limit' } as any] };
  assert.equal(policy.run(current)?.category, 'needsAttention');
});

test('unfinished background work suppresses turn-complete alerts, then reports its own terminal result once', () => {
  const policy = new TaskNotificationPolicy();
  const record = session('executing', { backgroundTasks: [{ id: 'bg', source: 'provider', label: 'Checks', state: 'running', startedAt: '2026-10-24', updatedAt: '2026-10-24' }] });
  policy.session(record);
  policy.background(record);
  record.state = 'completed';
  assert.equal(policy.session(record), undefined);
  record.backgroundTasks![0].state = 'completed';
  assert.equal(policy.background(record)[0]?.title, 'Background task completed');
  assert.deepEqual(policy.background(record), []);
});

test('background restore is silent, lost monitoring requests attention and a shell exit is not called success', () => {
  const policy = new TaskNotificationPolicy();
  const record = session('completed', { backgroundTasks: [{ id: 'bg', source: 'shell', label: 'Checks', state: 'running', startedAt: '2026-10-24', updatedAt: '2026-10-24' }] });
  assert.deepEqual(policy.background(record, true), []);
  record.backgroundTasks![0].state = 'unknown';
  assert.equal(policy.background(record)[0]?.category, 'needsAttention');
  record.backgroundTasks![0].state = 'exited';
  assert.equal(policy.background(record)[0]?.title, 'Background process exited');
});
