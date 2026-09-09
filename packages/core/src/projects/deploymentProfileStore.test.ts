import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOYMENT_PROFILES_DIR,
  allCredentialsBound,
  evaluateCredentialBindings,
  listDeploymentProfiles,
  readDeploymentProfile,
  writeDeploymentProfile
} from './deploymentProfileStore';
import { DEPLOYMENT_PROFILE_SCHEMA_VERSION, type DeploymentProfile } from './deploymentProfile';

function profile(overrides: Partial<DeploymentProfile> = {}): DeploymentProfile {
  const at = '2026-09-09T00:00:00.000Z';
  return {
    schemaVersion: DEPLOYMENT_PROFILE_SCHEMA_VERSION,
    version: 1,
    id: 'production',
    name: 'Production',
    projectId: 'proj-1',
    environment: 'production',
    executor: { kind: 'direct-process' },
    target: { kind: 'directory', path: 'dist' },
    rollback: { kind: 'none' },
    createdAt: at,
    updatedAt: at,
    ...overrides
  };
}

test('reading a project with no deployment profile comes back with no profile and no issues', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-deploy-'));
  try {
    assert.deepEqual(await readDeploymentProfile(dir, 'production'), { issues: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a profile written then read back round-trips unchanged', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-deploy-'));
  try {
    await writeDeploymentProfile(dir, profile());
    const result = await readDeploymentProfile(dir, 'production');
    assert.deepEqual(result.issues, []);
    assert.deepEqual(result.profile, profile());
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('writeDeploymentProfile refuses an invalid profile before touching disk', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-deploy-'));
  try {
    const invalid = profile({ target: { kind: 'directory', path: '/absolute/path' } });
    await assert.rejects(() => writeDeploymentProfile(dir, invalid), /is invalid/);
    assert.deepEqual(await readDeploymentProfile(dir, 'production'), { issues: [] });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a hand-edited malformed deployment profile comes back with a visible reason, not a silent empty result', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-deploy-'));
  try {
    await mkdir(path.join(dir, DEPLOYMENT_PROFILES_DIR), { recursive: true });
    await writeFile(path.join(dir, DEPLOYMENT_PROFILES_DIR, 'production.deployment.praxis.json'), 'not valid json', 'utf8');
    const result = await readDeploymentProfile(dir, 'production');
    assert.equal(result.profile, undefined);
    assert.ok(result.issues.length > 0);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('rewriting a profile overwrites the file rather than appending to it', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-deploy-'));
  try {
    await writeDeploymentProfile(dir, profile());
    await writeDeploymentProfile(dir, profile({ name: 'Production (renamed)' }));
    const result = await readDeploymentProfile(dir, 'production');
    assert.equal(result.profile?.name, 'Production (renamed)');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listDeploymentProfiles returns every valid profile in the project and skips a malformed one', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-deploy-'));
  try {
    await writeDeploymentProfile(dir, profile({ id: 'staging', name: 'Staging' }));
    await writeDeploymentProfile(dir, profile({ id: 'production', name: 'Production' }));
    await writeFile(path.join(dir, DEPLOYMENT_PROFILES_DIR, 'broken.deployment.praxis.json'), 'not json', 'utf8');
    const profiles = await listDeploymentProfiles(dir);
    assert.equal(profiles.length, 2);
    assert.deepEqual(
      profiles.map(p => p.id).sort(),
      ['production', 'staging']
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('listDeploymentProfiles on a project with none comes back empty, not an error', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'praxis-deploy-'));
  try {
    assert.deepEqual(await listDeploymentProfiles(dir), []);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('evaluateCredentialBindings: on a fresh machine with an empty secret store, every credential comes back unbound — this is the "rebind secrets explicitly" behavior', async () => {
  const p = profile({ credentials: { DEPLOY_TOKEN: '${secret:deploy-token}', API_KEY: '${secret:api-key}' } });
  const emptyStore = async (_name: string): Promise<string | undefined> => undefined;
  const statuses = await evaluateCredentialBindings(p, emptyStore);
  assert.equal(statuses.length, 2);
  assert.ok(statuses.every(s => s.bound === false));
  assert.equal(allCredentialsBound(statuses), false);
});

test('evaluateCredentialBindings: once every referenced secret exists on this machine, every credential is bound', async () => {
  const p = profile({ credentials: { DEPLOY_TOKEN: '${secret:deploy-token}', API_KEY: '${secret:api-key}' } });
  const values: Record<string, string> = { 'deploy-token': 'ghp_xxx', 'api-key': 'sk_xxx' };
  const populatedStore = async (name: string): Promise<string | undefined> => values[name];
  const statuses = await evaluateCredentialBindings(p, populatedStore);
  assert.ok(statuses.every(s => s.bound === true));
  assert.equal(allCredentialsBound(statuses), true);
});

test('evaluateCredentialBindings: a partially-bound machine (one secret present, one missing) reports each credential independently', async () => {
  const p = profile({ credentials: { DEPLOY_TOKEN: '${secret:deploy-token}', API_KEY: '${secret:api-key}' } });
  const partial = async (name: string): Promise<string | undefined> => (name === 'deploy-token' ? 'ghp_xxx' : undefined);
  const statuses = await evaluateCredentialBindings(p, partial);
  const byKey = Object.fromEntries(statuses.map(s => [s.key, s.bound]));
  assert.equal(byKey.DEPLOY_TOKEN, true);
  assert.equal(byKey.API_KEY, false);
  assert.equal(allCredentialsBound(statuses), false);
});

test('evaluateCredentialBindings on a profile with no credentials comes back empty, and vacuously "all bound"', async () => {
  const statuses = await evaluateCredentialBindings(profile(), async () => undefined);
  assert.deepEqual(statuses, []);
  assert.equal(allCredentialsBound(statuses), true);
});

test('a secret store returning an empty string is treated as unbound, not bound', async () => {
  const p = profile({ credentials: { DEPLOY_TOKEN: '${secret:deploy-token}' } });
  const statuses = await evaluateCredentialBindings(p, async () => '');
  assert.equal(statuses[0].bound, false);
});
