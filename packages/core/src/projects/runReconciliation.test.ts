import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  RUN_STATE_SCHEMA_VERSION,
  clearRunState,
  reconcileRunState,
  readRunState,
  writeRunState,
  type PersistedRunState
} from './runReconciliation';

function state(overrides: Partial<PersistedRunState> = {}): PersistedRunState {
  return {
    schemaVersion: RUN_STATE_SCHEMA_VERSION,
    projectId: 'proj-1',
    runId: 'run-1',
    startedAt: '2026-09-09T00:00:00.000Z',
    services: [],
    ...overrides
  };
}

test('reading with no persisted state comes back undefined, not an error', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-runstate-'));
  try {
    assert.equal(await readRunState(dir, 'proj-1'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a written state round-trips unchanged', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-runstate-'));
  try {
    const written = state({ services: [{ serviceId: 'api', pid: 12345, state: 'ready', startedAt: '2026-09-09T00:00:01.000Z' }] });
    await writeRunState(dir, written);
    assert.deepEqual(await readRunState(dir, 'proj-1'), written);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewriting a project\'s state overwrites rather than appending', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-runstate-'));
  try {
    await writeRunState(dir, state({ services: [{ serviceId: 'api', pid: 1, state: 'ready' }] }));
    await writeRunState(dir, state({ runId: 'run-2', services: [{ serviceId: 'worker', pid: 2, state: 'ready' }] }));
    const read = await readRunState(dir, 'proj-1');
    assert.equal(read?.runId, 'run-2');
    assert.equal(read?.services.length, 1);
    assert.equal(read?.services[0].serviceId, 'worker');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a malformed persisted file is treated as no state rather than thrown', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-runstate-'));
  try {
    const { mkdir, writeFile } = await import('node:fs/promises');
    await mkdir(path.join(dir, 'proj-1'), { recursive: true });
    await writeFile(path.join(dir, 'proj-1', 'run-state.json'), 'not json', 'utf8');
    assert.equal(await readRunState(dir, 'proj-1'), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('two different projects\' states do not collide', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-runstate-'));
  try {
    await writeRunState(dir, state({ projectId: 'proj-a', services: [{ serviceId: 'api', pid: 1, state: 'ready' }] }));
    await writeRunState(dir, state({ projectId: 'proj-b', services: [{ serviceId: 'api', pid: 2, state: 'ready' }] }));
    assert.equal((await readRunState(dir, 'proj-a'))?.services[0].pid, 1);
    assert.equal((await readRunState(dir, 'proj-b'))?.services[0].pid, 2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clearRunState removes exactly one project\'s record', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-runstate-'));
  try {
    await writeRunState(dir, state({ projectId: 'proj-a' }));
    await writeRunState(dir, state({ projectId: 'proj-b' }));
    await clearRunState(dir, 'proj-a');
    assert.equal(await readRunState(dir, 'proj-a'), undefined);
    assert.ok(await readRunState(dir, 'proj-b'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('clearRunState on a project with nothing persisted is a no-op, not an error', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-runstate-'));
  try {
    await assert.doesNotReject(() => clearRunState(dir, 'nothing-here'));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('reconciliation labels a still-alive pid unknown-running, conservatively, never ready', async () => {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
  try {
    await new Promise<void>(resolve => child.once('spawn', () => resolve()));
    const reconciled = reconcileRunState(state({ services: [{ serviceId: 'api', pid: child.pid, state: 'ready' }] }));
    assert.equal(reconciled.length, 1);
    assert.equal(reconciled[0].state, 'unknown-running');
    assert.equal(reconciled[0].pid, child.pid);
  } finally {
    child.kill();
  }
});

test('reconciliation labels a pid that no longer exists stopped-while-closed', async () => {
  const child = spawn(process.execPath, ['-e', '']); // exits almost immediately
  const pid = await new Promise<number>(resolve => child.once('spawn', () => resolve(child.pid!)));
  await new Promise<void>(resolve => child.once('exit', () => resolve()));
  const reconciled = reconcileRunState(state({ services: [{ serviceId: 'api', pid, state: 'ready' }] }));
  assert.equal(reconciled[0].state, 'stopped-while-closed');
});

test('a record with no pid (never spawned before the app closed) reconciles straight to stopped-while-closed', () => {
  const reconciled = reconcileRunState(state({ services: [{ serviceId: 'api', state: 'starting' }] }));
  assert.equal(reconciled[0].state, 'stopped-while-closed');
  assert.equal(reconciled[0].pid, undefined);
});

test('reconciliation covers every service in the record independently', async () => {
  const alive = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000);']);
  try {
    await new Promise<void>(resolve => alive.once('spawn', () => resolve()));
    const reconciled = reconcileRunState(
      state({
        services: [
          { serviceId: 'alive', pid: alive.pid, state: 'ready' },
          { serviceId: 'gone', pid: 999_999, state: 'ready' },
          { serviceId: 'never-started', state: 'pending' }
        ]
      })
    );
    assert.equal(reconciled.find(r => r.serviceId === 'alive')?.state, 'unknown-running');
    assert.equal(reconciled.find(r => r.serviceId === 'gone')?.state, 'stopped-while-closed');
    assert.equal(reconciled.find(r => r.serviceId === 'never-started')?.state, 'stopped-while-closed');
  } finally {
    alive.kill();
  }
});
