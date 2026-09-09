import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubActionsObserver,
  GitHubActionsObserverError,
  type WorkflowRunCandidate
} from './githubActionsObserver';
import type { GitHubActionsConfig } from '../ci/githubActionsEvidenceProvider';

function config(overrides?: Partial<GitHubActionsConfig>): GitHubActionsConfig {
  return { baseUrl: 'https://api.github.com', owner: 'acme', repo: 'demo', token: 'ghp-test', ...overrides };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

// ── listWorkflowRuns ────────────────────────────────────────────────────

test('listWorkflowRuns lists runs for a workflow, normalized', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      total_count: 2,
      workflow_runs: [
        { id: 101, head_sha: 'abc123', name: 'Deploy', status: 'completed', conclusion: 'success', created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/demo/actions/runs/101', run_attempt: 1 },
        { id: 100, head_sha: 'def456', name: 'Deploy', status: 'in_progress', conclusion: null, created_at: '2026-09-08T00:00:00Z', html_url: 'https://github.com/acme/demo/actions/runs/100', run_attempt: 1 }
      ]
    });
  const observer = new GitHubActionsObserver(config(), fakeFetch);
  const result = await observer.listWorkflowRuns(1);
  assert.ok(result);
  assert.equal(result.runs.length, 2);
  assert.deepEqual(result.runs[0], {
    id: 101,
    attempt: 1,
    sha: 'abc123',
    workflowName: 'Deploy',
    status: 'completed',
    conclusion: 'success',
    createdAt: '2026-09-09T00:00:00Z',
    htmlUrl: 'https://github.com/acme/demo/actions/runs/101'
  });
});

test('listWorkflowRuns returns null if workflow does not exist (404)', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Not Found"}', { status: 404 });
  const observer = new GitHubActionsObserver(config(), fakeFetch);
  const result = await observer.listWorkflowRuns(999);
  assert.equal(result, null);
});

test('listWorkflowRuns reports other errors normally', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Internal Server Error"}', { status: 500 });
  const observer = new GitHubActionsObserver(config(), fakeFetch);
  await assert.rejects(
    () => observer.listWorkflowRuns(1),
    (error: unknown) => error instanceof Error && /HTTP 500/.test(error.message)
  );
});

// ── correlateWorkflowRun: pagination and filtering ─────────────────────

test('correlateWorkflowRun returns single-candidate when exactly one run matches the SHA', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      total_count: 3,
      workflow_runs: [
        { id: 103, head_sha: 'zzz999', name: 'Deploy', status: 'completed', conclusion: 'success', created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/demo/actions/runs/103', run_attempt: 1 },
        { id: 102, head_sha: 'abc123', name: 'Deploy', status: 'completed', conclusion: 'success', created_at: '2026-09-08T00:00:00Z', html_url: 'https://github.com/acme/demo/actions/runs/102', run_attempt: 1 },
        { id: 101, head_sha: 'def456', name: 'Deploy', status: 'in_progress', conclusion: null, created_at: '2026-09-07T00:00:00Z', html_url: 'https://github.com/acme/demo/actions/runs/101', run_attempt: 1 }
      ]
    });
  const observer = new GitHubActionsObserver(config(), fakeFetch);
  const outcome = await observer.correlateWorkflowRun(1, { kind: 'commit', sha: 'abc123' });
  assert.equal(outcome.kind, 'single-candidate');
  assert.equal((outcome as any).run.id, 102);
});

test('correlateWorkflowRun returns multiple-candidates when multiple runs match the SHA', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      total_count: 4,
      workflow_runs: [
        { id: 104, head_sha: 'abc123', name: 'Deploy', status: 'completed', conclusion: 'failure', created_at: '2026-09-09T02:00:00Z', html_url: 'https://github.com/acme/demo/actions/runs/104', run_attempt: 2 },
        { id: 103, head_sha: 'abc123', name: 'Deploy', status: 'completed', conclusion: 'success', created_at: '2026-09-09T00:00:00Z', html_url: 'https://github.com/acme/demo/actions/runs/103', run_attempt: 1 },
        { id: 102, head_sha: 'def456', name: 'Deploy', status: 'completed', conclusion: 'success', created_at: '2026-09-08T00:00:00Z', html_url: 'https://github.com/acme/demo/actions/runs/102', run_attempt: 1 },
        { id: 101, head_sha: 'ghi789', name: 'Deploy', status: 'in_progress', conclusion: null, created_at: '2026-09-07T00:00:00Z', html_url: 'https://github.com/acme/demo/actions/runs/101', run_attempt: 1 }
      ]
    });
  const observer = new GitHubActionsObserver(config(), fakeFetch);
  const outcome = await observer.correlateWorkflowRun(1, { kind: 'commit', sha: 'abc123' });
  assert.equal(outcome.kind, 'multiple-candidates');
  const candidates = (outcome as any).runs;
  assert.equal(candidates.length, 2);
  assert.deepEqual(
    candidates.map((r: any) => r.id),
    [104, 103]
  );
});

test('correlateWorkflowRun returns no-candidates when no runs match the SHA', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      total_count: 2,
      workflow_runs: [
        { id: 102, head_sha: 'def456', name: 'Deploy', status: 'completed', conclusion: 'success', created_at: '2026-09-08T00:00:00Z', html_url: 'https://github.com/acme/demo/actions/runs/102', run_attempt: 1 },
        { id: 101, head_sha: 'ghi789', name: 'Deploy', status: 'in_progress', conclusion: null, created_at: '2026-09-07T00:00:00Z', html_url: 'https://github.com/acme/demo/actions/runs/101', run_attempt: 1 }
      ]
    });
  const observer = new GitHubActionsObserver(config(), fakeFetch);
  const outcome = await observer.correlateWorkflowRun(1, { kind: 'commit', sha: 'abc123' });
  assert.equal(outcome.kind, 'no-candidates');
});

test('correlateWorkflowRun rejects non-commit source refs', async () => {
  const fakeFetch: typeof fetch = async () => {
    throw new Error('should not fetch');
  };
  const observer = new GitHubActionsObserver(config(), fakeFetch);
  const outcome = await observer.correlateWorkflowRun(1, { kind: 'unknown' });
  assert.equal(outcome.kind, 'no-candidates');
});

test('correlateWorkflowRun returns no-candidates if workflow does not exist', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Not Found"}', { status: 404 });
  const observer = new GitHubActionsObserver(config(), fakeFetch);
  const outcome = await observer.correlateWorkflowRun(999, { kind: 'commit', sha: 'abc123' });
  assert.equal(outcome.kind, 'no-candidates');
});

// ── Error classification ────────────────────────────────────────────────

test('insufficient permission (403, no rate-limit signal) is classified correctly', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Forbidden"}', { status: 403 });
  const observer = new GitHubActionsObserver(config(), fakeFetch);
  await assert.rejects(
    () => observer.listWorkflowRuns(1),
    (error: unknown) => error instanceof GitHubActionsObserverError && error.kind === 'insufficient-permission'
  );
});

test('rate limit (429) is classified correctly', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Too Many Requests"}', { status: 429 });
  const observer = new GitHubActionsObserver(config(), fakeFetch);
  await assert.rejects(
    () => observer.listWorkflowRuns(1),
    (error: unknown) => error instanceof GitHubActionsObserverError && error.kind === 'rate-limited'
  );
});

test('rate limit via 403 + X-RateLimit-Remaining: 0 is classified as rate-limited', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response('{"message":"API rate limit exceeded"}', { status: 403, headers: { 'X-RateLimit-Remaining': '0' } });
  const observer = new GitHubActionsObserver(config(), fakeFetch);
  await assert.rejects(
    () => observer.listWorkflowRuns(1),
    (error: unknown) => error instanceof GitHubActionsObserverError && error.kind === 'rate-limited'
  );
});
