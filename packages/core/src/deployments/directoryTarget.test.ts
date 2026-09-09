import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  applyDirectoryDeployment,
  deployDirectoryWithHealthCheck,
  isValidExcludePath,
  listDirectoryContents,
  restoreDirectoryBackup,
  verifyDirectoryHealth,
  type DirectoryDeploymentInput
} from './directoryTarget';
import { buildPublishManifest } from '../projects/publishManifest';
import type { DirectoryTargetRef } from '../projects/deploymentProfile';

async function tmp(prefix: string): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), prefix));
}

/** Writes `files` (relative path -> content) under `root`, then builds and returns its manifest. */
async function artifact(root: string, files: Record<string, string>) {
  for (const [relativePath, content] of Object.entries(files)) {
    const full = path.join(root, ...relativePath.split('/'));
    await mkdir(path.dirname(full), { recursive: true });
    await writeFile(full, content);
  }
  return buildPublishManifest(root);
}

interface Rig {
  target: DirectoryTargetRef;
  targetDir: string;
  artifactDir: string;
  backupDir: string;
  stagingDir: string;
  cleanup: () => Promise<void>;
}

async function rig(): Promise<Rig> {
  const targetDir = await tmp('praxis-target-');
  const artifactDir = await tmp('praxis-artifact-');
  const backupDir = path.join(await tmp('praxis-backups-'), 'b1');
  const stagingDir = await tmp('praxis-staging-');
  return {
    target: { kind: 'directory', path: targetDir },
    targetDir,
    artifactDir,
    backupDir,
    stagingDir,
    cleanup: async () => {
      await Promise.all(
        [targetDir, artifactDir, path.dirname(backupDir), stagingDir].map(dir => rm(dir, { recursive: true, force: true }))
      );
    }
  };
}

function input(r: Rig, overrides: Partial<DirectoryDeploymentInput> = {}) {
  return (manifest: Awaited<ReturnType<typeof buildPublishManifest>>): DirectoryDeploymentInput => ({
    target: r.target,
    artifactRootDir: r.artifactDir,
    manifest,
    excludePaths: [],
    backupDir: r.backupDir,
    stagingDir: r.stagingDir,
    ...overrides
  });
}

// ── Core update-from-artifact behavior ─────────────────────────────────────

test('a fixture web root updates from one immutable artifact', async () => {
  const r = await rig();
  try {
    const manifest = await artifact(r.artifactDir, { 'index.html': '<h1>v1</h1>', 'assets/app.js': 'console.log(1)' });
    const result = await applyDirectoryDeployment(input(r)(manifest));
    assert.equal(result.applied, true);
    assert.deepEqual(result.filesWritten.sort(), ['assets/app.js', 'index.html']);
    assert.equal(await readFile(path.join(r.targetDir, 'index.html'), 'utf8'), '<h1>v1</h1>');
    assert.equal(await readFile(path.join(r.targetDir, 'assets/app.js'), 'utf8'), 'console.log(1)');
  } finally {
    await r.cleanup();
  }
});

test('a second deploy replaces stale application files the new artifact no longer names', async () => {
  const r = await rig();
  try {
    const v1 = await artifact(r.artifactDir, { 'index.html': 'v1', 'old.html': 'stale' });
    await applyDirectoryDeployment(input(r)(v1));

    const artifact2 = await tmp('praxis-artifact2-');
    const v2 = await artifact(artifact2, { 'index.html': 'v2' });
    const result = await applyDirectoryDeployment(input(r, { artifactRootDir: artifact2, backupDir: path.join(path.dirname(r.backupDir), 'b2') })(v2));

    assert.equal(result.applied, true);
    assert.equal(await readFile(path.join(r.targetDir, 'index.html'), 'utf8'), 'v2');
    assert.deepEqual(await listDirectoryContents(r.targetDir), ['index.html'], 'the stale old.html is gone');
    await rm(artifact2, { recursive: true, force: true });
  } finally {
    await r.cleanup();
  }
});

// ── Excluding mutable user data ─────────────────────────────────────────────

test('excluded user data survives a deploy untouched, and is never reported as written', async () => {
  const r = await rig();
  try {
    await mkdir(path.join(r.targetDir, 'uploads'), { recursive: true });
    await writeFile(path.join(r.targetDir, 'uploads/photo.jpg'), 'binary-ish-content');

    const manifest = await artifact(r.artifactDir, { 'index.html': 'v1' });
    const result = await applyDirectoryDeployment(input(r, { excludePaths: ['uploads'] })(manifest));

    assert.equal(result.applied, true);
    assert.ok(!result.filesWritten.includes('uploads/photo.jpg'));
    assert.equal(await readFile(path.join(r.targetDir, 'uploads/photo.jpg'), 'utf8'), 'binary-ish-content');
  } finally {
    await r.cleanup();
  }
});

test('a stale application file is removed even when an unrelated exclude path is configured', async () => {
  const r = await rig();
  try {
    await mkdir(path.join(r.targetDir, 'uploads'), { recursive: true });
    await writeFile(path.join(r.targetDir, 'uploads/keep.txt'), 'keep-me');
    await writeFile(path.join(r.targetDir, 'old.html'), 'stale');

    const manifest = await artifact(r.artifactDir, { 'index.html': 'v1' });
    await applyDirectoryDeployment(input(r, { excludePaths: ['uploads'] })(manifest));

    const contents = (await listDirectoryContents(r.targetDir)).sort();
    assert.deepEqual(contents, ['index.html', 'uploads/keep.txt']);
  } finally {
    await r.cleanup();
  }
});

test('a nested exclude path is honored the same as a top-level one', async () => {
  const r = await rig();
  try {
    await mkdir(path.join(r.targetDir, 'data'), { recursive: true });
    await writeFile(path.join(r.targetDir, 'data/db.sqlite'), 'db-bytes');

    const manifest = await artifact(r.artifactDir, { 'index.html': 'v1' });
    await applyDirectoryDeployment(input(r, { excludePaths: ['data/db.sqlite'] })(manifest));

    assert.equal(await readFile(path.join(r.targetDir, 'data/db.sqlite'), 'utf8'), 'db-bytes');
  } finally {
    await r.cleanup();
  }
});

// ── Exclude path validation fails closed ────────────────────────────────────

test('isValidExcludePath rejects traversal, absolute paths, and unsafe characters', () => {
  assert.equal(isValidExcludePath('uploads'), true);
  assert.equal(isValidExcludePath('data/db.sqlite'), true);
  assert.equal(isValidExcludePath('../etc'), false);
  assert.equal(isValidExcludePath('/etc/passwd'), false);
  assert.equal(isValidExcludePath('uploads/../../etc'), false);
  assert.equal(isValidExcludePath(''), false);
  assert.equal(isValidExcludePath('uploads; rm -rf /'), false);
});

test('an invalid exclude path refuses the whole deploy before anything is touched', async () => {
  const r = await rig();
  try {
    await writeFile(path.join(r.targetDir, 'existing.html'), 'untouched');
    const manifest = await artifact(r.artifactDir, { 'index.html': 'v1' });
    const result = await applyDirectoryDeployment(input(r, { excludePaths: ['../escape'] })(manifest));

    assert.equal(result.applied, false);
    assert.match(result.error ?? '', /safe exclude path/);
    assert.equal(await readFile(path.join(r.targetDir, 'existing.html'), 'utf8'), 'untouched', 'the target was never touched');
  } finally {
    await r.cleanup();
  }
});

// ── A tampered artifact is refused ──────────────────────────────────────────

test('an artifact whose content no longer matches its manifest is refused before the target is touched', async () => {
  const r = await rig();
  try {
    await writeFile(path.join(r.targetDir, 'existing.html'), 'untouched');
    const manifest = await artifact(r.artifactDir, { 'index.html': 'v1' });
    await writeFile(path.join(r.artifactDir, 'index.html'), 'tampered-after-manifest-was-built');

    const result = await applyDirectoryDeployment(input(r)(manifest));
    assert.equal(result.applied, false);
    assert.match(result.error ?? '', /no longer matches its manifest/);
    assert.equal(await readFile(path.join(r.targetDir, 'existing.html'), 'utf8'), 'untouched');
  } finally {
    await r.cleanup();
  }
});

// ── Backup and restore ──────────────────────────────────────────────────────

test('a backup captures the replaced application content, excluding user data', async () => {
  const r = await rig();
  try {
    await mkdir(path.join(r.targetDir, 'uploads'), { recursive: true });
    await writeFile(path.join(r.targetDir, 'uploads/keep.txt'), 'keep-me');
    await writeFile(path.join(r.targetDir, 'index.html'), 'v1');

    const manifest = await artifact(r.artifactDir, { 'index.html': 'v2' });
    await applyDirectoryDeployment(input(r, { excludePaths: ['uploads'] })(manifest));

    assert.deepEqual(await listDirectoryContents(r.backupDir), ['index.html']);
    assert.equal(await readFile(path.join(r.backupDir, 'index.html'), 'utf8'), 'v1');
  } finally {
    await r.cleanup();
  }
});

test('restoreDirectoryBackup puts the previous version back, still excluding user data', async () => {
  const r = await rig();
  try {
    await writeFile(path.join(r.targetDir, 'index.html'), 'v1');
    const manifest = await artifact(r.artifactDir, { 'index.html': 'v2' });
    await applyDirectoryDeployment(input(r)(manifest));
    assert.equal(await readFile(path.join(r.targetDir, 'index.html'), 'utf8'), 'v2');

    const restore = await restoreDirectoryBackup(r.target, r.backupDir, []);
    assert.equal(restore.restored, true);
    assert.equal(await readFile(path.join(r.targetDir, 'index.html'), 'utf8'), 'v1');
  } finally {
    await r.cleanup();
  }
});

test('restoreDirectoryBackup refuses a backup directory that does not exist', async () => {
  const r = await rig();
  try {
    const result = await restoreDirectoryBackup(r.target, path.join(r.targetDir, '..', 'no-such-backup'), []);
    assert.equal(result.restored, false);
    assert.match(result.error ?? '', /not found/);
  } finally {
    await r.cleanup();
  }
});

// ── Health check ─────────────────────────────────────────────────────────

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

test('a log-line health check is refused for a directory target rather than silently passing', async () => {
  const result = await verifyDirectoryHealth({ kind: 'log-line', match: 'ready' }, '127.0.0.1', 80);
  assert.equal(result.healthy, false);
  assert.match(result.detail, /not supported/);
});

test('an http health check that passes reports healthy', async () => {
  const port = await freePort();
  const server = http.createServer((_req, res) => {
    res.writeHead(200);
    res.end('ok');
  });
  await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
  try {
    const result = await verifyDirectoryHealth({ kind: 'http', path: '/healthz' }, '127.0.0.1', port);
    assert.equal(result.healthy, true);
  } finally {
    server.close();
  }
});

test('a bad health check on a port nothing listens on reports unhealthy', async () => {
  const port = await freePort(); // freed immediately after — nothing is listening by the time we check
  const result = await verifyDirectoryHealth({ kind: 'tcp', port }, '127.0.0.1', port);
  assert.equal(result.healthy, false);
});

// ── The integrated deploy-then-verify-then-restore flow ───────────────────

test('a failed health check automatically restores the previous version', async () => {
  const r = await rig();
  try {
    await writeFile(path.join(r.targetDir, 'index.html'), 'v1');
    const manifest = await artifact(r.artifactDir, { 'index.html': 'v2-bad' });
    const unusedPort = await freePort(); // guaranteed nothing listens here

    const outcome = await deployDirectoryWithHealthCheck({
      ...input(r)(manifest),
      healthCheck: { kind: 'tcp', port: unusedPort },
      healthCheckPort: unusedPort
    });

    assert.equal(outcome.applied, true);
    assert.equal(outcome.healthy, false);
    assert.equal(outcome.restored, true);
    assert.equal(await readFile(path.join(r.targetDir, 'index.html'), 'utf8'), 'v1', 'the bad v2 was rolled back');
  } finally {
    await r.cleanup();
  }
});

test('a passing health check leaves the new version in place', async () => {
  const r = await rig();
  try {
    await writeFile(path.join(r.targetDir, 'index.html'), 'v1');
    const manifest = await artifact(r.artifactDir, { 'index.html': 'v2-good' });
    const port = await freePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end();
    });
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));

    try {
      const outcome = await deployDirectoryWithHealthCheck({
        ...input(r)(manifest),
        healthCheck: { kind: 'http', path: '/healthz' },
        healthCheckPort: port
      });
      assert.equal(outcome.healthy, true);
      assert.equal(outcome.restored, undefined);
      assert.equal(await readFile(path.join(r.targetDir, 'index.html'), 'utf8'), 'v2-good');
    } finally {
      server.close();
    }
  } finally {
    await r.cleanup();
  }
});

test('no health check configured leaves the deploy applied and unverified', async () => {
  const r = await rig();
  try {
    const manifest = await artifact(r.artifactDir, { 'index.html': 'v1' });
    const outcome = await deployDirectoryWithHealthCheck(input(r)(manifest));
    assert.equal(outcome.applied, true);
    assert.equal(outcome.healthy, undefined);
    assert.equal(outcome.restored, undefined);
  } finally {
    await r.cleanup();
  }
});
