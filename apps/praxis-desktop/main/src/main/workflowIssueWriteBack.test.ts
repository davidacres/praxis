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
    outcomeOf: () => 'failed',
    mark: async (_id, at, outcome) => { current = { ...current, issueWriteBackAt: at, issueWriteBackOutcome: outcome }; }
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
    outcomeOf: () => 'failed',
    mark: async (_id, at, outcome) => { current = { ...current, issueWriteBackAt: at, issueWriteBackOutcome: outcome }; }
  });
  await assert.rejects(writer.write('r'), /offline/);
  assert.equal(current.issueWriteBackAt, undefined);
  await writer.write('r');
  assert.equal(attempts, 2);
  assert.ok(current.issueWriteBackAt);
});

test('a retried run that fails the same way again is not recorded twice; a different outcome is', async () => {
  let current = { runId: 'r', issueKey: 'P-1' } as WorkflowRun;
  let outcome = 'failed at Plan: unknown model';
  const sent: string[] = [];
  const writer = new WorkflowIssueWriteBack({
    get: () => current,
    outcomeOf: () => outcome,
    send: async () => { sent.push(outcome); },
    mark: async (_id, at, written) => { current = { ...current, issueWriteBackAt: at, issueWriteBackOutcome: written }; }
  });
  const retry = () => { const { issueWriteBackAt: _at, ...rest } = current; current = rest as WorkflowRun; };

  await writer.write('r');
  retry();
  await writer.write('r');
  assert.deepEqual(sent, ['failed at Plan: unknown model']);
  assert.ok(current.issueWriteBackAt, 'the repeat is still marked as handled');

  retry();
  outcome = 'succeeded';
  await writer.write('r');
  assert.deepEqual(sent, ['failed at Plan: unknown model', 'succeeded']);
});
