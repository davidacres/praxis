import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  approveDirectDeployment,
  deploymentHealthResult,
  prepareDirectDeployment,
  rollbackDirectDeployment,
  runDirectDeployment
} from './directDeploymentOrchestrator';
import { DeploymentTargetLockRegistry } from '../projects/deploymentRunState';
import { DeploymentRunStore } from '../projects/deploymentRunStore';
import { buildPublishManifest } from '../projects/publishManifest';
import type { KeyValueStore } from '../host/stateStore';
import type { DeploymentProfile, PublishedArtifact, TargetRef } from '../projects/deploymentProfile';

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      values.set(key, JSON.parse(JSON.stringify(value)));
    }
  };
}

let clock = 0;
function nextAt(): string {
  clock += 1;
  return `2026-09-09T00:${String(Math.floor(clock / 60)).padStart(2, '0')}:${String(clock % 60).padStart(2, '0')}.000Z`;
}

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

function profile(target: TargetRef, overrides: Partial<DeploymentProfile> = {}): DeploymentProfile {
  const at = '2026-09-09T00:00:00.000Z';
  return {
    schemaVersion: 1,
    id: 'profile-1',
    version: 1,
    name: 'Staging',
    projectId: 'project-1',
    environment: 'staging',
    executor: { kind: 'direct-process' },
    target,
    rollback: { kind: 'keep-previous-artifact' },
    createdAt: at,
    updatedAt: at,
    ...overrides
  };
}

async function publishedArtifact(files: Record<string, string>): Promise<{ artifact: PublishedArtifact; rootDir: string; manifest: Awaited<ReturnType<typeof buildPublishManifest>> }> {
  const rootDir = await tmp('praxis-artifact-');
  for (const [relativePath, content] of Object.entries(files)) {
    const full = path.join(rootDir, ...relativePath.split('/'));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  const manifest = await buildPublishManifest(rootDir);
  const artifact: PublishedArtifact = {
    id: 'artifact-1',
    deploymentProfileId: 'profile-1',
    sourceCommit: { kind: 'unknown' },
    digest: manifest.digest,
    createdAt: manifest.createdAt,
    location: { kind: 'local-path', path: rootDir }
  };
  return { artifact, rootDir, manifest };
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = http.createServer((_req, res) => res.end());
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      const port = typeof address === 'object' && address ? address.port : undefined;
      server.close(() => (port ? resolve(port) : reject(new Error('no port'))));
    });
  });
}

// ── Prepare / approve ────────────────────────────────────────────────────

test('prepare creates and persists a run in prepared status', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const { artifact } = await publishedArtifact({ 'index.html': 'v1' });
  const p = profile({ kind: 'directory', path: '/tmp/whatever' });
  const run = await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
  assert.equal(run.status, 'prepared');
  assert.equal(store.get('run-1')?.status, 'prepared');
});

test('approve moves a prepared run to queued with a matching approval attached', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const { artifact } = await publishedArtifact({ 'index.html': 'v1' });
  const p = profile({ kind: 'directory', path: '/tmp/whatever' });
  await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });

  const result = await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });
  assert.equal(result.ok, true);
  assert.equal(result.run.status, 'queued');
  assert.equal(result.run.approval?.approvedBy, 'dave');
});

test('approving an already-queued run again is a safe no-op, not a duplicate approval', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const { artifact } = await publishedArtifact({ 'index.html': 'v1' });
  const p = profile({ kind: 'directory', path: '/tmp/whatever' });
  await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
  const first = await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });

  const second = await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });
  assert.equal(second.ok, true);
  assert.deepEqual(second.run, first.run, 'reconnect-and-reapprove changes nothing');
});

// ── Deploy: directory target end to end ("folder-backed project deploys to a temporary local server without GitHub") ──

test('a folder-backed project deploys to a temporary local server and succeeds, with no GitHub/CI executor involved', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const locks = new DeploymentTargetLockRegistry();
  const targetDir = await tmp('praxis-target-');
  const backupDir = path.join(await tmp('praxis-backup-'), 'b1');
  const stagingDir = await tmp('praxis-staging-');
  const { artifact, manifest, rootDir } = await publishedArtifact({ 'index.html': '<h1>v1</h1>' });

  const port = await freePort();
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));

  try {
    const p = profile(
      { kind: 'directory', path: targetDir },
      { healthCheck: { kind: 'http', path: '/healthz' } }
    );
    await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
    await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });

    const result = await runDirectDeployment({
      store, locks, runId: 'run-1', profile: p, artifact, manifest,
      projectFolder: '/unused', backupDir, stagingDir, healthCheckPort: port, now: nextAt
    });

    assert.equal(result.dispatched, true);
    assert.equal(result.run.status, 'succeeded');
    assert.equal(await readFile(path.join(targetDir, 'index.html'), 'utf8'), '<h1>v1</h1>');

    const health = deploymentHealthResult(result.run);
    assert.equal(health.healthy, true);
  } finally {
    server.close();
    await Promise.all([targetDir, backupDir, stagingDir, rootDir].map(dir => rm(dir, { recursive: true, force: true })));
  }
});

test('a bad health check fails the run without auto-restoring — rollback stays a separate explicit action', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const locks = new DeploymentTargetLockRegistry();
  const targetDir = await tmp('praxis-target-');
  const backupDir = path.join(await tmp('praxis-backup-'), 'b1');
  const stagingDir = await tmp('praxis-staging-');
  const { artifact, manifest, rootDir } = await publishedArtifact({ 'index.html': 'v1' });
  const unusedPort = await freePort();

  try {
    const p = profile({ kind: 'directory', path: targetDir }, { healthCheck: { kind: 'tcp', port: unusedPort } });
    await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
    await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });

    const result = await runDirectDeployment({
      store, locks, runId: 'run-1', profile: p, artifact, manifest,
      projectFolder: '/unused', backupDir, stagingDir, healthCheckPort: unusedPort, now: nextAt
    });

    assert.equal(result.run.status, 'failed');
    assert.equal(await readFile(path.join(targetDir, 'index.html'), 'utf8'), 'v1', 'the new version stays applied — no auto-restore');
    assert.equal(deploymentHealthResult(result.run).healthy, false);
  } finally {
    await Promise.all([targetDir, backupDir, stagingDir, rootDir].map(dir => rm(dir, { recursive: true, force: true })));
  }
});

// ── Deploy: local-process target ────────────────────────────────────────

test('a local-process target spawns the configured script with the artifact path as a typed input', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const locks = new DeploymentTargetLockRegistry();
  const outFile = path.join(await tmp('praxis-out-'), 'result.txt');
  const { artifact, manifest, rootDir } = await publishedArtifact({ 'index.html': 'v1' });

  try {
    const p = profile({
      kind: 'local-process',
      executable: process.execPath,
      args: ['-e', `require('fs').writeFileSync(${JSON.stringify(outFile)}, process.env.PRAXIS_DEPLOY_ARTIFACT_PATH);`]
    });
    await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
    await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });

    const result = await runDirectDeployment({
      store, locks, runId: 'run-1', profile: p, artifact, manifest, projectFolder: os.tmpdir(), now: nextAt
    });

    assert.equal(result.run.status, 'succeeded', result.run.endedReason);
    assert.equal(await readFile(outFile, 'utf8'), rootDir);
    assert.match(result.run.externalId ?? '', /^pid:\d+$/);
  } finally {
    await Promise.all([path.dirname(outFile), rootDir].map(dir => rm(dir, { recursive: true, force: true })));
  }
});

test('a failing script fails the run with the script error recorded', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const locks = new DeploymentTargetLockRegistry();
  const { artifact, manifest, rootDir } = await publishedArtifact({ 'index.html': 'v1' });

  try {
    const p = profile({ kind: 'local-process', executable: process.execPath, args: ['-e', 'process.exit(3);'] });
    await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
    await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });

    const result = await runDirectDeployment({
      store, locks, runId: 'run-1', profile: p, artifact, manifest, projectFolder: os.tmpdir(), now: nextAt
    });

    assert.equal(result.run.status, 'failed');
    assert.match(result.run.endedReason ?? '', /Exit code 3/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ── Repeated click / reconnect cannot duplicate execution ─────────────────

test('two concurrent deploy calls for the same run dispatch the script exactly once', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const locks = new DeploymentTargetLockRegistry();
  const outFile = path.join(await tmp('praxis-out-'), 'counter.txt');
  await writeFile(outFile, '');
  const { artifact, manifest, rootDir } = await publishedArtifact({ 'index.html': 'v1' });

  try {
    const p = profile({
      kind: 'local-process',
      executable: process.execPath,
      // Append one 'x' per actual invocation; a duplicate dispatch would append twice.
      args: ['-e', `require('fs').appendFileSync(${JSON.stringify(outFile)}, 'x');`]
    });
    await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
    await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });

    const call = (): ReturnType<typeof runDirectDeployment> =>
      runDirectDeployment({ store, locks, runId: 'run-1', profile: p, artifact, manifest, projectFolder: os.tmpdir(), now: nextAt });

    const [first, second] = await Promise.all([call(), call()]);
    const dispatchedCount = [first, second].filter(r => r.dispatched).length;
    assert.equal(dispatchedCount, 1, 'exactly one of the two concurrent calls actually dispatched');

    const scriptRuns = await readFile(outFile, 'utf8');
    assert.equal(scriptRuns, 'x', 'the script itself only ran once');
  } finally {
    await Promise.all([path.dirname(outFile), rootDir].map(dir => rm(dir, { recursive: true, force: true })));
  }
});

test('reconnecting and re-sending "deploy" against an already-settled run does not redispatch', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const locks = new DeploymentTargetLockRegistry();
  const outFile = path.join(await tmp('praxis-out-'), 'counter.txt');
  await writeFile(outFile, '');
  const { artifact, manifest, rootDir } = await publishedArtifact({ 'index.html': 'v1' });

  try {
    const p = profile({
      kind: 'local-process',
      executable: process.execPath,
      args: ['-e', `require('fs').appendFileSync(${JSON.stringify(outFile)}, 'x');`]
    });
    await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
    await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });

    const first = await runDirectDeployment({ store, locks, runId: 'run-1', profile: p, artifact, manifest, projectFolder: os.tmpdir(), now: nextAt });
    assert.equal(first.dispatched, true);
    assert.equal(first.run.status, 'succeeded');

    // Simulates a reconnected UI re-sending the same "deploy" click.
    const second = await runDirectDeployment({ store, locks, runId: 'run-1', profile: p, artifact, manifest, projectFolder: os.tmpdir(), now: nextAt });
    assert.equal(second.dispatched, false);
    assert.match(second.reason ?? '', /not queued/);
    assert.deepEqual(second.run, first.run, 'the settled run is returned unchanged');

    assert.equal(await readFile(outFile, 'utf8'), 'x', 'the script never ran a second time');
  } finally {
    await Promise.all([path.dirname(outFile), rootDir].map(dir => rm(dir, { recursive: true, force: true })));
  }
});

// ── Unsupported executor/target refuse cleanly ─────────────────────────────

test('an unimplemented executor kind is refused with a clear reason and touches nothing', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const locks = new DeploymentTargetLockRegistry();
  const { artifact, manifest, rootDir } = await publishedArtifact({ 'index.html': 'v1' });
  try {
    const p = profile({ kind: 'directory', path: '/tmp/never-touched' }, { executor: { kind: 'github-actions', workflowFile: 'deploy.yml' } });
    await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
    await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });

    const result = await runDirectDeployment({ store, locks, runId: 'run-1', profile: p, artifact, manifest, projectFolder: '/unused', now: nextAt });
    assert.equal(result.dispatched, false);
    assert.match(result.reason ?? '', /github-actions.*no implementation/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('an unimplemented target kind is refused with a clear reason', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const locks = new DeploymentTargetLockRegistry();
  const { artifact, manifest, rootDir } = await publishedArtifact({ 'index.html': 'v1' });
  try {
    const p = profile({ kind: 'iis', siteName: 'Default Web Site' });
    await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
    await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });

    const result = await runDirectDeployment({ store, locks, runId: 'run-1', profile: p, artifact, manifest, projectFolder: '/unused', now: nextAt });
    assert.equal(result.dispatched, false);
    assert.match(result.reason ?? '', /iis.*no implementation/);
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

// ── Rollback ─────────────────────────────────────────────────────────────

test('rollback on a directory target restores the previous version', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const locks = new DeploymentTargetLockRegistry();
  const targetDir = await tmp('praxis-target-');
  await writeFile(path.join(targetDir, 'index.html'), 'v1');
  const backupDir = path.join(await tmp('praxis-backup-'), 'b1');
  const stagingDir = await tmp('praxis-staging-');
  const { artifact, manifest, rootDir } = await publishedArtifact({ 'index.html': 'v2' });

  try {
    const p = profile({ kind: 'directory', path: targetDir });
    await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
    await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });
    const deployed = await runDirectDeployment({
      store, locks, runId: 'run-1', profile: p, artifact, manifest, projectFolder: '/unused', backupDir, stagingDir, now: nextAt
    });
    assert.equal(deployed.run.status, 'succeeded');
    assert.equal(await readFile(path.join(targetDir, 'index.html'), 'utf8'), 'v2');

    const rollback = await rollbackDirectDeployment({ store, runId: 'run-1', profile: p, backupDir, now: nextAt });
    assert.equal(rollback.rolledBack, true);
    assert.equal(rollback.run.status, 'rolled-back');
    assert.equal(await readFile(path.join(targetDir, 'index.html'), 'utf8'), 'v1');
  } finally {
    await Promise.all([targetDir, backupDir, stagingDir, rootDir].map(dir => rm(dir, { recursive: true, force: true })));
  }
});

test('rollback on a local-process target is refused, explains why, and leaves evidence in the run', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const locks = new DeploymentTargetLockRegistry();
  const { artifact, manifest, rootDir } = await publishedArtifact({ 'index.html': 'v1' });
  try {
    const p = profile({ kind: 'local-process', executable: process.execPath, args: ['-e', 'process.exit(0);'] });
    await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
    await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });
    const deployed = await runDirectDeployment({ store, locks, runId: 'run-1', profile: p, artifact, manifest, projectFolder: os.tmpdir(), now: nextAt });
    assert.equal(deployed.run.status, 'succeeded');

    const rollback = await rollbackDirectDeployment({ store, runId: 'run-1', profile: p, now: nextAt });
    assert.equal(rollback.rolledBack, false);
    assert.match(rollback.reason ?? '', /not supported for target kind "local-process"/);
    assert.equal(rollback.run.status, 'failed', 'the rollback attempt itself settles as failed, not silently dropped');
    assert.ok(
      rollback.run.events.some(event => event.kind === 'rollback-started'),
      'the attempt is on the record even though it could not proceed'
    );
    assert.ok(rollback.run.events.some(event => event.kind === 'rollback-failed'));
  } finally {
    await rm(rootDir, { recursive: true, force: true });
  }
});

test('rollback is refused on a run that never succeeded or failed', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const { artifact } = await publishedArtifact({ 'index.html': 'v1' });
  const p = profile({ kind: 'directory', path: '/tmp/never-used' });
  await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
  await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });

  const rollback = await rollbackDirectDeployment({ store, runId: 'run-1', profile: p, now: nextAt });
  assert.equal(rollback.rolledBack, false);
  assert.match(rollback.reason ?? '', /"queued"/);
});

test('a directory rollback with no backupDir given is refused and explains why', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const locks = new DeploymentTargetLockRegistry();
  const targetDir = await tmp('praxis-target-');
  const backupDir = path.join(await tmp('praxis-backup-'), 'b1');
  const stagingDir = await tmp('praxis-staging-');
  const { artifact, manifest, rootDir } = await publishedArtifact({ 'index.html': 'v1' });
  try {
    const p = profile({ kind: 'directory', path: targetDir });
    await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });
    await approveDirectDeployment({ store, runId: 'run-1', profile: p, artifact, actor: 'dave', now: nextAt });
    await runDirectDeployment({ store, locks, runId: 'run-1', profile: p, artifact, manifest, projectFolder: '/unused', backupDir, stagingDir, now: nextAt });

    const rollback = await rollbackDirectDeployment({ store, runId: 'run-1', profile: p, now: nextAt });
    assert.equal(rollback.rolledBack, false);
    assert.match(rollback.reason ?? '', /No backup directory/);
  } finally {
    await Promise.all([targetDir, backupDir, stagingDir, rootDir].map(dir => rm(dir, { recursive: true, force: true })));
  }
});

// ── Health results ───────────────────────────────────────────────────────

test('deploymentHealthResult reports no outcome yet for a run that has not reached verification', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const { artifact } = await publishedArtifact({ 'index.html': 'v1' });
  const p = profile({ kind: 'directory', path: '/tmp/never-used' });
  const run = await prepareDirectDeployment({ store, runId: 'run-1', profile: p, artifact, now: nextAt });

  const health = deploymentHealthResult(run);
  assert.equal(health.status, 'prepared');
  assert.equal(health.healthy, undefined);
});
