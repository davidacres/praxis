import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WORKFLOW_SCHEMA_VERSION,
  type CheckFindings,
  type WorkflowDefinition,
  type WorkflowPolicyProfile
} from './workflowTypes';
import { createWorkflowRun, applyWorkflowRunCommand } from './workflowRun';
import { evaluateGates } from './workflowGates';
import { composeWorkflowPolicies } from './workflowStore';
import { validateWorkflow } from './workflowValidation';

function makeThresholdWorkflow(outputsFindings: boolean = true): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'threshold-workflow',
    name: 'Threshold Workflow',
    scope: 'global',
    version: 1,
    entryNodeId: 'qa',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [
      {
        type: 'check',
        id: 'qa',
        name: 'QA Tests',
        x: 0,
        y: 0,
        inputs: [],
        command: 'npm test',
        outputs: outputsFindings
          ? [{ id: 'qa-findings', kind: 'findings', required: true }]
          : [{ id: 'qa-results', kind: 'test-results', required: true }],
        satisfiesGate: 'qa'
      },
      {
        type: 'approval',
        id: 'approve',
        name: 'Approve',
        x: 200,
        y: 0,
        inputs: outputsFindings ? ['qa-findings'] : ['qa-results'],
        prompt: 'Approve run',
        requiredGates: ['qa'],
        allowBypass: false
      }
    ],
    edges: [
      { id: 'e1', from: 'qa', to: 'approve', on: 'success', required: true }
    ]
  };
}

test('TASK-239: evaluateGates metric threshold condition passes at 82, fails at 78, and is pending until settled', () => {
  const def = makeThresholdWorkflow(true);
  const policy: WorkflowPolicyProfile = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'qa-coverage-policy',
    name: 'Coverage Policy',
    scope: 'global',
    requiredGates: ['qa'],
    requireHumanApproval: true,
    allowGateBypass: false,
    requireTrustedAgents: true,
    maxAttemptsPerNode: 1,
    gateThresholds: {
      qa: [
        { type: 'metric', metric: 'newCodeCoveragePct', operator: '>=', value: 80 }
      ]
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const run = createWorkflowRun({
    runId: 'run-1',
    projectId: 'test-project',
    definition: def,
    at: new Date().toISOString()
  });

  // While QA is pending/running
  const pendingGates = evaluateGates(run, 'approve', policy);
  assert.equal(pendingGates.length, 1);
  assert.equal(pendingGates[0].state, 'pending');
  assert.ok(pendingGates[0].detail.includes('has not finished'));

  // When QA settles with 78% coverage
  const runWithStarted = applyWorkflowRunCommand(run, {
    kind: 'node-started',
    nodeId: 'qa',
    at: new Date().toISOString()
  });

  const findings78: CheckFindings = {
    findings: [],
    metrics: { newCodeCoveragePct: 78 }
  };
  const runFailed = applyWorkflowRunCommand(runWithStarted, {
    kind: 'node-succeeded',
    nodeId: 'qa',
    at: new Date().toISOString(),
    artifacts: [{ contractId: 'qa-findings', kind: 'findings' }],
    exitCode: 0,
    findings: findings78
  });
  const failedGates = evaluateGates(runFailed, 'approve', policy);
  assert.equal(failedGates.length, 1);
  assert.equal(failedGates[0].state, 'failed');
  assert.ok(failedGates[0].detail.includes('Metric "newCodeCoveragePct" was 78, required >= 80.'));

  // When QA settles with 82% coverage
  const findings82: CheckFindings = {
    findings: [],
    metrics: { newCodeCoveragePct: 82 }
  };
  const runPassed = applyWorkflowRunCommand(runWithStarted, {
    kind: 'node-succeeded',
    nodeId: 'qa',
    at: new Date().toISOString(),
    artifacts: [{ contractId: 'qa-findings', kind: 'findings' }],
    exitCode: 0,
    findings: findings82
  });
  const passedGates = evaluateGates(runPassed, 'approve', policy);
  assert.equal(passedGates.length, 1);
  assert.equal(passedGates[0].state, 'passed');
});

test('TASK-239: evaluateGates severity threshold condition fails with one high finding and passes with none', () => {
  const def = makeThresholdWorkflow(true);
  const policy: WorkflowPolicyProfile = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'security-severity-policy',
    name: 'Security Policy',
    scope: 'global',
    requiredGates: ['qa'],
    requireHumanApproval: true,
    allowGateBypass: false,
    requireTrustedAgents: true,
    maxAttemptsPerNode: 1,
    gateThresholds: {
      qa: [
        { type: 'severity', severityLevel: 'high', maxCount: 0 }
      ]
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  const run = createWorkflowRun({
    runId: 'run-2',
    projectId: 'test-project',
    definition: def,
    at: new Date().toISOString()
  });

  const runStarted = applyWorkflowRunCommand(run, {
    kind: 'node-started',
    nodeId: 'qa',
    at: new Date().toISOString()
  });

  // 1 high finding present
  const runWithHighFinding = applyWorkflowRunCommand(runStarted, {
    kind: 'node-succeeded',
    nodeId: 'qa',
    at: new Date().toISOString(),
    artifacts: [{ contractId: 'qa-findings', kind: 'findings' }],
    exitCode: 0,
    findings: {
      findings: [
        {
          fingerprint: 'fp-1',
          severity: 'high',
          category: 'security',
          message: 'Vulnerability found'
        }
      ],
      metrics: {}
    }
  });
  const gatesWithHigh = evaluateGates(runWithHighFinding, 'approve', policy);
  assert.equal(gatesWithHigh[0].state, 'failed');
  assert.ok(gatesWithHigh[0].detail.includes('Found 1 finding(s) with severity >= high (max allowed: 0).'));

  // 0 high findings (only low/info)
  const runClean = applyWorkflowRunCommand(runStarted, {
    kind: 'node-succeeded',
    nodeId: 'qa',
    at: new Date().toISOString(),
    artifacts: [{ contractId: 'qa-findings', kind: 'findings' }],
    exitCode: 0,
    findings: {
      findings: [
        {
          fingerprint: 'fp-2',
          severity: 'low',
          category: 'lint',
          message: 'Minor note'
        }
      ],
      metrics: {}
    }
  });
  const gatesClean = evaluateGates(runClean, 'approve', policy);
  assert.equal(gatesClean[0].state, 'passed');
});

test('TASK-239: composeWorkflowPolicies refuses loosening and composes tightening', () => {
  const globalPolicy: WorkflowPolicyProfile = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'org-policy',
    name: 'Org Policy',
    scope: 'global',
    requiredGates: ['qa'],
    requireHumanApproval: true,
    allowGateBypass: false,
    requireTrustedAgents: true,
    maxAttemptsPerNode: 2,
    gateThresholds: {
      qa: [
        { type: 'metric', metric: 'newCodeCoveragePct', operator: '>=', value: 80 },
        { type: 'severity', severityLevel: 'high', maxCount: 0 }
      ]
    },
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };

  // Tightening: project raises coverage minimum to 85
  const projectTightened: WorkflowPolicyProfile = {
    ...globalPolicy,
    id: 'proj-policy',
    scope: 'project',
    projectId: 'p1',
    gateThresholds: {
      qa: [
        { type: 'metric', metric: 'newCodeCoveragePct', operator: '>=', value: 85 }
      ]
    }
  };
  const effective = composeWorkflowPolicies(globalPolicy, projectTightened);
  const effectiveMetric = effective.profile.gateThresholds?.qa?.find(c => c.type === 'metric') as any;
  assert.equal(effectiveMetric?.value, 85, 'Should accept tightened threshold');

  // Loosening: project lowers coverage minimum to 70 -> refused
  const projectLoosenedMetric: WorkflowPolicyProfile = {
    ...globalPolicy,
    id: 'proj-policy-2',
    scope: 'project',
    projectId: 'p1',
    gateThresholds: {
      qa: [
        { type: 'metric', metric: 'newCodeCoveragePct', operator: '>=', value: 70 }
      ]
    }
  };
  assert.throws(
    () => composeWorkflowPolicies(globalPolicy, projectLoosenedMetric),
    /Cannot loosen org metric threshold/
  );

  // Loosening: project allows 1 high finding -> refused
  const projectLoosenedSeverity: WorkflowPolicyProfile = {
    ...globalPolicy,
    id: 'proj-policy-3',
    scope: 'project',
    projectId: 'p1',
    gateThresholds: {
      qa: [
        { type: 'severity', severityLevel: 'high', maxCount: 1 }
      ]
    }
  };
  assert.throws(
    () => composeWorkflowPolicies(globalPolicy, projectLoosenedSeverity),
    /Cannot loosen org severity threshold/
  );
});

test('TASK-239: validateWorkflow requires owning node to produce findings if threshold gate is present', () => {
  const withoutFindings = makeThresholdWorkflow(false);
  (withoutFindings.nodes[1] as any).gateThresholds = {
    qa: [{ type: 'metric', metric: 'newCodeCoveragePct', operator: '>=', value: 80 }]
  };

  const validation = validateWorkflow(withoutFindings);
  assert.equal(validation.valid, false);
  assert.ok(validation.errors.some(e => e.message.includes('does not produce findings')));
});
