import test from 'node:test';
import assert from 'node:assert/strict';
import { evaluateGates } from './workflowGates';
import {
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition,
  type WorkflowApprovalNode,
  type WorkflowCheckNode
} from './workflowTypes';
import { createWorkflowRun, applyWorkflowRunCommand } from './workflowRun';

function createMultiScannerWorkflow(): WorkflowDefinition {
  const secretCheck: WorkflowCheckNode = {
    id: 'secret-check',
    name: 'Secret Scan',
    type: 'check',
    command: 'gitleaks',
    satisfiesGate: 'security',
    outputs: [{ id: 'sec-out', kind: 'findings', required: true }],
    x: 0,
    y: 0,
    inputs: []
  };

  const sastCheck: WorkflowCheckNode = {
    id: 'sast-check',
    name: 'SAST Scan',
    type: 'check',
    command: 'semgrep',
    satisfiesGate: 'security',
    outputs: [{ id: 'sast-out', kind: 'findings', required: true }],
    x: 0,
    y: 0,
    inputs: []
  };

  const scaCheck: WorkflowCheckNode = {
    id: 'sca-check',
    name: 'SCA Scan',
    type: 'check',
    command: 'osv-scanner',
    satisfiesGate: 'security',
    outputs: [{ id: 'sca-out', kind: 'findings', required: true }],
    x: 0,
    y: 0,
    inputs: []
  };

  const approval: WorkflowApprovalNode = {
    id: 'gate-approval',
    name: 'Approval',
    type: 'approval',
    prompt: 'Approve production release',
    requiredGates: ['security'],
    allowBypass: false,
    gateThresholds: {
      security: [{ type: 'severity', severityLevel: 'high', maxCount: 0 }]
    },
    x: 100,
    y: 0,
    inputs: ['sec-out', 'sast-out', 'sca-out']
  };

  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'multi-sec-wf',
    name: 'Multi-Scanner Security Gate Workflow',
    scope: 'project',
    version: 1,
    entryNodeId: 'secret-check',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [secretCheck, sastCheck, scaCheck, approval],
    edges: [
      { id: 'e1', from: 'secret-check', to: 'gate-approval', on: 'success', required: true },
      { id: 'e2', from: 'sast-check', to: 'gate-approval', on: 'success', required: true },
      { id: 'e3', from: 'sca-check', to: 'gate-approval', on: 'success', required: true }
    ]
  };
}

test('evaluateGates multi-owner gate: passes when all enabled scanners succeed and findings meet threshold', () => {
  const wf = createMultiScannerWorkflow();
  let run = createWorkflowRun({ runId: 'run-1', projectId: 'proj-1', definition: wf, at: new Date().toISOString() });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'secret-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'secret-check', artifacts: [{ contractId: 'sec-out', kind: 'findings' }], findings: { findings: [], metrics: {} }, at: '2026-09-09T10:01:00Z' });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'sast-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'sast-check', artifacts: [{ contractId: 'sast-out', kind: 'findings' }], findings: { findings: [], metrics: {} }, at: '2026-09-09T10:01:00Z' });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'sca-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'sca-check', artifacts: [{ contractId: 'sca-out', kind: 'findings' }], findings: { findings: [], metrics: {} }, at: '2026-09-09T10:01:00Z' });

  const gates = evaluateGates(run, 'gate-approval');
  assert.strictEqual(gates.length, 1);
  assert.strictEqual(gates[0].gate, 'security');
  assert.strictEqual(gates[0].state, 'passed');
  assert.ok(gates[0].detail.includes('Scanners passed'));
});

test('evaluateGates multi-owner gate: fails naming specific scanner when one scanner fails', () => {
  const wf = createMultiScannerWorkflow();
  let run = createWorkflowRun({ runId: 'run-1', projectId: 'proj-1', definition: wf, at: new Date().toISOString() });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'secret-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'secret-check', artifacts: [{ contractId: 'sec-out', kind: 'findings' }], findings: { findings: [], metrics: {} }, at: '2026-09-09T10:01:00Z' });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'sast-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'sast-check', error: 'Process exited 1', at: '2026-09-09T10:01:00Z' });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'sca-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'sca-check', artifacts: [{ contractId: 'sca-out', kind: 'findings' }], findings: { findings: [], metrics: {} }, at: '2026-09-09T10:01:00Z' });

  const gates = evaluateGates(run, 'gate-approval');
  assert.strictEqual(gates[0].state, 'failed');
  assert.ok(gates[0].detail.includes('SAST Scan failed'), `detail was: ${gates[0].detail}`);
});

test('evaluateGates multi-owner gate: fails when combined findings exceed threshold', () => {
  const wf = createMultiScannerWorkflow();
  let run = createWorkflowRun({ runId: 'run-1', projectId: 'proj-1', definition: wf, at: new Date().toISOString() });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'secret-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'secret-check', artifacts: [{ contractId: 'sec-out', kind: 'findings' }], findings: { findings: [], metrics: {} }, at: '2026-09-09T10:01:00Z' });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'sast-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'sast-check',
    artifacts: [{ contractId: 'sast-out', kind: 'findings' }],
    findings: {
      findings: [
        {
          fingerprint: 'fp-sqli',
          ruleId: 'semgrep-sqli',
          severity: 'high',
          category: 'security',
          message: 'SQL injection detected'
        }
      ],
      metrics: {}
    },
    at: '2026-09-09T10:01:00Z'
  });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'sca-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'sca-check', artifacts: [{ contractId: 'sca-out', kind: 'findings' }], findings: { findings: [], metrics: {} }, at: '2026-09-09T10:01:00Z' });

  const gates = evaluateGates(run, 'gate-approval');
  assert.strictEqual(gates[0].state, 'failed');
  assert.ok(gates[0].detail.includes('severity >= high'), `detail was: ${gates[0].detail}`);
});

test('evaluateGates multi-owner gate: waiver clears finding and gate passes', () => {
  const wf = createMultiScannerWorkflow();
  const approval = wf.nodes.find(n => n.id === 'gate-approval') as WorkflowApprovalNode;

  // Add waiver for the high finding
  approval.waivers = [
    {
      fingerprint: 'fp-sqli',
      reason: 'Verified sanitized in query helper',
      actor: 'security-reviewer',
      createdAt: new Date(Date.now() - 3600_000).toISOString(),
      expiresAt: new Date(Date.now() + 86400_000).toISOString()
    }
  ];

  let run = createWorkflowRun({ runId: 'run-1', projectId: 'proj-1', definition: wf, at: new Date().toISOString() });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'secret-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'secret-check', artifacts: [{ contractId: 'sec-out', kind: 'findings' }], findings: { findings: [], metrics: {} }, at: '2026-09-09T10:01:00Z' });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'sast-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'sast-check',
    artifacts: [{ contractId: 'sast-out', kind: 'findings' }],
    findings: {
      findings: [
        {
          fingerprint: 'fp-sqli',
          ruleId: 'semgrep-sqli',
          severity: 'high',
          category: 'security',
          message: 'SQL injection detected'
        }
      ],
      metrics: {}
    },
    at: '2026-09-09T10:01:00Z'
  });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'sca-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'sca-check', artifacts: [{ contractId: 'sca-out', kind: 'findings' }], findings: { findings: [], metrics: {} }, at: '2026-09-09T10:01:00Z' });

  const gates = evaluateGates(run, 'gate-approval');
  assert.strictEqual(gates[0].state, 'passed');
  assert.ok(gates[0].detail.includes('1 waived'), `detail was: ${gates[0].detail}`);
});

test('evaluateGates multi-owner gate: reports disabled scanner in detail', () => {
  const wf = createMultiScannerWorkflow();
  const scaNode = wf.nodes.find(n => n.id === 'sca-check') as WorkflowCheckNode;
  scaNode.enabled = false;

  let run = createWorkflowRun({ runId: 'run-1', projectId: 'proj-1', definition: wf, at: new Date().toISOString() });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'secret-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'secret-check', artifacts: [{ contractId: 'sec-out', kind: 'findings' }], findings: { findings: [], metrics: {} }, at: '2026-09-09T10:01:00Z' });

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'sast-check', at: '2026-09-09T10:00:00Z' });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'sast-check', artifacts: [{ contractId: 'sast-out', kind: 'findings' }], findings: { findings: [], metrics: {} }, at: '2026-09-09T10:01:00Z' });

  const gates = evaluateGates(run, 'gate-approval');
  assert.strictEqual(gates[0].state, 'passed');
  assert.ok(gates[0].detail.includes('SCA Scan disabled'), `detail was: ${gates[0].detail}`);
});

