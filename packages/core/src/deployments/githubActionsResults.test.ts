import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  GitHubActionsResults,
  GitHubActionsResultsError,
  type WorkflowJobResult
} from './githubActionsResults';
import type { GitHubActionsConfig } from '../ci/githubActionsEvidenceProvider';

function config(overrides?: Partial<GitHubActionsConfig>): GitHubActionsConfig {
  return { baseUrl: 'https://api.github.com', owner: 'acme', repo: 'demo', token: 'ghp-test', ...overrides };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

// ── getRunJobs ────────────────────────────────────────────────────────────

test('getRunJobs fetches and normalizes job list for a run', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      jobs: [
        {
          id: 1,
          name: 'Build',
          status: 'completed',
          conclusion: 'success',
          started_at: '2026-09-09T00:00:00Z',
          completed_at: '2026-09-09T00:05:00Z',
          html_url: 'https://github.com/acme/demo/runs/1'
        },
        {
          id: 2,
          name: 'Test',
          status: 'completed',
          conclusion: 'failure',
          started_at: '2026-09-09T00:05:00Z',
          completed_at: '2026-09-09T00:10:00Z',
          html_url: 'https://github.com/acme/demo/runs/2'
        }
      ]
    });

  const results = new GitHubActionsResults(config(), fakeFetch);
  const jobs = await results.getRunJobs(101, 1);

  assert.equal(jobs.length, 2);
  assert.deepEqual(jobs[0], {
    id: 1,
    name: 'Build',
    status: 'completed',
    conclusion: 'success',
    startedAt: '2026-09-09T00:00:00Z',
    completedAt: '2026-09-09T00:05:00Z',
    htmlUrl: 'https://github.com/acme/demo/runs/1'
  });
  assert.equal(jobs[1].conclusion, 'failure');
});

test('getRunJobs handles cancelled job (conclusion=cancelled)', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      jobs: [
        {
          id: 1,
          name: 'Deploy',
          status: 'completed',
          conclusion: 'cancelled',
          started_at: '2026-09-09T00:00:00Z',
          completed_at: '2026-09-09T00:01:00Z',
          html_url: 'https://github.com/acme/demo/runs/1'
        }
      ]
    });

  const results = new GitHubActionsResults(config(), fakeFetch);
  const jobs = await results.getRunJobs(101);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].conclusion, 'cancelled');
});

test('getRunJobs handles job in progress (no conclusion yet)', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      jobs: [
        {
          id: 1,
          name: 'Deploy',
          status: 'in_progress',
          conclusion: null,
          started_at: '2026-09-09T00:00:00Z',
          completed_at: null,
          html_url: 'https://github.com/acme/demo/runs/1'
        }
      ]
    });

  const results = new GitHubActionsResults(config(), fakeFetch);
  const jobs = await results.getRunJobs(101);

  assert.equal(jobs.length, 1);
  assert.equal(jobs[0].status, 'in_progress');
  assert.equal(jobs[0].conclusion, null);
});

// ── getRunResults ──────────────────────────────────────────────────────────

test('getRunResults separates workflow success from job outcomes', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      jobs: [
        {
          id: 1,
          name: 'Deploy',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/acme/demo/runs/1'
        },
        {
          id: 2,
          name: 'HealthCheck',
          status: 'completed',
          conclusion: 'failure',
          html_url: 'https://github.com/acme/demo/runs/2'
        }
      ]
    });

  const results = new GitHubActionsResults(config(), fakeFetch);
  const outcome = await results.getRunResults(101, 'completed', 'failure', 'https://github.com/acme/demo/runs/101');

  assert.equal(outcome.runConclusion, 'failure');
  assert.equal(outcome.workflowFailed, true);
  assert.equal(outcome.jobs.length, 2);
  assert.ok(outcome.providerUrls.workflowRunUrl.includes('101'));
  assert.ok(outcome.providerUrls.jobUrls.has(1));
  assert.ok(outcome.providerUrls.jobUrls.has(2));
});

test('getRunResults marks workflow as succeeded when conclusion is success', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      jobs: [
        {
          id: 1,
          name: 'Deploy',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/acme/demo/runs/1'
        }
      ]
    });

  const results = new GitHubActionsResults(config(), fakeFetch);
  const outcome = await results.getRunResults(101, 'completed', 'success', 'https://github.com/acme/demo/runs/101');

  assert.equal(outcome.workflowFailed, false);
});

// ── fetchJobLog: success and expired logs ────────────────────────────────

test('fetchJobLog returns logs on success', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response('2026-09-09T00:00:00Z [INFO] Deploying...\n2026-09-09T00:00:05Z [INFO] Done.', { status: 200 });

  const results = new GitHubActionsResults(config(), fakeFetch);
  const log = await results.fetchJobLog(1);

  assert.equal(log.jobId, 1);
  assert.ok(log.content.includes('Deploying'));
  assert.equal(log.expired, false);
  assert.equal(log.error, undefined);
});

test('fetchJobLog marks logs as expired on 404', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Not Found"}', { status: 404 });

  const results = new GitHubActionsResults(config(), fakeFetch);
  const log = await results.fetchJobLog(1);

  assert.equal(log.jobId, 1);
  assert.equal(log.content, '');
  assert.equal(log.expired, true);
  assert.equal(log.error, undefined);
});

test('fetchJobLog marks logs as expired on 410 (Gone)', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Gone"}', { status: 410 });

  const results = new GitHubActionsResults(config(), fakeFetch);
  const log = await results.fetchJobLog(1);

  assert.equal(log.expired, true);
});

test('fetchJobLog reports permission error on 403', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Forbidden"}', { status: 403 });

  const results = new GitHubActionsResults(config(), fakeFetch);
  const log = await results.fetchJobLog(1);

  assert.equal(log.expired, false);
  assert.ok(log.error?.includes('permission'));
  assert.equal(log.content, '');
});

// ── fetchJobLog: backoff and retry ──────────────────────────────────────

test('fetchJobLog retries on 429 (rate limit) with backoff', async () => {
  let attempts = 0;
  const fakeFetch: typeof fetch = async () => {
    attempts++;
    if (attempts < 3) {
      return new Response('{"message":"Too Many Requests"}', { status: 429 });
    }
    return new Response('Retry succeeded', { status: 200 });
  };

  const results = new GitHubActionsResults(config(), fakeFetch);
  const log = await results.fetchJobLog(1, { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50 });

  assert.equal(attempts, 3);
  assert.ok(log.content.includes('succeeded'));
  assert.equal(log.error, undefined);
});

test('fetchJobLog retries on 503 (service unavailable) with backoff', async () => {
  let attempts = 0;
  const fakeFetch: typeof fetch = async () => {
    attempts++;
    if (attempts === 1) {
      return new Response('Service Unavailable', { status: 503 });
    }
    return new Response('Log content', { status: 200 });
  };

  const results = new GitHubActionsResults(config(), fakeFetch);
  const log = await results.fetchJobLog(1, { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50 });

  assert.equal(attempts, 2);
  assert.equal(log.content, 'Log content');
});

test('fetchJobLog gives up after max attempts', async () => {
  const fakeFetch: typeof fetch = async () => new Response('Server Error', { status: 500 });

  const results = new GitHubActionsResults(config(), fakeFetch);
  const log = await results.fetchJobLog(1, { maxAttempts: 2, initialDelayMs: 10, maxDelayMs: 50 });

  assert.equal(log.expired, false);
  assert.ok(log.error?.includes('after 2 attempts'));
});

// ── fetchJobLog: network errors ────────────────────────────────────────

test('fetchJobLog retries on network errors (socket hang up)', async () => {
  let attempts = 0;
  const fakeFetch: typeof fetch = async () => {
    attempts++;
    if (attempts < 2) {
      throw new Error('socket hang up');
    }
    return new Response('Success after retry', { status: 200 });
  };

  const results = new GitHubActionsResults(config(), fakeFetch);
  const log = await results.fetchJobLog(1, { maxAttempts: 3, initialDelayMs: 10, maxDelayMs: 50 });

  assert.equal(attempts, 2);
  assert.equal(log.content, 'Success after retry');
});

test('fetchJobLog reports non-transient exceptions', async () => {
  const fakeFetch: typeof fetch = async () => {
    throw new Error('Invalid URL format');
  };

  const results = new GitHubActionsResults(config(), fakeFetch);
  const log = await results.fetchJobLog(1, { maxAttempts: 1 });

  assert.ok(log.error?.includes('Invalid URL'));
});

// ── Approval wait scenario ────────────────────────────────────────────────

test('workflow with queued job (waiting for approval/runner) normalizes correctly', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      jobs: [
        {
          id: 1,
          name: 'Approve and Deploy',
          status: 'queued',
          conclusion: null,
          started_at: null,
          completed_at: null,
          html_url: 'https://github.com/acme/demo/runs/1'
        }
      ]
    });

  const results = new GitHubActionsResults(config(), fakeFetch);
  const jobs = await results.getRunJobs(101);

  assert.equal(jobs[0].status, 'queued');
  assert.equal(jobs[0].conclusion, null);
  assert.equal(jobs[0].startedAt, null);
});

// ── Successful pipeline with unhealthy app ──────────────────────────────

test('successful workflow (all jobs passed) can still have failed health check', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      jobs: [
        { id: 1, name: 'Deploy', status: 'completed', conclusion: 'success', html_url: 'https://github.com/acme/demo/runs/1' },
        { id: 2, name: 'HealthCheck', status: 'completed', conclusion: 'failure', html_url: 'https://github.com/acme/demo/runs/2' }
      ]
    });

  const results = new GitHubActionsResults(config(), fakeFetch);
  const outcome = await results.getRunResults(101, 'completed', 'failure', 'https://github.com/acme/demo/runs/101');

  // Workflow failed (conclusion=failure), even though deploy job succeeded
  assert.equal(outcome.workflowFailed, true);
  // But we can distinguish: deploy succeeded, health check failed
  assert.equal(outcome.jobs[0].conclusion, 'success');
  assert.equal(outcome.jobs[1].conclusion, 'failure');
});

// ── Reconnect to same external run ──────────────────────────────────────

test('fetching results twice for same run returns same data (reconnect idempotent)', async () => {
  let fetchCount = 0;
  const fakeFetch: typeof fetch = async () => {
    fetchCount++;
    return jsonResponse({
      jobs: [
        {
          id: 1,
          name: 'Deploy',
          status: 'completed',
          conclusion: 'success',
          html_url: 'https://github.com/acme/demo/runs/1'
        }
      ]
    });
  };

  const results = new GitHubActionsResults(config(), fakeFetch);
  const first = await results.getRunResults(101, 'completed', 'success', 'https://github.com/acme/demo/runs/101');
  const second = await results.getRunResults(101, 'completed', 'success', 'https://github.com/acme/demo/runs/101');

  assert.equal(fetchCount, 2);
  assert.deepEqual(first.runId, second.runId);
  assert.deepEqual(first.jobs[0].id, second.jobs[0].id);
  assert.deepEqual(first.providerUrls.workflowRunUrl, second.providerUrls.workflowRunUrl);
});
