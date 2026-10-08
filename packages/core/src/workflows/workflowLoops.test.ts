import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowOrchestrator,
  type StageDispatcher,
  type StageOutcome,
  type WorkflowRunPersistence,
  type WorkflowWorkspaceProvider
} from './workflowOrchestrator';
import {
  applyWorkflowRunCommand,
  attemptsSpent,
  canRetry,
  createWorkflowRun,
  normalizeWorkflowRun,
  type WorkflowRun
} from './workflowRun';
import { scheduleWorkflowRun } from './workflowScheduler';
import { findingsPredicateHolds, loopBudget, pendingLoop } from './workflowEdges';
import { normalizeWorkflow, resolveRunParameters, validateWorkflow } from './workflowValidation';
import { summarizeWorkflowRun } from './workflowRunSummary';
import { evaluateGates } from './workflowGates';
import {
  WORKFLOW_MAX_LOOP_ITERATIONS,
  WORKFLOW_SCHEMA_VERSION,
  type CheckFindings,
  type WorkflowDefinition,
  type WorkflowEdge
} from './workflowTypes';

let clock = 0;
const now = (): string => new Date(Date.UTC(2026, 9, 8, 9, 0, clock++)).toISOString();

const HIGH: CheckFindings = {
  findings: [{ fingerprint: 'fp-1', severity: 'high', category: 'bug', message: 'Off by one in the pager', file: 'src/pager.ts', line: 12 }],
  metrics: { issuesFound: 1 }
};
const CLEAN: CheckFindings = { findings: [], metrics: { issuesFound: 0 } };

/** plan → implement(mutating) → review(findings) → approve, with review ⟲ implement on high findings. */
function loopDefinition(edgeOverrides: Partial<WorkflowEdge> = {}): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'loop', name: 'Loop', scope: 'global', version: 1,
    entryNodeId: 'plan', createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
    nodes: [
      {
        type: 'agent-task', id: 'plan', name: 'Plan', x: 0, y: 0, inputs: [],
        agent: { agentId: 'planner', scope: 'global', toolMode: 'read-only' },
        instructions: 'Plan.', outputs: [{ id: 'plan-doc', kind: 'plan', required: true }], mutatesWorktree: false
      },
      {
        type: 'agent-task', id: 'implement', name: 'Implement', x: 0, y: 0, inputs: ['plan-doc'],
        agent: { agentId: 'coder', scope: 'global', toolMode: 'full' },
        instructions: 'Build.', outputs: [{ id: 'change-diff', kind: 'diff', required: true }],
        mutatesWorktree: true, maxAttempts: 2
      },
      {
        type: 'agent-task', id: 'review', name: 'Review', x: 0, y: 0, inputs: ['change-diff'],
        agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only' },
        instructions: 'Review.', outputs: [{ id: 'review-findings', kind: 'findings', required: true }],
        mutatesWorktree: false, satisfiesGate: 'review'
      },
      {
        type: 'approval', id: 'approve', name: 'Approve', x: 0, y: 0, inputs: ['review-findings'],
        prompt: 'Ship?', requiredGates: ['review'], allowBypass: false
      }
    ],
    edges: [
      { id: 'e-plan', from: 'plan', to: 'implement', on: 'success', required: true },
      { id: 'e-impl', from: 'implement', to: 'review', on: 'success', required: true },
      { id: 'e-ship', from: 'review', to: 'approve', on: 'success', required: true },
      {
        id: 'e-fix', from: 'review', to: 'implement', on: 'findings', required: true,
        when: { severity: 'high' }, loop: { maxIterations: 2 },
        ...edgeOverrides
      }
    ]
  };
}

function start(definition = loopDefinition()): WorkflowRun {
  return createWorkflowRun({ runId: 'run-loop-1', projectId: 'p1', definition, at: now() });
}

/** Runs a stage to an outcome through the reducer. */
function run(r: WorkflowRun, nodeId: string, outcome: 'succeeded' | 'failed', extra: { findings?: CheckFindings; snapshotRef?: string } = {}): WorkflowRun {
  let next = applyWorkflowRunCommand(r, { kind: 'node-started', nodeId, at: now() });
  const node = r.definition.nodes.find(candidate => candidate.id === nodeId)!;
  const outputs = 'outputs' in node ? node.outputs : [];
  next =
    outcome === 'succeeded'
      ? applyWorkflowRunCommand(next, {
          kind: 'node-succeeded', nodeId, at: now(),
          artifacts: outputs.map(output => ({ contractId: output.id, kind: output.kind })),
          ...(extra.findings ? { findings: extra.findings } : {}),
          ...(extra.snapshotRef ? { snapshotRef: extra.snapshotRef } : {})
        })
      : applyWorkflowRunCommand(next, { kind: 'node-failed', nodeId, at: now(), error: 'boom', ...(extra.findings ? { findings: extra.findings } : {}) });
  return next;
}

// ── Validation ───────────────────────────────────────────────────────────

test('an ordinary edge that closes a cycle is still rejected, and the message points at loop edges', () => {
  const definition = loopDefinition();
  const { loop: _loop, ...plain } = definition.edges[3];
  definition.edges[3] = plain;
  const result = validateWorkflow(normalizeWorkflow(definition));
  assert.equal(result.valid, false);
  const cycle = result.errors.find(error => /cycle/.test(error.message));
  assert.ok(cycle, JSON.stringify(result.errors));
  assert.match(cycle.message, /loop edge with an iteration budget/);
});

test('a budgeted back-edge validates, and every other walk ignores it', () => {
  const result = validateWorkflow(normalizeWorkflow(loopDefinition()));
  assert.deepEqual(result.errors, []);
});

test('a loop budget outside 1…ceiling is rejected', () => {
  for (const maxIterations of [0, WORKFLOW_MAX_LOOP_ITERATIONS + 1, -2]) {
    const result = validateWorkflow(normalizeWorkflow(loopDefinition({ loop: { maxIterations } })));
    assert.ok(result.errors.some(error => error.path === 'edges[3].loop.maxIterations'), `budget ${maxIterations}: ${JSON.stringify(result.errors)}`);
  }
});

test('a loop edge that does not point back upstream is rejected', () => {
  const definition = loopDefinition();
  definition.edges[3] = { id: 'e-fwd', from: 'plan', to: 'review', on: 'success', required: true, loop: { maxIterations: 2 } };
  const result = validateWorkflow(normalizeWorkflow(definition));
  assert.ok(result.errors.some(error => /must point back to a stage upstream/.test(error.message)), JSON.stringify(result.errors));
});

test('a findings edge from a stage with no findings output is rejected', () => {
  const definition = loopDefinition();
  definition.edges.push({ id: 'e-bad', from: 'plan', to: 'implement', on: 'findings', required: false });
  const result = validateWorkflow(normalizeWorkflow(definition));
  assert.ok(result.errors.some(error => /declares no findings output/.test(error.message)), JSON.stringify(result.errors));
});

test('an unreadable loop budget survives normalisation as 0 so validation names it rather than reporting a cycle', () => {
  const raw = JSON.parse(JSON.stringify(loopDefinition()));
  raw.edges[3].loop = { maxIterations: 'lots' };
  const definition = normalizeWorkflow(raw);
  assert.equal(definition.edges[3].loop?.maxIterations, 0);
  const result = validateWorkflow(definition);
  assert.ok(result.errors.some(error => error.path === 'edges[3].loop.maxIterations'));
  assert.ok(!result.errors.some(error => /cycle/.test(error.message)));
});

test('normalizeWorkflow round-trips every new field', () => {
  const definition: WorkflowDefinition = {
    ...loopDefinition({ when: { severity: 'medium', minCount: 2, categories: ['security'], metric: { metric: 'score', operator: '<', value: 90 } }, loop: { maxIterations: 3, keepBest: { metric: 'score', higherIsBetter: true } } }),
    parameters: [
      { id: 'goal', label: 'Goal', kind: 'text', required: true, description: 'What to improve' },
      { id: 'iterations', label: 'Iterations', kind: 'integer', default: 3, min: 1, max: 5, bindsLoopEdge: 'e-fix' }
    ],
    requiresMeasurableGoal: true
  };
  (definition.nodes[2] as { independentOf?: string }).independentOf = 'implement';
  definition.nodes.push({
    type: 'map', id: 'fan', name: 'Fix each', x: 0, y: 0, inputs: ['review-findings'], over: 'review-findings', itemSource: 'findings',
    agent: { agentId: 'coder', scope: 'global', toolMode: 'full' }, instructions: 'Fix it.', mutatesWorktree: true,
    concurrency: 2, maxItems: 10, onItemFailure: 'failFast', outputs: [{ id: 'fixes', kind: 'diff', required: true }], modelTier: 'standard'
  });
  const json = JSON.parse(JSON.stringify(definition));
  assert.deepEqual(normalizeWorkflow(json), json);
});

test('parameters: a required goal, an integer loop budget within the ceiling, and a measurable goal', () => {
  const definition = {
    parameters: [
      { id: 'goal', label: 'Goal', kind: 'text' as const, required: true },
      { id: 'iterations', label: 'Iterations', kind: 'integer' as const, bindsLoopEdge: 'e-fix', max: 20 },
      { id: 'target', label: 'Target', kind: 'number' as const }
    ],
    requiresMeasurableGoal: true
  };
  const missing = resolveRunParameters(definition, {});
  assert.deepEqual(missing.issues.map(issue => issue.parameterId).sort(), ['goal', 'target']);

  const tooMany = resolveRunParameters(definition, { goal: 'Faster', iterations: 50, target: 90 });
  assert.match(tooMany.issues[0].message, new RegExp(`at most ${WORKFLOW_MAX_LOOP_ITERATIONS}`));

  const fine = resolveRunParameters(definition, { goal: '  Faster  ', iterations: '4', target: 90 });
  assert.deepEqual(fine.issues, []);
  assert.deepEqual(fine.values, { goal: 'Faster', iterations: 4, target: 90 });
});

// ── Routing ──────────────────────────────────────────────────────────────

test('findings predicates: any clause holds; refuted findings never count', () => {
  assert.equal(findingsPredicateHolds(undefined, HIGH), true);
  assert.equal(findingsPredicateHolds({ severity: 'critical' }, HIGH), false);
  assert.equal(findingsPredicateHolds({ minCount: 2 }, HIGH), false);
  assert.equal(findingsPredicateHolds({ categories: ['security'] }, HIGH), false);
  assert.equal(findingsPredicateHolds({ metric: { metric: 'score', operator: '<', value: 90 } }, { findings: [], metrics: { score: 80 } }), true);
  assert.equal(findingsPredicateHolds({ metric: { metric: 'score', operator: '<', value: 90 } }, { findings: [], metrics: {} }), false, 'a missing metric never holds');
  const refuted: CheckFindings = { findings: [{ ...HIGH.findings[0], verdict: 'refuted' }], metrics: {} };
  assert.equal(findingsPredicateHolds(undefined, refuted), false);
});

test('a forward findings edge routes to its target only when the predicate holds', () => {
  const definition = loopDefinition();
  definition.edges = definition.edges.filter(edge => edge.id !== 'e-fix');
  definition.nodes.push({
    type: 'agent-task', id: 'triage', name: 'Triage', x: 0, y: 0, inputs: ['review-findings'],
    agent: { agentId: 'triager', scope: 'global', toolMode: 'read-only' }, instructions: 'Triage.', outputs: [], mutatesWorktree: false
  });
  definition.edges.push({ id: 'e-triage', from: 'review', to: 'triage', on: 'findings', required: false, when: { severity: 'high' } });
  assert.deepEqual(validateWorkflow(normalizeWorkflow(definition)).errors, []);

  let r = run(run(run(start(definition), 'plan', 'succeeded'), 'implement', 'succeeded', { snapshotRef: 'sha-1' }), 'review', 'succeeded', { findings: HIGH });
  assert.ok(scheduleWorkflowRun(r).ready.includes('triage'));

  r = run(run(run(start(definition), 'plan', 'succeeded'), 'implement', 'succeeded', { snapshotRef: 'sha-1' }), 'review', 'succeeded', { findings: CLEAN });
  assert.ok(scheduleWorkflowRun(r).skip.some(entry => entry.nodeId === 'triage'));
});

// ── Loops through the reducer ────────────────────────────────────────────

test('a firing loop holds the run, then reopens its target and everything after it as a new revision', () => {
  let r = run(run(start(), 'plan', 'succeeded'), 'implement', 'succeeded', { snapshotRef: 'sha-1' });
  r = run(r, 'review', 'succeeded', { findings: HIGH });

  assert.equal(r.status, 'running', 'a firing loop keeps the run open');
  const pending = pendingLoop(r);
  assert.equal(pending?.kind, 'take');
  const schedule = scheduleWorkflowRun(r);
  assert.deepEqual(schedule.ready, []);
  assert.deepEqual(schedule.awaitingApproval, [], 'approval is not offered while the loop decides');

  r = applyWorkflowRunCommand(r, { kind: 'loop-taken', edgeId: 'e-fix', at: now() });
  assert.equal(r.nodes.implement.outcome, 'pending');
  assert.equal(r.nodes.review.outcome, 'pending');
  assert.equal(r.nodes.plan.outcome, 'succeeded', 'upstream of the target is untouched');
  assert.equal(r.nodes.implement.revisionBase, 1);
  assert.equal(r.loopHistory?.length, 1);
  assert.equal(r.loopHistory?.[0].iteration, 1);
  assert.equal(r.loopHistory?.[0].findings[0].message, 'Off by one in the pager');
  assert.ok(r.events.some(event => event.kind === 'loop-taken' && /iteration 1 of 2/.test(event.message)));
  assert.deepEqual(scheduleWorkflowRun(r).ready, ['implement']);

  // Replaying the command is a no-op: the loop no longer fires.
  assert.equal(applyWorkflowRunCommand(r, { kind: 'loop-taken', edgeId: 'e-fix', at: now() }), r);

  r = run(r, 'implement', 'succeeded', { snapshotRef: 'sha-2' });
  r = run(r, 'review', 'succeeded', { findings: CLEAN });
  assert.equal(pendingLoop(r), undefined);
  assert.deepEqual(scheduleWorkflowRun(r).awaitingApproval, ['approve']);
});

test('a loop is not taken while a stage is still running', () => {
  let r = run(run(start(), 'plan', 'succeeded'), 'implement', 'succeeded', { snapshotRef: 'sha-1' });
  r = run(r, 'review', 'succeeded', { findings: HIGH });
  // Simulate an unrelated stage still in flight.
  r = { ...r, nodes: { ...r.nodes, approve: { ...r.nodes.approve, outcome: 'running', attempts: [{ attempt: 1, outcome: 'running', startedAt: now() }] } } };
  assert.equal(applyWorkflowRunCommand(r, { kind: 'loop-taken', edgeId: 'e-fix', at: now() }), r);
});

test('attempt budgets restart with each revision', () => {
  let r = run(run(start(), 'plan', 'succeeded'), 'implement', 'failed');
  r = applyWorkflowRunCommand(r, { kind: 'node-retry', nodeId: 'implement', at: now() });
  r = run(r, 'implement', 'succeeded', { snapshotRef: 'sha-1' });
  assert.equal(attemptsSpent(r.nodes.implement), 2);
  r = run(r, 'review', 'succeeded', { findings: HIGH });
  r = applyWorkflowRunCommand(r, { kind: 'loop-taken', edgeId: 'e-fix', at: now() });
  assert.equal(attemptsSpent(r.nodes.implement), 0);
  r = run(r, 'implement', 'failed');
  assert.equal(canRetry(r, 'implement'), true, 'the new revision has its own maxAttempts');
});

test('a spent budget waits for a decision instead of failing or continuing', () => {
  let r = run(start(), 'plan', 'succeeded');
  for (let lap = 0; lap < 2; lap += 1) {
    r = run(r, 'implement', 'succeeded', { snapshotRef: `sha-${lap}` });
    r = run(r, 'review', 'succeeded', { findings: HIGH });
    r = applyWorkflowRunCommand(r, { kind: 'loop-taken', edgeId: 'e-fix', at: now() });
  }
  r = run(r, 'implement', 'succeeded', { snapshotRef: 'sha-9' });
  r = run(r, 'review', 'succeeded', { findings: HIGH });

  assert.equal(pendingLoop(r)?.kind, 'decide');
  assert.equal(r.status, 'running');
  const schedule = scheduleWorkflowRun(r);
  assert.match(schedule.blocked ?? '', /Needs a decision: Review still matches its loop back to Implement .* after 2 of 2 iterations/);
  assert.equal(applyWorkflowRunCommand(r, { kind: 'loop-taken', edgeId: 'e-fix', at: now() }), r, 'cannot exceed the budget');

  const summary = summarizeWorkflowRun(r);
  assert.equal(summary.needsDecision?.edgeId, 'e-fix');
  assert.equal(summary.loops[0].needsDecision, true);
  assert.equal(summary.loops[0].openFindings?.[0].message, 'Off by one in the pager');
  assert.equal(summary.stages.find(stage => stage.nodeId === 'implement')?.loopIteration?.iteration, 3);
  assert.match(summary.explanation, /Needs a decision/);

  // Accept needs who and why.
  assert.equal(applyWorkflowRunCommand(r, { kind: 'loop-decided', edgeId: 'e-fix', at: now(), actor: 'dave', decision: 'accept' }), r);
  const accepted = applyWorkflowRunCommand(r, { kind: 'loop-decided', edgeId: 'e-fix', at: now(), actor: 'dave', decision: 'accept', reason: 'Known issue, ticket filed' });
  assert.equal(pendingLoop(accepted), undefined);
  assert.deepEqual(scheduleWorkflowRun(accepted).awaitingApproval, ['approve']);
  assert.ok(accepted.events.some(event => event.kind === 'loop-decided' && /accepted .*Known issue/.test(event.message)));

  // Grant more goes round again.
  const granted = applyWorkflowRunCommand(r, { kind: 'loop-decided', edgeId: 'e-fix', at: now(), actor: 'dave', decision: 'grant', extraIterations: 2 });
  assert.equal(loopBudget(granted, granted.definition.edges[3]), 4);
  assert.equal(pendingLoop(granted)?.kind, 'take');

  // Grant is capped at the ceiling.
  const huge = applyWorkflowRunCommand(r, { kind: 'loop-decided', edgeId: 'e-fix', at: now(), actor: 'dave', decision: 'grant', extraIterations: 99 });
  assert.equal(loopBudget(huge, huge.definition.edges[3]), WORKFLOW_MAX_LOOP_ITERATIONS);

  // Stop ends the run, saying who and why.
  const stopped = applyWorkflowRunCommand(r, { kind: 'loop-decided', edgeId: 'e-fix', at: now(), actor: 'dave', decision: 'stop', reason: 'Not converging' });
  assert.equal(stopped.status, 'failed');
  assert.match(stopped.endedReason ?? '', /Stopped by dave after 2 loop iterations .*Not converging/);
});

test('a failure loop edge keeps a failing run open and loops back instead of failing it', () => {
  const definition = loopDefinition({ on: 'failure', when: undefined });
  delete definition.edges[3].when;
  definition.nodes[2] = { ...definition.nodes[2], outputs: [{ id: 'review-findings', kind: 'findings', required: true }] } as typeof definition.nodes[2];
  let r = run(run(start(definition), 'plan', 'succeeded'), 'implement', 'succeeded', { snapshotRef: 'sha-1' });
  r = run(r, 'review', 'failed');
  assert.equal(r.status, 'running');
  assert.equal(pendingLoop(r)?.kind, 'take');
  r = applyWorkflowRunCommand(r, { kind: 'loop-taken', edgeId: 'e-fix', at: now() });
  assert.equal(r.loopHistory?.[0].outcome, 'failed');
  assert.equal(r.loopHistory?.[0].error, 'boom');
});

test('keep-best restores the best iteration when a later one scores worse', () => {
  const definition = loopDefinition({
    when: { metric: { metric: 'score', operator: '<', value: 90 } },
    loop: { maxIterations: 3, keepBest: { metric: 'score', higherIsBetter: true } }
  });
  const scored = (score: number): CheckFindings => ({ findings: [], metrics: { score } });
  let r = run(start(definition), 'plan', 'succeeded');
  r = run(r, 'implement', 'succeeded', { snapshotRef: 'sha-a' });
  r = run(r, 'review', 'succeeded', { findings: scored(70) });
  r = applyWorkflowRunCommand(r, { kind: 'loop-taken', edgeId: 'e-fix', at: now() });
  assert.equal(r.pendingRestore, undefined);
  r = run(r, 'implement', 'succeeded', { snapshotRef: 'sha-b' });
  r = run(r, 'review', 'succeeded', { findings: scored(60) });
  r = applyWorkflowRunCommand(r, { kind: 'loop-taken', edgeId: 'e-fix', at: now() });
  assert.equal(r.pendingRestore?.ref, 'sha-a');
  assert.equal(r.loopHistory?.[1].restoredTo, 'sha-a');

  const restored = applyWorkflowRunCommand(r, { kind: 'loop-restored', at: now(), ok: true });
  assert.equal(restored.pendingRestore, undefined);
  assert.ok(restored.events.some(event => event.kind === 'loop-restored' && /Restored the code to iteration 1/.test(event.message)));
  const summary = summarizeWorkflowRun(restored);
  assert.equal(summary.loops[0].keepBest?.bestScore, 70);
  assert.deepEqual(summary.loops[0].history.map(row => row.score), [70, 60]);
});

test('a skeptic-refuted finding does not hold a review gate threshold', () => {
  const definition = loopDefinition();
  definition.edges = definition.edges.filter(edge => edge.id !== 'e-fix');
  (definition.nodes[3] as { gateThresholds?: unknown }).gateThresholds = { review: [{ type: 'severity', severityLevel: 'high', maxCount: 0 }] };
  let r = run(run(start(definition), 'plan', 'succeeded'), 'implement', 'succeeded', { snapshotRef: 'sha-1' });
  r = run(r, 'review', 'succeeded', { findings: { findings: [{ ...HIGH.findings[0], verdict: 'refuted', verdictReason: 'The pager is 0-based by contract.' }], metrics: {} } });
  assert.equal(evaluateGates(r, 'approve')[0].state, 'passed');
});

test('loop state survives a round trip through disk', () => {
  let r = run(run(start(), 'plan', 'succeeded'), 'implement', 'succeeded', { snapshotRef: 'sha-1' });
  r = run(r, 'review', 'succeeded', { findings: HIGH });
  r = applyWorkflowRunCommand(r, { kind: 'loop-taken', edgeId: 'e-fix', at: now() });
  r = { ...r, parameters: { goal: 'Fix it', iterations: 2 } };
  const reloaded = normalizeWorkflowRun(JSON.parse(JSON.stringify(r)));
  assert.deepEqual(reloaded, JSON.parse(JSON.stringify(r)));
});

test('a run parameter bound to a loop sets its budget', () => {
  const definition: WorkflowDefinition = {
    ...loopDefinition(),
    parameters: [{ id: 'iterations', label: 'Iterations', kind: 'integer', bindsLoopEdge: 'e-fix' }]
  };
  const r = createWorkflowRun({ runId: 'run-p', projectId: 'p1', definition, at: now(), parameters: { iterations: 5 } });
  assert.equal(loopBudget(r, definition.edges[3]), 5);
});

// ── Through the orchestrator ─────────────────────────────────────────────

function memoryRuns(): WorkflowRunPersistence {
  const byId = new Map<string, WorkflowRun>();
  return {
    get: runId => byId.get(runId),
    async save(saved) {
      byId.set(saved.runId, saved);
      return saved;
    }
  };
}

const settleAll = async (): Promise<void> => {
  for (let round = 0; round < 40; round += 1) {
    for (let i = 0; i < 12; i += 1) await Promise.resolve();
    await new Promise(resolve => setImmediate(resolve));
  }
};

function scriptedDispatcher(reviewFindings: () => CheckFindings): { dispatcher: StageDispatcher; started: string[] } {
  const started: string[] = [];
  let sha = 0;
  const outcome = (nodeId: string): StageOutcome => {
    started.push(nodeId);
    if (nodeId === 'plan') return { status: 'succeeded', artifacts: [{ contractId: 'plan-doc', kind: 'plan' }] };
    if (nodeId === 'implement') return { status: 'succeeded', artifacts: [{ contractId: 'change-diff', kind: 'diff' }], snapshotRef: `sha-${++sha}` };
    return { status: 'succeeded', artifacts: [{ contractId: 'review-findings', kind: 'findings' }], findings: reviewFindings() };
  };
  return {
    started,
    dispatcher: {
      runCheck: async node => outcome(node.id),
      runAgentStage: async (node, _context, onSession) => {
        onSession(`session-${node.id}`);
        return outcome(node.id);
      }
    }
  };
}

test('orchestrator: review findings loop back to implement until the review is clean', async () => {
  const runs = memoryRuns();
  const results = [HIGH, HIGH, CLEAN];
  const { dispatcher, started } = scriptedDispatcher(() => results.shift() ?? CLEAN);
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher, now });
  await runs.save(start());
  await orchestrator.step('run-loop-1');
  await settleAll();

  assert.deepEqual(started, ['plan', 'implement', 'review', 'implement', 'review', 'implement', 'review']);
  const final = runs.get('run-loop-1')!;
  assert.equal(final.loopHistory?.length, 2);
  assert.deepEqual(scheduleWorkflowRun(final).awaitingApproval, ['approve']);
});

test('orchestrator: a loop that never converges stops at its budget and waits for a person', async () => {
  const runs = memoryRuns();
  const { dispatcher, started } = scriptedDispatcher(() => HIGH);
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher, now });
  await runs.save(start());
  await orchestrator.step('run-loop-1');
  await settleAll();

  // Initial pass plus exactly the budget of two loops — never more.
  assert.equal(started.filter(id => id === 'implement').length, 3);
  const r = runs.get('run-loop-1')!;
  assert.equal(r.status, 'running');
  assert.equal(pendingLoop(r)?.kind, 'decide');

  // Granting one more takes exactly one more lap.
  await runs.save(applyWorkflowRunCommand(r, { kind: 'loop-decided', edgeId: 'e-fix', at: now(), actor: 'dave', decision: 'grant', extraIterations: 1 }));
  await orchestrator.step('run-loop-1');
  await settleAll();
  assert.equal(started.filter(id => id === 'implement').length, 4);
  assert.equal(pendingLoop(runs.get('run-loop-1')!)?.kind, 'decide');
});

test('orchestrator: keep-best asks the workspace to restore before the next pass', async () => {
  const runs = memoryRuns();
  const scores = [70, 60, 95];
  const { dispatcher, started } = scriptedDispatcher(() => ({ findings: [], metrics: { score: scores.shift() ?? 95 } }));
  const restores: string[] = [];
  const workspace: WorkflowWorkspaceProvider = {
    acquire: async () => '/tmp/wt',
    release: async () => undefined,
    restore: async (_run, ref) => {
      // The restore lands before the next implement pass starts.
      restores.push(`${ref}@${started.filter(id => id === 'implement').length}`);
    }
  };
  const definition = loopDefinition({
    when: { metric: { metric: 'score', operator: '<', value: 90 } },
    loop: { maxIterations: 3, keepBest: { metric: 'score', higherIsBetter: true } }
  });
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher, workspace, now });
  await runs.save(start(definition));
  await orchestrator.step('run-loop-1');
  await settleAll();

  // Iteration 1 scored 70 at sha-1; iteration 2 scored 60 at sha-2, so sha-1 is restored before the third implement.
  assert.deepEqual(restores, ['sha-1@2']);
  const final = runs.get('run-loop-1')!;
  assert.equal(final.pendingRestore, undefined);
  assert.deepEqual(scheduleWorkflowRun(final).awaitingApproval, ['approve']);
});

test('property: any always-firing loop graph stops within its budget', async () => {
  for (let budget = 1; budget <= 4; budget += 1) {
    const runs = memoryRuns();
    const { dispatcher, started } = scriptedDispatcher(() => HIGH);
    const orchestrator = new WorkflowOrchestrator({ runs, dispatcher, now });
    await runs.save(start(loopDefinition({ loop: { maxIterations: budget } })));
    await orchestrator.step('run-loop-1');
    await settleAll();
    assert.equal(started.filter(id => id === 'review').length, budget + 1, `budget ${budget}`);
    // No stage was ever dispatched twice in one revision.
    const r = runs.get('run-loop-1')!;
    assert.equal(r.nodes.implement.attempts.length, budget + 1);
  }
});
