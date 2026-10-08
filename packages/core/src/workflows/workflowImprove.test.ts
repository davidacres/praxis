import test from 'node:test';
import assert from 'node:assert/strict';
import { WorkflowOrchestrator, type StageDispatcher, type StageOutcome, type WorkflowRunPersistence, type WorkflowWorkspaceProvider } from './workflowOrchestrator';
import { applyWorkflowRunCommand, createWorkflowRun, type WorkflowRun } from './workflowRun';
import { scheduleWorkflowRun } from './workflowScheduler';
import { normalizeWorkflow, resolveRunParameters, validateWorkflow } from './workflowValidation';
import { improveUntilTargetTemplate, builtInWorkflowTemplates, instantiateTemplateForProject } from './workflowTemplates';
import { summarizeWorkflowRun } from './workflowRunSummary';
import { approveStage } from './workflowGates';
import { assessTestChanges, isTestPath } from './testGuard';
import { pendingLoop } from './workflowEdges';

let clock = 0;
const now = (): string => new Date(Date.UTC(2026, 9, 8, 12, 0, clock++)).toISOString();

// ── Test guard (TASK-433) ────────────────────────────────────────────────

test('test paths are recognised by convention and by the guard\'s own paths', () => {
  for (const path of ['src/pager.test.ts', 'e2e/journey.spec.ts', 'tests/test_api.py', 'pkg/api_test.go', 'src/__tests__/a.js', 'Api.Tests/ApiTests.cs']) {
    assert.equal(isTestPath(path), true, path);
  }
  assert.equal(isTestPath('src/pager.ts'), false);
  assert.equal(isTestPath('checks/smoke.js', { paths: ['checks/'] }), true);
  assert.equal(isTestPath('qa/deep/x.js', { paths: ['qa/**/*.js'] }), true);
});

test('adding a test is allowed', () => {
  assert.deepEqual(assessTestChanges([{ path: 'src/new.test.ts', status: 'added', patch: '+it("works", () => {\n+  expect(f()).toBe(1);\n+});' }]), []);
});

test('weakening a test is flagged, in each of its forms', () => {
  const rules = (changes: Parameters<typeof assessTestChanges>[0], guard = {}) => assessTestChanges(changes, guard).map(finding => finding.ruleId);
  assert.deepEqual(rules([{ path: 'src/a.test.ts', status: 'deleted' }]), ['test-guard/deleted']);
  assert.deepEqual(rules([{ path: 'src/a.test.ts', status: 'modified', patch: '-it("x", () => {\n+it.skip("x", () => {' }]), ['test-guard/skipped']);
  assert.deepEqual(rules([{ path: 'src/a.test.ts', status: 'modified', patch: '-  expect(total).toBe(3);\n+  // fine' }]), ['test-guard/assertions-removed']);
  assert.deepEqual(rules([{ path: 'jest.config.js', status: 'modified', patch: '-    branches: 80,\n+    branches: 60,' }]), ['test-guard/threshold-lowered']);
  assert.deepEqual(rules([{ path: 'tests/test_api.py', status: 'modified', patch: '+@pytest.mark.skip\n def test_x():' }]), ['test-guard/skipped']);
});

test('editing an existing test is flagged unless tests are the stage\'s job — and weakening is flagged even then', () => {
  const edit = [{ path: 'src/a.test.ts', status: 'modified' as const, patch: '-  const input = 1;\n+  const input = 2;' }];
  assert.deepEqual(assessTestChanges(edit).map(finding => finding.ruleId), ['test-guard/edited']);
  assert.deepEqual(assessTestChanges(edit, { testsInScope: true }), []);
  const weaken = [{ path: 'src/a.test.ts', status: 'modified' as const, patch: '-  expect(x).toBe(1);' }];
  assert.deepEqual(assessTestChanges(weaken, { testsInScope: true }).map(finding => finding.ruleId), ['test-guard/assertions-removed']);
});

// ── The template (TASK-432) ──────────────────────────────────────────────

test('improve-until-target is a valid built-in, round-trips, and refuses to start without a target or rubric', () => {
  const template = improveUntilTargetTemplate();
  assert.ok(builtInWorkflowTemplates().some(candidate => candidate.id === template.id));
  assert.deepEqual(validateWorkflow(template).errors, []);
  assert.deepEqual(normalizeWorkflow(JSON.parse(JSON.stringify(template))), JSON.parse(JSON.stringify(template)));

  assert.match(resolveRunParameters(template, { goal: 'Faster pager' }).issues.map(issue => issue.message).join(' '), /numeric target or a rubric/);
  const ok = resolveRunParameters(template, { goal: 'Faster pager', target: 85 });
  assert.deepEqual(ok.issues, []);
  assert.deepEqual(ok.values, { goal: 'Faster pager', target: 85, iterations: 3 });
  const evaluate = template.nodes.find(node => node.id === 'evaluate');
  assert.ok(evaluate && evaluate.type === 'agent-task' && evaluate.independentOf === 'improve');
  const improve = template.nodes.find(node => node.id === 'improve');
  assert.ok(improve && improve.type === 'agent-task' && improve.guardTests);
});

function memoryRuns(): WorkflowRunPersistence {
  const byId = new Map<string, WorkflowRun>();
  return { get: runId => byId.get(runId), async save(saved) { byId.set(saved.runId, saved); return saved; } };
}

const settleAll = async (): Promise<void> => {
  for (let round = 0; round < 60; round += 1) {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
};

/** Scores each evaluation from `scores`; every other stage simply succeeds. */
function scripted(scores: number[]): { dispatcher: StageDispatcher; started: string[] } {
  const started: string[] = [];
  let sha = 0;
  const run = (nodeId: string): StageOutcome => {
    started.push(nodeId);
    switch (nodeId) {
      case 'baseline':
        return { status: 'succeeded', artifacts: [{ contractId: 'baseline-findings', kind: 'findings' }], findings: { findings: [], metrics: { score: 40 } } };
      case 'improve':
        return { status: 'succeeded', artifacts: [{ contractId: 'change-diff', kind: 'diff' }], snapshotRef: `${(++sha).toString(16).padStart(7, '0')}` };
      case 'install':
        return { status: 'succeeded', artifacts: [{ contractId: 'install-log', kind: 'log' }] };
      case 'test':
        return { status: 'succeeded', artifacts: [{ contractId: 'test-results', kind: 'test-results' }] };
      default:
        return { status: 'succeeded', artifacts: [{ contractId: 'evaluation', kind: 'findings' }], findings: { findings: [], metrics: { score: scores.shift() ?? 0 } } };
    }
  };
  return {
    started,
    dispatcher: {
      runCheck: async node => run(node.id),
      runAgentStage: async (node, _context, onSession) => {
        onSession(`s-${node.id}`);
        return run(node.id);
      }
    }
  };
}

async function improveRun(scores: number[], parameters: Record<string, string | number>) {
  const runs = memoryRuns();
  const { dispatcher, started } = scripted(scores);
  const restores: string[] = [];
  const workspace: WorkflowWorkspaceProvider = {
    acquire: async () => '/tmp/wt',
    release: async () => undefined,
    restore: async (_run, ref) => { restores.push(ref); }
  };
  const definition = instantiateTemplateForProject({ template: improveUntilTargetTemplate(), projectId: 'p1', at: now(), newId: 'improve-until-target' });
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher, workspace, now });
  await runs.save(createWorkflowRun({ runId: 'run-improve', projectId: 'p1', definition, at: now(), parameters }));
  await orchestrator.step('run-improve');
  await settleAll();
  return { run: runs.get('run-improve')!, started, restores };
}

test('a loop that reaches its target stops there and waits for approval', async () => {
  const { run, started } = await improveRun([60, 75, 92], { goal: 'Faster', target: 90, iterations: 5 });
  assert.equal(started.filter(id => id === 'improve').length, 3);
  assert.deepEqual(scheduleWorkflowRun(run).awaitingApproval, ['approve']);
  const loop = summarizeWorkflowRun(run).loops[0];
  assert.equal(loop.stoppedBecause, 'condition-met');
  assert.deepEqual(loop.history.map(row => row.score), [60, 75]);
  assert.equal(loop.keepBest?.currentScore, 92);
});

test('a worse pass is undone before the next one, and two passes without beating the best end the loop on the best code', async () => {
  const { run, started, restores } = await improveRun([70, 65, 68], { goal: 'Faster', target: 95, iterations: 5 });
  // 70 (best) → 65 (worse: restore iteration 1's code, go again) → 68 (still not better: out of patience).
  assert.equal(started.filter(id => id === 'improve').length, 3);
  assert.equal(restores.length, 2, `restored before pass 3 and at the end: ${restores}`);
  assert.equal(restores[0], restores[1]);
  assert.equal(pendingLoop(run), undefined);
  const summary = summarizeWorkflowRun(run);
  assert.equal(summary.loops[0].stoppedBecause, 'no-improvement');
  assert.equal(summary.loops[0].keepBest?.bestScore, 70);
  assert.ok(run.events.some(event => /did not beat iteration 1's score of 70/.test(event.message)));

  const approved = approveStage(run, 'approve', { actor: 'dave', at: now() });
  assert.equal(approved.ok, true);
  assert.match(summarizeWorkflowRun(approved.run).explanation, /target was not reached.*best score was 70 \(iteration 1\)/);
});

test('a loop that runs out of iterations below target asks a person, and accepting ends on the best code', async () => {
  const { run, started } = await improveRun([60, 70], { goal: 'Faster', target: 95, iterations: 1 });
  assert.equal(started.filter(id => id === 'improve').length, 2);
  assert.equal(pendingLoop(run)?.kind, 'decide');
  const accepted = applyWorkflowRunCommand(run, { kind: 'loop-decided', edgeId: 'e-improve-again', at: now(), actor: 'dave', decision: 'accept', reason: 'Good enough for now' });
  assert.equal(accepted.pendingRestore, undefined, 'the last pass was the best, so nothing to restore');
  assert.deepEqual(scheduleWorkflowRun(accepted).awaitingApproval, ['approve']);
});
