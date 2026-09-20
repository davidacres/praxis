import test from 'node:test';
import assert from 'node:assert/strict';
import {
  sdlcLoopTemplate,
  sdlcLoopMarketplaceTemplates
} from './sdlcLoopTemplates';
import { validateWorkflow } from './workflowValidation';
import {
  createWorkflowRun,
  applyWorkflowRunCommand,
  canRetry
} from './workflowRun';
import { evaluateGates } from './workflowGates';
import type { WorkflowDefinition, WorkflowAgentTaskNode, WorkflowApprovalNode, CheckFinding } from './workflowTypes';

function loopWorkflow(): WorkflowDefinition {
  return sdlcLoopTemplate('node');
}

function runToApproval(wf: WorkflowDefinition) {
  let run = createWorkflowRun({ runId: 'run-1', projectId: 'proj-1', definition: wf, at: '2026-09-10T10:00:00Z' });
  const at = (n: number) => new Date(Date.UTC(2026, 8, 10, 10, n)).toISOString();
  // Plan
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'plan', at: at(0) });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'plan', artifacts: [{ contractId: 'plan-doc', kind: 'plan' }], at: at(1) });
  // BDD authoring
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'bdd-author', at: at(2) });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'bdd-author', artifacts: [{ contractId: 'bdd-scenarios', kind: 'report' }], snapshotRef: 'sha-bdd', at: at(3) });
  // Implement
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: at(4) });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'implement', artifacts: [{ contractId: 'change-diff', kind: 'diff' }], snapshotRef: 'sha-1', at: at(5) });
  return run;
}

function findingsWith(severity: CheckFinding['severity']): { findings: CheckFinding[]; metrics: Record<string, number> } {
  return {
    findings: [
      {
        fingerprint: `fp-${severity}-1`,
        ruleId: 'test-rule',
        file: 'src/x.ts',
        line: 1,
        severity,
        category: 'review',
        message: `A ${severity} finding.`
      }
    ],
    metrics: { findingsCount: 1, [`${severity}Count`]: 1 }
  };
}

test('TASK-253: every sdlcLoop variant passes workflow validation', () => {
  for (const wf of sdlcLoopMarketplaceTemplates()) {
    const result = validateWorkflow(wf);
    assert.strictEqual(result.valid, true, `${wf.id} validation errors: ${JSON.stringify(result.errors)}`);
    assert.deepEqual(result.errors, []);
  }
});

test('TASK-253: node DAG carries every requested SDLC responsibility', () => {
  const wf = loopWorkflow();
  const ids = wf.nodes.map(n => n.id);
  for (const expected of ['plan', 'bdd-author', 'implement', 'lint', 'typecheck', 'unit-test', 'bdd-run', 'sast', 'secrets', 'sca', 'review', 'test-review', 'security-review', 'ux-review', 'gates', 'approve', 'deploy']) {
    assert.ok(ids.includes(expected), `missing node: ${expected}`);
  }
  // BDD scenarios flow into both implement and the BDD run and the test review.
  const bddNode = wf.nodes.find(n => n.id === 'bdd-run');
  assert.ok(bddNode && bddNode.type === 'check' && bddNode.inputs.includes('bdd-scenarios'));
  const impl = wf.nodes.find(n => n.id === 'implement');
  assert.ok(impl && impl.type === 'agent-task' && impl.inputs.includes('bdd-scenarios'));
  const testReview = wf.nodes.find(n => n.id === 'test-review');
  assert.ok(testReview && testReview.type === 'agent-task' && testReview.inputs.includes('bdd-scenarios'));
});

test('TASK-253: reviewer stages own the gates; UX review is advisory', () => {
  const wf = loopWorkflow();
  const byId = new Map(wf.nodes.map(n => [n.id, n]));
  const gateOf = (id: string) => {
    const node = byId.get(id);
    return node && (node.type === 'agent-task' || node.type === 'check') ? node.satisfiesGate : undefined;
  };
  assert.equal(gateOf('review'), 'review');
  assert.equal(gateOf('test-review'), 'review');
  assert.equal(gateOf('security-review'), 'security');
  for (const checkId of ['sast', 'secrets', 'sca']) {
    const node = byId.get(checkId);
    assert.ok(node && node.type === 'check' && node.satisfiesGate === 'security', `${checkId} should satisfy security`);
  }
  for (const checkId of ['lint', 'typecheck', 'unit-test', 'bdd-run']) {
    const node = byId.get(checkId);
    assert.ok(node && node.type === 'check' && node.satisfiesGate === 'qa', `${checkId} should satisfy qa`);
  }
  const ux = byId.get('ux-review');
  assert.ok(ux && ux.type === 'agent-task' && ux.satisfiesGate === undefined, 'ux-review must not own a gate');
});

test('TASK-253: review stages require findings artifacts, not prose', () => {
  const wf = loopWorkflow();
  let run = runToApproval(wf);
  const at = (n: number) => new Date(Date.UTC(2026, 8, 10, 10, n)).toISOString();
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'review', at: at(6) });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'review', artifacts: [], at: at(7) });
  assert.equal(run.nodes['review']?.outcome, 'failed');
  const last = run.nodes['review']?.attempts[run.nodes['review']!.attempts.length - 1];
  assert.ok(last?.error?.includes('required artifacts'));
});

test('TASK-253: failing stages are retryable within their attempt budget', () => {
  const wf = loopWorkflow();
  let run = runToApproval(wf);
  const at = (n: number) => new Date(Date.UTC(2026, 8, 10, 10, n)).toISOString();
  const implement = wf.nodes.find(n => n.id === 'implement') as WorkflowAgentTaskNode;
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'review', at: at(6) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'review', error: 'blocking high finding', at: at(7) });
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'sast', at: at(6) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'sast', error: 'scanner reported blocking findings', at: at(7) });
  assert.equal(run.nodes['review']?.outcome, 'failed');
  assert.equal(canRetry(run, 'review'), true, 'review has 3 attempts, first failure retries');
  assert.equal(canRetry(run, 'sast'), true, 'sast has 2 attempts, first failure retries');
  assert.equal(canRetry(run, 'implement'), false, 'implement succeeded, so it is not retryable');
  assert.equal(implement.maxAttempts, 3);
});

test('TASK-253: a high review finding holds approval; a clean run approves', () => {
  const wf = loopWorkflow();
  let run = runToApproval(wf);
  const at = (n: number) => new Date(Date.UTC(2026, 8, 10, 10, n)).toISOString();
  // The exact artifact contract ids the template declares.
  const contractId: Record<string, string> = {
    lint: 'lint-findings',
    typecheck: 'typecheck-findings',
    'unit-test': 'test-findings',
    'bdd-run': 'bdd-findings',
    sast: 'sast-findings',
    secrets: 'secret-findings',
    sca: 'sca-findings',
    review: 'review-findings',
    'test-review': 'test-review-findings',
    'security-review': 'security-review-findings',
    'ux-review': 'ux-review-findings'
  };
  const succeedBand = (r: typeof run, reviewFindings: { findings: CheckFinding[]; metrics: Record<string, number> } | undefined) => {
    let out = r;
    for (const id of ['lint', 'typecheck', 'unit-test', 'bdd-run', 'sast', 'secrets', 'sca']) {
      out = applyWorkflowRunCommand(out, { kind: 'node-started', nodeId: id, at: at(6) });
      out = applyWorkflowRunCommand(out, { kind: 'node-succeeded', nodeId: id, artifacts: [{ contractId: contractId[id], kind: 'findings' }], findings: { findings: [], metrics: id === 'unit-test' ? { lineCoveragePct: 91 } : {} }, snapshotRef: 'sha-1', at: at(7) });
    }
    for (const id of ['review', 'test-review', 'security-review']) {
      out = applyWorkflowRunCommand(out, { kind: 'node-started', nodeId: id, at: at(8) });
      out = applyWorkflowRunCommand(out, { kind: 'node-succeeded', nodeId: id, artifacts: [{ contractId: contractId[id], kind: 'findings' }], findings: reviewFindings, snapshotRef: 'sha-1', at: at(9) });
    }
    out = applyWorkflowRunCommand(out, { kind: 'node-started', nodeId: 'ux-review', at: at(10) });
    out = applyWorkflowRunCommand(out, { kind: 'node-succeeded', nodeId: 'ux-review', artifacts: [{ contractId: contractId['ux-review'], kind: 'findings' }], findings: reviewFindings, snapshotRef: 'sha-1', at: at(11) });
    return out;
  };

  const blocked = succeedBand(run, findingsWith('high'));
  let gates = evaluateGates(blocked, 'approve');
  const reviewGate = gates.find(g => g.gate === 'review');
  assert.ok(reviewGate);
  assert.equal(reviewGate.state, 'failed', 'a high review finding must hold the run at approval');

  const clean = succeedBand(run, { findings: [], metrics: {} });
  gates = evaluateGates(clean, 'approve');
  for (const gate of ['qa', 'security', 'review']) {
    const g = gates.find(x => x.gate === gate);
    assert.ok(g, `gate ${gate} missing`);
    assert.equal(g.state, 'passed', `gate ${gate} should pass on a clean run (got ${g?.detail})`);
  }
});

test('TASK-253: coverage threshold holds the qa gate when line coverage is low', () => {
  const wf = loopWorkflow();
  let run = runToApproval(wf);
  const at = (n: number) => new Date(Date.UTC(2026, 8, 10, 10, n)).toISOString();
  let out = run;
  const contractId: Record<string, string> = {
    lint: 'lint-findings',
    typecheck: 'typecheck-findings',
    'unit-test': 'test-findings',
    'bdd-run': 'bdd-findings',
    sast: 'sast-findings',
    secrets: 'secret-findings',
    sca: 'sca-findings',
    review: 'review-findings',
    'test-review': 'test-review-findings',
    'security-review': 'security-review-findings',
    'ux-review': 'ux-review-findings'
  };
  for (const id of ['lint', 'typecheck', 'bdd-run', 'sast', 'secrets', 'sca']) {
    out = applyWorkflowRunCommand(out, { kind: 'node-started', nodeId: id, at: at(6) });
    out = applyWorkflowRunCommand(out, { kind: 'node-succeeded', nodeId: id, artifacts: [{ contractId: contractId[id], kind: 'findings' }], findings: { findings: [], metrics: {} }, snapshotRef: 'sha-1', at: at(7) });
  }
  out = applyWorkflowRunCommand(out, { kind: 'node-started', nodeId: 'unit-test', at: at(6) });
  out = applyWorkflowRunCommand(out, { kind: 'node-succeeded', nodeId: 'unit-test', artifacts: [{ contractId: 'test-findings', kind: 'findings' }], findings: { findings: [], metrics: { lineCoveragePct: 42 } }, snapshotRef: 'sha-1', at: at(7) });
  for (const id of ['review', 'test-review', 'security-review', 'ux-review']) {
    out = applyWorkflowRunCommand(out, { kind: 'node-started', nodeId: id, at: at(8) });
    out = applyWorkflowRunCommand(out, { kind: 'node-succeeded', nodeId: id, artifacts: [{ contractId: contractId[id], kind: 'findings' }], findings: { findings: [], metrics: {} }, snapshotRef: 'sha-1', at: at(9) });
  }
  const gates = evaluateGates(out, 'approve');
  const qa = gates.find(g => g.gate === 'qa');
  assert.ok(qa);
  assert.equal(qa.state, 'failed', '42% coverage must fail the 80% threshold');
});

test('TASK-253: instantiation for a project produces a valid project-scoped copy', () => {
  // Reuse the same instantiation path the template library exposes.
  const { instantiateTemplateForProject } = require('./workflowTemplates') as typeof import('./workflowTemplates');
  const copy = instantiateTemplateForProject({ template: loopWorkflow(), projectId: 'p1', at: '2026-09-10T00:00:00Z' });
  assert.equal(copy.scope, 'project');
  assert.equal(copy.id, 'full-sdlc-loop-p1');
  assert.deepEqual(validateWorkflow(copy).errors, []);
});

test('TASK-253: variants differ only in commands, not in graph shape', () => {
  const node = loopWorkflow();
  for (const wf of sdlcLoopMarketplaceTemplates()) {
    assert.equal(wf.nodes.length, node.nodes.length, wf.id);
    assert.equal(wf.edges.length, node.edges.length, wf.id);
    const bdd = wf.nodes.find(n => n.id === 'bdd-run');
    assert.ok(bdd && bdd.type === 'check' && bdd.command, `variant ${wf.id} lost its BDD command`);
  }
});
