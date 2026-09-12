import test from 'node:test';
import assert from 'node:assert/strict';
import {
  computeFindingFingerprint,
  WORKFLOW_SCHEMA_VERSION,
  type WorkflowDefinition
} from './workflowTypes';
import { validateWorkflow } from './workflowValidation';

test('TASK-237: computeFindingFingerprint is deterministic and normalizes file paths', () => {
  const f1 = {
    ruleId: 'no-eval',
    file: 'src/utils/eval.ts',
    line: 42,
    message: 'eval is dangerous'
  };
  const f2 = {
    ruleId: 'no-eval',
    file: 'src\\utils\\eval.ts ',
    line: 42,
    message: 'eval is dangerous'
  };

  const fp1 = computeFindingFingerprint(f1);
  const fp2 = computeFindingFingerprint(f2);
  assert.equal(fp1, fp2, 'Fingerprint must be identical when path backslashes/whitespace are normalized');

  // Sensitivity tests:
  const fpDiffRule = computeFindingFingerprint({ ...f1, ruleId: 'no-implied-eval' });
  const fpDiffFile = computeFindingFingerprint({ ...f1, file: 'src/utils/other.ts' });
  const fpDiffLine = computeFindingFingerprint({ ...f1, line: 43 });
  const fpDiffMessage = computeFindingFingerprint({ ...f1, message: 'eval is very dangerous' });

  assert.notEqual(fp1, fpDiffRule, 'Rule change alters fingerprint');
  assert.notEqual(fp1, fpDiffFile, 'File change alters fingerprint');
  assert.notEqual(fp1, fpDiffLine, 'Line change alters fingerprint');
  assert.notEqual(fp1, fpDiffMessage, 'Message change alters fingerprint');
});

test('TASK-237: validateWorkflow accepts findings artifact kind on check and agent nodes', () => {
  const definition: WorkflowDefinition = {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'findings-workflow',
    name: 'Findings Workflow',
    scope: 'global',
    version: 1,
    entryNodeId: 'scan',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    nodes: [
      {
        type: 'check',
        id: 'scan',
        name: 'Security scan',
        x: 0,
        y: 0,
        inputs: [],
        command: 'semgrep',
        outputs: [{ id: 'security-findings', kind: 'findings', required: true }],
        satisfiesGate: 'security'
      },
      {
        type: 'agent-task',
        id: 'review',
        name: 'Code review',
        x: 200,
        y: 0,
        inputs: ['security-findings'],
        agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only' },
        instructions: 'Review findings and code diff',
        outputs: [{ id: 'review-findings', kind: 'findings', required: false }],
        mutatesWorktree: false,
        satisfiesGate: 'review'
      },
      {
        type: 'approval',
        id: 'approve',
        name: 'Approve',
        x: 400,
        y: 0,
        inputs: ['review-findings'],
        prompt: 'Approve findings',
        requiredGates: ['security', 'review'],
        allowBypass: false
      }
    ],
    edges: [
      { id: 'e1', from: 'scan', to: 'review', on: 'success', required: true },
      { id: 'e2', from: 'review', to: 'approve', on: 'success', required: true }
    ]
  };

  const result = validateWorkflow(definition);
  assert.equal(result.valid, true, `Workflow should be valid: ${JSON.stringify(result.errors)}`);
});
