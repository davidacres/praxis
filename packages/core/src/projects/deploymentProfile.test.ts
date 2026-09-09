import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  DEPLOYMENT_PROFILE_SCHEMA_VERSION,
  preflightDeploymentCapabilities,
  validateDeploymentProfile,
  type DeploymentProfile,
  type ExecutorRef,
  type TargetRef
} from './deploymentProfile';

function profile(overrides: Partial<DeploymentProfile> = {}): DeploymentProfile {
  const at = '2026-09-09T00:00:00.000Z';
  return {
    schemaVersion: DEPLOYMENT_PROFILE_SCHEMA_VERSION,
    id: 'prod-deploy',
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

test('a direct-process executor with a directory target is schema-valid and preflight-clean', () => {
  const { valid, errors } = validateDeploymentProfile(profile());
  assert.equal(valid, true);
  assert.deepEqual(errors, []);
  assert.deepEqual(preflightDeploymentCapabilities(profile()), []);
});

test('a direct-process executor with a local-process target is schema-valid and preflight-clean', () => {
  const local = profile({ target: { kind: 'local-process', executable: 'node', args: ['server.js'] } });
  assert.equal(validateDeploymentProfile(local).valid, true);
  assert.deepEqual(preflightDeploymentCapabilities(local), []);
});

test('a github-actions executor with an iis target is schema-valid — this feature does not implement either, but the shape is accepted', () => {
  const p = profile({
    executor: { kind: 'github-actions', workflowFile: '.github/workflows/deploy.yml' },
    target: { kind: 'iis', siteName: 'Default Web Site' }
  });
  assert.equal(validateDeploymentProfile(p).valid, true);
});

test('unsupported executor/target capabilities fail preflight even though the profile is schema-valid', () => {
  const p = profile({
    executor: { kind: 'github-actions', workflowFile: '.github/workflows/deploy.yml' },
    target: { kind: 'iis', siteName: 'Default Web Site' }
  });
  assert.equal(validateDeploymentProfile(p).valid, true, 'schema-valid despite being unsupported to run');
  const issues = preflightDeploymentCapabilities(p);
  assert.equal(issues.length, 2);
  assert.ok(issues.some(issue => issue.path === 'executor.kind' && /github-actions/.test(issue.message)));
  assert.ok(issues.some(issue => issue.path === 'target.kind' && /iis/.test(issue.message)));
});

test('a gitlab-ci executor is also schema-valid but fails preflight as unsupported', () => {
  const p = profile({ executor: { kind: 'gitlab-ci', pipelineFile: '.gitlab-ci.yml' } });
  assert.equal(validateDeploymentProfile(p).valid, true);
  const issues = preflightDeploymentCapabilities(p);
  assert.equal(issues.length, 1);
  assert.match(issues[0].message, /gitlab-ci/);
});

test('the project\'s issue tracker never enters this schema — two projects on different trackers validate identically for the same executor/target', () => {
  // projectId is an opaque reference; nothing here reads or branches on tracker kind.
  // A "jira-tracked-project" and a "folder-tracked-project" are simulated only by
  // their projectId — the schema has no field that could distinguish them anyway.
  const jiraTracked = profile({ projectId: 'jira-project-1' });
  const folderTracked = profile({ projectId: 'folder-project-1' });
  assert.deepEqual(validateDeploymentProfile(jiraTracked), validateDeploymentProfile(folderTracked));
  assert.deepEqual(preflightDeploymentCapabilities(jiraTracked), preflightDeploymentCapabilities(folderTracked));
});

test('an unknown executor kind fails validation with a clear message', () => {
  const p = profile({ executor: { kind: 'ftp' } as unknown as ExecutorRef });
  const { valid, errors } = validateDeploymentProfile(p);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.path === 'executor.kind'));
});

test('an unknown target kind fails validation with a clear message', () => {
  const p = profile({ target: { kind: 's3-bucket' } as unknown as TargetRef });
  const { valid, errors } = validateDeploymentProfile(p);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.path === 'target.kind'));
});

test('a github-actions executor missing workflowFile fails validation', () => {
  const p = profile({ executor: { kind: 'github-actions', workflowFile: '' } });
  const { valid, errors } = validateDeploymentProfile(p);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.path === 'executor.workflowFile'));
});

test('a gitlab-ci executor missing pipelineFile fails validation', () => {
  const p = profile({ executor: { kind: 'gitlab-ci', pipelineFile: '' } });
  const { valid, errors } = validateDeploymentProfile(p);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.path === 'executor.pipelineFile'));
});

test('a local-process target missing executable fails validation', () => {
  const p = profile({ target: { kind: 'local-process', executable: '' } });
  const { valid, errors } = validateDeploymentProfile(p);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.path === 'target.executable'));
});

test('a directory target missing path fails validation', () => {
  const p = profile({ target: { kind: 'directory', path: '' } });
  const { valid, errors } = validateDeploymentProfile(p);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.path === 'target.path'));
});

test('an iis target missing siteName fails validation', () => {
  const p = profile({ target: { kind: 'iis', siteName: '' } });
  const { valid, errors } = validateDeploymentProfile(p);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.path === 'target.siteName'));
});

test('required top-level fields are checked: id, name, projectId, environment', () => {
  const { errors } = validateDeploymentProfile(profile({ id: '', name: '', projectId: '', environment: '' }));
  const paths = errors.map(e => e.path);
  assert.ok(paths.includes('id'));
  assert.ok(paths.includes('name'));
  assert.ok(paths.includes('projectId'));
  assert.ok(paths.includes('environment'));
});

test('an unknown rollback kind fails validation', () => {
  const p = profile({ rollback: { kind: 'archive-forever' } as unknown as DeploymentProfile['rollback'] });
  const { valid, errors } = validateDeploymentProfile(p);
  assert.equal(valid, false);
  assert.ok(errors.some(e => e.path === 'rollback.kind'));
});

test('keep-previous-artifact accepts a positive integer retainCount and rejects a non-positive or fractional one', () => {
  assert.equal(validateDeploymentProfile(profile({ rollback: { kind: 'keep-previous-artifact', retainCount: 3 } })).valid, true);
  assert.equal(validateDeploymentProfile(profile({ rollback: { kind: 'keep-previous-artifact' } })).valid, true, 'retainCount is optional');
  assert.equal(validateDeploymentProfile(profile({ rollback: { kind: 'keep-previous-artifact', retainCount: 0 } })).valid, false);
  assert.equal(validateDeploymentProfile(profile({ rollback: { kind: 'keep-previous-artifact', retainCount: -1 } })).valid, false);
  assert.equal(validateDeploymentProfile(profile({ rollback: { kind: 'keep-previous-artifact', retainCount: 1.5 } })).valid, false);
});

test('a rollback of "none" ignores retainCount entirely', () => {
  assert.equal(validateDeploymentProfile(profile({ rollback: { kind: 'none' } })).valid, true);
});

test('a profile with a health check (reusing the RunReadinessProbe shape) validates the same as one without', () => {
  const withHealth = profile({ healthCheck: { kind: 'http', path: '/healthz', expectedStatus: 200 } });
  assert.equal(validateDeploymentProfile(withHealth).valid, true);
});
