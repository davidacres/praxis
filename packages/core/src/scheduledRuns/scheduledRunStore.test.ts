import { applyEntryProgress, markEntryLaunching, startScheduledRunAttempt } from './scheduledRunExecution';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KeyValueStore } from '../host/stateStore';
import { armScheduledRun, createScheduledRun, moveEntryInScheduledRun, type ScheduledRun } from './scheduledRun';
import { ScheduledRunStore, normalizeScheduledRun } from './scheduledRunStore';

function memoryStore(seed?: Record<string, unknown>): KeyValueStore & { dump(): Record<string, unknown> } {
  const values = new Map<string, unknown>(Object.entries(seed ?? {}));
  return {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      values.set(key, JSON.parse(JSON.stringify(value)));
    },
    dump: () => Object.fromEntries(values)
  };
}

const NOW = '2026-10-20T10:00:00.000Z';
const tickets = ['PRX-1', 'PRX-2', 'PRX-3'].map(issueKey => ({ connectionId: 'c1', issueKey, title: `T ${issueKey}` }));

function makeRun(name: string, start: string, id?: string): ScheduledRun {
  return createScheduledRun({ id, name, scheduledStartAt: start, timezone: 'Europe/London', tickets, at: NOW });
}

test('a saved schedule comes back with the same start, tickets and order', async () => {
  const state = memoryStore();
  const store = new ScheduledRunStore(state);
  let run = makeRun('Nightly', '2026-10-21T21:00:00Z', 'run-1');
  run = moveEntryInScheduledRun(run, run.entries[2].id, 0, NOW);
  run = armScheduledRun(run, NOW);
  await store.save(run);

  // A second store over the same state models an app restart.
  const reopened = new ScheduledRunStore(state).get('run-1');
  assert.deepEqual(reopened, run);
  assert.deepEqual(reopened?.entries.map(entry => entry.ticket.issueKey), ['PRX-3', 'PRX-1', 'PRX-2']);
  assert.equal(reopened?.scheduledStartAt, '2026-10-21T21:00:00.000Z');
  assert.equal(reopened?.timezone, 'Europe/London');
});

test('save replaces by id, list is soonest first, remove deletes', async () => {
  const store = new ScheduledRunStore(memoryStore());
  await store.save(makeRun('Later', '2026-10-23T10:00:00Z', 'b'));
  await store.save(makeRun('Sooner', '2026-10-21T10:00:00Z', 'a'));
  assert.deepEqual(store.list().map(run => run.id), ['a', 'b']);

  await store.save({ ...store.get('a')!, name: 'Renamed' });
  assert.equal(store.list().length, 2);
  assert.equal(store.get('a')?.name, 'Renamed');

  await store.remove('a');
  assert.deepEqual(store.list().map(run => run.id), ['b']);
  await assert.rejects(store.remove('a'), /was not found/);
});

test('an unusable record is dropped without hiding the others', () => {
  const good = makeRun('Good', '2026-10-21T10:00:00Z', 'good');
  const store = new ScheduledRunStore(memoryStore({ 'praxis.scheduledRuns.v1': [null, 'junk', { id: 'x' }, good, { id: 'y', name: 'y', scheduledStartAt: 'nope' }] }));
  assert.deepEqual(store.list().map(run => run.id), ['good']);
});

test('a legacy record with no schema version, bad sequences and bad entries is repaired', () => {
  const run = normalizeScheduledRun({
    id: 'old',
    name: 'Legacy',
    scheduledStartAt: '2026-10-21T21:00:00+01:00',
    timezone: 'Not/AZone',
    status: 'weird',
    entries: [
      { id: 'e3', sequence: 7, ticket: { connectionId: 'c', issueKey: 'PRX-3' } },
      { id: 'e1', sequence: 2, ticket: { connectionId: 'c', issueKey: 'PRX-1', title: 'One' } },
      { id: 'bad', ticket: { connectionId: 'c' } },
      { id: 'e2', sequence: 2, ticket: { connectionId: 'c', issueKey: 'PRX-2' } }
    ]
  });
  assert.ok(run);
  assert.equal(run.schemaVersion, 1);
  assert.equal(run.scheduledStartAt, '2026-10-21T20:00:00.000Z');
  assert.equal(run.timezone, 'UTC');
  assert.equal(run.status, 'draft');
  assert.deepEqual(run.entries.map(entry => [entry.id, entry.sequence]), [['e1', 1], ['e2', 2], ['e3', 3]]);
  assert.equal(run.entries[2].ticket.title, 'PRX-3'); // falls back to the key
  assert.deepEqual(run.attempts, []);
  assert.deepEqual(run.events, []);
});

test('runner fields survive a round trip untouched', async () => {
  const state = memoryStore();
  const store = new ScheduledRunStore(state);
  const base = makeRun('Running', '2026-10-21T10:00:00Z', 'r');
  const run: ScheduledRun = {
    ...base,
    status: 'paused',
    attempts: [{ id: 'att-1', trigger: 'start-now', startedAt: NOW }],
    entries: base.entries.map((entry, index) =>
      index === 0
        ? { ...entry, outcome: { status: 'paused', sessionId: 's1', workflowRunId: 'w1', startedAt: NOW, reason: 'Waiting at the Review gate' } }
        : entry
    )
  };
  await store.save(run);
  assert.deepEqual(new ScheduledRunStore(state).get('r'), run);
});

test('the providers that ran out survive a round trip, deduplicated', async () => {
  const state = memoryStore();
  const store = new ScheduledRunStore(state);
  const base = makeRun('Spent', '2026-10-21T10:00:00Z', 'spent');
  await store.save({
    ...base,
    status: 'running',
    entries: base.entries.map((entry, index) =>
      index === 0 ? { ...entry, outcome: { status: 'failed' as const, retries: 1, exhausted: ['claude', 'claude', 'codex'] } } : entry
    )
  });
  const stored = new ScheduledRunStore(state).get('spent')!;
  assert.deepEqual(stored.entries[0].outcome?.exhausted, ['claude', 'codex']);
  assert.equal(stored.entries[0].outcome?.retries, 1);
});

test('reconcileOnLaunch marks only overdue armed runs missed, and persists once', async () => {
  const state = memoryStore();
  const store = new ScheduledRunStore(state);
  await store.save(armScheduledRun(makeRun('Overdue', '2026-10-21T10:00:00Z', 'overdue'), NOW));
  await store.save(armScheduledRun(makeRun('Future', '2026-10-30T10:00:00Z', 'future'), NOW));
  await store.save(makeRun('Draft', '2026-10-21T10:00:00Z', 'draft'));

  const changed = await store.reconcileOnLaunch('2026-10-25T00:00:00Z');
  assert.deepEqual(changed.map(run => run.id), ['overdue']);
  assert.equal(store.get('overdue')?.status, 'missed');
  assert.equal(store.get('future')?.status, 'scheduled');
  assert.equal(store.get('draft')?.status, 'draft');

  assert.deepEqual(await store.reconcileOnLaunch('2026-10-25T00:00:00Z'), []);
});

test('the project id survives a round trip and an unset one stays unset', async () => {
  const store = new ScheduledRunStore(memoryStore());
  await store.save({ ...makeRun('Mine', '2026-10-21T10:00:00Z', 'mine'), projectId: 'p1' });
  await store.save(makeRun('Loose', '2026-10-22T10:00:00Z', 'loose'));
  assert.equal(store.get('mine')?.projectId, 'p1');
  assert.ok(!('projectId' in store.get('loose')!));
});

test('ledger estimates and artifacts survive progress and a store restart', async () => {
  let run = startScheduledRunAttempt(armScheduledRun(makeRun('Audit', '2026-10-21T21:00:00Z'), NOW), NOW);
  const entryId = run.entries[0].id;
  run = markEntryLaunching(run, entryId, 'token', 'claude', NOW);
  const estimate = { tokens: { low: 10, high: 100 }, spend: { low: 1, high: 2, currency: 'USD' }, basedOnSessions: 3 };
  const artifact = { artifactId: 'a', contractId: 'change-diff', nodeId: 'implement', runId: 'w', kind: 'diff' as const, path: '.praxis/change-diff.md', createdAt: NOW };
  run = applyEntryProgress(run, entryId, { kind: 'running', estimate, artifacts: [artifact] }, NOW);
  run = applyEntryProgress(run, entryId, { kind: 'succeeded', spend: { tokens: 50 } }, NOW);
  const state = memoryStore();
  await new ScheduledRunStore(state).save(run);
  const outcome = new ScheduledRunStore(state).get(run.id)?.entries[0].outcome;
  assert.deepEqual(outcome?.estimate, estimate);
  assert.deepEqual(outcome?.artifacts, [artifact]);
  assert.deepEqual(outcome?.spend, { tokens: 50 });
});
