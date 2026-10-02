import assert from 'node:assert/strict';
import test from 'node:test';
import type { AgentSessionRecord, PermissionDecision } from '@praxis/core';
import { pendingMobilePermissions, respondToMobilePermission } from './mobilePermissions';

const record = (events: AgentSessionRecord['events']): AgentSessionRecord => ({
  issueKey: 'SESSION-1', sessionId: 's1', projectId: 'p1', state: 'awaiting_approval',
  taskDefinition: { goal: 'Help', scope: 'repo', definitionOfDone: 'done' },
  events, stepCount: 1, startedAt: '2026-09-22T09:00:00.000Z',
});

test('identifies the exact unresolved permission after completed requests', () => {
  const records = [record([
    { timestamp: '2026-09-22T09:00:01.000Z', type: 'permission_requested', summary: 'Read file' },
    { timestamp: '2026-09-22T09:00:02.000Z', type: 'permission_completed', summary: 'Permission: allow' },
    { timestamp: '2026-09-22T09:00:03.000Z', type: 'permission_requested', summary: 'Run tests', detail: 'npm test' },
  ])];
  assert.deepEqual(pendingMobilePermissions(records), [{
    requestId: 's1:permission:2', sessionId: 's1', sessionKey: 'SESSION-1', projectId: 'p1',
    summary: 'Run tests', detail: 'npm test', createdAt: '2026-09-22T09:00:03.000Z',
  }]);
});

test('dismisses unresolved permission history once its session is no longer awaiting approval', () => {
  const events = [{ timestamp: '2026-09-22T09:00:01.000Z', type: 'permission_requested' as const, summary: 'Run tests' }];
  assert.equal(pendingMobilePermissions([record(events)]).length, 1);
  for (const state of ['completed', 'failed', 'aborted'] as const) {
    assert.deepEqual(pendingMobilePermissions([{ ...record(events), state }]), []);
  }
});

test('responds only to a current request and rejects a stale id', () => {
  const records = [record([{ timestamp: '2026-09-22T09:00:01.000Z', type: 'permission_requested', summary: 'Run tests' }])];
  let observed: { key: string; decision: PermissionDecision } | undefined;
  const result = respondToMobilePermission({
    records,
    requestId: 's1:permission:0',
    projectId: 'p1',
    decision: 'deny',
    hasActiveTask: () => true,
    respond: (key, decision) => { observed = { key, decision }; },
  });
  assert.deepEqual(result, { requestId: 's1:permission:0', decision: 'deny', sessionId: 's1' });
  assert.deepEqual(observed, { key: 'SESSION-1', decision: 'deny' });
  assert.throws(() => respondToMobilePermission({
    records: [record([])], requestId: 's1:permission:0', projectId: 'p1', decision: 'allow', hasActiveTask: () => true, respond: () => undefined,
  }), /no longer pending/);
});

test('preserves approve-all as allow_always when responding to the desktop', () => {
  let observed: PermissionDecision | undefined;
  const result = respondToMobilePermission({
    records: [record([{ timestamp: '2026-09-22T09:00:01.000Z', type: 'permission_requested', summary: 'Run tests' }])],
    requestId: 's1:permission:0',
    projectId: 'p1',
    decision: 'allow_always',
    hasActiveTask: () => true,
    respond: (_key, decision) => { observed = decision; },
  });
  assert.deepEqual(result, { requestId: 's1:permission:0', decision: 'allow_always', sessionId: 's1' });
  assert.equal(observed, 'allow_always');
});

test('refuses a later request while an earlier one in the same session waits', () => {
  const records = [record([
    { timestamp: '2026-09-22T09:00:01.000Z', type: 'permission_requested', summary: 'Run tests' },
    { timestamp: '2026-09-22T09:00:02.000Z', type: 'permission_requested', summary: 'Write file' },
  ])];
  let responded = false;
  assert.throws(() => respondToMobilePermission({
    records, requestId: 's1:permission:1', projectId: 'p1', decision: 'allow', hasActiveTask: () => true, respond: () => { responded = true; },
  }), /earlier permission request/);
  assert.equal(responded, false);
});
