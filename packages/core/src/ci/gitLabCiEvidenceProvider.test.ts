import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitLabCiEvidenceProvider, type GitLabCiConfig } from './gitLabCiEvidenceProvider';

function config(overrides?: Partial<GitLabCiConfig>): GitLabCiConfig {
  return { baseUrl: 'https://gitlab.com/api/v4', projectPath: 'acme/demo', token: 'glpat-test', ...overrides };
}

function jsonResponse(body: unknown, headers?: Record<string, string>): Response {
  return new Response(JSON.stringify(body), { status: 200, headers });
}

test('listFailedRuns follows GitLab\'s x-next-page header, and reports no next page as no more', async () => {
  const calls: string[] = [];
  const fakeFetch: typeof fetch = async url => {
    calls.push(String(url));
    const page = new URL(String(url)).searchParams.get('page');
    if (page === '1') {
      return jsonResponse(
        [{ id: 100, sha: 'a'.repeat(40), status: 'failed', created_at: '2026-01-01T00:00:00Z', ref: 'main' }],
        { 'x-next-page': '2' }
      );
    }
    return jsonResponse([{ id: 101, sha: 'b'.repeat(40), status: 'failed', created_at: '2026-01-02T00:00:00Z', ref: 'main' }], {});
  };

  const provider = new GitLabCiEvidenceProvider(config(), fakeFetch);
  const page1 = await provider.listFailedRuns(1);
  assert.equal(page1.runs[0].runId, '100');
  assert.equal(page1.hasMore, true);

  const page2 = await provider.listFailedRuns(2);
  assert.equal(page2.runs[0].runId, '101');
  assert.equal(page2.hasMore, false);
  assert.equal(calls.length, 2);
});

test('a pipeline missing a sha reports an explicit unknown source', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse([{ id: 100, status: 'failed', created_at: '2026-01-01T00:00:00Z' }]);
  const provider = new GitLabCiEvidenceProvider(config(), fakeFetch);
  const { runs } = await provider.listFailedRuns(1);
  assert.deepEqual(runs[0].source, { kind: 'unknown' });
});

test('GitLab statuses map onto the shared conclusion vocabulary', async () => {
  const fakeFetch: typeof fetch = async () =>
    jsonResponse([
      { id: 1, sha: 'a'.repeat(40), status: 'failed', created_at: '2026-01-01T00:00:00Z' },
      { id: 2, sha: 'b'.repeat(40), status: 'canceled', created_at: '2026-01-01T00:00:00Z' }
    ]);
  const provider = new GitLabCiEvidenceProvider(config(), fakeFetch);
  const { runs } = await provider.listFailedRuns(1);
  assert.equal(runs[0].conclusion, 'failure');
  assert.equal(runs[1].conclusion, 'cancelled');
});

test('listFailedRuns surfaces a missing-permissions 403 rather than an empty list', async () => {
  const fakeFetch: typeof fetch = async () => new Response('{"message":"403 Forbidden"}', { status: 403, statusText: 'Forbidden' });
  const provider = new GitLabCiEvidenceProvider(config(), fakeFetch);
  await assert.rejects(() => provider.listFailedRuns(1), /No permission to read pipelines.*403/);
});

test('getJobLog reports a 404 trace as an explicit expired state, not an error', async () => {
  const provider = new GitLabCiEvidenceProvider(config(), async () => new Response('', { status: 404 }));
  assert.deepEqual(await provider.getJobLog('1'), { content: '', expired: true });
});

test('getJobLog surfaces a missing-permissions 403 distinctly from an expired trace', async () => {
  const provider = new GitLabCiEvidenceProvider(config(), async () => new Response('', { status: 403 }));
  await assert.rejects(() => provider.getJobLog('1'), /No permission to read this job.s trace.*403/);
});

test('getJobLog returns the raw trace text on success', async () => {
  const provider = new GitLabCiEvidenceProvider(config(), async () => new Response('$ npm test\nok\n', { status: 200 }));
  assert.deepEqual(await provider.getJobLog('1'), { content: '$ npm test\nok\n', expired: false });
});

test('a missing project path throws before any network attempt', async () => {
  const unreachable: typeof fetch = () => {
    throw new Error('must not be called');
  };
  const provider = new GitLabCiEvidenceProvider(config({ projectPath: '' }), unreachable);
  await assert.rejects(() => provider.listFailedRuns(1), /No GitLab project is configured/);
});
