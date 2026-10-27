import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_SCHEDULED_CONCURRENCY,
  armScheduledRun,
  composeScheduledRun,
  createScheduledRun,
  scheduledConcurrency,
  scheduledPolicyFor,
  type ScheduledRun
} from './scheduledRun';
import { decideExtraLane, LANE_ALLOWANCE_RESERVE } from './scheduledBudget';
import { ExclusiveResources } from './exclusiveResource';
import { freeScheduledLane, launchableEntries } from './scheduledRunExecution';
import { ScheduledLaunchError, ScheduledRunRunner, type ProviderUsageReading, type ScheduledRunnerPorts, type WorkflowObservation } from './scheduledRunRunner';
import { normalizeScheduledRun } from './scheduledRunStore';
import { assessScheduledRunReadiness } from './scheduledRunReadiness';

/*
 * Bounded parallel lanes (FX-BE-149 / TASK-387). Steps come from `withPrevious`:
 * `[['A', 'B'], ['C']]` is A and B sharing step 1, then C.
 */

const CREATED = '2026-10-20T10:00:00.000Z';
const START = '2026-10-20T12:00:00.000Z';

class Harness {
  public clock = Date.parse('2026-10-20T12:00:01.000Z');
  public saved = new Map<string, ScheduledRun>();
  public workflows = new Map<string, WorkflowObservation | undefined>();
  public byToken = new Map<string, string>();
  public launches: Array<{ key: string; provider?: string }> = [];
  public cancelled: string[] = [];
  public failLaunchFor = new Map<string, Error>();
  public usage: ProviderUsageReading = { usable: ['claude', 'codex'], active: 'claude', used: { claude: 0.1, codex: 0.1 } };
  private counter = 0;

  public ports: ScheduledRunnerPorts = {
    store: {
      list: () => [...this.saved.values()],
      get: id => this.saved.get(id),
      save: async run => {
        const stored = normalizeScheduledRun(JSON.parse(JSON.stringify(run)))!;
        this.saved.set(run.id, stored);
        return stored;
      }
    },
    now: () => new Date(this.clock).toISOString(),
    isEnabled: () => true,
    newToken: () => `token-${++this.counter}`,
    observe: id => this.workflows.get(id),
    findByLaunchToken: token => this.byToken.get(token),
    checkTicket: async () => undefined,
    launch: async ({ entry, token, provider }) => {
      const failure = this.failLaunchFor.get(entry.ticket.issueKey);
      if (failure) throw failure;
      const id = `wf-${entry.ticket.issueKey}`;
      this.launches.push({ key: entry.ticket.issueKey, provider });
      this.byToken.set(token, id);
      this.workflows.set(id, { progress: { kind: 'running', provider } });
      return id;
    },
    cancelWorkflow: async id => { this.cancelled.push(id); },
    usage: async () => this.usage,
    handOver: async () => ({}),
    approveGate: async () => undefined
  };

  public runner = new ScheduledRunRunner(this.ports);

  public constructor(steps: string[][], maxConcurrency = 2) {
    const tickets = steps.flat().map(key => ({ connectionId: 'c', issueKey: key, title: key }));
    const withPrevious = steps.flatMap(step => step.slice(1).map(key => `c\u0000${key}`));
    const draft = createScheduledRun({ name: 'Night', scheduledStartAt: START, timezone: 'UTC', at: CREATED, workflowId: 'governed', tickets, withPrevious, maxConcurrency });
    this.saved.set(draft.id, armScheduledRun(draft, CREATED));
  }

  public get run(): ScheduledRun { return [...this.saved.values()][0]; }
  public entry(key: string) { return this.run.entries.find(entry => entry.ticket.issueKey === key); }
  public status(key: string) { return this.entry(key)?.outcome?.status; }
  public set(key: string, observation: WorkflowObservation | undefined) { this.workflows.set(`wf-${key}`, observation); }
  public running(): string[] { return this.run.entries.filter(entry => entry.outcome?.status === 'running').map(entry => entry.ticket.issueKey); }
  public events(kind: string) { return this.run.events.filter(event => event.kind === kind); }
}

// ── policy ────────────────────────────────────────────────────────────────

test('a run is sequential unless a concurrency above one is chosen, and bad values are refused before anything runs', () => {
  assert.deepEqual(scheduledPolicyFor(undefined, 'wf'), { mode: 'sequential', workflowId: 'wf' });
  assert.deepEqual(scheduledPolicyFor(1, 'wf'), { mode: 'sequential', workflowId: 'wf' });
  assert.deepEqual(scheduledPolicyFor(3, 'wf'), { mode: 'parallel', maxConcurrency: 3, workflowId: 'wf' });
  for (const bad of [0, -1, 1.5, Number.NaN, MAX_SCHEDULED_CONCURRENCY + 1]) {
    assert.throws(() => scheduledPolicyFor(bad, 'wf'), /whole number from 1 to/);
  }
  const form = { name: 'Night', date: '2026-10-21', time: '22:00', timezone: 'UTC', arm: false, at: CREATED, tickets: [{ connectionId: 'c', issueKey: 'A', title: 'A' }] };
  assert.equal(composeScheduledRun(undefined, form).policy.mode, 'sequential');
  assert.throws(() => composeScheduledRun(undefined, { ...form, maxConcurrency: 9 }), /whole number/);
  const parallel = composeScheduledRun(undefined, { ...form, maxConcurrency: 2 });
  assert.deepEqual(parallel.policy, { mode: 'parallel', maxConcurrency: 2 });
  const back = composeScheduledRun(parallel, { ...form, maxConcurrency: 1 });
  assert.equal(back.policy.mode, 'sequential');
  assert.match(back.events.at(-1)?.message ?? '', /one at a time/);
});

test('a stored parallel policy survives a reload, and an impossible one falls back to sequential', () => {
  const run = createScheduledRun({ name: 'N', scheduledStartAt: START, timezone: 'UTC', at: CREATED, maxConcurrency: 3, tickets: [] });
  assert.equal(scheduledConcurrency(normalizeScheduledRun(JSON.parse(JSON.stringify(run)))!.policy), 3);
  const tampered = { ...JSON.parse(JSON.stringify(run)), policy: { mode: 'parallel', maxConcurrency: 50 } };
  assert.deepEqual(normalizeScheduledRun(tampered)!.policy, { mode: 'sequential' });
});

// ── dispatch ──────────────────────────────────────────────────────────────

test('sequential stays one at a time even when tickets share a step', async () => {
  const h = new Harness([['A', 'B'], ['C']], 1);
  await h.runner.tick();
  assert.deepEqual(h.launches.map(launch => launch.key), ['A']);
  h.set('A', { progress: { kind: 'succeeded' } });
  await h.runner.tick();
  assert.deepEqual(h.launches.map(launch => launch.key), ['A', 'B']);
});

test('tickets of one step fill lanes up to the cap, each with its lane and the reason it may run now', async () => {
  const h = new Harness([['A', 'B', 'C']], 2);
  await h.runner.tick();
  assert.deepEqual(h.running(), ['A', 'B']);
  assert.equal(h.status('C'), undefined);
  assert.deepEqual([h.entry('A')?.outcome?.lane, h.entry('B')?.outcome?.lane], [1, 2]);
  assert.match(h.entry('A')?.outcome?.laneReason ?? '', /first ticket going in step 1/);
  assert.match(h.entry('B')?.outcome?.laneReason ?? '', /runs alongside A; tickets in step 1 do not depend on each other/);
  assert.ok(h.events('entry-launching').some(event => /in lane 2/.test(event.message)));

  // The cap holds across repeated dispatches.
  for (let i = 0; i < 3; i += 1) await h.runner.tick();
  assert.equal(h.launches.length, 2);

  // A lane frees up: C takes lane 1, the one A left.
  h.set('A', { progress: { kind: 'succeeded' } });
  await h.runner.tick();
  assert.deepEqual(h.running(), ['B', 'C']);
  assert.equal(h.entry('C')?.outcome?.lane, 1);
});

test('a step waits for every ticket before it, even with a lane free', async () => {
  const h = new Harness([['A', 'B'], ['C']], 3);
  await h.runner.tick();
  assert.deepEqual(h.running(), ['A', 'B']);
  h.set('A', { progress: { kind: 'succeeded' } });
  await h.runner.tick();
  assert.equal(h.status('C'), undefined, 'C depends on all of step 1');
  h.set('B', { progress: { kind: 'succeeded' } });
  await h.runner.tick();
  assert.deepEqual(h.running(), ['C']);
});

test('a failed ticket blocks every further launch, while its neighbour keeps running and is still watched', async () => {
  const h = new Harness([['A', 'B'], ['C']], 2);
  await h.runner.tick();
  h.set('A', { progress: { kind: 'failed', reason: 'tests failed' } });
  await h.runner.tick();
  assert.equal(h.run.status, 'paused');
  assert.equal(h.run.pause?.reason, 'failure');
  assert.equal(h.status('B'), 'running');
  h.set('B', { progress: { kind: 'succeeded' } });
  await h.runner.tick();
  assert.equal(h.status('B'), 'done');
  assert.equal(h.status('C'), undefined);
  assert.equal(h.run.pause?.entryId, h.entry('A')?.id, 'still paused for the failure');
});

test('a gate pauses new launches; settling one waiting ticket moves the pause to another that still needs a person', async () => {
  const h = new Harness([['A', 'B'], ['C']], 2);
  await h.runner.tick();
  h.set('A', { progress: { kind: 'gate', nodeId: 'review', label: 'Review' } });
  await h.runner.tick();
  assert.equal(h.run.pause?.reason, 'approval');
  h.set('B', { progress: { kind: 'failed', reason: 'lint' } });
  await h.runner.tick();
  assert.equal(h.run.pause?.reason, 'failure');
  // A is approved and runs on; the run stays paused, now for B's failure, and nothing new starts.
  h.set('A', { progress: { kind: 'running', provider: 'claude' } });
  await h.runner.tick();
  assert.equal(h.status('A'), 'running');
  assert.equal(h.run.status, 'paused');
  assert.equal(h.run.pause?.entryId, h.entry('B')?.id);
  assert.equal(h.status('C'), undefined);
});

test('retrying one failure while another is still failed leaves the run paused for the other', async () => {
  const h = new Harness([['A', 'B']], 2);
  await h.runner.tick();
  h.set('A', { progress: { kind: 'failed', reason: 'one' } });
  h.set('B', { progress: { kind: 'failed', reason: 'two' } });
  await h.runner.tick();
  await h.runner.retryEntry(h.run.id, h.entry('B')!.id);
  assert.equal(h.run.status, 'paused');
  assert.equal(h.run.pause?.entryId, h.entry('A')?.id);
  assert.equal(h.status('B'), 'queued');
});

// ── allowance ─────────────────────────────────────────────────────────────

test('an extra lane needs room for every ticket on that provider; short of it the run uses fewer lanes and says why once', async () => {
  // 95% hand-over point: 80% used leaves 15%, enough for one ticket at 10% but not two.
  const h = new Harness([['A', 'B']], 2);
  h.usage = { usable: ['claude'], active: 'claude', used: { claude: 0.8 } };
  await h.runner.tick();
  assert.deepEqual(h.running(), ['A']);
  assert.equal(h.run.status, 'running', 'a held lane is not a pause');
  for (let i = 0; i < 3; i += 1) await h.runner.tick();
  const held = h.events('budget-checked').filter(event => /waits for a free lane/.test(event.message));
  assert.equal(held.length, 1, 'recorded once, not every tick');
  assert.match(held[0].message, /not enough for 2 tickets/);
  // A finishes: B is now the only ticket going and starts.
  h.set('A', { progress: { kind: 'succeeded' } });
  await h.runner.tick();
  assert.deepEqual(h.running(), ['B']);
});

test('a provider that does not report its allowance never gets an extra lane', async () => {
  const h = new Harness([['A', 'B']], 2);
  h.usage = { usable: ['claude'], active: 'claude', used: { claude: undefined } };
  await h.runner.tick();
  assert.deepEqual(h.running(), ['A']);
  assert.ok(h.events('budget-checked').some(event => /does not report its allowance/.test(event.message)));
});

test('the allowance check counts the tickets already running', () => {
  // 70% used, 25% left: two tickets (20%) fit, three (30%) do not.
  assert.equal(decideExtraLane({ provider: 'claude', used: 0.7, alongside: 1 }).ok, true);
  assert.equal(decideExtraLane({ provider: 'claude', used: 0.7, alongside: 2 }).ok, false);
  assert.equal(LANE_ALLOWANCE_RESERVE, 0.1);
});

test('an extra lane is judged on the provider it would start on, counting only the tickets on that provider', async () => {
  const h = new Harness([['A', 'B', 'C']], 2);
  await h.runner.tick();
  // B moved to Codex; Claude is now past its hand-over point.
  h.set('B', { progress: { kind: 'running', provider: 'codex' } });
  h.set('A', { progress: { kind: 'succeeded' } });
  h.usage = { usable: ['claude', 'codex'], active: 'claude', used: { claude: 0.97, codex: 0.5 } };
  await h.runner.tick();
  assert.equal(h.status('C'), 'running');
  assert.equal(h.entry('C')?.outcome?.provider, 'codex');
  assert.match(h.entry('C')?.outcome?.laneReason ?? '', /runs alongside B; .*codex has used 50%.*room for 2 tickets/);
});

// ── launch problems, stop, lanes ──────────────────────────────────────────

test('a lane that cannot launch pauses the run with the reason, and the ticket already running is untouched', async () => {
  const h = new Harness([['A', 'B']], 2);
  h.failLaunchFor.set('B', new ScheduledLaunchError('needs workspace trust', 'trust'));
  await h.runner.tick();
  assert.equal(h.status('A'), 'running');
  assert.equal(h.status('B'), 'queued');
  assert.equal(h.run.pause?.reason, 'trust');
  assert.match(h.run.pause?.message ?? '', /B could not be started: needs workspace trust/);
});

test('stopping a parallel run stops every ticket in flight', async () => {
  const h = new Harness([['A', 'B', 'C']], 3);
  await h.runner.tick();
  await h.runner.cancel(h.run.id);
  assert.deepEqual(h.cancelled.sort(), ['wf-A', 'wf-B', 'wf-C']);
  assert.equal(h.run.status, 'cancelled');
});

test('lane numbers reuse the lowest free lane', () => {
  const run = createScheduledRun({ name: 'N', scheduledStartAt: START, timezone: 'UTC', at: CREATED, maxConcurrency: 3, tickets: ['A', 'B', 'C'].map(key => ({ connectionId: 'c', issueKey: key, title: key })) });
  const at = (lanes: Array<number | undefined>): ScheduledRun => ({ ...run, entries: run.entries.map((entry, index) => lanes[index] === undefined ? entry : { ...entry, outcome: { status: 'running', lane: lanes[index] } }) });
  assert.equal(freeScheduledLane(at([undefined, undefined, undefined])), 1);
  assert.equal(freeScheduledLane(at([2, undefined, undefined])), 1);
  assert.equal(freeScheduledLane(at([1, 3, undefined])), 2);
  assert.deepEqual(launchableEntries({ ...run, status: 'draft' }), []);
});

// ── exclusive resources ───────────────────────────────────────────────────

test('work on one exclusive resource never overlaps; different resources run side by side', async () => {
  const locks = new ExclusiveResources();
  const log: string[] = [];
  let releaseFirst!: () => void;
  const first = locks.with('repo-a', async () => { log.push('a1 start'); await new Promise<void>(resolve => { releaseFirst = resolve; }); log.push('a1 end'); });
  const second = locks.with('repo-a', async () => { log.push('a2 start'); log.push('a2 end'); });
  const other = locks.with('repo-b', async () => { log.push('b start'); });
  await other;
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(log, ['a1 start', 'b start'], 'repo-b did not wait; a2 is held behind a1');
  assert.equal(locks.busy('repo-a'), true);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(log, ['a1 start', 'b start', 'a1 end', 'a2 start', 'a2 end']);
  assert.equal(locks.busy('repo-a'), false);
  // A holder that throws still lets the next one in.
  await assert.rejects(locks.with('repo-a', async () => { throw new Error('merge failed'); }), /merge failed/);
  assert.equal(await locks.with('repo-a', async () => 'next'), 'next');
});

test('a parallel run carries a budget warning in its readiness, and says so when no step is shared', () => {
  const context = { now: CREATED, probe: () => ({ state: 'found' as const, hasFolder: true, hasWorkflow: true, hasAcceptanceCriteria: true }), usableProviderCount: 1 };
  const parallel = (steps: string[][], max: number) => new Harness(steps, max).run;
  const warning = (run: ScheduledRun) => assessScheduledRunReadiness(run, context).issues.find(issue => issue.code === 'parallel-lanes');
  assert.equal(warning(parallel([['A', 'B']], 1)), undefined);
  assert.match(warning(parallel([['A', 'B']], 2))?.message ?? '', /Up to 2 tickets of a shared step run at once, using allowance up to 2 times as fast/);
  assert.equal(warning(parallel([['A', 'B']], 2))?.severity, 'warning');
  assert.match(warning(parallel([['A'], ['B']], 3))?.message ?? '', /no step is shared/);
});
