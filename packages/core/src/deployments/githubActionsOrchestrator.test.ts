import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  prepareGitHubActionsDeployment,
  observeGitHubActionsDeployment,
  type ObserveGitHubActionsDeploymentInput
} from './githubActionsOrchestrator';
import type { DeploymentProfile, PublishedArtifact } from '../projects/deploymentProfile';
import { DeploymentRunStore } from '../projects/deploymentRunStore';
import type { GitHubActionsConfig } from '../ci/githubActionsEvidenceProvider';
import type { KeyValueStore } from '../host/stateStore';

function memoryStore(): KeyValueStore {
  const values = new Map<string, unknown>();
  return {
    get: <T>(key: string): T | undefined => values.get(key) as T | undefined,
    update: async (key: string, value: unknown): Promise<void> => {
      values.set(key, JSON.parse(JSON.stringify(value)));
    }
  };
}

function profile(overrides?: Partial<DeploymentProfile>): DeploymentProfile {
  const baseExecutor = { kind: 'github-actions' as const, workflowFile: '.github/workflows/deploy.yml', observeOnly: true };
  return {
    schemaVersion: 1,
    id: 'prof-1',
    name: 'Deploy to staging',
    projectId: 'proj-1',
    environment: 'staging',
    executor: { ...baseExecutor, ...overrides?.executor },
    target: { kind: 'directory' as const, path: '.' },
    rollback: { kind: 'none' as const },
    version: 1,
    createdAt: '2026-09-09T00:00:00Z',
    updatedAt: '2026-09-09T00:00:00Z',
    ...overrides
  };
}

function artifact(overrides?: Partial<PublishedArtifact>): PublishedArtifact {
  return {
    id: 'art-1',
    deploymentProfileId: 'prof-1',
    sourceCommit: { kind: 'commit', sha: 'abc123' },
    digest: 'sha256:deadbeef',
    createdAt: '2026-09-09T00:00:00Z',
    location: { kind: 'local-path', path: '/tmp/artifact' },
    ...overrides
  };
}

function config(overrides?: Partial<GitHubActionsConfig>): GitHubActionsConfig {
  return { baseUrl: 'https://api.github.com', owner: 'acme', repo: 'demo', token: 'ghp-test', ...overrides };
}

async function prepareAndApproveRun(
  store: DeploymentRunStore,
  prof: DeploymentProfile,
  art: PublishedArtifact
) {
  const { applyDeploymentRunCommand } = await import('../projects/deploymentRunState.js');
  let run = await prepareGitHubActionsDeployment({
    store,
    runId: 'run-1',
    profile: prof,
    artifact: art,
    now: () => '2026-09-09T00:00:00Z'
  });
  run = applyDeploymentRunCommand(run, { kind: 'request-approval', at: '2026-09-09T00:00:01Z' });
  run = applyDeploymentRunCommand(run, { kind: 'approve', at: '2026-09-09T00:00:02Z', by: 'test' });
  await store.save(run);
  return run;
}

// ── Prepare ──────────────────────────────────────────────────────────────

test('prepareGitHubActionsDeployment creates and persists a run in prepared state', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const prof = profile();
  const art = artifact();
  const result = await prepareGitHubActionsDeployment({
    store,
    runId: 'run-1',
    profile: prof,
    artifact: art,
    now: () => '2026-09-09T00:00:00Z'
  });

  assert.equal(result.status, 'prepared');
  assert.equal(result.deploymentProfileId, 'prof-1');
  assert.equal(result.artifactId, 'art-1');

  const stored = store.get('run-1');
  assert.ok(stored);
  assert.equal(stored?.status, 'prepared');
});

// ── Observe: single candidate (auto-attach) ──────────────────────────────

test('observeGitHubActionsDeployment auto-attaches when exactly one run matches', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const prof = profile();
  const art = artifact();

  await prepareAndApproveRun(store, prof, art);

  const fakeFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/workflows/')) {
      return new Response(
        JSON.stringify({
          total_count: 1,
          workflow_runs: [
            {
              id: 101,
              head_sha: 'abc123',
              name: 'Deploy',
              status: 'queued',
              conclusion: null,
              created_at: '2026-09-09T00:00:00Z',
              html_url: 'https://github.com/acme/demo/actions/runs/101',
              run_attempt: 1
            }
          ]
        }),
        { status: 200 }
      );
    }
    return new Response('{}', { status: 404 });
  };

  const result = await observeGitHubActionsDeployment({
    store,
    runId: 'run-1',
    profile: prof,
    artifact: art,
    config: config(),
    now: () => '2026-09-09T01:00:00Z',
    fetchImpl: fakeFetch
  });

  assert.equal(result.attached, true);
  assert.equal(result.run.status, 'succeeded');
  assert.ok(result.run.externalId?.includes('101'));
});

test('observeGitHubActionsDeployment returns candidates when multiple runs match', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const prof = profile();
  const art = artifact();

  await prepareAndApproveRun(store, prof, art);

  const fakeFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/workflows/')) {
      return new Response(
        JSON.stringify({
          total_count: 2,
          workflow_runs: [
            {
              id: 102,
              head_sha: 'abc123',
              name: 'Deploy',
              status: 'completed',
              conclusion: 'failure',
              created_at: '2026-09-09T02:00:00Z',
              html_url: 'https://github.com/acme/demo/actions/runs/102',
              run_attempt: 2
            },
            {
              id: 101,
              head_sha: 'abc123',
              name: 'Deploy',
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-09-09T00:00:00Z',
              html_url: 'https://github.com/acme/demo/actions/runs/101',
              run_attempt: 1
            }
          ]
        }),
        { status: 200 }
      );
    }
    return new Response('{}', { status: 404 });
  };

  const result = await observeGitHubActionsDeployment({
    store,
    runId: 'run-1',
    profile: prof,
    artifact: art,
    config: config(),
    now: () => '2026-09-09T01:00:00Z',
    fetchImpl: fakeFetch
  });

  assert.equal(result.attached, false);
  assert.ok(result.candidates);
  assert.equal(result.candidates.length, 2);
  assert.deepEqual(result.candidates[0].id, 102);
});

test('observeGitHubActionsDeployment fails when no runs match the SHA', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const prof = profile();
  const art = artifact();

  await prepareAndApproveRun(store, prof, art);

  const fakeFetch: typeof fetch = async (url) => {
    const urlStr = String(url);
    if (urlStr.includes('/workflows/')) {
      return new Response(
        JSON.stringify({
          total_count: 2,
          workflow_runs: [
            {
              id: 201,
              head_sha: 'def456',
              name: 'Deploy',
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-09-08T00:00:00Z',
              html_url: 'https://github.com/acme/demo/actions/runs/201',
              run_attempt: 1
            },
            {
              id: 200,
              head_sha: 'ghi789',
              name: 'Deploy',
              status: 'completed',
              conclusion: 'success',
              created_at: '2026-09-07T00:00:00Z',
              html_url: 'https://github.com/acme/demo/actions/runs/200',
              run_attempt: 1
            }
          ]
        }),
        { status: 200 }
      );
    }
    return new Response('{}', { status: 404 });
  };

  const result = await observeGitHubActionsDeployment({
    store,
    runId: 'run-1',
    profile: prof,
    artifact: art,
    config: config(),
    now: () => '2026-09-09T01:00:00Z',
    fetchImpl: fakeFetch
  });

  assert.equal(result.attached, false);
  assert.equal(result.run.status, 'failed');
  assert.ok(result.reason?.includes('No workflow run found'));
});

test('observeGitHubActionsDeployment is idempotent: calling on an in-flight run returns the existing state', async () => {
  const store = new DeploymentRunStore(memoryStore());
  const prof = profile();
  const art = artifact();

  // Prepare, approve, and transition to deploying
  let run = await prepareGitHubActionsDeployment({
    store,
    runId: 'run-1',
    profile: prof,
    artifact: art,
    now: () => '2026-09-09T00:00:00Z'
  });

  const { applyDeploymentRunCommand } = await import('../projects/deploymentRunState.js');
  run = applyDeploymentRunCommand(run, { kind: 'request-approval', at: '2026-09-09T00:00:01Z' });
  run = applyDeploymentRunCommand(run, { kind: 'approve', at: '2026-09-09T00:00:02Z', by: 'test' });
  run = applyDeploymentRunCommand(run, { kind: 'start-deploying', at: '2026-09-09T00:01:00Z' });
  await store.save(run);

  const fakeFetch: typeof fetch = async () => {
    throw new Error('should not fetch during idempotent call');
  };

  const result = await observeGitHubActionsDeployment({
    store,
    runId: 'run-1',
    profile: prof,
    artifact: art,
    config: config(),
    now: () => '2026-09-09T01:00:00Z',
    fetchImpl: fakeFetch
  });

  assert.equal(result.attached, false);
  assert.equal(result.run.status, 'deploying');
  assert.ok(result.reason?.includes('not queued'));
});
