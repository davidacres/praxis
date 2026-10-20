import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GitLabBoardService } from './gitLabBoardService';
import type { GitLabConfigStore } from './gitLabConfigStore';
import type { LogSink } from '../host/logSink';

const silentSink: LogSink = { appendLine: () => {} };

function configStore(overrides?: Partial<GitLabConfigStore>): GitLabConfigStore {
  return {
    getDefaultPageSize: () => 25,
    getGitLabUrl: () => 'https://gitlab.example.com',
    getGitLabProjectPath: () => 'group/demo',
    getGitLabListAllAccessibleBoards: () => false,
    getGitLabSelectedBoardRefs: () => [],
    getGitLabApiKey: () => 'glpat-test',
    getGitLabAllowIssueCreation: () => false,
    ...overrides
  };
}

const unreachableFetch: typeof fetch = () => {
  throw new Error('fetch should not have been called for an operation the backend refuses outright');
};

function service(overrides?: Partial<GitLabConfigStore>, fetchImpl: typeof fetch = unreachableFetch): GitLabBoardService {
  return new GitLabBoardService(configStore(overrides), silentSink, fetchImpl);
}

const issueJson = {
  id: 501,
  iid: 7,
  title: 'New thing',
  description: 'Details',
  state: 'opened',
  labels: [],
  assignees: [],
  web_url: 'https://gitlab.example.com/group/demo/-/issues/7',
  references: { full: 'group/demo#7' }
};
const projectJson = { id: 1, name: 'Demo', path_with_namespace: 'group/demo', web_url: 'https://gitlab.example.com/group/demo' };

test('createIssue refuses while the connection has not enabled creation, before any network call', async () => {
  await assert.rejects(
    () => service().createIssue({ projectKey: 'group/demo', issueType: 'issue', summary: 'x' }),
    /Issue creation is disabled for this GitLab connection/
  );
});

test('createIssue rejects an empty summary', async () => {
  await assert.rejects(
    () => service({ getGitLabAllowIssueCreation: () => true })
      .createIssue({ projectKey: 'group/demo', issueType: 'issue', summary: '   ' }),
    /Summary cannot be empty\./
  );
});

test('createIssue posts the title and description, then returns the created issue', async () => {
  const requests: { method: string; path: string; body?: string }[] = [];
  const fakeFetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    requests.push({ method: String(init?.method), path: url.pathname, body: init?.body ? String(init.body) : undefined });
    if (url.pathname.endsWith('/notes')) return new Response('[]');
    if (init?.method === 'POST' || url.pathname.endsWith('/issues/7')) return new Response(JSON.stringify(issueJson));
    return new Response(JSON.stringify(projectJson));
  };

  const created = await service({ getGitLabAllowIssueCreation: () => true }, fakeFetch)
    .createIssue({ projectKey: 'group/demo', issueType: 'issue', summary: '  New thing ', description: ' Details ' });

  const post = requests.find(request => request.method === 'POST');
  assert.equal(post?.path, '/api/v4/projects/group%2Fdemo/issues');
  const form = new URLSearchParams(post?.body);
  assert.equal(form.get('title'), 'New thing');
  assert.equal(form.get('description'), 'Details');
  assert.equal(created.key, 'group/demo#7');
  assert.equal(created.summary, 'New thing');
});

test('deleteIssue refuses by naming the alternative (close it), never "not implemented yet"', async () => {
  await assert.rejects(() => service().deleteIssue('group/demo#7'), /Close the issue instead\./);
});

test('attachments refuse by naming the alternative (a link)', async () => {
  await assert.rejects(() => service().attachFile('group/demo#7', '/tmp/x.png'), /Add files as links/);
  await assert.rejects(
    () => service().downloadAttachment('group/demo#7', { fileName: 'x.png' }, '/tmp/x.png'),
    /Add files as links/
  );
});

test('board create, update and delete name where to do it instead', async () => {
  await assert.rejects(() => service().createBoard({ name: 'x', projectKey: 'group/demo' }), /Create the board in GitLab/);
  await assert.rejects(() => service().updateBoard('1', {}), /Edit the board in GitLab/);
  await assert.rejects(() => service().deleteBoard('1'), /Delete the board in GitLab/);
});
