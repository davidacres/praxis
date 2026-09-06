import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowRun } from '@praxis/core';
import { WorkflowIssueWriteBack } from './workflowIssueWriteBack';

test('concurrent completion notifications post once and merge the marker into current state', async () => {
  let current = { runId: 'r', issueKey: 'P-1', worktreePath: '/tmp/old' } as WorkflowRun;
  let sent = 0;
  let finish!: () => void;
  const blocked = new Promise<void>(resolve => { finish = resolve; });
  const writer = new WorkflowIssueWriteBack({
    get: () => current,
    send: async () => { sent++; await blocked; },
    mark: async (_id, at) => { current = { ...current, issueWriteBackAt: at }; }
  });
  const first = writer.write('r');
  await Promise.resolve();
  current = { ...current, worktreePath: undefined };
  const second = writer.write('r');
  finish();
  await Promise.all([first, second]);
  await writer.write('r');
  assert.equal(sent, 1);
  assert.equal(current.worktreePath, undefined);
  assert.ok(current.issueWriteBackAt);
});

test('a failed comment remains retryable and is not marked sent', async () => {
  let attempts = 0;
  let current = { runId: 'r', issueKey: 'P-1' } as WorkflowRun;
  const writer = new WorkflowIssueWriteBack({
    get: () => current,
    send: async () => { if (++attempts === 1) throw new Error('offline'); },
    mark: async (_id, at) => { current = { ...current, issueWriteBackAt: at }; }
  });
  await assert.rejects(writer.write('r'), /offline/);
  assert.equal(current.issueWriteBackAt, undefined);
  await writer.write('r');
  assert.equal(attempts, 2);
  assert.ok(current.issueWriteBackAt);
});
