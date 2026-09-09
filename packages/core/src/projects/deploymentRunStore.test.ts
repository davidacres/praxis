import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { KeyValueStore } from '../host/stateStore';
import { DeploymentRunStore, normalizeDeploymentRun, reconcileDeploymentRun } from './deploymentRunStore';
import { applyDeploymentRunCommand, createDeploymentRun, type DeploymentRun } from './deploymentRunState';

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      values.set(key, JSON.parse(JSON.stringify(value)));
    }
  };
}

const AT = '2026-09-09T00:00:00.000Z';
let clock = 0;
function nextAt(): string {
  clock += 1;
  return `2026-09-09T00:0${clock}:00.000Z`;
}

function freshRun(overrides: Partial<Parameters<typeof createDeploymentRun>[0]> = {}): DeploymentRun {
  return createDeploymentRun({
    runId: 'run-1',
    deploymentProfileId: 'production',
    profileVersion: 1,
    environment: 'production',
    artifactId: 'artifact-1',
    artifactDigest: 'sha256:abc',
    at: AT,
    ...overrides
  });
}

function toDeploying(runId = 'run-1'): DeploymentRun {
  let r = freshRun({ runId });
  r = applyDeploymentRunCommand(r, { kind: 'request-approval', at: nextAt() });
  r = applyDeploymentRunCommand(r, { kind: 'approve', at: nextAt(), by: 'alice' });
  r = applyDeploymentRunCommand(r, { kind: 'start-deploying', at: nextAt() });
  return r;
}

test('a saved run round-trips through the store unchanged', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const run = freshRun();
  await store.save(run);
  assert.deepEqual(store.get('run-1'), run);
});

test('saving a run twice replaces it by runId rather than duplicating', async () => {
  const store = new DeploymentRunStore(memoryStore());
  await store.save(freshRun());
  const updated = applyDeploymentRunCommand(freshRun(), { kind: 'request-approval', at: nextAt() });
  await store.save(updated);
  assert.equal(store.list().length, 1);
  assert.equal(store.get('run-1')?.status, 'awaiting-approval');
});

test('forProfile returns only that profile\'s runs, newest first', async () => {
  const store = new DeploymentRunStore(memoryStore());
  await store.save(freshRun({ runId: 'run-a', deploymentProfileId: 'staging', at: '2026-09-09T00:00:00.000Z' }));
  await store.save(freshRun({ runId: 'run-b', deploymentProfileId: 'production', at: '2026-09-09T00:01:00.000Z' }));
  await store.save(freshRun({ runId: 'run-c', deploymentProfileId: 'production', at: '2026-09-09T00:02:00.000Z' }));
  const runs = store.forProfile('production');
  assert.deepEqual(
    runs.map(r => r.runId),
    ['run-c', 'run-b']
  );
});

test('remove deletes exactly one run and throws for an unknown id', async () => {
  const store = new DeploymentRunStore(memoryStore());
  await store.save(freshRun({ runId: 'run-a' }));
  await store.save(freshRun({ runId: 'run-b' }));
  await store.remove('run-a');
  assert.equal(store.list().length, 1);
  assert.equal(store.get('run-a'), undefined);
  await assert.rejects(() => store.remove('run-a'), /was not found/);
});

test('needingReconciliation returns only runs stuck in deploying/verifying', async () => {
  const store = new DeploymentRunStore(memoryStore());
  await store.save(toDeploying('run-deploying'));
  const verifying = applyDeploymentRunCommand(toDeploying('run-verifying'), { kind: 'start-verifying', at: nextAt() });
  await store.save(verifying);
  await store.save(freshRun({ runId: 'run-prepared' }));
  const succeeded = applyDeploymentRunCommand(
    applyDeploymentRunCommand(toDeploying('run-succeeded'), { kind: 'start-verifying', at: nextAt() }),
    { kind: 'health-verified', at: nextAt() }
  );
  await store.save(succeeded);

  const stuck = store.needingReconciliation().map(r => r.runId).sort();
  assert.deepEqual(stuck, ['run-deploying', 'run-verifying']);
});

test('normalizeDeploymentRun accepts a well-formed record and rejects a garbage one', () => {
  const run = freshRun();
  assert.deepEqual(normalizeDeploymentRun(run), run);
  assert.equal(normalizeDeploymentRun(null), undefined);
  assert.equal(normalizeDeploymentRun('not an object'), undefined);
  assert.equal(normalizeDeploymentRun({}), undefined);
  assert.equal(normalizeDeploymentRun({ runId: 'x' }), undefined, 'missing deploymentProfileId');
});

test('normalizeDeploymentRun falls back to safe defaults for missing optional fields, never throwing', () => {
  const minimal = normalizeDeploymentRun({ runId: 'run-1', deploymentProfileId: 'production' });
  assert.ok(minimal);
  assert.equal(minimal?.status, 'prepared');
  assert.equal(minimal?.attempt, 1);
  assert.deepEqual(minimal?.events, []);
});

test('reconcileDeploymentRun: lost acknowledgement — no external id was ever recorded', async () => {
  const run = toDeploying();
  assert.equal(run.externalId, undefined);
  const result = await reconcileDeploymentRun(run, () => true, nextAt());
  assert.equal(result.reconciled, true);
  assert.equal(result.run.status, 'unknown');
  assert.match(result.note, /lost acknowledgement/);
});

test('reconcileDeploymentRun: an external id whose process is still alive is unconfirmed-but-running', async () => {
  let run = toDeploying();
  run = applyDeploymentRunCommand(run, { kind: 'record-external-id', at: nextAt(), externalId: 'pid:4242' });
  const result = await reconcileDeploymentRun(run, externalId => externalId === 'pid:4242', nextAt());
  assert.equal(result.run.status, 'unknown');
  assert.match(result.note, /still running/);
  assert.match(result.note, /pid:4242/);
});

test('reconcileDeploymentRun: an external id whose process is gone is unconfirmed-and-stopped', async () => {
  let run = toDeploying();
  run = applyDeploymentRunCommand(run, { kind: 'record-external-id', at: nextAt(), externalId: 'pid:4242' });
  const result = await reconcileDeploymentRun(run, () => false, nextAt());
  assert.equal(result.run.status, 'unknown');
  assert.match(result.note, /no longer running/);
});

test('reconcileDeploymentRun: a settled run (including a confirmed failure) needs no reconciliation at all', async () => {
  let run = toDeploying();
  run = applyDeploymentRunCommand(run, { kind: 'start-verifying', at: nextAt() });
  run = applyDeploymentRunCommand(run, { kind: 'health-failed', at: nextAt(), error: 'confirmed 500' });
  assert.equal(run.status, 'failed');
  const isAliveCalled: string[] = [];
  const result = await reconcileDeploymentRun(run, id => {
    isAliveCalled.push(id);
    return true;
  }, nextAt());
  assert.equal(result.reconciled, false);
  assert.deepEqual(result.run, run, 'a confirmed failure is returned completely unchanged');
  assert.deepEqual(isAliveCalled, [], 'a settled run never even asks whether the external operation is alive');
});

test('reconcileDeploymentRun never re-issues a second dispatch — the reconciled run sits at unknown, not queued or deploying', async () => {
  const run = toDeploying();
  const result = await reconcileDeploymentRun(run, () => false, nextAt());
  assert.equal(result.run.status, 'unknown');
  assert.notEqual(result.run.status, 'deploying');
  assert.notEqual(result.run.status, 'queued');
});

test('an isAlive check that fails propagates rather than being silently treated as "not alive" — a liveness check that errors is not the same as a confirmed-stopped answer', async () => {
  let run = toDeploying();
  run = applyDeploymentRunCommand(run, { kind: 'record-external-id', at: nextAt(), externalId: 'pid:bad' });
  const flaky = async (): Promise<boolean> => {
    throw new Error('permission denied checking pid');
  };
  await assert.rejects(() => reconcileDeploymentRun(run, flaky, nextAt()), /permission denied/);
});
