import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  armScheduledRun,
  createScheduledRun,
  resolveMissedScheduledRun,
  reconcileScheduledRunOnLaunch,
  type ScheduledRun
} from './scheduledRun';
import { ScheduledLaunchError, ScheduledRunRunner, scheduledWorkflowBlocker, type ProviderUsageReading, type ScheduledRunnerPorts, type WorkflowObservation } from './scheduledRunRunner';
import { nextLaunchableEntry } from './scheduledRunExecution';
import { normalizeScheduledRun } from './scheduledRunStore';

const CREATED = '2026-10-20T10:00:00.000Z';
const START = '2026-10-20T12:00:00.000Z';

class Harness {
  public clock = Date.parse('2026-10-20T12:00:01.000Z');
  public saved = new Map<string, ScheduledRun>();
  public workflows = new Map<string, WorkflowObservation | undefined>();
  public byToken = new Map<string, string>();
  public launches: Array<{ key: string; provider?: string; token: string }> = [];
  public cancelled: string[] = [];
  public handovers: Array<{ from: string; to: string }> = [];
  public missingTickets = new Map<string, string>();
  public failLaunch: Error | undefined;
  public launchBeforeFailing = false;
  public usage: ProviderUsageReading = { usable: ['claude', 'codex'], active: 'claude', used: { claude: 0.1, codex: 0.1 } };
  public enabled = true;
  private counter = 0;

  public ports: ScheduledRunnerPorts = {
    store: {
      list: () => [...this.saved.values()],
      get: id => this.saved.get(id),
      save: async run => {
        // Round-trip through the normaliser like the real store, so a field the store drops shows up here.
        const stored = normalizeScheduledRun(JSON.parse(JSON.stringify(run)))!;
        this.saved.set(run.id, stored);
        return stored;
      }
    },
    now: () => new Date(this.clock).toISOString(),
    isEnabled: () => this.enabled,
    newToken: () => `token-${++this.counter}`,
    observe: id => this.workflows.get(id),
    findByLaunchToken: token => this.byToken.get(token),
    checkTicket: async ticket => this.missingTickets.get(ticket.issueKey),
    launch: async ({ entry, token, provider }) => {
      if (this.failLaunch && !this.launchBeforeFailing) throw this.failLaunch;
      const id = `wf-${entry.ticket.issueKey}`;
      this.launches.push({ key: entry.ticket.issueKey, provider, token });
      this.byToken.set(token, id);
      this.workflows.set(id, { progress: { kind: 'running', provider } });
      if (this.failLaunch) throw this.failLaunch;
      return id;
    },
    cancelWorkflow: async id => {
      this.cancelled.push(id);
    },
    usage: async () => this.usage,
    handOver: async ({ from, to }) => {
      this.handovers.push({ from, to });
      return { checkpointRef: 'abc1234' };
    }
  };

  public runner = new ScheduledRunRunner(this.ports);

  public constructor(keys: string[] = ['T-1', 'T-2', 'T-3'], workflowId: string | null = 'governed') {
    const draft = createScheduledRun({
      name: 'Night', scheduledStartAt: START, timezone: 'UTC', at: CREATED, workflowId: workflowId ?? undefined,
      tickets: keys.map(key => ({ connectionId: 'c', issueKey: key, title: key }))
    });
    this.saved.set(draft.id, armScheduledRun(draft, CREATED));
  }

  public get run(): ScheduledRun {
    return [...this.saved.values()][0];
  }

  public status(key: string): string | undefined {
    return this.run.entries.find(entry => entry.ticket.issueKey === key)?.outcome?.status;
  }

  public setWorkflow(key: string, observation: WorkflowObservation | undefined): void {
    this.workflows.set(`wf-${key}`, observation);
  }
}

test('a due run starts once and launches only the first ticket', async () => {
  const h = new Harness();
  await h.runner.tick();
  assert.equal(h.run.status, 'running');
  assert.equal(h.run.attempts.length, 1);
  assert.deepEqual(h.launches.map(launch => launch.key), ['T-1']);
  await h.runner.tick();
  assert.equal(h.run.attempts.length, 1);
  assert.equal(h.launches.length, 1);
});

test('a run that is not yet due does not start', async () => {
  const h = new Harness();
  h.clock = Date.parse('2026-10-20T11:00:00.000Z');
  await h.runner.tick();
  assert.equal(h.run.status, 'scheduled');
  assert.equal(h.launches.length, 0);
});

test('a missed run never starts until the user starts it', async () => {
  const h = new Harness();
  h.saved.set(h.run.id, reconcileScheduledRunOnLaunch(h.run, new Date(h.clock).toISOString()));
  assert.equal(h.run.status, 'missed');
  await h.runner.tick();
  assert.equal(h.launches.length, 0);
  h.saved.set(h.run.id, resolveMissedScheduledRun(h.run, 'start-now', new Date(h.clock).toISOString()));
  await h.runner.tick();
  assert.equal(h.run.attempts[0].trigger, 'start-now');
  assert.equal(h.launches.length, 1);
});

test('tickets run in order, each waiting for the one before to settle', async () => {
  const h = new Harness();
  await h.runner.tick();
  await h.runner.tick();
  assert.deepEqual(h.launches.map(launch => launch.key), ['T-1']);
  h.setWorkflow('T-1', { progress: { kind: 'succeeded' } });
  await h.runner.tick();
  assert.equal(h.status('T-1'), 'done');
  assert.deepEqual(h.launches.map(launch => launch.key), ['T-1', 'T-2']);
  h.setWorkflow('T-2', { progress: { kind: 'succeeded' } });
  await h.runner.tick();
  h.setWorkflow('T-3', { progress: { kind: 'succeeded' } });
  await h.runner.tick();
  assert.equal(h.run.status, 'completed');
  assert.deepEqual(h.launches.map(launch => launch.key), ['T-1', 'T-2', 'T-3']);
  assert.ok(h.run.attempts[0].endedAt);
});

test('a gate pauses the run, and it carries on by itself once the gate clears', async () => {
  const h = new Harness(['T-1', 'T-2']);
  await h.runner.tick();
  h.setWorkflow('T-1', { progress: { kind: 'gate', nodeId: 'review', label: 'Review sign-off' } });
  await h.runner.tick();
  assert.equal(h.run.status, 'paused');
  assert.equal(h.run.pause?.reason, 'approval');
  assert.equal(h.run.entries[0].outcome?.gate?.label, 'Review sign-off');
  await h.runner.tick();
  assert.equal(h.launches.length, 1, 'nothing launches while waiting');
  await assert.rejects(h.runner.resume(h.run.id), /approval gate/);
  h.setWorkflow('T-1', { progress: { kind: 'running', provider: 'claude' } });
  await h.runner.tick();
  assert.equal(h.run.status, 'running');
  assert.equal(h.run.entries[0].outcome?.gate, undefined);
});

test('a failure pauses and never moves on by itself; retry, skip and stop each work', async () => {
  const h = new Harness(['T-1', 'T-2']);
  await h.runner.tick();
  h.setWorkflow('T-1', { progress: { kind: 'failed', reason: 'tests failed' } });
  await h.runner.tick();
  assert.equal(h.run.status, 'paused');
  assert.equal(h.run.pause?.reason, 'failure');
  await h.runner.tick();
  assert.equal(h.launches.length, 1);
  assert.equal(nextLaunchableEntry(h.run), undefined);
  await assert.rejects(h.runner.resume(h.run.id), /Retry it, skip it, or stop/);

  await h.runner.retryEntry(h.run.id, h.run.entries[0].id);
  assert.equal(h.launches.length, 2, 'retry launches a fresh workflow run');
  assert.equal(h.run.entries[0].outcome?.retries, 1);

  h.setWorkflow('T-1', { progress: { kind: 'failed', reason: 'again' } });
  await h.runner.tick();
  await h.runner.skipEntry(h.run.id, h.run.entries[0].id);
  assert.equal(h.status('T-1'), 'skipped');
  assert.equal(h.launches.at(-1)?.key, 'T-2');

  h.setWorkflow('T-2', { progress: { kind: 'failed', reason: 'nope' } });
  await h.runner.tick();
  await h.runner.cancel(h.run.id);
  assert.equal(h.run.status, 'failed');
});

test('a crash between saving and launching never launches twice: the run is found by its token', async () => {
  const h = new Harness();
  h.failLaunch = new Error('process died');
  h.launchBeforeFailing = true; // the workflow run got created, then the process died
  await h.runner.tick();
  // Simulate the restart: the saved entry is running with a token and no workflow id.
  const restored = h.run;
  assert.equal(restored.entries[0].outcome?.workflowRunId, 'wf-T-1');
  h.failLaunch = undefined;

  const crashed = new Harness();
  const token = 'token-x';
  const base = (() => {
    const run = crashed.run;
    return { ...run, status: 'running' as const, attempts: [{ id: 'a', trigger: 'schedule' as const, startedAt: START }], entries: run.entries.map((entry, index) => (index === 0 ? { ...entry, outcome: { status: 'running' as const, launchToken: token, startedAt: START } } : entry)) };
  })();
  crashed.saved.set(base.id, base);
  crashed.byToken.set(token, 'wf-recovered');
  crashed.workflows.set('wf-recovered', { progress: { kind: 'running' } });
  await crashed.runner.recover();
  assert.equal(crashed.run.entries[0].outcome?.workflowRunId, 'wf-recovered');
  assert.equal(crashed.launches.length, 0);
});

test('a crash before the workflow run existed pauses as launch-interrupted and does not relaunch', async () => {
  const h = new Harness();
  await h.runner.tick();
  const run = h.run;
  const { workflowRunId: _gone, ...outcome } = run.entries[0].outcome!;
  h.saved.set(run.id, { ...run, entries: run.entries.map((entry, index) => (index === 0 ? { ...entry, outcome } : entry)) });
  h.byToken.clear();
  h.launches.length = 0;
  await h.runner.recover();
  assert.equal(h.run.status, 'paused');
  assert.equal(h.run.pause?.reason, 'launch-interrupted');
  await h.runner.tick();
  assert.equal(h.launches.length, 0);
  await h.runner.retryEntry(h.run.id, h.run.entries[0].id);
  assert.equal(h.launches.length, 1);
});

test('a launch that throws before creating anything pauses with its reason and requeues the ticket', async () => {
  const h = new Harness();
  h.failLaunch = new ScheduledLaunchError('This workflow needs trust.', 'trust');
  await h.runner.tick();
  assert.equal(h.run.status, 'paused');
  assert.equal(h.run.pause?.reason, 'trust');
  assert.equal(h.status('T-1'), 'queued');
  h.failLaunch = undefined;
  await h.runner.resume(h.run.id);
  assert.equal(h.launches.length, 1);
  assert.equal(h.run.status, 'running');
});

test('a deleted ticket is skipped with a readable reason and the next one starts', async () => {
  const h = new Harness();
  h.missingTickets.set('T-1', 'T-1 no longer exists.');
  await h.runner.tick();
  assert.equal(h.status('T-1'), 'skipped');
  assert.equal(h.run.entries[0].outcome?.reason, 'T-1 no longer exists.');
  assert.deepEqual(h.launches.map(launch => launch.key), ['T-2']);
});

test('a schedule with no workflow pauses instead of guessing one', async () => {
  const h = new Harness(['T-1'], null);
  await h.runner.tick();
  assert.equal(h.run.status, 'paused');
  assert.equal(h.run.pause?.reason, 'policy');
  assert.equal(h.launches.length, 0);
});

test('nothing runs while the preview is off', async () => {
  const h = new Harness();
  h.enabled = false;
  await h.runner.tick();
  assert.equal(h.run.status, 'scheduled');
  assert.equal(h.launches.length, 0);
});

test('budget: starts on a provider under 95%, switching away from one at the limit', async () => {
  const h = new Harness(['T-1']);
  h.usage = { usable: ['claude', 'codex'], active: 'claude', used: { claude: 0.96, codex: 0.2 } };
  await h.runner.tick();
  assert.equal(h.launches[0].provider, 'codex');
});

test('budget: with no provider under 95% the run pauses and launches nothing', async () => {
  const h = new Harness(['T-1']);
  h.usage = { usable: ['claude'], active: 'claude', used: { claude: 0.97 } };
  await h.runner.tick();
  assert.equal(h.run.status, 'paused');
  assert.equal(h.run.pause?.reason, 'budget');
  assert.equal(h.launches.length, 0);
});

test('mid-ticket hand-over at 95% records the brief, checkpoint and switch', async () => {
  const h = new Harness(['T-1']);
  await h.runner.tick();
  h.usage = { usable: ['claude', 'codex'], active: 'claude', used: { claude: 0.95, codex: 0.3 } };
  await h.runner.tick();
  assert.deepEqual(h.handovers, [{ from: 'claude', to: 'codex' }]);
  const handover = h.run.entries[0].outcome?.handovers?.[0];
  assert.equal(handover?.checkpointRef, 'abc1234');
  assert.equal(handover?.usedPercent, 95);
  assert.equal(h.run.entries[0].outcome?.provider, 'codex');
});

test('mid-ticket hand-over waits for the current turn to finish', async () => {
  const h = new Harness(['T-1']);
  await h.runner.tick();
  h.usage = { usable: ['claude', 'codex'], active: 'claude', used: { claude: 0.99, codex: 0.3 } };
  h.setWorkflow('T-1', { progress: { kind: 'running', provider: 'claude' }, idle: false });
  await h.runner.tick();
  assert.equal(h.handovers.length, 0);
});

test('workflow-change events that arrive mid-step are queued, not dropped', async () => {
  const h = new Harness(['T-1', 'T-2']);
  await h.runner.tick();
  h.setWorkflow('T-1', { progress: { kind: 'succeeded' } });
  await Promise.all([h.runner.handleWorkflowChanged('wf-T-1'), h.runner.handleWorkflowChanged('wf-T-1'), h.runner.tick()]);
  assert.deepEqual(h.launches.map(launch => launch.key), ['T-1', 'T-2']);
});

test('a workflow run that vanished fails its ticket for the user to decide', async () => {
  const h = new Harness(['T-1']);
  await h.runner.tick();
  h.workflows.delete('wf-T-1');
  await h.runner.tick();
  assert.equal(h.status('T-1'), 'failed');
  assert.equal(h.run.pause?.reason, 'failure');
});

test('a record saved before the runner existed loads with no runner fields', () => {
  const run = normalizeScheduledRun({
    schemaVersion: 1, id: 'r', name: 'Old', scheduledStartAt: START, timezone: 'UTC', policy: { mode: 'sequential' },
    entries: [{ id: 'e', sequence: 1, ticket: { connectionId: 'c', issueKey: 'T-1', title: 'T' } }], status: 'scheduled', attempts: [], createdAt: CREATED, updatedAt: CREATED, events: []
  })!;
  assert.equal(run.policy.workflowId, undefined);
  assert.equal(run.pause, undefined);
  assert.equal(run.entries[0].outcome, undefined);
});

test('runner fields survive the store round trip', async () => {
  const h = new Harness(['T-1']);
  await h.runner.tick();
  h.setWorkflow('T-1', { progress: { kind: 'gate', nodeId: 'n', label: 'Sign off', spend: { tokens: 10, cost: 0.5, currency: 'USD' } } });
  await h.runner.tick();
  const outcome = h.run.entries[0].outcome!;
  assert.equal(outcome.gate?.nodeId, 'n');
  assert.deepEqual(outcome.spend, { tokens: 10, cost: 0.5, currency: 'USD' });
  assert.equal(h.run.pause?.reason, 'approval');
  assert.equal(h.run.policy.workflowId, 'governed');
});


test('Run now starts a future schedule immediately and serializes repeated clicks with timer ticks', async () => {
  const h = new Harness();
  h.clock = Date.parse(CREATED);
  const results = await Promise.allSettled([h.runner.startNow(h.run.id), h.runner.startNow(h.run.id), h.runner.tick()]);
  assert.equal(results[0].status, 'fulfilled');
  assert.equal(results[1].status, 'rejected');
  assert.equal(h.run.status, 'running');
  assert.equal(h.run.attempts[0].trigger, 'start-now');
  assert.equal(h.launches.length, 1);
  assert.equal(h.run.attempts.length, 1);
});

test('Run now obeys the preview switch and provider budget gate', async () => {
  const h = new Harness();
  h.enabled = false;
  await assert.rejects(h.runner.startNow(h.run.id), /Enable scheduled runs/);
  assert.equal(h.run.status, 'scheduled');
  h.enabled = true;
  h.usage.used = { claude: 0.99, codex: 1 };
  await h.runner.startNow(h.run.id);
  assert.equal(h.run.status, 'paused');
  assert.equal(h.launches.length, 0);
});


test('a stalled failure pauses once, keeps its workflow, and resumes after stage recovery', async () => {
  const h = new Harness();
  await h.runner.tick();
  const entry = h.run.entries[0];
  const workflowRunId = entry.outcome!.workflowRunId!;
  h.workflows.set(workflowRunId, { progress: { kind: 'stalled', pauseReason: 'failure', reason: 'Implement failed: build exited 1. Retry the stage.' } });
  await h.runner.tick();
  assert.equal(h.run.status, 'paused');
  assert.equal(h.run.pause?.reason, 'failure');
  assert.equal(h.run.entries[0].outcome?.workflowRunId, workflowRunId);
  const events = h.run.events.length;
  await h.runner.tick();
  assert.equal(h.run.events.length, events, 'polling does not repeat failure events');
  h.workflows.set(workflowRunId, { progress: { kind: 'running' } });
  await h.runner.handleWorkflowChanged(workflowRunId);
  assert.equal(h.run.status, 'running');
  assert.equal(h.run.entries[0].outcome?.reason, undefined, 'recovery clears the stale error');
  assert.equal(h.launches.length, 1, 'stage recovery never launches a duplicate workflow');
});

test('only an idle failed workflow needs manual scheduled recovery', () => {
  const failed = { nodeId: 'implement', outcome: 'failed', lane: 'failed' };
  const summary = { status: 'running', stages: [failed], loops: [] } as unknown as Parameters<typeof scheduledWorkflowBlocker>[0];
  assert.equal(scheduledWorkflowBlocker(summary), failed);
  for (const lane of ['running', 'ready'] as const) {
    assert.equal(scheduledWorkflowBlocker({ ...summary, stages: [...summary.stages, { ...summary.stages[0], nodeId: 'repair', lane }] }), undefined);
  }
  assert.equal(scheduledWorkflowBlocker({ ...summary, status: 'succeeded' }), undefined);
  assert.equal(scheduledWorkflowBlocker({ ...summary, needsDecision: { edgeId: 'repair', message: 'Loop budget spent' } }), undefined);
  assert.equal(scheduledWorkflowBlocker({ ...summary, stages: [{ ...summary.stages[0], lane: 'paused' }] }), undefined);
  assert.equal(scheduledWorkflowBlocker({ ...summary, loops: [{ firing: true, needsDecision: false }] as typeof summary.loops }), undefined);
});
