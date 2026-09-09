import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyWorkflowRunCommand,
  canRetry,
  createWorkflowRun,
  normalizeWorkflowRun,
  type WorkflowRun
} from './workflowRun';
import { advanceJoins, deriveRunStatus, scheduleWorkflowRun } from './workflowScheduler';
import { findTimedOutNodes, nextActions, recoverWorkflowRun } from './workflowRecovery';
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from './workflowTypes';

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

test('retry past the attempt budget is refused', () => {
  let run = succeed(newRun(), 'plan', 1);
  for (const minute of [3, 6]) {
    run = applyWorkflowRunCommand(run, { kind: 'node-started', nodeId: 'implement', at: T(minute) });
    run = applyWorkflowRunCommand(run, { kind: 'node-failed', nodeId: 'implement', at: T(minute + 1), error: 'again' });
    run = applyWorkflowRunCommand(run, { kind: 'node-retry', nodeId: 'implement', at: T(minute + 2) });
  }
  assert.equal(run.nodes.implement.attempts.length, 2);
  assert.equal(canRetry(run, 'implement'), false);
  assert.equal(run.status, 'failed');
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
