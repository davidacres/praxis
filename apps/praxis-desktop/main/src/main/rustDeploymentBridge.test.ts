import test from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  type DeploymentProfile,
  type PublishedArtifact,
  type PublishManifest,
  type DeploymentRun,
  type ApproveDirectDeploymentResult,
  type RunDirectDeploymentResult,
  type RollbackDirectDeploymentResult,
  type DeploymentHealthResult,
  buildPublishManifest
} from '@praxis/core';
import { RustHostBridge, StdioRustHostTransport } from './rustHostBridge';

function setup(t: test.TestContext) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-deployment-parity-'));
  const bridge = new RustHostBridge({
    transport: new StdioRustHostTransport({
      userDataDir: dir,
      settingsPath: path.join(dir, 'settings.json')
    })
  });
  t.after(async () => {
    await bridge.dispose();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { dir, bridge };
}

const at = '2026-11-09T00:00:00.000Z';
const profile: DeploymentProfile = {
  schemaVersion: 1,
  id: 'prod-deploy',
  version: 1,
  name: 'Prod Deploy',
  projectId: 'proj-1',
  environment: 'production',
  executor: { kind: 'direct-process' },
  target: { kind: 'directory', path: 'target-site' },
  rollback: { kind: 'keep-previous-artifact', retainCount: 3 },
  createdAt: at,
  updatedAt: at
};

const artifact: PublishedArtifact = {
  id: 'artifact-1',
  deploymentProfileId: 'prod-deploy',
  sourceCommit: { kind: 'commit', sha: 'abc1234' },
  digest: 'sha256:digest1',
  createdAt: at,
  location: { kind: 'local-path', path: 'build-out' }
};

const manifest: PublishManifest = {
  schemaVersion: 1,
  digest: 'sha256:digest1',
  files: [{ path: 'index.html', digest: 'sha256:index', size: 100 }],
  createdAt: at
};

test('Direct deployment prepare, approve, getRun, listRuns, and health bridge parity', async t => {
  const { dir, bridge } = setup(t);
  const projectFolder = path.join(dir, 'project');
  fs.mkdirSync(projectFolder, { recursive: true });

  const runId = 'run-test-1';
  const prepared = await bridge.invoke<DeploymentRun>(
    'deployments:prepare',
    'proj-1',
    runId,
    profile,
    artifact,
    { issueKey: 'FX-1', targetUrl: 'https://example.com' }
  );

  assert.equal(prepared.runId, runId);
  assert.equal(prepared.deploymentProfileId, 'prod-deploy');
  assert.equal(prepared.status, 'prepared');
  assert.equal(prepared.issueKey, 'FX-1');
  assert.equal(prepared.targetUrl, 'https://example.com');
  assert.equal(prepared.events.length, 1);
  assert.equal(prepared.events[0].kind, 'prepared');

  const fetched = await bridge.invoke<DeploymentRun | null>('deployments:getRun', runId);
  assert.ok(fetched);
  assert.equal(fetched.runId, runId);

  const runs = await bridge.invoke<DeploymentRun[]>('deployments:listRuns', 'prod-deploy');
  assert.equal(runs.length, 1);
  assert.equal(runs[0].runId, runId);

  // Approve
  const approved = await bridge.invoke<ApproveDirectDeploymentResult>(
    'deployments:approve',
    'proj-1',
    runId,
    profile,
    artifact,
    'alice'
  );
  assert.equal(approved.ok, true);
  assert.equal(approved.run.status, 'queued');
  assert.ok(approved.run.approval);
  assert.equal(approved.run.approval.approvedBy, 'alice');

  // Approve with mismatched version should fail
  const badApprove = await bridge.invoke<ApproveDirectDeploymentResult>(
    'deployments:approve',
    'proj-1',
    runId,
    { ...profile, version: 2 },
    artifact,
    'bob'
  );
  assert.equal(badApprove.ok, false);

  // Health
  const health = await bridge.invoke<DeploymentHealthResult>('deployments:health', runId);
  assert.equal(health.status, 'queued');
});

test('Direct deployment directory execution and rollback through Rust bridge', async t => {
  const { dir, bridge } = setup(t);
  const projectFolder = path.join(dir, 'project');
  const targetDir = path.join(projectFolder, 'target-site');
  const artifactDir = path.join(projectFolder, 'build-out');
  const backupDir = path.join(projectFolder, 'backups');
  const stagingDir = path.join(projectFolder, 'staging');

  fs.mkdirSync(artifactDir, { recursive: true });
  fs.mkdirSync(backupDir, { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, 'index.html'), '<h1>Hello v1</h1>');

  const realManifest = await buildPublishManifest(artifactDir);

  const artifactWithActualPath: PublishedArtifact = {
    ...artifact,
    digest: realManifest.digest,
    location: { kind: 'local-path', path: artifactDir }
  };

  const runId = 'run-test-2';
  await bridge.invoke('deployments:prepare', 'proj-1', runId, profile, artifactWithActualPath, {});
  await bridge.invoke('deployments:approve', 'proj-1', runId, profile, artifactWithActualPath, 'alice');

  const deployResult = await bridge.invoke<RunDirectDeploymentResult>(
    'deployments:deploy',
    projectFolder,
    runId,
    profile,
    artifactWithActualPath,
    realManifest,
    {
      backupDir,
      stagingDir
    }
  );

  assert.equal(deployResult.dispatched, true);
  assert.equal(deployResult.run.status, 'succeeded');
  assert.ok(fs.existsSync(path.join(targetDir, 'index.html')));
  assert.equal(fs.readFileSync(path.join(targetDir, 'index.html'), 'utf8'), '<h1>Hello v1</h1>');

  const health = await bridge.invoke<DeploymentHealthResult>('deployments:health', runId);
  assert.equal(health.status, 'succeeded');
  assert.equal(health.healthy, true);

  // Rollback
  const rollbackResult = await bridge.invoke<RollbackDirectDeploymentResult>(
    'deployments:rollback',
    projectFolder,
    runId,
    profile,
    { backupDir }
  );
  assert.equal(rollbackResult.rolledBack, true);
  assert.equal(rollbackResult.run.status, 'rolled-back');
});
