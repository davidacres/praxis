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
