import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { normalizeWorkflow, validateWorkflow } from './workflowValidation';
import { createWorkflowRun, applyWorkflowRunCommand, normalizeWorkflowRun, type WorkflowRun } from './workflowRun';
import { advanceJoins, deriveRunStatus, scheduleWorkflowRun } from './workflowScheduler';
import { approveStage, skipApproval } from './workflowGates';
import { nodeOutputs, type WorkflowDefinition } from './workflowTypes';

// Compiled to packages/core/out/workflows; the add-ons live at the repo root.
const ADDON_WORKFLOWS = path.resolve(__dirname, '../../../../addons/workflows');

/** What the desktop's marketplace tier does with an installed template. */
function loadAddonTemplate(id: string): WorkflowDefinition {
  const raw = JSON.parse(fs.readFileSync(path.join(ADDON_WORKFLOWS, id, 'addon', 'template.json'), 'utf8'));
  return normalizeWorkflow({ ...raw, scope: 'global' });
}

test('every workflow add-on template normalizes and validates', () => {
  const ids = fs.readdirSync(ADDON_WORKFLOWS).filter(id => fs.existsSync(path.join(ADDON_WORKFLOWS, id, 'addon', 'template.json')));
  assert.ok(ids.includes('security-review'));
  for (const id of ids) {
    const result = validateWorkflow(loadAddonTemplate(id));
    assert.equal(result.valid, true, `${id}: ${JSON.stringify(result.errors)}`);
  }
});

test('security-review add-on: manifest id matches the template and it is not built in', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ADDON_WORKFLOWS, 'security-review', 'package.json'), 'utf8'));
  const definition = loadAddonTemplate('security-review');
  assert.equal(pkg.praxis.kind, 'workflow-template');
  assert.equal(pkg.praxis.id, definition.id);
  assert.notEqual(definition.builtIn, true);
  assert.equal(definition.trigger, 'on-demand');
});

test('security-review add-on: no stage can modify the codebase', () => {
  for (const node of loadAddonTemplate('security-review').nodes) {
    if (node.type === 'agent-task') {
      assert.equal(node.agent.toolMode, 'read-only', node.id);
      assert.equal(node.mutatesWorktree, false, node.id);
    }
    if (node.type === 'check') assert.notEqual(node.mutatesWorktree, true, node.id);
  }
});

const at = (minute: number) => new Date(Date.UTC(2026, 8, 24, 10, minute)).toISOString();

function succeed(run: WorkflowRun, nodeId: string, minute: number): WorkflowRun {
  const node = run.definition.nodes.find(candidate => candidate.id === nodeId)!;
  let next = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId, at: at(minute) });
  next = applyWorkflowRunCommand(next, {
    kind: 'node-succeeded',
    nodeId,
    at: at(minute),
    artifacts: nodeOutputs(node).map(contract => ({ contractId: contract.id, kind: contract.kind, ...(contract.kind === 'log' ? { path: `/evidence/${contract.id}.log` } : {}) })),
    ...(nodeOutputs(node).some(contract => contract.kind === 'findings') ? { findings: { findings: [], metrics: { findingsCount: 0 } } } : {})
  });
  return settleSkips(advanceJoins(next, at(minute)), minute);
}

/** What the orchestrator does with branches that can no longer run. */
function settleSkips(run: WorkflowRun, minute: number): WorkflowRun {
  let next = run;
  for (const skip of scheduleWorkflowRun(next).skip) {
    next = applyWorkflowRunCommand(next, { kind: 'node-skipped', nodeId: skip.nodeId, at: at(minute), reason: skip.reason });
  }
  return next;
}

function toReport(options: { failSast?: boolean } = {}): WorkflowRun {
  let run = createWorkflowRun({ runId: 'run-sec', projectId: 'proj-1', definition: loadAddonTemplate('security-review'), at: at(0) });
  assert.deepEqual(scheduleWorkflowRun(run).ready, ['inventory']);
  run = succeed(run, 'inventory', 1);
  assert.deepEqual(scheduleWorkflowRun(run).ready.sort(), ['dependencies', 'recon', 'sast', 'secrets']);
  run = succeed(run, 'recon', 2);
  if (options.failSast) {
    run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'sast', at: at(3) });
    run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'sast', at: at(3), error: 'Check timed out.' });
    run = advanceJoins(run, at(3));
  } else {
    run = succeed(run, 'sast', 3);
  }
  run = succeed(run, 'secrets', 4);
  assert.ok(!scheduleWorkflowRun(run).ready.includes('review'), 'the review waits for every scanner to settle');
  run = succeed(run, 'dependencies', 5);
  assert.deepEqual(scheduleWorkflowRun(run).ready, ['review']);
  return succeed(run, 'review', 6);
}

test('security-review run: the report is produced, then the plan waits on approval', () => {
  let run = toReport();
  assert.equal(deriveRunStatus(run), 'awaiting-approval');
  assert.deepEqual(scheduleWorkflowRun(run).awaitingApproval, ['plan-decision']);
  assert.deepEqual(scheduleWorkflowRun(run).ready, []);

  const approved = approveStage(run, 'plan-decision', { actor: 'reviewer', at: at(7) });
  assert.equal(approved.ok, true, approved.reason);
  run = approved.run;
  assert.deepEqual(scheduleWorkflowRun(run).ready, ['remediation-plan']);
  run = succeed(run, 'remediation-plan', 8);
  assert.equal(run.status, 'succeeded');
});

test('security-review run: a scanner that fails does not stop the review', () => {
  const run = toReport({ failSast: true });
  assert.equal(run.nodes.review.outcome, 'succeeded');
  assert.equal(deriveRunStatus(run), 'awaiting-approval');
});

test('security-review add-on: the plan is optional and is published to the board', () => {
  const definition = loadAddonTemplate('security-review');
  const decision = definition.nodes.find(node => node.id === 'plan-decision');
  const plan = definition.nodes.find(node => node.id === 'remediation-plan');
  const review = definition.nodes.find(node => node.id === 'review');
  assert.equal(decision?.type === 'approval' && decision.optional, true);
  assert.equal(plan?.type === 'agent-task' && plan.outputs[0].publishTo, 'board');
  assert.deepEqual(review?.type === 'agent-task' && review.outputs.map(output => output.kind), ['report', 'findings']);
});

test('security-review run: skipping the plan finishes the run as succeeded', () => {
  let run = toReport();
  const skipped = skipApproval(run, 'plan-decision', { actor: 'reviewer', at: at(7) });
  assert.equal(skipped.ok, true, skipped.reason);
  run = settleSkips(skipped.run, 7);
  assert.equal(run.nodes['plan-decision'].outcome, 'skipped');
  assert.equal(run.nodes['remediation-plan'].outcome, 'skipped');
  assert.equal(run.status, 'succeeded');
  assert.ok(run.events.some(event => event.kind === 'node-skipped' && /skipped by reviewer/.test(event.message)));
});

test('a sign-off approval cannot be skipped', () => {
  let run = toReport();
  run = { ...run, definition: { ...run.definition, nodes: run.definition.nodes.map(node => (node.type === 'approval' ? { ...node, optional: false } : node)) } };
  const result = skipApproval(run, 'plan-decision', { actor: 'reviewer', at: at(7) });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /cannot be skipped/);
});

test('security-review run: the published plan id is recorded on the run', () => {
  let run = approveStage(toReport(), 'plan-decision', { actor: 'reviewer', at: at(7) }).run;
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'remediation-plan', at: at(8) });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'remediation-plan',
    at: at(9),
    artifacts: [{ contractId: 'remediation-plan', kind: 'plan', reference: { key: 'AUDIT-F03', title: 'Security remediation', itemKeys: ['AUDIT-B03-1', 'AUDIT-T03-2'] } }]
  });
  assert.equal(run.status, 'succeeded');
  assert.deepEqual(run.nodes['remediation-plan'].artifacts[0].reference?.key, 'AUDIT-F03');
  assert.ok(run.events.some(event => event.message.includes('created plan AUDIT-F03 on the board: Security remediation (2 items)')));
});

test('a stage\'s findings survive the run being read back from disk', () => {
  const run = toReport();
  const withFindings = {
    ...run,
    nodes: { ...run.nodes, review: { ...run.nodes.review, findings: { findings: [{ fingerprint: 'f', severity: 'critical' as const, category: 'CWE-89', message: 'SEC-001' }], metrics: { findingsCount: 1 } } } }
  };
  const reloaded = normalizeWorkflowRun(JSON.parse(JSON.stringify(withFindings)));
  assert.equal(reloaded?.nodes.review.findings?.findings[0].message, 'SEC-001');
});

test('a branch that is not taken is skipped, so the run can finish', () => {
  const definition = normalizeWorkflow({
    schemaVersion: 1, id: 'w', name: 'W', scope: 'global', version: 1, entryNodeId: 'build', createdAt: '', updatedAt: '',
    nodes: [
      { type: 'check', id: 'build', name: 'Build', x: 0, y: 0, inputs: [], command: 'true', outputs: [] },
      { type: 'check', id: 'ship', name: 'Ship', x: 0, y: 0, inputs: [], command: 'true', outputs: [] },
      { type: 'check', id: 'notify-failure', name: 'Notify failure', x: 0, y: 0, inputs: [], command: 'true', outputs: [] }
    ],
    edges: [
      { id: 'e1', from: 'build', to: 'ship', on: 'success', required: true },
      { id: 'e2', from: 'build', to: 'notify-failure', on: 'failure', required: false }
    ]
  });
  let run = createWorkflowRun({ runId: 'r', projectId: 'p', definition, at: at(0) });
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'build', at: at(1) });
  run = advanceJoins(applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'build', at: at(1) }), at(1));
  assert.equal(run.nodes['notify-failure'].outcome, 'skipped');
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'ship', at: at(2) });
  run = advanceJoins(applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'ship', at: at(2) }), at(2));
  assert.equal(run.status, 'succeeded');
});
