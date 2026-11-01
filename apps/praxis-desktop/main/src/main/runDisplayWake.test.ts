import test from 'node:test';
import assert from 'node:assert/strict';
import type { WorkflowRun } from '@praxis/core';
import { RunDisplayWake } from './runDisplayWake';

function run(runId: string, status: WorkflowRun['status'], outcome: string): WorkflowRun {
  return { runId, status, nodes: { qa: { nodeId: 'qa', outcome, attempts: [], artifacts: [] } } } as unknown as WorkflowRun;
}

function wake() {
  const calls: string[] = [];
  let next = 1;
  const keeper = new RunDisplayWake({
    start: () => { calls.push('start'); return next++; },
    stop: id => { calls.push(`stop ${id}`); }
  });
  return { keeper, calls };
}

test('the display is kept awake from the first running stage until the last run stops moving', () => {
  const { keeper, calls } = wake();
  keeper.update(run('a', 'running', 'running'));
  keeper.update(run('b', 'running', 'running'));
  keeper.update(run('a', 'running', 'running'));
  assert.deepEqual(calls, ['start'], 'one blocker however many runs and updates');
  keeper.update(run('a', 'succeeded', 'succeeded'));
  assert.ok(keeper.holding, 'still held while run b is running');
  keeper.update(run('b', 'failed', 'failed'));
  assert.deepEqual(calls, ['start', 'stop 1']);
  assert.equal(keeper.holding, false);
});

test('a run waiting for a person lets the display sleep', () => {
  const { keeper, calls } = wake();
  keeper.update(run('a', 'running', 'running'));
  keeper.update(run('a', 'running', 'waiting-approval'));
  assert.deepEqual(calls, ['start', 'stop 1']);
  keeper.update(run('a', 'running', 'running'));
  assert.deepEqual(calls, ['start', 'stop 1', 'start']);
});
