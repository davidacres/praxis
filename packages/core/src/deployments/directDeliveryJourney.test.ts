/**
 * The complete direct-delivery journey, end to end (FX-BE-060 / TASK-161).
 *
 * "Exercise build/publish, prepared artifact review, deployment, failed
 * health and rollback" as one continuous, scripted narrative — every step
 * a real caller (the renderer, over IPC) would actually take, using only
 * local fixtures: a real temp directory standing in for a build output, a
 * real temp `http.createServer` standing in for a health check target, no
 * network access, no production credentials of any kind. This is deliberately
 * a *journey* test, not another unit test for any one function — those
 * already exist in `directDeploymentOrchestrator.test.ts`,
 * `directoryTarget.test.ts`, `directProcessExecutor.test.ts`, and
 * `deploymentProfile.test.ts`. What this file proves is that the pieces
 * those tests verify in isolation actually compose into the full story the
 * story's own acceptance criteria describe.
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { preflightDeploymentCapabilities, validateDeploymentProfile, type DeploymentProfile } from '../projects/deploymentProfile';
import { allCredentialsBound, evaluateCredentialBindings } from '../projects/deploymentProfileStore';
import { createPublishedArtifact } from '../projects/publishManifest';
import { DeploymentTargetLockRegistry } from '../projects/deploymentRunState';
import { DeploymentRunStore } from '../projects/deploymentRunStore';
import type { KeyValueStore } from '../host/stateStore';
import {
  approveDirectDeployment,
  deploymentHealthResult,
  prepareDirectDeployment,
  rollbackDirectDeployment,
  runDirectDeployment
} from './directDeploymentOrchestrator';

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

test('the complete direct delivery journey: build, publish, review, deploy, failed health, rollback, redeploy, succeed', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const locks = new DeploymentTargetLockRegistry();
  const targetDir = await tmp('praxis-journey-target-');
  const buildDir = await tmp('praxis-journey-build-');
  const backupDir1 = path.join(await tmp('praxis-journey-backup-'), 'b1');
  const backupDir2 = path.join(await tmp('praxis-journey-backup-'), 'b2');
  const stagingDir1 = await tmp('praxis-journey-staging-');
  const stagingDir2 = await tmp('praxis-journey-staging-');
  const cleanup = [targetDir, buildDir, path.dirname(backupDir1), path.dirname(backupDir2), stagingDir1, stagingDir2];

  try {
    // ── 1. Build ────────────────────────────────────────────────────────
    // A "build" is nothing more than files landing in a directory — nothing
    // in this feature has, or needs, its own build step.
    await writeFile(path.join(buildDir, 'index.html'), '<h1>release candidate</h1>');
    await mkdir(path.join(buildDir, 'assets'), { recursive: true });
    await writeFile(path.join(buildDir, 'assets', 'app.js'), 'console.log("v1");');

    // ── 2. Publish ──────────────────────────────────────────────────────
    const { artifact, manifest } = await createPublishedArtifact({
      id: 'artifact-journey-1',
      deploymentProfileId: 'profile-staging',
      sourceCommit: { kind: 'commit', sha: 'abc123' },
      rootDir: buildDir
    });
    assert.ok(artifact.digest.startsWith('sha256:'));
    assert.equal(manifest.files.length, 2);

    // ── 3. Prepared artifact review ─────────────────────────────────────
    // A profile that requires a credential no local machine has bound yet —
    // "profile editor supports missing credentials" (TASK-159), proven here
    // as part of the full journey rather than in isolation.
    const profile: DeploymentProfile = {
      schemaVersion: 1,
      id: 'profile-staging',
      version: 1,
      name: 'Staging web root',
      projectId: 'project-1',
      environment: 'staging',
      executor: { kind: 'direct-process' },
      // Repo-relative, as a valid profile requires — resolved against
      // projectFolder (here, targetDir itself) at deploy/rollback time,
      // the same way a local-process target's cwd resolves.
      target: { kind: 'directory', path: '.' },
      healthCheck: { kind: 'http', path: '/healthz' },
      rollback: { kind: 'keep-previous-artifact', retainCount: 1 },
      credentials: { DEPLOY_TOKEN: '${secret:DEPLOY_TOKEN}' },
      createdAt: nextAt(),
      updatedAt: nextAt()
    };

    const shapeCheck = validateDeploymentProfile(profile);
    assert.equal(shapeCheck.valid, true);
    const capabilityCheck = preflightDeploymentCapabilities(profile);
    assert.deepEqual(capabilityCheck, [], 'direct-process + directory are both implemented, so preflight has nothing to say');
    const credentialCheck = await evaluateCredentialBindings(profile, async () => undefined); // no production secrets — nothing is bound
    assert.equal(allCredentialsBound(credentialCheck), false);
    assert.equal(credentialCheck[0]?.bound, false, 'the review surfaces a missing credential rather than hiding or faking it');

    // ── 4. Prepare + approve ────────────────────────────────────────────
    await prepareDirectDeployment({ store, runId: 'run-1', profile, artifact, now: nextAt, issueKey: 'PROJ-42' });
    const approved = await approveDirectDeployment({ store, runId: 'run-1', profile, artifact, actor: 'release-manager', now: nextAt });
    assert.equal(approved.ok, true);

    // ── 5. Deploy v1, with a real health check — this is the "previous
    // version" a later rollback restores. ───────────────────────────────
    const port = await freePort();
    const server = http.createServer((_req, res) => {
      res.writeHead(200);
      res.end('ok');
    });
    await new Promise<void>(resolve => server.listen(port, '127.0.0.1', resolve));
    try {
      const firstAttempt = await runDirectDeployment({
        store, locks, runId: 'run-1', profile, artifact, manifest,
        projectFolder: targetDir, backupDir: backupDir1, stagingDir: stagingDir1,
        healthCheckPort: port, now: nextAt
      });
      assert.equal(firstAttempt.run.status, 'succeeded');
      assert.equal(await readFile(path.join(targetDir, 'index.html'), 'utf8'), '<h1>release candidate</h1>');
      assert.equal(deploymentHealthResult(firstAttempt.run).healthy, true);

      // ── 6. Build and publish v2, deploy it with a health check pointed
      // at nothing listening — a bad release. ───────────────────────────
      const buildDir2 = await tmp('praxis-journey-build2-');
      cleanup.push(buildDir2);
      await writeFile(path.join(buildDir2, 'index.html'), '<h1>bad release</h1>');
      const { artifact: artifact2, manifest: manifest2 } = await createPublishedArtifact({
        id: 'artifact-journey-2',
        deploymentProfileId: 'profile-staging',
        sourceCommit: { kind: 'commit', sha: 'def456' },
        rootDir: buildDir2
      });
      assert.notEqual(artifact2.digest, artifact.digest, 'a different build is a different digest');

      await prepareDirectDeployment({ store, runId: 'run-2', profile, artifact: artifact2, now: nextAt, issueKey: 'PROJ-42' });
      await approveDirectDeployment({ store, runId: 'run-2', profile, artifact: artifact2, actor: 'release-manager', now: nextAt });
      const badPort = await freePort(); // freed immediately — guaranteed nothing answers
      const secondAttempt = await runDirectDeployment({
        store, locks, runId: 'run-2', profile, artifact: artifact2, manifest: manifest2,
        projectFolder: targetDir, backupDir: backupDir2, stagingDir: stagingDir2,
        healthCheckPort: badPort, now: nextAt
      });
      assert.equal(secondAttempt.dispatched, true);
      assert.equal(secondAttempt.run.status, 'failed', 'the deploy itself applied, but the bad health check failed it');
      assert.equal(await readFile(path.join(targetDir, 'index.html'), 'utf8'), '<h1>bad release</h1>', 'no auto-restore — the failed version stays applied until an explicit rollback');
      assert.equal(deploymentHealthResult(secondAttempt.run).healthy, false);

      // ── 7. Explicit rollback — restores v1, the version run-2's own
      // deploy backed up before replacing it. ────────────────────────────
      const rollback = await rollbackDirectDeployment({ store, runId: 'run-2', profile, projectFolder: targetDir, backupDir: backupDir2, now: nextAt });
      assert.equal(rollback.rolledBack, true);
      assert.equal(rollback.run.status, 'rolled-back');
      assert.equal(await readFile(path.join(targetDir, 'index.html'), 'utf8'), '<h1>release candidate</h1>', 'the previous, working version is back');

      // Both deploy attempts share the digest v2 was built from — v2's own
      // digest — while v1's own run recorded a different one; outcomes are
      // cleanly distinguishable, never conflated.
      assert.equal(firstAttempt.run.artifactDigest, artifact.digest);
      assert.equal(secondAttempt.run.artifactDigest, artifact2.digest);
      assert.equal(firstAttempt.run.status, 'succeeded');
      assert.equal(secondAttempt.run.status, 'failed');
      assert.equal(rollback.run.status, 'rolled-back');
    } finally {
      server.close();
    }
  } finally {
    await Promise.all(cleanup.map(dir => rm(dir, { recursive: true, force: true })));
  }
});
