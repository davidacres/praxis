import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorkflowRunCommand, createWorkflowRun, type WorkflowRun } from './workflowRun';
import { advanceJoins } from './workflowScheduler';
import { approveStage } from './workflowGates';
import { summarizeWorkflowRun } from './workflowRunSummary';
import { governedDeliveryTemplate } from './workflowTemplates';
import { instantiateTemplateForProject } from './workflowTemplates';
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition, type WorkflowPolicyProfile } from './workflowTypes';

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

test('a summary names its project, which the phone scopes run actions by', () => {
  // Without it every phone action on a run (approve, retry, …) failed "not found in project".
  const source = run();
  assert.equal(summarizeWorkflowRun(source).projectId, source.projectId);
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
  r = succeed(r, 'test-contracts', 4, 'sha-2');
  let summary = summarizeWorkflowRun(r);

  assert.equal(summary.branchGroups.length, 1);
  assert.equal(summary.branchGroups[0].joinNodeId, 'gates');
  assert.equal(summary.branchGroups[0].converged, false);
  assert.deepEqual(
    summary.branchGroups[0].branches.map(branch => branch.headName).sort(),
    ['QA', 'Review', 'Security scan']
  );

  // QA cannot start until the dependencies are installed; review and security do not wait for it.
  assert.equal(summary.stages.find(stage => stage.nodeId === 'qa')?.lane, 'idle');
  r = succeed(r, 'install', 5);
  r = succeed(r, 'build', 5);
  r = succeed(r, 'review', 6);
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

/** A single check → approval workflow whose approval node allows a bypass. */
function bypassableDefinition(): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'd-bypass', name: 'Bypassable', scope: 'global', version: 1, entryNodeId: 'qa',
    createdAt: T(0), updatedAt: T(0),
    nodes: [
      {
        type: 'check', id: 'qa', name: 'QA', x: 0, y: 0, inputs: [],
        command: 'npm', args: ['test'], successExitCodes: [0],
        outputs: [{ id: 'qa-results', kind: 'test-results', required: true }], satisfiesGate: 'qa'
      },
      {
        type: 'approval', id: 'approve', name: 'Approve', x: 0, y: 0, inputs: ['qa-results'],
        prompt: 'Ship?', requiredGates: ['qa'], allowBypass: true
      }
    ],
    edges: [{ id: 'e1', from: 'qa', to: 'approve', on: 'success', required: true }]
  };
}

function permissivePolicy(): WorkflowPolicyProfile {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'p', name: 'Policy', scope: 'global',
    requiredGates: [], requireHumanApproval: true, allowGateBypass: true, requireTrustedAgents: true,
    maxAttemptsPerNode: 3, createdAt: T(0), updatedAt: T(0)
  };
}

test('a failed gate that policy and the approval node allow to bypass is marked bypassable, with its approval node named', () => {
  let r = createWorkflowRun({ runId: 'run-bypass', projectId: 'p1', definition: bypassableDefinition(), at: T(0) });
  r = applyWorkflowRunCommand(r, { kind: 'node-started', nodeId: 'qa', at: T(1) });
  r = applyWorkflowRunCommand(r, { kind: 'node-failed', nodeId: 'qa', at: T(2), error: 'flaky' });

  const summary = summarizeWorkflowRun(r, permissivePolicy());
  const qaGate = summary.gates.find(gate => gate.gate === 'qa');
  assert.equal(qaGate?.state, 'failed');
  assert.equal(qaGate?.bypassable, true);
  assert.equal(qaGate?.approvalNodeId, 'approve');
});

test('a pending gate is never marked bypassable, even when policy and the node allow one', () => {
  const summary = summarizeWorkflowRun(
    createWorkflowRun({ runId: 'run-bypass-pending', projectId: 'p1', definition: bypassableDefinition(), at: T(0) }),
    permissivePolicy()
  );
  const qaGate = summary.gates.find(gate => gate.gate === 'qa');
  assert.equal(qaGate?.state, 'pending');
  assert.equal(qaGate?.bypassable, false);
});

test('without a permissive policy, a failed gate is not marked bypassable even though the node allows one', () => {
  let r = createWorkflowRun({ runId: 'run-bypass-no-policy', projectId: 'p1', definition: bypassableDefinition(), at: T(0) });
  r = applyWorkflowRunCommand(r, { kind: 'node-started', nodeId: 'qa', at: T(1) });
  r = applyWorkflowRunCommand(r, { kind: 'node-failed', nodeId: 'qa', at: T(2), error: 'flaky' });

  const summary = summarizeWorkflowRun(r);
  const qaGate = summary.gates.find(gate => gate.gate === 'qa');
  assert.equal(qaGate?.bypassable, false);
  // Distinguishes "the workflow itself would allow this" from "nothing
  // would" — without it the UI has no way to explain the missing button.
  assert.equal(qaGate?.bypassBlockedByPolicy, true);
});

test('a workflow whose approval node forbids bypass is never reported as policy-blocked', () => {
  const forbidding: WorkflowDefinition = {
    ...bypassableDefinition(),
    nodes: bypassableDefinition().nodes.map(node =>
      node.type === 'approval' ? { ...node, allowBypass: false } : node
    )
  };
  let r = createWorkflowRun({ runId: 'run-bypass-forbidden', projectId: 'p1', definition: forbidding, at: T(0) });
  r = applyWorkflowRunCommand(r, { kind: 'node-started', nodeId: 'qa', at: T(1) });
  r = applyWorkflowRunCommand(r, { kind: 'node-failed', nodeId: 'qa', at: T(2), error: 'flaky' });

  // Even with a permissive policy, the workflow itself never allowed this —
  // there is nothing for a policy to unblock, so it must not read as blocked.
  const summary = summarizeWorkflowRun(r, permissivePolicy());
  const qaGate = summary.gates.find(gate => gate.gate === 'qa');
  assert.equal(qaGate?.bypassable, false);
  assert.equal(qaGate?.bypassBlockedByPolicy, undefined);
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
  r = succeed(r, 'test-contracts', 4, 'sha-2');
  r = succeed(r, 'install', 5);
  r = succeed(r, 'build', 5);
  r = succeed(r, 'review', 6);
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

test('a run summary preserves aiProvider and aiModel', () => {
  const base = run();
  const configured = createWorkflowRun({
    runId: 'r-ai',
    projectId: 'p1',
    definition: base.definition,
    at: T(0),
    aiProvider: 'codex-cli',
    aiModel: 'gpt-5-turbo'
  });
  const summary = summarizeWorkflowRun(configured);
  assert.equal(summary.aiProvider, 'codex-cli');
  assert.equal(summary.aiModel, 'gpt-5-turbo');
});

test('a cancelled run reports why', () => {
  const cancelled = applyWorkflowRunCommand(run(), { kind: 'cancel', at: T(1), reason: 'superseded' });
  const summary = summarizeWorkflowRun(cancelled);
  assert.equal(summary.status, 'cancelled');
  assert.match(summary.explanation, /cancelled: superseded/);
});

test('a stage row carries its reported phase while running, and drops it once settled', () => {
  let r = applyWorkflowRunCommand(run(), { kind: 'node-started', nodeId: 'plan', at: T(1) });
  r = applyWorkflowRunCommand(r, { kind: 'node-progress', nodeId: 'plan', at: T(2), phase: 'verifying' });

  let summary = summarizeWorkflowRun(r);
  assert.equal(summary.stages.find(stage => stage.nodeId === 'plan')?.phase, 'verifying');

  r = succeed(r, 'plan', 3, 'sha-1');
  summary = summarizeWorkflowRun(r);
  assert.equal(summary.stages.find(stage => stage.nodeId === 'plan')?.phase, undefined);
});
