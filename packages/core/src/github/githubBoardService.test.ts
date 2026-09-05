import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitHubBoardService } from './githubBoardService';
import type { GitHubConfigStore } from './githubConfigStore';
import type { LogSink } from '../host/logSink';

const silentSink: LogSink = { appendLine: () => {} };

function configStore(overrides?: Partial<GitHubConfigStore>): GitHubConfigStore {
  return {
    getDefaultPageSize: () => 25,
    getGitHubApiUrl: () => '',
    getGitHubOwner: () => 'octocat',
    getGitHubRepo: () => 'demo',
    getGitHubApiKey: () => 'ghp-test',
    getGitHubAllowIssueCreation: () => false,
    ...overrides
  };
}

/** A `fetch` that must never be called — proves a refusal throws before any network attempt. */
const unreachableFetch: typeof fetch = () => {
  throw new Error('fetch should not have been called for an operation the backend refuses outright');
};

function service(overrides?: Partial<GitHubConfigStore>, fetchImpl: typeof fetch = unreachableFetch): GitHubBoardService {
  return new GitHubBoardService(configStore(overrides), silentSink, fetchImpl);
}

// ── Refusals: folder's voice, not GitLab's "not implemented yet" ────────────

test('createBoard refuses by naming the repository as the board, without touching the network', async () => {
  await assert.rejects(
    () => service().createBoard({ name: 'x', projectKey: 'octocat/demo' }),
    /does not support creating boards.*repository is the board/
  );
});

test('updateBoard refuses the same way', async () => {
  await assert.rejects(
    () => service().updateBoard('github:octocat/demo', {}),
    /does not support updating boards.*repository is the board/
  );
});

test('deleteBoard refuses by naming the alternative (remove the connection)', async () => {
  await assert.rejects(
    () => service().deleteBoard('github:octocat/demo'),
    /does not support deleting boards\. Remove the connection instead\./
  );
});

test('deleteIssue refuses by naming the alternative (close it), never "not implemented yet"', async () => {
  let message = '';
  try {
    await service().deleteIssue('octocat/demo#1');
    assert.fail('deleteIssue should have thrown');
  } catch (error) {
    message = (error as Error).message;
  }
  assert.match(message, /does not support deleting issues\. Close the issue instead\./);
  assert.doesNotMatch(message, /not implemented yet/i);
});

test('attachFile refuses by naming the alternative (a link in the description or a comment)', async () => {
  await assert.rejects(
    () => service().attachFile('octocat/demo#1', '/tmp/x.png'),
    /does not support attachments.*Add files as links/
  );
});

test('downloadAttachment refuses the same way', async () => {
  await assert.rejects(
    () => service().downloadAttachment('octocat/demo#1', { fileName: 'x.png' }, '/tmp/x.png'),
    /does not support attachments.*Add files as links/
  );
});

// ── Configuration failures also surface before any network attempt ─────────

test('a missing PAT throws a clear message and never falls back to empty data', async () => {
  // getApiConfig falls back to process.env.GITHUB_TOKEN (mirroring GitLab's
  // own GITLAB_TOKEN fallback) — this sandbox has one set for its own GitHub
  // tooling, so it must be cleared for this assertion to test what it says.
  const savedToken = process.env.GITHUB_TOKEN;
  delete process.env.GITHUB_TOKEN;
  try {
    await assert.rejects(
      () => service({ getGitHubApiKey: () => '' }).getIssue('octocat/demo#1'),
      /No GitHub personal access token is configured\./
    );
  } finally {
    if (savedToken !== undefined) {
      process.env.GITHUB_TOKEN = savedToken;
    }
  }
});

test('a missing owner or repo throws a clear message', async () => {
  await assert.rejects(
    () => service({ getGitHubOwner: () => '' }).checkConnection(),
    /Configure a GitHub repository owner and name for this connection\./
  );
});

// ── An invalid/expired token surfaces GitHub's own error text ───────────────

test('checkConnection surfaces a 401 from GitHub verbatim rather than reporting false success', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ message: 'Bad credentials' }), {
      status: 401,
      statusText: 'Unauthorized'
    });

  await assert.rejects(
    () => service(undefined, fakeFetch).checkConnection(),
    /GitHub request failed \(HTTP 401 Unauthorized\): Bad credentials/
  );
});

test('a 404 for an unknown repository surfaces GitHub\'s own error text', async () => {
  const fakeFetch: typeof fetch = async () =>
    new Response(JSON.stringify({ message: 'Not Found' }), { status: 404, statusText: 'Not Found' });

  await assert.rejects(
    () => service(undefined, fakeFetch).checkConnection(),
    /GitHub request failed \(HTTP 404 Not Found\): Not Found/
  );
});
