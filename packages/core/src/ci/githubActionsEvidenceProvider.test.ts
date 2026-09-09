import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubActionsEvidenceProvider, type GitHubActionsConfig } from './githubActionsEvidenceProvider';

function config(overrides?: Partial<GitHubActionsConfig>): GitHubActionsConfig {
  return { baseUrl: 'https://api.github.com', owner: 'acme', repo: 'demo', token: 'ghp-test', ...overrides };
}

function jsonResponse(body: unknown, init?: ResponseInit): Response {
  return new Response(JSON.stringify(body), { status: 200, ...init });
}

test('listFailedRuns paginates using total_count, and filters out runs that are not a failure shape', async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async url => {
    calls.push(String(url));
    const page = new URL(String(url)).searchParams.get('page');
    if (page === '1') {
      return jsonResponse({
        total_count: 3,
        workflow_runs: [
          { id: 1, run_attempt: 1, head_sha: 'a'.repeat(40), conclusion: 'failure', created_at: '2026-01-01T00:00:00Z', name: 'CI' },
          { id: 2, run_attempt: 1, head_sha: 'b'.repeat(40), conclusion: 'success', created_at: '2026-01-02T00:00:00Z', name: 'CI' }
        ]
      });
    }
    return jsonResponse({
      total_count: 3,
      workflow_runs: [
        { id: 3, run_attempt: 2, head_sha: 'c'.repeat(40), conclusion: 'cancelled', created_at: '2026-01-03T00:00:00Z', name: 'CI' }
      ]
    });
  };

  const provider = new GitHubActionsEvidenceProvider(config(), fakeFetch);
  const page1 = await provider.listFailedRuns(1, 2);
  assert.equal(page1.runs.length, 1); // the 'success' run is excluded
  assert.equal(page1.runs[0].runId, '1');
  assert.equal(page1.hasMore, true); // 1 * 2 < 3

  const page2 = await provider.listFailedRuns(2, 2);
  assert.equal(page2.runs.length, 1);
  assert.equal(page2.runs[0].runId, '3');
  assert.equal(page2.hasMore, false); // 2 * 2 >= 3

  assert.equal(calls.length, 2);
});

test('a run missing head_sha reports an explicit unknown source, never a guessed one', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse({
      total_count: 1,
      workflow_runs: [{ id: 1, run_attempt: 1, conclusion: 'failure', created_at: '2026-01-01T00:00:00Z', name: 'CI' }]
    });
  const provider = new GitHubActionsEvidenceProvider(config(), fakeFetch);
  const { runs } = await provider.listFailedRuns(1);
  assert.deepEqual(runs[0].source, { kind: 'unknown' });
});

test('listJobs is scoped to the requested attempt, not "whatever is latest"', async () => {
  let requestedUrl = '';
  const fakeFetch: typeof fetch = async url => {
    requestedUrl = String(url);
    return jsonResponse({ jobs: [{ id: 10, name: 'build', conclusion: 'failure', html_url: 'https://x' }] });
  };
  const provider = new GitHubActionsEvidenceProvider(config(), fakeFetch);
  const jobs = await provider.listJobs('42', 2);
  assert.match(requestedUrl, /\/actions\/runs\/42\/attempts\/2\/jobs/);
  assert.equal(jobs[0].jobId, '10');
});

test('listFailedRuns surfaces a missing-permissions 403 rather than an empty list', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"Forbidden"}', { status: 403, statusText: 'Forbidden' });
  const provider = new GitHubActionsEvidenceProvider(config(), fakeFetch);
  await assert.rejects(() => provider.listFailedRuns(1), /No permission to read Actions runs.*403/);
});

test('getJobLog reports 404/410 as an explicit expired state, not an error', async () => {
  const notFound = new GitHubActionsEvidenceProvider(config(), async () => new Response('', { status: 404 }));
  assert.deepEqual(await notFound.getJobLog('1'), { content: '', expired: true });

  const gone = new GitHubActionsEvidenceProvider(config(), async () => new Response('', { status: 410 }));
  assert.deepEqual(await gone.getJobLog('1'), { content: '', expired: true });
});

test('getJobLog surfaces a missing-permissions 403 distinctly from an expired log', async () => {
  const provider = new GitHubActionsEvidenceProvider(config(), async () => new Response('', { status: 403 }));
  await assert.rejects(() => provider.getJobLog('1'), /No permission to read this job.s log.*403/);
});

test('getJobLog returns the raw log text on success', async () => {
  const provider = new GitHubActionsEvidenceProvider(config(), async () => new Response('line one\nline two\n', { status: 200 }));
  const result = await provider.getJobLog('1');
  assert.deepEqual(result, { content: 'line one\nline two\n', expired: false });
});

test('a missing owner or repo throws before any network attempt', async () => {
  const unreachable: typeof fetch = () => {
    throw new Error('must not be called');
  };
  const provider = new GitHubActionsEvidenceProvider(config({ owner: '' }), unreachable);
  await assert.rejects(() => provider.listFailedRuns(1), /No GitHub repository is configured/);
});
