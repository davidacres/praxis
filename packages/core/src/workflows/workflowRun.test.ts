import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorkflowRunCommand,
  canRetry,
  exhaustedProviders,
  stageProvider,
  stageModel,
  createWorkflowRun,
  normalizeWorkflowRun,
  reworkWorkflowRun,
  type WorkflowRun
} from './workflowRun';
import { advanceJoins, deriveRunStatus, scheduleWorkflowRun } from './workflowScheduler';
import { findTimedOutNodes, nextActions, recoverWorkflowRun } from './workflowRecovery';
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from './workflowTypes';
import { summarizeWorkflowRun } from './workflowRunSummary';
import { stageOutcomeFromSession } from './workflowStageTask';

const T = (minutes: number): string => new Date(Date.UTC(2026, 8, 2, 9, minutes)).toISOString();

/** plan → implement → (review ∥ qa ∥ security) → join → approval. */
function definition(): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'delivery',
    name: 'Delivery',
    scope: 'global',
    version: 1,
    entryNodeId: 'plan',
    createdAt: T(0),
    updatedAt: T(0),
    nodes: [
      {
        type: 'agent-task', id: 'plan', name: 'Plan', x: 0, y: 0, inputs: [],
        agent: { agentId: 'planner', scope: 'global', toolMode: 'read-only' },
        instructions: 'Plan it.', outputs: [{ id: 'plan-doc', kind: 'plan', required: true }],
        mutatesWorktree: false
      },
      {
        type: 'agent-task', id: 'implement', name: 'Implement', x: 0, y: 0, inputs: ['plan-doc'],
        agent: { agentId: 'coder', scope: 'global', toolMode: 'full' },
        instructions: 'Build it.', outputs: [{ id: 'change-diff', kind: 'diff', required: true }],
        mutatesWorktree: true, maxAttempts: 2
      },
      {
        type: 'agent-task', id: 'review', name: 'Review', x: 0, y: 0, inputs: ['change-diff'],
        agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only' },
        instructions: 'Review it.', outputs: [{ id: 'review-report', kind: 'report', required: true }],
        mutatesWorktree: false, satisfiesGate: 'review'
      },
      {
        type: 'check', id: 'qa', name: 'QA', x: 0, y: 0, inputs: ['change-diff'],
        command: 'npm', args: ['test'], successExitCodes: [0],
        outputs: [{ id: 'qa-results', kind: 'test-results', required: true }], satisfiesGate: 'qa'
      },
      {
        type: 'check', id: 'security', name: 'Security', x: 0, y: 0, inputs: ['change-diff'],
        command: 'npm', args: ['audit'], successExitCodes: [0],
        outputs: [{ id: 'security-report', kind: 'report', required: true }], satisfiesGate: 'security'
      },
      { type: 'join', id: 'gates', name: 'Gates', x: 0, y: 0, inputs: [], mode: 'all' },
      {
        type: 'approval', id: 'approve', name: 'Approve', x: 0, y: 0, inputs: [],
        prompt: 'Ship it?', requiredGates: ['review', 'qa', 'security'], allowBypass: false
      }
    ],
    edges: [
      { id: 'e1', from: 'plan', to: 'implement', on: 'success', required: true },
      { id: 'e2', from: 'implement', to: 'review', on: 'success', required: true },
      { id: 'e3', from: 'implement', to: 'qa', on: 'success', required: true },
      { id: 'e4', from: 'implement', to: 'security', on: 'success', required: true },
      { id: 'e5', from: 'review', to: 'gates', on: 'success', required: true },
      { id: 'e6', from: 'qa', to: 'gates', on: 'success', required: true },
      { id: 'e7', from: 'security', to: 'gates', on: 'success', required: true },
      { id: 'e8', from: 'gates', to: 'approve', on: 'success', required: true }
    ]
  };
}

function newRun(def: WorkflowDefinition = definition()): WorkflowRun {
  return createWorkflowRun({ runId: 'run-1', projectId: 'p1', definition: def, at: T(0) });
}

test('a run keeps its controller session relationship across normalization', () => {
  const run = createWorkflowRun({
    runId: 'run-controller',
    projectId: 'p1',
    definition: definition(),
    at: T(0),
    controllerSessionKey: 'SESSION-controller',
    controllerSessionId: 'session-1'
  });
  const restored = normalizeWorkflowRun(JSON.parse(JSON.stringify(run)));
  assert.ok(restored);
  assert.equal(restored.controllerSessionKey, 'SESSION-controller');
  assert.equal(restored.controllerSessionId, 'session-1');
});

/** Runs a node start→success with the artifacts its contract declares. */
function succeed(run: WorkflowRun, nodeId: string, minute: number): WorkflowRun {
  const node = run.definition.nodes.find(candidate => candidate.id === nodeId);
  const outputs = node && 'outputs' in node ? node.outputs : [];
  let next = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId, at: T(minute) });
  next = applyWorkflowRunCommand(next, {
    kind: 'node-succeeded',
    nodeId,
    at: T(minute + 1),
    artifacts: outputs.map(contract => ({ contractId: contract.id, kind: contract.kind }))
  });
  return advanceJoins(next, T(minute + 1));
}

// ── Idempotency ──────────────────────────────────────────────────────────

test('replaying a start command does not open a second attempt', () => {
  const run = applyWorkflowRunCommand(newRun(), { kind: 'node-started', nodeId: 'plan', at: T(1) });
  const again = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'plan', at: T(2) });
  assert.equal(again, run, 'a no-op must return the same run object');
  assert.equal(run.nodes.plan.attempts.length, 1);
});

test('replaying a success command does not append a second event', () => {
  const run = succeed(newRun(), 'plan', 1);
  const again = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'plan', at: T(5) });
  assert.equal(again, run);
});

test('a settled run absorbs no further stage commands', () => {
  const cancelled = applyWorkflowRunCommand(newRun(), { kind: 'cancel', at: T(1), reason: 'user asked' });
  const after = applyWorkflowRunCommand(cancelled, { kind: 'node-started', nodeId: 'plan', at: T(2) });
  assert.equal(after, cancelled);
  assert.equal(cancelled.status, 'cancelled');
});

// ── Artifact contracts ───────────────────────────────────────────────────

test('a stage that does not produce its required artifact has not succeeded', () => {
  let run = applyWorkflowRunCommand(newRun(), { kind: 'node-started', nodeId: 'plan', at: T(1) });
  run = applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'plan', at: T(2), artifacts: [] });
  assert.equal(run.nodes.plan.outcome, 'failed');
  assert.match(run.nodes.plan.attempts[0].error ?? '', /did not produce required artifacts: plan-doc/);
});

test('an artifact the node never declared is not recorded', () => {
  let run = applyWorkflowRunCommand(newRun(), { kind: 'node-started', nodeId: 'plan', at: T(1) });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'plan',
    at: T(2),
    artifacts: [
      { contractId: 'plan-doc', kind: 'plan' },
      { contractId: 'smuggled', kind: 'note' }
    ]
  });
  assert.deepEqual(run.nodes.plan.artifacts.map(a => a.contractId), ['plan-doc']);
});

// ── Scheduling and fan-out ───────────────────────────────────────────────

test('the entry node is the only thing ready at the start', () => {
  assert.deepEqual(scheduleWorkflowRun(newRun()).ready, ['plan']);
});

test('review, QA, and security fan out together once implement succeeds', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = succeed(run, 'implement', 3);
  assert.deepEqual(scheduleWorkflowRun(run).ready, ['review', 'qa', 'security']);
});

test('two mutating stages never run at once', () => {
  const def = definition();
  // A second writer fanning out beside `implement`.
  def.nodes.push({
    type: 'agent-task', id: 'refactor', name: 'Refactor', x: 0, y: 0, inputs: ['plan-doc'],
    agent: { agentId: 'coder', scope: 'global', toolMode: 'full' },
    instructions: 'Tidy.', outputs: [], mutatesWorktree: true
  });
  def.edges.push({ id: 'e9', from: 'plan', to: 'refactor', on: 'success', required: false });

  const run = succeed(newRun(def), 'plan', 1);
  const schedule = scheduleWorkflowRun(run);
  assert.deepEqual(schedule.ready, ['implement'], 'only the first writer is admitted');

  // While one writer runs, the other stays out. Nothing is *blocked* — the
  // worktree is simply busy, and `blocked` is reserved for a genuine stall.
  const busy = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(3) });
  assert.deepEqual(scheduleWorkflowRun(busy).ready, []);
  assert.deepEqual(scheduleWorkflowRun(busy).running, ['implement']);
  assert.equal(scheduleWorkflowRun(busy).blocked, undefined);
});

test('a queued writer is admitted once the running one settles', () => {
  const def = definition();
  def.nodes.push({
    type: 'agent-task', id: 'refactor', name: 'Refactor', x: 0, y: 0, inputs: ['plan-doc'],
    agent: { agentId: 'coder', scope: 'global', toolMode: 'full' },
    instructions: 'Tidy.', outputs: [], mutatesWorktree: true
  });
  def.edges.push({ id: 'e9', from: 'plan', to: 'refactor', on: 'success', required: false });

  let run = succeed(newRun(def), 'plan', 1);
  run = succeed(run, 'implement', 3);
  assert.ok(scheduleWorkflowRun(run).ready.includes('refactor'), 'the queued writer gets its turn');
});

test('read-only stages are not blocked by a running writer', () => {
  const def = definition();
  def.nodes.push({
    type: 'check', id: 'lint', name: 'Lint', x: 0, y: 0, inputs: ['plan-doc'],
    command: 'npm', args: ['run', 'lint'], successExitCodes: [0], outputs: []
  });
  def.edges.push({ id: 'e9', from: 'plan', to: 'lint', on: 'success', required: false });

  const run = succeed(newRun(def), 'plan', 1);
  const busy = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(3) });
  assert.deepEqual(scheduleWorkflowRun(busy).ready, ['lint']);
});

// ── Edge outcomes and joins ──────────────────────────────────────────────

test('a failure edge routes where a success edge does not', () => {
  const def = definition();
  def.nodes.push({
    type: 'check', id: 'triage', name: 'Triage', x: 0, y: 0, inputs: [],
    command: 'echo', successExitCodes: [0], outputs: []
  });
  def.edges.push({ id: 'e9', from: 'implement', to: 'triage', on: 'failure', required: false });

  let run = succeed(newRun(def), 'plan', 1);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(3) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'implement', at: T(4), error: 'compile error' });

  const schedule = scheduleWorkflowRun(run);
  assert.ok(schedule.ready.includes('triage'), 'the failure branch is taken');
  // The success branches can never be reached now.
  assert.deepEqual(schedule.skip.map(entry => entry.nodeId).sort(), ['qa', 'review', 'security']);
});

test('an all join waits for every branch, then advances on its own', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = succeed(run, 'implement', 3);
  run = succeed(run, 'review', 5);
  run = succeed(run, 'qa', 7);
  assert.equal(run.nodes.gates.outcome, 'pending', 'still waiting on security');

  run = succeed(run, 'security', 9);
  assert.equal(run.nodes.gates.outcome, 'succeeded', 'the join settled itself');
  assert.deepEqual(scheduleWorkflowRun(run).awaitingApproval, ['approve']);
});

test('an all-required join releases without its advisory branch', () => {
  const def = definition();
  const join = def.nodes.find(node => node.id === 'gates');
  if (join?.type === 'join') join.mode = 'all-required';
  // Security becomes advisory.
  def.edges = def.edges.map(edge => (edge.id === 'e7' ? { ...edge, required: false } : edge));

  let run = succeed(newRun(def), 'plan', 1);
  run = succeed(run, 'implement', 3);
  run = succeed(run, 'review', 5);
  run = succeed(run, 'qa', 7);
  assert.equal(run.nodes.gates.outcome, 'succeeded', 'released without waiting for security');
});

test('a failed required gate ends the run instead of offering approval', () => {
  // Security has no attempt budget beyond its first, so its failure is final.
  // The run settles rather than sitting at a join that can never converge.
  let run = succeed(newRun(), 'plan', 1);
  run = succeed(run, 'implement', 3);
  run = succeed(run, 'review', 5);
  run = succeed(run, 'qa', 7);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'security', at: T(9) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'security', at: T(10), error: 'CVE found' });

  assert.equal(run.status, 'failed');
  assert.match(run.endedReason ?? '', /security/);
  assert.deepEqual(scheduleWorkflowRun(run).awaitingApproval, [], 'approval is never offered');
  assert.equal(run.nodes.approve.outcome, 'pending', 'approval never ran');
});

test('an advisory branch failing does not sink the run', () => {
  // Same shape, but security is advisory and the join only waits on required
  // branches — delivery survives a failing branch nobody depends on.
  const def = definition();
  const join = def.nodes.find(node => node.id === 'gates');
  if (join?.type === 'join') join.mode = 'all-required';
  def.edges = def.edges.map(edge => (edge.id === 'e4' || edge.id === 'e7' ? { ...edge, required: false } : edge));

  let run = succeed(newRun(def), 'plan', 1);
  run = succeed(run, 'implement', 3);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'security', at: T(5) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'security', at: T(6), error: 'CVE found' });
  assert.equal(run.status, 'running');

  run = succeed(run, 'review', 7);
  run = succeed(run, 'qa', 9);
  assert.equal(run.nodes.gates.outcome, 'succeeded');
  assert.deepEqual(scheduleWorkflowRun(run).awaitingApproval, ['approve']);
});

test('a required failure with no retries left fails the run', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = succeed(run, 'implement', 3);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'review', at: T(5) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'review', at: T(6), error: 'rejected' });
  assert.equal(run.status, 'failed');
  assert.match(run.endedReason ?? '', /review/);
});

test('the run reports awaiting-approval only when nothing else can move', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = succeed(run, 'implement', 3);
  assert.equal(deriveRunStatus(run), 'running');

  run = succeed(run, 'review', 5);
  run = succeed(run, 'qa', 7);
  run = succeed(run, 'security', 9);
  assert.equal(deriveRunStatus(run), 'awaiting-approval');
});

test('rework opens a new implementation revision and clears only its downstream evidence', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = succeed(run, 'implement', 3);
  run = succeed(run, 'review', 5);
  run = succeed(run, 'qa', 7);
  run = succeed(run, 'security', 9);

  const result = reworkWorkflowRun(run, 'implement', T(12));
  assert.equal(result.reason, undefined);
  assert.deepEqual(result.requeued, ['implement', 'review', 'qa', 'security', 'gates', 'approve']);
  assert.equal(result.run.nodes.plan.outcome, 'succeeded', 'upstream planning remains valid');
  for (const nodeId of result.requeued) {
    assert.equal(result.run.nodes[nodeId].outcome, 'pending');
    assert.deepEqual(result.run.nodes[nodeId].artifacts, []);
  }
  assert.equal(result.run.nodes.implement.attempts.length, 1, 'the earlier implementation attempt remains auditable');
  assert.equal(result.run.status, 'running');
  assert.deepEqual(scheduleWorkflowRun(result.run).ready, ['implement']);
  assert.ok(result.run.events.some(event => event.kind === 'node-reworked' && event.nodeId === 'implement'));
});

test('a stale gate offers rework from the implementation snapshot that caused it', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = succeed(run, 'implement', 3);
  run = succeed(run, 'review', 5);
  run = {
    ...run,
    nodes: {
      ...run.nodes,
      implement: { ...run.nodes.implement, snapshotRef: 'sha-new' },
      review: { ...run.nodes.review, assessedSnapshotRef: 'sha-old' }
    }
  };

  assert.deepEqual(
    nextActions(run).filter(action => action.kind === 'rework-stage').map(action => action.nodeId),
    ['implement']
  );
});

test('a failed gate offers rework from the implementation stage that fed it, even when the run failed', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(2) });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'implement',
    at: T(3),
    snapshotRef: 'sha-impl',
    artifacts: [{ contractId: 'change-diff', kind: 'diff' }]
  });
  run = advanceJoins(run, T(3));
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'qa', at: T(4) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'qa', at: T(5), error: 'test failed' });
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'qa', at: T(6) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'qa', at: T(7), error: 'test failed again' });

  assert.equal(run.status, 'failed');
  const rework = nextActions(run).filter(action => action.kind === 'rework-stage');
  assert.equal(rework.length, 1);
  assert.equal(rework[0].nodeId, 'implement');
  assert.match(rework[0].label, /qa failed/);
});

// ── Retry ────────────────────────────────────────────────────────────────

test('a failed stage within its attempt budget is retryable and keeps its history', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(3) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'implement', at: T(4), error: 'flaky' });
  assert.equal(canRetry(run, 'implement'), true);
  assert.equal(run.status, 'running', 'a retryable failure does not sink the run');

  run = applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId: 'implement', at: T(5) });
  assert.deepEqual(scheduleWorkflowRun(run).ready, ['implement']);

  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(6) });
  assert.equal(run.nodes.implement.attempts.length, 2, 'the first attempt is still on the record');
  assert.equal(run.nodes.implement.attempts[0].error, 'flaky');
});

test('a person can retry a failed stage after its attempt budget is spent, which reopens the failed run', () => {
  let run = succeed(newRun(), 'plan', 1);
  for (const minute of [3, 6]) {
    run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(minute) });
    run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'implement', at: T(minute + 1), error: 'again' });
    if (minute === 3) run = applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId: 'implement', at: T(minute + 2) });
  }
  assert.equal(run.nodes.implement.attempts.length, 2);
  assert.equal(canRetry(run, 'implement'), false, 'the budget still bounds the run continuing on its own');
  assert.equal(run.status, 'failed');
  assert.ok(
    nextActions(run).some(action => action.kind === 'retry-stage' && action.nodeId === 'implement'),
    'a failed run still offers a retry'
  );

  run = { ...run, issueWriteBackAt: T(8) };
  run = applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId: 'implement', at: T(9) });
  assert.equal(run.status, 'running');
  assert.equal(run.endedAt, undefined);
  assert.equal(run.endedReason, undefined);
  assert.equal(run.issueWriteBackAt, undefined, 'a retried run must publish its next terminal outcome');
  assert.equal(run.nodes.implement.attempts.length, 2, 'earlier attempts stay on the record');
  assert.deepEqual(scheduleWorkflowRun(run).ready, ['implement']);
  assert.match(run.events.at(-1)?.message ?? '', /attempt 3/);
});

test('retrying a failed run requeues siblings that were stopped when it ended', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(3) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'implement', at: T(4), error: 'boom' });
  run = applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId: 'implement', at: T(5) });
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(6) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'implement', at: T(7), error: 'boom' });
  assert.equal(run.status, 'failed');

  // Simulate a sibling the orchestrator stopped when the run failed.
  run = { ...run, nodes: { ...run.nodes, qa: { ...run.nodes.qa, outcome: 'cancelled' } } };
  run = applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId: 'implement', at: T(8) });
  assert.equal(run.nodes.qa.outcome, 'pending');
});

test('a cancelled run cannot be reopened by a retry', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(3) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'implement', at: T(4), error: 'boom' });
  run = applyWorkflowRunCommand(run, { kind: 'cancel', at: T(5) });
  assert.equal(run.status, 'cancelled');
  const after = applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId: 'implement', at: T(6) });
  assert.equal(after, run);
  assert.equal(nextActions(run).some(action => action.kind === 'retry-stage'), false);
});

test('a retryable QA failure keeps the run open for a QA-only retry', () => {
  const base = definition();
  const retryable: WorkflowDefinition = {
    ...base,
    nodes: base.nodes.map(node => node.id === 'qa' && node.type === 'check' ? { ...node, maxAttempts: 2 } : node)
  };
  let run = succeed(newRun(retryable), 'plan', 1);
  run = succeed(run, 'implement', 3);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'qa', at: T(5) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'qa', at: T(6), error: 'test failure' });
  assert.equal(run.status, 'running');
  assert.ok(nextActions(run).some(action => action.kind === 'retry-stage' && action.nodeId === 'qa'));
});

// ── Timeout ──────────────────────────────────────────────────────────────

test('a stage past its timeout is reported, and only that stage', () => {
  const def = definition();
  const implement = def.nodes.find(node => node.id === 'implement');
  if (implement?.type === 'agent-task') implement.timeoutMs = 60_000;

  let run = succeed(newRun(def), 'plan', 1);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(3) });

  assert.deepEqual(findTimedOutNodes(run, T(3)), []);
  assert.deepEqual(findTimedOutNodes(run, T(5)), ['implement']);
});

test('a timed-out stage records the timeout as its failure', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(3) });
  run = applyWorkflowRunCommand(run, { kind: 'node-timed-out', nodeId: 'implement', at: T(9) });
  assert.equal(run.nodes.implement.outcome, 'failed');
  assert.ok(run.events.some(event => event.kind === 'node-timed-out'));
});

// ── Restart recovery ─────────────────────────────────────────────────────

test('recovery closes the in-flight attempt and leaves completed stages alone', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(3) });

  const recovered = recoverWorkflowRun(run, T(20));
  assert.deepEqual(recovered.interrupted, ['implement']);
  assert.equal(recovered.run.nodes.plan.outcome, 'succeeded', 'a completed stage is untouched');
  assert.equal(recovered.run.nodes.plan.attempts.length, 1, 'and is not re-attempted');
  assert.equal(recovered.run.nodes.implement.outcome, 'failed');
  assert.match(recovered.run.nodes.implement.attempts[0].error ?? '', /Interrupted/);
});

test('recovery is idempotent — recovering twice changes nothing further', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(3) });
  const once = recoverWorkflowRun(run, T(20)).run;
  const twice = recoverWorkflowRun(once, T(21));
  assert.deepEqual(twice.interrupted, []);
  assert.equal(twice.run, once);
});

test('an interrupted stage is offered as an explicit retry, not resumed', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(3) });
  const recovered = recoverWorkflowRun(run, T(20)).run;

  const actions = nextActions(recovered);
  const retry = actions.find(action => action.kind === 'retry-stage');
  assert.ok(retry, 'recovery must surface a retry');
  assert.equal(retry.kind === 'retry-stage' && retry.nodeId, 'implement');
  assert.equal(
    actions.some(action => action.kind === 'start-stage' && action.nodeId === 'implement'),
    false,
    'it must not silently restart'
  );
});

test('a settled run survives a restart untouched', () => {
  const cancelled = applyWorkflowRunCommand(newRun(), { kind: 'cancel', at: T(1) });
  const recovered = recoverWorkflowRun(cancelled, T(20));
  assert.equal(recovered.run, cancelled);
});

// ── Persistence ──────────────────────────────────────────────────────────

test('a run survives a JSON round-trip with its history intact', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = succeed(run, 'implement', 3);
  const restored = normalizeWorkflowRun(JSON.parse(JSON.stringify(run)));
  assert.deepEqual(restored, run);
  assert.ok((restored?.events.length ?? 0) > 0);
});

test('a custom automation name survives normalization and JSON round-trip', () => {
  const source = { ...newRun(), displayName: 'Nightly verification' };
  const restored = normalizeWorkflowRun(JSON.parse(JSON.stringify(source)));
  assert.equal(restored?.displayName, 'Nightly verification');
});

test('a run preserves aiProvider and aiModel across normalize round-trip', () => {
  const run = createWorkflowRun({
    runId: 'r-custom-ai',
    projectId: 'p1',
    definition: definition(),
    at: T(0),
    aiProvider: 'claude-code-cli',
    aiModel: 'claude-sonnet-4'
  });
  assert.equal(run.aiProvider, 'claude-code-cli');
  assert.equal(run.aiModel, 'claude-sonnet-4');

  const normalized = normalizeWorkflowRun(JSON.parse(JSON.stringify(run)));
  assert.equal(normalized?.aiProvider, 'claude-code-cli');
  assert.equal(normalized?.aiModel, 'claude-sonnet-4');
});

test('a run record missing its node map rebuilds it as pending without losing events', () => {
  const run = succeed(newRun(), 'plan', 1);
  const damaged = { ...JSON.parse(JSON.stringify(run)), nodes: undefined };
  const restored = normalizeWorkflowRun(damaged);
  assert.equal(restored?.nodes.plan.outcome, 'pending');
  assert.equal(restored?.events.length, run.events.length, 'history is preserved, never rebuilt');
});

test('a record with no runId or definition is not a run', () => {
  assert.equal(normalizeWorkflowRun({ definition: definition() }), undefined);
  assert.equal(normalizeWorkflowRun({ runId: 'r' }), undefined);
  assert.equal(normalizeWorkflowRun(null), undefined);
});

// ── Next actions ─────────────────────────────────────────────────────────

test('a run awaiting approval offers approve and cancel', () => {
  let run = succeed(newRun(), 'plan', 1);
  run = succeed(run, 'implement', 3);
  run = succeed(run, 'review', 5);
  run = succeed(run, 'qa', 7);
  run = succeed(run, 'security', 9);

  const kinds = nextActions(run).map(action => action.kind);
  assert.deepEqual(kinds, ['approve', 'cancel-run']);
});

test('a settled run offers no action but says why it ended', () => {
  const cancelled = applyWorkflowRunCommand(newRun(), { kind: 'cancel', at: T(1), reason: 'user asked' });
  const actions = nextActions(cancelled);
  assert.deepEqual(actions.map(action => action.kind), ['none']);
  assert.match(actions[0].label, /user asked/);
});

// ── Progress phase (FX-BE-058 / TASK-155) ───────────────────────────────

test('node-progress records a phase on a running node', () => {
  let run = applyWorkflowRunCommand(newRun(), { kind: 'node-started', nodeId: 'plan', at: T(1) });
  run = applyWorkflowRunCommand(run, { kind: 'node-progress', nodeId: 'plan', at: T(2), phase: 'deploying' });
  assert.equal(run.nodes.plan.phase, 'deploying');
  assert.equal(run.events[run.events.length - 1].kind, 'node-progress');
});

test('node-progress can move a node from one phase to another', () => {
  let run = applyWorkflowRunCommand(newRun(), { kind: 'node-started', nodeId: 'plan', at: T(1) });
  run = applyWorkflowRunCommand(run, { kind: 'node-progress', nodeId: 'plan', at: T(2), phase: 'deploying' });
  run = applyWorkflowRunCommand(run, { kind: 'node-progress', nodeId: 'plan', at: T(3), phase: 'verifying' });
  assert.equal(run.nodes.plan.phase, 'verifying');
  assert.deepEqual(
    run.events.filter(event => event.kind === 'node-progress').map(event => event.message),
    ['Plan entered phase "deploying".', 'Plan entered phase "verifying".']
  );
});

test('replaying the same phase does not append a second event', () => {
  let run = applyWorkflowRunCommand(newRun(), { kind: 'node-started', nodeId: 'plan', at: T(1) });
  run = applyWorkflowRunCommand(run, { kind: 'node-progress', nodeId: 'plan', at: T(2), phase: 'deploying' });
  const again = applyWorkflowRunCommand(run, { kind: 'node-progress', nodeId: 'plan', at: T(3), phase: 'deploying' });
  assert.equal(again, run, 'a no-op must return the same run object');
});

test('a phase reported for a node that has not started is dropped, not resurrected', () => {
  const run = newRun();
  const after = applyWorkflowRunCommand(run, { kind: 'node-progress', nodeId: 'plan', at: T(1), phase: 'deploying' });
  assert.equal(after, run);
  assert.equal(after.nodes.plan.outcome, 'pending');
});

test('a phase reported after settling is dropped, not applied retroactively', () => {
  const run = succeed(newRun(), 'plan', 1);
  const after = applyWorkflowRunCommand(run, { kind: 'node-progress', nodeId: 'plan', at: T(5), phase: 'deploying' });
  assert.equal(after, run);
});

test('a new attempt starts with no phase left over from a previous one', () => {
  let run = applyWorkflowRunCommand(newRun(), { kind: 'node-started', nodeId: 'implement', at: T(1) });
  run = applyWorkflowRunCommand(run, { kind: 'node-progress', nodeId: 'implement', at: T(2), phase: 'deploying' });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'implement', at: T(3), error: 'boom' });
  run = applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId: 'implement', at: T(4) });
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(5) });
  assert.equal(run.nodes.implement.phase, undefined);
});

test('settling a node clears its reported phase', () => {
  let run = applyWorkflowRunCommand(newRun(), { kind: 'node-started', nodeId: 'plan', at: T(1) });
  run = applyWorkflowRunCommand(run, { kind: 'node-progress', nodeId: 'plan', at: T(2), phase: 'verifying' });
  run = applyWorkflowRunCommand(run, {
    kind: 'node-succeeded',
    nodeId: 'plan',
    at: T(3),
    artifacts: [{ contractId: 'plan-doc', kind: 'plan' }]
  });
  assert.equal(run.nodes.plan.phase, undefined);
});

test('a phase survives a normalize round-trip while the node is still running, and is dropped once settled', () => {
  let run = applyWorkflowRunCommand(newRun(), { kind: 'node-started', nodeId: 'plan', at: T(1) });
  run = applyWorkflowRunCommand(run, { kind: 'node-progress', nodeId: 'plan', at: T(2), phase: 'verifying' });
  const restoredRunning = normalizeWorkflowRun(JSON.parse(JSON.stringify(run)));
  assert.equal(restoredRunning?.nodes.plan.phase, 'verifying');

  const settled = succeed(run, 'plan', 3);
  const restoredSettled = normalizeWorkflowRun(JSON.parse(JSON.stringify(settled)));
  assert.equal(restoredSettled?.nodes.plan.phase, undefined);
});

test('an explicit Task Designer plan input survives run creation and restart normalization', () => {
  const planInput = {
    source: 'task-designer' as const,
    boardId: 'board-1',
    outputPath: '/workspace/plans/master-plan.md',
    generatedFeaturesPath: '/workspace/plans/features',
    fingerprint: 'abc123',
    generatedFeatureCount: 2,
    generatedStoryCount: 6
  };
  const run = createWorkflowRun({
    runId: 'run-plan-input',
    projectId: 'project-1',
    definition: definition(),
    at: T(0),
    planInput
  });
  const restored = normalizeWorkflowRun(JSON.parse(JSON.stringify(run)));
  assert.deepEqual(restored?.planInput, planInput);
});

// ── AI provider limit (credits / quota / rate) ───────────────────────────

/** review → (on failure) fix, with the default one-attempt budget on both. */
function limitDefinition(): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'limit',
    name: 'Limit',
    scope: 'global',
    version: 1,
    entryNodeId: 'review',
    createdAt: T(0),
    updatedAt: T(0),
    nodes: [
      {
        type: 'agent-task', id: 'review', name: 'Review', x: 0, y: 0, inputs: [],
        agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only' },
        instructions: 'Review it.', outputs: [{ id: 'review-report', kind: 'report', required: true }],
        mutatesWorktree: false
      },
      {
        type: 'agent-task', id: 'fix', name: 'Fix', x: 0, y: 0, inputs: [],
        agent: { agentId: 'coder', scope: 'global', toolMode: 'full' },
        instructions: 'Fix it.', outputs: [{ id: 'fix-report', kind: 'report', required: true }],
        mutatesWorktree: false
      }
    ],
    edges: [{ id: 'e1', from: 'review', to: 'fix', on: 'failure', required: false }]
  };
}

function startedLimitRun(): WorkflowRun {
  const run = createWorkflowRun({ runId: 'run-limit', projectId: 'p', definition: limitDefinition(), at: T(0) });
  return applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'review', at: T(1) });
}

test('a provider-limit failure pauses the run instead of failing it', () => {
  const run = applyWorkflowRunCommand(startedLimitRun(), {
    kind: 'node-failed', nodeId: 'review', at: T(2), error: 'credit balance is too low', pause: 'provider-limit'
  });

  assert.equal(run.nodes.review.outcome, 'failed');
  assert.equal(run.nodes.review.attempts[0].pause, 'provider-limit');
  // The run is still open: not failed, not ended, no failed-run event.
  assert.equal(run.status, 'running');
  assert.equal(run.endedAt, undefined);
  assert.equal(run.events.some(event => event.kind === 'run-failed'), false);
  assert.equal(run.events.at(-1)?.kind, 'node-failed');
  assert.match(run.events.at(-1)?.message ?? '', /paused/i);
});

test('a provider-limit failure does not spend the stage its only attempt', () => {
  const paused = applyWorkflowRunCommand(startedLimitRun(), {
    kind: 'node-failed', nodeId: 'review', at: T(2), error: 'quota', pause: 'provider-limit'
  });

  // maxAttempts defaults to 1, yet the stage is still retryable.
  assert.equal(canRetry(paused, 'review'), true);
  assert.ok(nextActions(paused).some(action => action.kind === 'retry-stage' && action.nodeId === 'review'));

  const retried = applyWorkflowRunCommand(paused, { kind: 'node-retry', nodeId: 'review', at: T(3) });
  assert.equal(retried.nodes.review.outcome, 'pending');
  assert.equal(retried.status, 'running');
  assert.match(retried.events.at(-1)?.message ?? '', /attempt 1 of 1/);

  // A genuine failure still spends the attempt: no retry left, and now the
  // failure edge is taken into the fix stage.
  const again = applyWorkflowRunCommand(retried, { kind: 'node-started', nodeId: 'review', at: T(4) });
  const failed = applyWorkflowRunCommand(again, { kind: 'node-failed', nodeId: 'review', at: T(5), error: 'wrong answer' });
  assert.equal(canRetry(failed, 'review'), false);
  assert.ok(scheduleWorkflowRun(failed).ready.includes('fix'));
});

test('a provider-limit failure does not route into failure-edge stages', () => {
  const paused = applyWorkflowRunCommand(startedLimitRun(), {
    kind: 'node-failed', nodeId: 'review', at: T(2), error: 'quota', pause: 'provider-limit'
  });
  const schedule = scheduleWorkflowRun(paused);
  assert.equal(schedule.ready.includes('fix'), false);
  assert.equal(schedule.autoAdvance.includes('fix'), false);

  // Contrast: the same failure without the limit flag does take the edge.
  const genuine = applyWorkflowRunCommand(startedLimitRun(), {
    kind: 'node-failed', nodeId: 'review', at: T(2), error: 'review found problems'
  });
  assert.ok(scheduleWorkflowRun(genuine).ready.includes('fix'));
});

test('a paused run reports itself as paused, not failed, and names the limit', () => {
  const paused = applyWorkflowRunCommand(startedLimitRun(), {
    kind: 'node-failed', nodeId: 'review', at: T(2), error: 'quota', pause: 'provider-limit'
  });
  const summary = summarizeWorkflowRun(paused);
  assert.equal(summary.status, 'running');
  assert.equal(summary.paused, true);
  assert.equal(summary.stages.find(stage => stage.nodeId === 'review')?.lane, 'paused');
  assert.equal(summary.stages.find(stage => stage.nodeId === 'review')?.pause, 'provider-limit');
  assert.match(summary.explanation, /ran out of credits or hit its usage limit.*Switch to another AI/);
  assert.match(summary.explanation, /Review/);
});

test('a session that stopped on a provider limit maps to a limit outcome, not a plain failure', () => {
  const node = limitDefinition().nodes[0] as never;
  const limited = stageOutcomeFromSession(node, {
    state: 'failed', lastError: 'Your credit balance is too low to continue.\nSee billing.', providerLimitReached: true
  });
  assert.equal(limited.status, 'failed');
  assert.equal(limited.pause, 'provider-limit');
  assert.match(limited.error ?? '', /credit balance is too low/);

  const plain = stageOutcomeFromSession(node, { state: 'failed', lastError: 'tool crashed' });
  assert.equal(plain.pause, undefined);
});

// ── Run permission mode (ask / auto-approve) ─────────────────────────────

test('a run asks for tool permissions unless started in auto-approve mode', () => {
  const ask = createWorkflowRun({ runId: 'a', projectId: 'p', definition: limitDefinition(), at: T(0) });
  assert.equal(ask.permissionMode, undefined);
  assert.equal(summarizeWorkflowRun(ask).permissionMode, 'ask');

  const auto = createWorkflowRun({ runId: 'b', projectId: 'p', definition: limitDefinition(), at: T(0), permissionMode: 'auto' });
  assert.equal(auto.permissionMode, 'auto');
  assert.equal(summarizeWorkflowRun(auto).permissionMode, 'auto');
  assert.match(auto.events[0].message, /auto-approved/);

  // Anything that is not exactly 'auto' is treated as ask.
  const odd = createWorkflowRun({ runId: 'c', projectId: 'p', definition: limitDefinition(), at: T(0), permissionMode: 'yolo' as never });
  assert.equal(odd.permissionMode, undefined);
});

test('the permission mode survives a save/reload round trip', () => {
  const auto = createWorkflowRun({ runId: 'b', projectId: 'p', definition: limitDefinition(), at: T(0), permissionMode: 'auto' });
  const reloaded = normalizeWorkflowRun(JSON.parse(JSON.stringify(auto)));
  assert.equal(reloaded?.permissionMode, 'auto');

  const forged = normalizeWorkflowRun({ ...JSON.parse(JSON.stringify(auto)), permissionMode: 'always' });
  assert.equal(forged?.permissionMode, undefined);
});

// ── Environment pause, and closing stages a finished run left running ────

test('an environment failure pauses the run and is free, exactly like a provider limit', () => {
  const run = applyWorkflowRunCommand(startedLimitRun(), {
    kind: 'node-failed', nodeId: 'review', at: T(2), error: 'npm exited 1: audit endpoint returned an error', pause: 'environment'
  });
  assert.equal(run.status, 'running');
  assert.equal(run.nodes.review.attempts[0].pause, 'environment');
  assert.equal(canRetry(run, 'review'), true);
  assert.equal(scheduleWorkflowRun(run).ready.includes('fix'), false);
  assert.match(run.events.at(-1)?.message ?? '', /could not run in this environment/);

  const summary = summarizeWorkflowRun(run);
  assert.equal(summary.paused, true);
  assert.equal(summary.pauseReason, 'environment');
  assert.equal(summary.stages.find(stage => stage.nodeId === 'review')?.pause, 'environment');
  assert.match(summary.explanation, /environment/);
  assert.doesNotMatch(summary.explanation, /credits/);
});

test('a settled run closes a stage it left running, and only that', () => {
  // review failed (required, no retry left) while a second stage was still running.
  const base = createWorkflowRun({ runId: 'r', projectId: 'p', definition: {
    ...limitDefinition(),
    edges: [] // both stages independent
  }, at: T(0) });
  let run = applyWorkflowRunCommand(base, { kind: 'node-started', nodeId: 'review', at: T(1) });
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'fix', at: T(1) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'review', at: T(2), error: 'wrong' });
  assert.equal(run.status, 'failed');
  assert.equal(run.nodes.fix.outcome, 'running', 'a settled run does not close it by itself');

  // Ordinary commands are still absorbed …
  assert.equal(applyWorkflowRunCommand(run, { kind: 'node-succeeded', nodeId: 'fix', at: T(3) }), run);

  // … but stopping the orphan is allowed, and touches nothing else.
  const stopped = applyWorkflowRunCommand(run, { kind: 'node-stopped', nodeId: 'fix', at: T(3), reason: 'the run ended.' });
  assert.equal(stopped.nodes.fix.outcome, 'cancelled');
  assert.equal(stopped.nodes.fix.attempts.at(-1)?.outcome, 'cancelled');
  assert.equal(stopped.nodes.review.outcome, 'failed');
  assert.equal(stopped.status, 'failed');
  // A node that is not running is left alone (idempotent).
  assert.equal(applyWorkflowRunCommand(stopped, { kind: 'node-stopped', nodeId: 'fix', at: T(4) }), stopped);
  assert.equal(applyWorkflowRunCommand(stopped, { kind: 'node-stopped', nodeId: 'review', at: T(4) }), stopped);
});

test('recovery repairs a finished run that still shows stages as running', () => {
  const base = createWorkflowRun({ runId: 'r', projectId: 'p', definition: { ...limitDefinition(), edges: [] }, at: T(0) });
  let run = applyWorkflowRunCommand(base, { kind: 'node-started', nodeId: 'review', at: T(1) });
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'fix', at: T(1) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'review', at: T(2), error: 'wrong' });

  const recovered = recoverWorkflowRun(run, T(9));
  assert.equal(recovered.run.nodes.fix.outcome, 'cancelled');
  assert.equal(recovered.run.status, 'failed');
  assert.deepEqual(recovered.interrupted, []);
  // Nothing to repair: the same object comes back, so nothing is re-saved.
  assert.equal(recoverWorkflowRun(recovered.run, T(10)).run, recovered.run);
});

test('a gate whose owning stage is paused is pending, not failed', () => {
  const definition: WorkflowDefinition = {
    ...limitDefinition(),
    nodes: [
      { ...limitDefinition().nodes[0], satisfiesGate: 'security' } as never,
      limitDefinition().nodes[1],
      {
        type: 'approval', id: 'approve', name: 'Approve', x: 0, y: 0, inputs: [],
        prompt: 'Ship?', requiredGates: ['security'], allowBypass: false
      }
    ],
    edges: [{ id: 'e1', from: 'review', to: 'approve', on: 'success', required: true }]
  };
  let run = createWorkflowRun({ runId: 'g', projectId: 'p', definition, at: T(0) });
  run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'review', at: T(1) });
  run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'review', at: T(2), error: 'audit endpoint returned an error', pause: 'environment' });

  const gate = summarizeWorkflowRun(run).gates.find(row => row.gate === 'security');
  assert.equal(gate?.state, 'pending');
  assert.match(gate?.detail ?? '', /could not run in this environment/);

  // The same failure without the pause is a real failed gate.
  let genuine = createWorkflowRun({ runId: 'g2', projectId: 'p', definition, at: T(0) });
  genuine = applyWorkflowRunCommand(genuine, { kind: 'node-started', nodeId: 'review', at: T(1) });
  genuine = applyWorkflowRunCommand(genuine, { kind: 'node-failed', nodeId: 'review', at: T(2), error: 'found vulnerabilities' });
  assert.equal(summarizeWorkflowRun(genuine).gates.find(row => row.gate === 'security')?.state, 'failed');
});

test('a stage runs on the AI it was switched to, else its own, else the run’s, else the selected AI', () => {
  const def = JSON.parse(JSON.stringify(definitionForAi())) as WorkflowDefinition;
  let run = createWorkflowRun({ runId: 'r', projectId: 'p', definition: def, at: '2026-09-23T00:00:00.000Z' });
  assert.equal(stageProvider(run, 'plan', 'vercel-gateway'), 'claude-code-cli');
  assert.equal(stageProvider(run, 'build', 'vercel-gateway'), 'vercel-gateway');
  run = createWorkflowRun({ runId: 'r', projectId: 'p', definition: def, at: '2026-09-23T00:00:00.000Z', aiProvider: 'openai' });
  assert.equal(stageProvider(run, 'build', 'vercel-gateway'), 'openai');
  run = { ...run, stageProviders: { plan: 'gemini' } };
  assert.equal(stageProvider(run, 'plan', 'vercel-gateway'), 'gemini');
  assert.deepEqual(exhaustedProviders(run), []);
});

function definitionForAi(): WorkflowDefinition {
  const agent = (id: string, providerId?: string) => ({
    type: 'agent-task' as const, id, name: id, x: 0, y: 0, inputs: [],
    agent: { agentId: 'coder', scope: 'global' as const, toolMode: 'full' as const, ...(providerId ? { providerId } : {}) },
    instructions: '', outputs: [], mutatesWorktree: false
  });
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION, id: 'd', name: 'D', scope: 'project', projectId: 'p', version: 1,
    entryNodeId: 'plan', createdAt: '2026-09-23T00:00:00.000Z', updatedAt: '2026-09-23T00:00:00.000Z',
    nodes: [agent('plan', 'claude-code-cli'), agent('build')],
    edges: [{ id: 'e1', from: 'plan', to: 'build', on: 'success', required: true }]
  };
}

test('a stored run keeps its budget policy and the AIs its stages were switched to', () => {
  const run = {
    ...createWorkflowRun({ runId: 'r', projectId: 'p', definition: definitionForAi(), at: '2026-09-23T00:00:00.000Z', providerLimitPolicy: 'stop' }),
    stageProviders: { plan: 'gemini', build: 7 as unknown as string },
    stageModels: { plan: 'gemini-2.0-flash', build: 42 as unknown as string }
  };
  const restored = normalizeWorkflowRun(JSON.parse(JSON.stringify(run)));
  assert.equal(restored?.providerLimitPolicy, 'stop');
  assert.deepEqual(restored?.stageProviders, { plan: 'gemini' });
  assert.deepEqual(restored?.stageModels, { plan: 'gemini-2.0-flash' });
});

test('switching a stage to another AI and model records stageModels and chosenModel in summary', () => {
  let run = createWorkflowRun({ runId: 'r', projectId: 'p', definition: definitionForAi(), at: T(0) });
  run = applyWorkflowRunCommand(run, {
    kind: 'stage-provider-switched',
    nodeId: 'plan',
    at: T(1),
    provider: 'gemini',
    model: 'gemini-2.5-pro'
  });

  assert.equal(stageProvider(run, 'plan', 'vercel-gateway'), 'gemini');
  assert.equal(stageModel(run, 'plan'), 'gemini-2.5-pro');
  assert.deepEqual(run.stageModels, { plan: 'gemini-2.5-pro' });
  assert.match(run.events[run.events.length - 1].message, /plan switched .*to Google Gemini \(gemini-2.5-pro\)\./i);

  const summary = summarizeWorkflowRun(run);
  const planStage = summary.stages.find(s => s.nodeId === 'plan');
  assert.equal(planStage?.chosenProvider, 'gemini');
  assert.equal(planStage?.chosenModel, 'gemini-2.5-pro');

  // Switching without a model clears stageModels for that node
  run = applyWorkflowRunCommand(run, {
    kind: 'stage-provider-switched',
    nodeId: 'plan',
    at: T(2),
    provider: 'openai'
  });
  assert.equal(stageProvider(run, 'plan', 'vercel-gateway'), 'openai');
  assert.equal(stageModel(run, 'plan'), undefined);
  assert.equal(run.stageModels, undefined);
  const summary2 = summarizeWorkflowRun(run);
  assert.equal(summary2.stages.find(s => s.nodeId === 'plan')?.chosenModel, undefined);
});
