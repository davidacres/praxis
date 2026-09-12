import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type WorkflowAgentTaskNode,
  type WorkflowApprovalNode
} from './workflowTypes';
import { createWorkflowRun, applyWorkflowRunCommand, canRetry } from './workflowRun';
import { evaluateGates } from './workflowGates';
import { scheduleWorkflowRun } from './workflowScheduler';

function createReviewLoopWorkflow(): WorkflowDefinition {
  const implementNode: WorkflowAgentTaskNode = {
    id: 'implement',
    name: 'Implement Stage',
    type: 'agent-task',
    agent: { agentId: 'test-agent', scope: 'global', toolMode: 'full' },
    instructions: 'Implement changes',
    mutatesWorktree: true,
    outputs: [{ id: 'impl-snapshot', kind: 'diff', required: true }],
    x: 0,
    y: 0,
    inputs: [],
    maxAttempts: 3
  };

  const reviewNode: WorkflowAgentTaskNode = {
    id: 'review',
    name: 'Code Review',
    type: 'agent-task',
    agent: { agentId: 'test-reviewer', scope: 'global', toolMode: 'read-only' },
    instructions: 'Review code changes and return structured findings',
    mutatesWorktree: false,
    satisfiesGate: 'review',
    outputs: [{ id: 'review-findings', kind: 'findings', required: true }],
    x: 100,
    y: 0,
    inputs: ['impl-snapshot'],
    maxAttempts: 3
  };

  const approvalNode: WorkflowApprovalNode = {
    id: 'approval',
    name: 'Approval',
    type: 'approval',
    prompt: 'Approve pull request',
    requiredGates: ['review'],
    allowBypass: false,
    gateThresholds: {
      review: [{ type: 'severity', severityLevel: 'high', maxCount: 0 }]
    },
    x: 200,
    y: 0,
    inputs: ['review-findings']
  };

  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'review-loop-wf',
    name: 'Review Fix Loop Workflow',
    scope: 'project',
    version: 1,
    entryNodeId: 'implement',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [implementNode, reviewNode, approvalNode],
    edges: [
      { id: 'e1', from: 'implement', to: 'review', on: 'success', required: true },
      { id: 'e2', from: 'review', to: 'approval', on: 'success', required: true },
      { id: 'e3', from: 'review', to: 'implement', on: 'failure', required: false }
    ]
  };
}

test('TASK-244: review stage returning only prose without findings fails required artifact check', () => {
  const wf = createReviewLoopWorkflow();
  let run = createWorkflowRun({ runId: 'run-1', projectId: 'proj-1', definition: wf, at: '2026-09-09T10:00:00Z' });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'implement',
    artifacts: [{ contractId: 'impl-snapshot', kind: 'diff' }],
    snapshotRef: 'sha-commit-1',
    at: '2026-09-09T10:01:00Z'
  });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'review', at: '2026-09-09T10:02:00Z' });
  // Reviewer attempts to succeed without producing findings artifact
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'review',
    artifacts: [],
    at: '2026-09-09T10:03:00Z'
  });

  assert.strictEqual(run.nodes['review']?.outcome, 'failed');
  const lastAttempt = run.nodes['review']?.attempts[run.nodes['review']!.attempts.length - 1];
  assert.ok(lastAttempt?.error?.includes('required artifacts'));
});

test('TASK-246: review fix loop routes back on blocking finding and succeeds on clean re-review', () => {
  const wf = createReviewLoopWorkflow();
  let run = createWorkflowRun({ runId: 'run-1', projectId: 'proj-1', definition: wf, at: '2026-09-09T10:00:00Z' });

  // 1. Initial implementation
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'implement',
    artifacts: [{ contractId: 'impl-snapshot', kind: 'diff' }],
    snapshotRef: 'sha-commit-1',
    at: '2026-09-09T10:01:00Z'
  });

  // 2. First review produces blocking high finding and fails
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'review', at: '2026-09-09T10:02:00Z' });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-failed',
    nodeId: 'review',
    error: 'Found 1 blocking high severity issue',
    findings: {
      findings: [
        {
          fingerprint: 'fp-auth-bypass',
          ruleId: 'sec-auth',
          severity: 'high',
          category: 'security',
          message: 'Auth middleware bypassed for /admin endpoint'
        }
      ],
      metrics: { issuesFound: 1 }
    },
    at: '2026-09-09T10:03:00Z'
  });

  // Review gate fails because review stage failed
  const gates = evaluateGates(run, 'approval');
  assert.strictEqual(gates[0].state, 'failed');

  // 3. Review is retryable within attempt budget
  assert.strictEqual(canRetry(run, 'review'), true);

  // 4. Re-review passes clean
  run = applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId: 'review', at: '2026-09-09T10:07:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'review', at: '2026-09-09T10:08:00Z' });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'review',
    artifacts: [{ contractId: 'review-findings', kind: 'findings' }],
    findings: { findings: [], metrics: { issuesFound: 0 } },
    at: '2026-09-09T10:09:00Z'
  });

  const finalGates = evaluateGates(run, 'approval');
  assert.strictEqual(finalGates[0].state, 'passed');
  assert.ok(finalGates[0].detail.includes('Code Review succeeded'));
});
