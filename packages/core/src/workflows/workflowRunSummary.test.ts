import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorkflowRunCommand, createWorkflowRun, type WorkflowRun } from './workflowRun';
import { advanceJoins } from './workflowScheduler';
import { approveStage } from './workflowGates';
import { summarizeWorkflowRun } from './workflowRunSummary';
import { governedDeliveryTemplate } from './workflowTemplates';
import { instantiateTemplateForProject } from './workflowTemplates';

const T = (m: number): string => new Date(Date.UTC(2026, 8, 2, 9, m)).toISOString();

function run(): WorkflowRun {
  const definition = instantiateTemplateForProject({
    template: governedDeliveryTemplate(),
    projectId: 'p1',
    at: T(0)
  });
  return createWorkflowRun({ runId: 'run-1', projectId: 'p1', definition, at: T(0) });
}

function succeed(r: WorkflowRun, nodeId: string, minute: number, snapshotRef?: string): WorkflowRun {
  const node = r.definition.nodes.find(candidate => candidate.id === nodeId);
  const outputs = node && 'outputs' in node ? node.outputs : [];
  let next = applyWorkflowRunCommand(r, { kind: 'node-started', nodeId, at: T(minute), sessionId: `s-${nodeId}` });
  next = applyWorkflowRunCommand(next, {
    kind: 'node-succeeded',
    nodeId,
    at: T(minute + 1),
    artifacts: outputs.map(contract => ({ contractId: contract.id, kind: contract.kind })),
    ...(snapshotRef ? { snapshotRef } : {})
  });
  return advanceJoins(next, T(minute + 1));
}

test('a fresh run explains that it is waiting to dispatch, with plan ready', () => {
  const summary = summarizeWorkflowRun(run());
  assert.equal(summary.status, 'running');
  assert.equal(summary.stages.find(stage => stage.nodeId === 'plan')?.lane, 'ready');
  assert.equal(summary.stages.find(stage => stage.nodeId === 'implement')?.lane, 'idle');
});

test('a running stage is named in the explanation', () => {
  const started = applyWorkflowRunCommand(run(), { kind: 'node-started', nodeId: 'plan', at: T(1) });
  const summary = summarizeWorkflowRun(started);
  assert.match(summary.explanation, /Stage in progress: Plan\./);
  assert.equal(summary.stages.find(stage => stage.nodeId === 'plan')?.lane, 'running');
});

test('review, QA, and security show as one branch group that converges at the join', () => {
  let r = succeed(run(), 'plan', 1, 'sha-1');
  r = succeed(r, 'implement', 3, 'sha-2');
  let summary = summarizeWorkflowRun(r);

  assert.equal(summary.branchGroups.length, 1);
  assert.equal(summary.branchGroups[0].joinNodeId, 'gates');
  assert.equal(summary.branchGroups[0].converged, false);
  assert.deepEqual(
    summary.branchGroups[0].branches.map(branch => branch.headName).sort(),
    ['QA', 'Review', 'Security scan']
  );

  r = succeed(r, 'review', 5);
  r = succeed(r, 'qa', 7);
  r = succeed(r, 'security', 9);
  summary = summarizeWorkflowRun(r);
  assert.equal(summary.branchGroups[0].converged, true);
  assert.equal(summary.status, 'awaiting-approval');
  assert.match(summary.explanation, /waiting for a human approval/);
});

test('gate rows track the owning stage outcome', () => {
  let r = succeed(run(), 'plan', 1, 'sha-1');
  r = succeed(r, 'implement', 3, 'sha-2');
  r = succeed(r, 'review', 5);
  const summary = summarizeWorkflowRun(r);
  assert.equal(summary.gates.find(gate => gate.gate === 'review')?.state, 'passed');
  assert.equal(summary.gates.find(gate => gate.gate === 'qa')?.state, 'pending');
});

test('a failed required stage explains the block and offers retry', () => {
  let r = succeed(run(), 'plan', 1, 'sha-1');
  r = applyWorkflowRunCommand(r, { kind: 'node-started', nodeId: 'implement', at: T(3) });
  r = applyWorkflowRunCommand(r, { kind: 'node-failed', nodeId: 'implement', at: T(4), error: 'compile error' });
  const summary = summarizeWorkflowRun(r);

  assert.match(summary.explanation, /Implement failed and can be retried/);
  assert.ok(summary.actions.some(action => action.kind === 'retry-stage'));
  assert.equal(summary.stages.find(stage => stage.nodeId === 'implement')?.lastError, 'compile error');
});

test('artifacts and the implementation snapshot ref surface on the stage row', () => {
  let r = succeed(run(), 'plan', 1, 'sha-plan');
  r = succeed(r, 'implement', 3, 'sha-impl');
  const summary = summarizeWorkflowRun(r);
  const implement = summary.stages.find(stage => stage.nodeId === 'implement');
  assert.equal(implement?.snapshotRef, 'sha-impl');
  assert.deepEqual(implement?.artifacts.map(artifact => artifact.contractId), ['change-diff']);
  assert.equal(implement?.sessionId, 's-implement');
});

test('a completed run explains itself and offers no further action', () => {
  let r = succeed(run(), 'plan', 1, 'sha-1');
  r = succeed(r, 'implement', 3, 'sha-2');
  r = succeed(r, 'review', 5);
  r = succeed(r, 'qa', 7);
  r = succeed(r, 'security', 9);
  const approved = approveStage(r, 'approve', { actor: 'dave', at: T(11) });
  assert.equal(approved.ok, true);

  const summary = summarizeWorkflowRun(approved.run);
  assert.equal(summary.status, 'succeeded');
  assert.match(summary.explanation, /completed: every required stage passed/);
  assert.deepEqual(summary.actions.map(action => action.kind), ['none']);
  assert.deepEqual(summary.outstanding, []);
});

test('a cancelled run reports why', () => {
  const cancelled = applyWorkflowRunCommand(run(), { kind: 'cancel', at: T(1), reason: 'superseded' });
  const summary = summarizeWorkflowRun(cancelled);
  assert.equal(summary.status, 'cancelled');
  assert.match(summary.explanation, /cancelled: superseded/);
});
