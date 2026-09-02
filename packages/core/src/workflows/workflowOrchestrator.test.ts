import test from 'node:test';
import assert from 'node:assert/strict';
import {
  WorkflowOrchestrator,
  type StageDispatcher,
  type StageOutcome,
  type WorkflowRunPersistence,
  type WorkflowWorkspaceProvider
} from './workflowOrchestrator';
import { createWorkflowRun, type WorkflowRun } from './workflowRun';
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition } from './workflowTypes';

let clock = 0;
const now = (): string => new Date(Date.UTC(2026, 8, 2, 9, clock++)).toISOString();

/** In-memory run store satisfying the persistence port. */
function memoryRuns(): WorkflowRunPersistence & { saves: number } {
  const byId = new Map<string, WorkflowRun>();
  return {
    saves: 0,
    get(runId) {
      return byId.get(runId);
    },
    async save(run) {
      this.saves += 1;
      byId.set(run.runId, run);
      return run;
    }
  };
}

interface Deferred {
  resolve: (outcome: StageOutcome) => void;
  promise: Promise<StageOutcome>;
}

/**
 * Records every dispatch and lets a test decide when each one finishes, so the
 * interleaving properties can be asserted rather than hoped for.
 */
function fakeDispatcher(auto?: (nodeId: string) => StageOutcome) {
  const started: string[] = [];
  const pending = new Map<string, Deferred>();
  const cancelled: string[] = [];
  const worktrees: Array<string | undefined> = [];

  const begin = (nodeId: string, worktreePath: string | undefined): Promise<StageOutcome> => {
    started.push(nodeId);
    worktrees.push(worktreePath);
    if (auto) return Promise.resolve(auto(nodeId));
    let resolve!: (outcome: StageOutcome) => void;
    const promise = new Promise<StageOutcome>(res => {
      resolve = res;
    });
    pending.set(nodeId, { resolve, promise });
    return promise;
  };

  const dispatcher: StageDispatcher = {
    runCheck: (node, context) => begin(node.id, context.worktreePath),
    runAgentStage: (node, context, onSession) => {
      onSession(`session-${node.id}`);
      return begin(node.id, context.worktreePath);
    },
    cancelStage: async nodeId => {
      cancelled.push(nodeId);
    }
  };

  return {
    dispatcher,
    started,
    cancelled,
    worktrees,
    finish(nodeId: string, outcome: StageOutcome = { status: 'succeeded' }) {
      const deferred = pending.get(nodeId);
      assert.ok(deferred, `${nodeId} was not dispatched`);
      pending.delete(nodeId);
      deferred.resolve(outcome);
    }
  };
}

/** Lets microtasks and the orchestrator's chained work drain. */
const settleAll = async (): Promise<void> => {
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
  await new Promise(resolve => setImmediate(resolve));
  for (let i = 0; i < 12; i += 1) await Promise.resolve();
};

// ── Fixtures ─────────────────────────────────────────────────────────────

/** implement(mutating) → (qa ∥ security) → join → approve. */
function definition(): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'd', name: 'D', scope: 'project', projectId: 'p1', version: 1,
    entryNodeId: 'implement', createdAt: now(), updatedAt: now(),
    nodes: [
      {
        type: 'agent-task', id: 'implement', name: 'Implement', x: 0, y: 0, inputs: [],
        agent: { agentId: 'coder', scope: 'global', toolMode: 'full' },
        instructions: 'Build.', outputs: [{ id: 'change-diff', kind: 'diff', required: true }],
        mutatesWorktree: true, maxAttempts: 2
      },
      {
        type: 'check', id: 'qa', name: 'QA', x: 0, y: 0, inputs: ['change-diff'],
        command: 'npm', args: ['test'], successExitCodes: [0],
        outputs: [{ id: 'qa-results', kind: 'test-results', required: true }], satisfiesGate: 'qa'
      },
      {
        type: 'check', id: 'security', name: 'Security', x: 0, y: 0, inputs: ['change-diff'],
        command: 'npm', args: ['audit'], successExitCodes: [0],
        outputs: [{ id: 'sec-report', kind: 'report', required: true }], satisfiesGate: 'security'
      },
      { type: 'join', id: 'gates', name: 'Gates', x: 0, y: 0, inputs: [], mode: 'all' },
      {
        type: 'approval', id: 'approve', name: 'Approve', x: 0, y: 0, inputs: [],
        prompt: 'Ship?', requiredGates: ['qa', 'security'], allowBypass: false
      }
    ],
    edges: [
      { id: 'e1', from: 'implement', to: 'qa', on: 'success', required: true },
      { id: 'e2', from: 'implement', to: 'security', on: 'success', required: true },
      { id: 'e3', from: 'qa', to: 'gates', on: 'success', required: true },
      { id: 'e4', from: 'security', to: 'gates', on: 'success', required: true },
      { id: 'e5', from: 'gates', to: 'approve', on: 'success', required: true }
    ]
  };
}

/** Two mutating stages fanning out from one entry — the contention case. */
function twoWritersDefinition(): WorkflowDefinition {
  const base = definition();
  base.nodes.push({
    type: 'agent-task', id: 'refactor', name: 'Refactor', x: 0, y: 0, inputs: ['change-diff'],
    agent: { agentId: 'coder', scope: 'global', toolMode: 'full' },
    instructions: 'Tidy.', outputs: [], mutatesWorktree: true
  });
  base.edges.push({ id: 'e6', from: 'implement', to: 'refactor', on: 'success', required: false });
  return base;
}

function seed(runs: WorkflowRunPersistence, def = definition()): WorkflowRun {
  const run = createWorkflowRun({ runId: 'run-1', projectId: 'p1', definition: def, at: now() });
  void runs.save(run);
  return run;
}

/** Artifacts matching a node's declared outputs, so success is not refused. */
function outputsFor(def: WorkflowDefinition, nodeId: string): StageOutcome['artifacts'] {
  const node = def.nodes.find(candidate => candidate.id === nodeId);
  return node && 'outputs' in node ? node.outputs.map(o => ({ contractId: o.id, kind: o.kind })) : [];
}

// ── Dispatch ─────────────────────────────────────────────────────────────

test('the entry stage is dispatched and recorded running before it starts', async () => {
  const runs = memoryRuns();
  const def = definition();
  seed(runs, def);
  const fake = fakeDispatcher();
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher: fake.dispatcher, now });

  await orchestrator.step('run-1');
  await settleAll();

  assert.deepEqual(fake.started, ['implement']);
  // Persist-before-launch: the record already says running.
  assert.equal(runs.get('run-1')?.nodes.implement.outcome, 'running');
});

test('a stage is never dispatched twice, however often the loop is entered', async () => {
  const runs = memoryRuns();
  seed(runs);
  const fake = fakeDispatcher();
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher: fake.dispatcher, now });

  await Promise.all([orchestrator.step('run-1'), orchestrator.step('run-1'), orchestrator.step('run-1')]);
  await settleAll();

  assert.deepEqual(fake.started, ['implement']);
  assert.deepEqual(orchestrator.inFlightStages(), ['run-1:implement']);
});

test('read-only checks fan out together once the writer settles', async () => {
  const runs = memoryRuns();
  const def = definition();
  seed(runs, def);
  const fake = fakeDispatcher();
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher: fake.dispatcher, now });

  await orchestrator.step('run-1');
  await settleAll();
  fake.finish('implement', { status: 'succeeded', artifacts: outputsFor(def, 'implement'), snapshotRef: 'sha-1' });
  await settleAll();

  assert.deepEqual(fake.started, ['implement', 'qa', 'security']);
});

test('two mutating stages never run at once; the second goes after the first settles', async () => {
  const runs = memoryRuns();
  const def = twoWritersDefinition();
  seed(runs, def);
  const fake = fakeDispatcher();
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher: fake.dispatcher, now });

  await orchestrator.step('run-1');
  await settleAll();
  fake.finish('implement', { status: 'succeeded', artifacts: outputsFor(def, 'implement'), snapshotRef: 'sha-1' });
  await settleAll();

  // qa and security are read-only, refactor is the queued writer.
  assert.equal(fake.started.filter(id => id === 'refactor').length, 1);
  const running = Object.values(runs.get('run-1')!.nodes).filter(state => state.outcome === 'running');
  const writers = running.filter(state => state.nodeId === 'refactor' || state.nodeId === 'implement');
  assert.equal(writers.length, 1, 'only one writer is ever running');
});

// ── Outcomes ─────────────────────────────────────────────────────────────

test('a run of checks reaches awaiting-approval with no manual advancement', async () => {
  const runs = memoryRuns();
  const def = definition();
  seed(runs, def);
  const fake = fakeDispatcher(nodeId => ({
    status: 'succeeded',
    artifacts: outputsFor(def, nodeId),
    ...(nodeId === 'implement' ? { snapshotRef: 'sha-1' } : {})
  }));
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher: fake.dispatcher, now });

  await orchestrator.step('run-1');
  await settleAll();

  const run = runs.get('run-1')!;
  assert.deepEqual(fake.started, ['implement', 'qa', 'security']);
  assert.equal(run.nodes.gates.outcome, 'succeeded', 'the join converged on its own');
  assert.equal(run.nodes.approve.outcome, 'pending', 'approval waits for a person');
});

test('a failing check records its exit code and stops the branch', async () => {
  const runs = memoryRuns();
  const def = definition();
  seed(runs, def);
  const fake = fakeDispatcher();
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher: fake.dispatcher, now });

  await orchestrator.step('run-1');
  await settleAll();
  fake.finish('implement', { status: 'succeeded', artifacts: outputsFor(def, 'implement'), snapshotRef: 'sha-1' });
  await settleAll();
  fake.finish('qa', { status: 'failed', error: 'tests failed', exitCode: 1 });
  fake.finish('security', { status: 'succeeded', artifacts: outputsFor(def, 'security') });
  await settleAll();

  const run = runs.get('run-1')!;
  assert.equal(run.nodes.qa.outcome, 'failed');
  assert.equal(run.nodes.qa.attempts[0].exitCode, 1);
  assert.equal(run.status, 'failed', 'a required check with no attempts left sinks the run');
});

test('a dispatcher that throws fails the stage rather than wedging the run', async () => {
  const runs = memoryRuns();
  seed(runs);
  const dispatcher: StageDispatcher = {
    runCheck: async () => {
      throw new Error('spawn ENOENT');
    },
    runAgentStage: async () => {
      throw new Error('no host');
    }
  };
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher, now });

  await orchestrator.step('run-1');
  await settleAll();

  const run = runs.get('run-1')!;
  assert.equal(run.nodes.implement.outcome, 'failed');
  assert.match(run.nodes.implement.attempts[0].error ?? '', /no host/);
  assert.deepEqual(orchestrator.inFlightStages(), [], 'the in-flight claim is released');
});

test('an agent stage records the session id its dispatcher reports', async () => {
  const runs = memoryRuns();
  const def = definition();
  seed(runs, def);
  const fake = fakeDispatcher();
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher: fake.dispatcher, now });

  await orchestrator.step('run-1');
  await settleAll();

  assert.equal(runs.get('run-1')?.nodes.implement.attempts[0].sessionId, 'session-implement');
});

test('a successful stage carries its snapshot ref onto the run', async () => {
  const runs = memoryRuns();
  const def = definition();
  seed(runs, def);
  const fake = fakeDispatcher();
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher: fake.dispatcher, now });

  await orchestrator.step('run-1');
  await settleAll();
  fake.finish('implement', { status: 'succeeded', artifacts: outputsFor(def, 'implement'), snapshotRef: 'sha-abc' });
  await settleAll();

  assert.equal(runs.get('run-1')?.nodes.implement.snapshotRef, 'sha-abc');
});

// ── Worktree ─────────────────────────────────────────────────────────────

function fakeWorkspace() {
  const acquired: string[] = [];
  const released: string[] = [];
  const provider: WorkflowWorkspaceProvider = {
    async acquire(run) {
      acquired.push(run.runId);
      return `/tmp/worktrees/${run.runId}`;
    },
    async release(run) {
      released.push(run.runId);
    }
  };
  return { provider, acquired, released };
}

test('the run worktree is acquired once and handed to every stage', async () => {
  const runs = memoryRuns();
  const def = definition();
  seed(runs, def);
  const fake = fakeDispatcher(nodeId => ({
    status: 'succeeded',
    artifacts: outputsFor(def, nodeId),
    ...(nodeId === 'implement' ? { snapshotRef: 'sha-1' } : {})
  }));
  const workspace = fakeWorkspace();
  const orchestrator = new WorkflowOrchestrator({
    runs,
    dispatcher: fake.dispatcher,
    workspace: workspace.provider,
    now
  });

  await orchestrator.step('run-1');
  await settleAll();

  assert.deepEqual(workspace.acquired, ['run-1'], 'acquired exactly once');
  assert.deepEqual(fake.worktrees, ['/tmp/worktrees/run-1', '/tmp/worktrees/run-1', '/tmp/worktrees/run-1']);
  assert.equal(runs.get('run-1')?.worktreePath, '/tmp/worktrees/run-1');
});

test('a settled run releases its worktree and clears the path', async () => {
  const runs = memoryRuns();
  const def = definition();
  // One attempt only, so the failure is final and the run settles.
  const implement = def.nodes.find(node => node.id === 'implement');
  if (implement?.type === 'agent-task') implement.maxAttempts = 1;
  seed(runs, def);
  const fake = fakeDispatcher(() => ({ status: 'failed', error: 'nope' }));
  const workspace = fakeWorkspace();
  const orchestrator = new WorkflowOrchestrator({
    runs,
    dispatcher: fake.dispatcher,
    workspace: workspace.provider,
    now
  });

  await orchestrator.step('run-1');
  await settleAll();
  assert.equal(runs.get('run-1')?.status, 'failed');

  // The next step sees a settled run and tears the worktree down.
  await orchestrator.step('run-1');
  await settleAll();
  assert.deepEqual(workspace.released, ['run-1']);
  assert.equal(runs.get('run-1')?.worktreePath, undefined);
});

test('a failed stage inside its attempt budget keeps the run alive and is not retried automatically', async () => {
  const runs = memoryRuns();
  const def = definition(); // implement has maxAttempts 2
  seed(runs, def);
  const fake = fakeDispatcher(() => ({ status: 'failed', error: 'flaky' }));
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher: fake.dispatcher, now });

  await orchestrator.step('run-1');
  await settleAll();
  await orchestrator.step('run-1');
  await settleAll();

  const run = runs.get('run-1')!;
  assert.equal(run.status, 'running', 'a retryable failure does not sink the run');
  assert.equal(run.nodes.implement.attempts.length, 1, 'retry is a user decision, not the loop’s');
  assert.deepEqual(fake.started, ['implement']);
});

test('a run that dispatches nothing never branches a worktree', async () => {
  const runs = memoryRuns();
  const run = seed(runs);
  void runs.save({ ...run, status: 'cancelled', endedAt: now() });
  const fake = fakeDispatcher();
  const workspace = fakeWorkspace();
  const orchestrator = new WorkflowOrchestrator({
    runs,
    dispatcher: fake.dispatcher,
    workspace: workspace.provider,
    now
  });

  await orchestrator.step('run-1');
  await settleAll();

  assert.deepEqual(workspace.acquired, []);
  assert.deepEqual(fake.started, []);
});

// ── Timeouts ─────────────────────────────────────────────────────────────

test('a stage past its timeout is cancelled and recorded', async () => {
  const runs = memoryRuns();
  const def = definition();
  // The fake clock advances a minute per read, so a 30s budget is already spent
  // by the time the tick looks.
  const implement = def.nodes.find(node => node.id === 'implement');
  if (implement?.type === 'agent-task') implement.timeoutMs = 30_000;
  seed(runs, def);
  const fake = fakeDispatcher();
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher: fake.dispatcher, now });

  await orchestrator.step('run-1');
  await settleAll();
  // `now` advances a minute per call, so the next read is past the timeout.
  await orchestrator.enforceTimeouts('run-1');
  await settleAll();

  assert.deepEqual(fake.cancelled, ['implement']);
  const run = runs.get('run-1')!;
  assert.equal(run.nodes.implement.outcome, 'failed');
  assert.ok(run.events.some(event => event.kind === 'node-timed-out'));
});

test('enforceTimeouts is a no-op for a settled run', async () => {
  const runs = memoryRuns();
  const run = seed(runs);
  void runs.save({ ...run, status: 'cancelled', endedAt: now() });
  const fake = fakeDispatcher();
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher: fake.dispatcher, now });

  await orchestrator.enforceTimeouts('run-1');
  await settleAll();
  assert.deepEqual(fake.cancelled, []);
});

// ── Recovery ─────────────────────────────────────────────────────────────

test('an interrupted stage is not re-dispatched by the loop; it waits for a retry', async () => {
  const runs = memoryRuns();
  const def = definition();
  const run = seed(runs, def);
  // Simulate what recovery leaves behind: the attempt closed as failed.
  void runs.save({
    ...run,
    nodes: {
      ...run.nodes,
      implement: {
        nodeId: 'implement',
        outcome: 'failed',
        attempts: [{ attempt: 1, outcome: 'failed', startedAt: now(), endedAt: now(), error: 'Interrupted' }],
        artifacts: []
      }
    }
  });

  const fake = fakeDispatcher();
  const orchestrator = new WorkflowOrchestrator({ runs, dispatcher: fake.dispatcher, now });
  await orchestrator.step('run-1');
  await settleAll();

  assert.deepEqual(fake.started, [], 'a failed stage is not silently restarted');
  assert.equal(runs.get('run-1')?.nodes.implement.attempts.length, 1, 'and its history is untouched');
});

test('every transition notifies the run-changed listener', async () => {
  const runs = memoryRuns();
  const def = definition();
  seed(runs, def);
  const fake = fakeDispatcher(nodeId => ({ status: 'succeeded', artifacts: outputsFor(def, nodeId) }));
  const changes: string[] = [];
  const orchestrator = new WorkflowOrchestrator({
    runs,
    dispatcher: fake.dispatcher,
    now,
    onRunChanged: run => changes.push(run.runId)
  });

  await orchestrator.step('run-1');
  await settleAll();

  assert.ok(changes.length >= 4, `expected several notifications, got ${changes.length}`);
  assert.ok(changes.every(id => id === 'run-1'));
});
