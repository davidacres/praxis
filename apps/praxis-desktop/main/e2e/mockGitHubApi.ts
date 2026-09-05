// SPDX-License-Identifier: MIT
//
// In-process mock GitHub REST API for Playwright e2e tests of the
// `@praxis/desktop-main` package. Mirrors `mockGitLabApi.ts`'s shape and
// conventions for the GitHub backend (`packages/core/src/github/githubApiService.ts`).
//
// Starts an internal `node:http` server on 127.0.0.1 with an ephemeral port
// and serves the subset of the GitHub REST API `GitHubApiService` calls.
// Field names match the real GitHub wire format (`html_url`, `created_at`,
// `pull_request`, etc.) because the API service normalizes incoming shapes via
// dedicated helpers — keeping the fixture wire-accurate means any
// normalization regression surfaces on the mock instead of being silently
// absorbed.
//
// Fixture, anchored around the seed in `github.spec.ts`:
//   • One repository `octocat/demo`.
//   • Two "status: …" labels — "status: Doing" and "status: Review" — plus one
//     plain label "bug" that carries no status meaning, so a transition can be
//     proven not to disturb it.
//   • Four issues occupy every synthesized column: number 1 (Doing), number 2
//     (Review), number 3 (Closed), number 4 (Backlog — no status label).
//   • One authenticated user "octocat".
//
// Counters expose how often each endpoint was hit and capture the last write
// payloads, the same pattern `mockGitLabApi.ts` uses.

import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockGitHubCounters {
  currentUserHits: number;
  getRepoHits: number;
  listLabelsHits: number;
  listIssuesHits: number;
  getIssueHits: number;
  listIssueCommentsHits: number;
  addIssueCommentHits: number;
  updateIssueHits: number;
  createIssueHits: number;
  lastAddedComment: { issueNumber: number; body: string } | undefined;
  lastUpdatedIssue: { issueNumber: number; labels?: string[]; state?: string } | undefined;
}

export interface MockGitHubServer {
  /** `http://127.0.0.1:<port>` — use as the connection `url` in the e2e seed. */
  baseUrl: string;
  counters: MockGitHubCounters;
  close(): Promise<void>;
}

interface MutableIssueFixture {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string;
  labels: string[];
  created_at: string;
  updated_at: string;
  html_url: string;
}

interface MutableCommentFixture {
  id: number;
  issueNumber: number;
  body: string;
  created_at: string;
  updated_at: string;
}

interface MockState {
  owner: string;
  repo: string;
  labels: string[];
  issues: MutableIssueFixture[];
  commentsByIssueNumber: Map<number, MutableCommentFixture[]>;
  counters: MockGitHubCounters;
  nextIssueId: number;
  nextCommentId: number;
}

export async function startMockGitHubApi(options?: {
  owner?: string;
  repo?: string;
}): Promise<MockGitHubServer> {
  const owner = options?.owner ?? 'octocat';
  const repo = options?.repo ?? 'demo';
  const state = buildInitialState(owner, repo);

  const server = http.createServer((req, res) => {
    void handleRequest(req, res, state);
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });

  const port = (server.address() as AddressInfo).port;
  let closed = false;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    counters: state.counters,
    async close(): Promise<void> {
      if (closed) {
        return;
      }
      closed = true;
      await new Promise<void>(resolve => server.close(() => resolve()));
    }
  };
}

function buildInitialState(owner: string, repo: string): MockState {
  const make = (
    number: number,
    title: string,
    body: string,
    state: string,
    labels: string[],
    createdAt: string,
    updatedAt: string
  ): MutableIssueFixture => ({
    id: 1000 + number,
    number,
    title,
    body,
    state,
    labels,
    created_at: createdAt,
    updated_at: updatedAt,
    html_url: `http://mock-github/${owner}/${repo}/issues/${number}`
  });

  const issues: MutableIssueFixture[] = [
    make(1, 'Wire GitHub token setup', 'Add a PAT field to the connection form.', 'open', ['status: Doing'], '2026-08-19T08:00:00.000Z', '2026-08-20T09:00:00.000Z'),
    make(2, 'Polish board rendering', 'Surface status columns on the board view.', 'open', ['status: Review', 'bug'], '2026-08-19T09:00:00.000Z', '2026-08-20T11:30:00.000Z'),
    make(3, 'Close stale migration issue', 'Mark the v1 migration ticket as closed.', 'closed', [], '2026-08-18T08:00:00.000Z', '2026-08-19T18:00:00.000Z'),
    make(4, 'Backlog candidate', 'Stretch goal: repo automation helpers.', 'open', [], '2026-08-17T08:00:00.000Z', '2026-08-18T12:00:00.000Z')
  ];

  return {
    owner,
    repo,
    labels: ['status: Doing', 'status: Review', 'bug'],
    issues,
    commentsByIssueNumber: new Map(),
    counters: {
      currentUserHits: 0,
      getRepoHits: 0,
      listLabelsHits: 0,
      listIssuesHits: 0,
      getIssueHits: 0,
      listIssueCommentsHits: 0,
      addIssueCommentHits: 0,
      updateIssueHits: 0,
      createIssueHits: 0,
      lastAddedComment: undefined,
      lastUpdatedIssue: undefined
    },
    nextIssueId: 5,
    nextCommentId: 1
  };
}

interface Route {
  method: 'GET' | 'POST' | 'PATCH';
  pattern: RegExp;
  handle(match: RegExpMatchArray, body: unknown, state: MockState): { status: number; body: unknown };
}

function buildRoutes(): readonly Route[] {
  return [
    {
      method: 'GET',
      pattern: /^\/user$/,
      handle: (_m, _b, state) => {
        state.counters.currentUserHits += 1;
        return { status: 200, body: { login: 'octocat', name: 'The Octocat' } };
      }
    },
    {
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)$/,
      handle: (match, _b, state) => {
        state.counters.getRepoHits += 1;
        if (!matchesRepo(match, state)) {
          return notFound();
        }
        return {
          status: 200,
          body: { full_name: `${state.owner}/${state.repo}`, name: state.repo, html_url: `http://mock-github/${state.owner}/${state.repo}`, private: false }
        };
      }
    },
    {
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/labels$/,
      handle: (match, _b, state) => {
        state.counters.listLabelsHits += 1;
        if (!matchesRepo(match, state)) {
          return notFound();
        }
        return { status: 200, body: state.labels.map(name => ({ name })) };
      }
    },
    {
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/issues$/,
      handle: (match, _b, state) => {
        state.counters.listIssuesHits += 1;
        if (!matchesRepo(match, state)) {
          return notFound();
        }
        return { status: 200, body: state.issues.map(serializeIssue) };
      }
    },
    {
      method: 'POST',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/issues$/,
      handle: (match, body, state) => {
        state.counters.createIssueHits += 1;
        if (!matchesRepo(match, state)) {
          return notFound();
        }
        const input = (body ?? {}) as { title?: string; body?: string; labels?: string[]; assignees?: string[] };
        const number = state.issues.length > 0 ? Math.max(...state.issues.map(i => i.number)) + 1 : 1;
        const now = new Date().toISOString();
        const created: MutableIssueFixture = {
          id: state.nextIssueId++,
          number,
          title: input.title ?? '',
          body: input.body ?? '',
          state: 'open',
          labels: input.labels ?? [],
          created_at: now,
          updated_at: now,
          html_url: `http://mock-github/${state.owner}/${state.repo}/issues/${number}`
        };
        state.issues.push(created);
        return { status: 201, body: serializeIssue(created) };
      }
    },
    {
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/,
      handle: (match, _b, state) => {
        state.counters.getIssueHits += 1;
        if (!matchesRepo(match, state)) {
          return notFound();
        }
        const issue = state.issues.find(candidate => candidate.number === Number(match[3]));
        if (!issue) {
          return { status: 404, body: { message: 'Not Found' } };
        }
        return { status: 200, body: serializeIssue(issue) };
      }
    },
    {
      method: 'PATCH',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)$/,
      handle: (match, body, state) => {
        state.counters.updateIssueHits += 1;
        if (!matchesRepo(match, state)) {
          return notFound();
        }
        const issue = state.issues.find(candidate => candidate.number === Number(match[3]));
        if (!issue) {
          return { status: 404, body: { message: 'Not Found' } };
        }
        const input = (body ?? {}) as { title?: string; body?: string; state?: string; labels?: string[]; assignees?: string[] };
        if (typeof input.title === 'string') {
          issue.title = input.title;
        }
        if (typeof input.body === 'string') {
          issue.body = input.body;
        }
        if (input.state === 'open' || input.state === 'closed') {
          issue.state = input.state;
        }
        if (Array.isArray(input.labels)) {
          issue.labels = input.labels;
        }
        issue.updated_at = new Date().toISOString();
        state.counters.lastUpdatedIssue = { issueNumber: issue.number, labels: input.labels, state: input.state };
        return { status: 200, body: serializeIssue(issue) };
      }
    },
    {
      method: 'GET',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/,
      handle: (match, _b, state) => {
        state.counters.listIssueCommentsHits += 1;
        if (!matchesRepo(match, state)) {
          return notFound();
        }
        const number = Number(match[3]);
        const comments = (state.commentsByIssueNumber.get(number) ?? []).map(serializeComment);
        return { status: 200, body: comments };
      }
    },
    {
      method: 'POST',
      pattern: /^\/repos\/([^/]+)\/([^/]+)\/issues\/(\d+)\/comments$/,
      handle: (match, body, state) => {
        state.counters.addIssueCommentHits += 1;
        if (!matchesRepo(match, state)) {
          return notFound();
        }
        const number = Number(match[3]);
        const input = (body ?? {}) as { body?: string };
        const text = (input.body ?? '').trim();
        if (!text) {
          return { status: 422, body: { message: 'body cannot be empty' } };
        }
        const now = new Date().toISOString();
        const comment: MutableCommentFixture = {
          id: state.nextCommentId++,
          issueNumber: number,
          body: text,
          created_at: now,
          updated_at: now
        };
        const existing = state.commentsByIssueNumber.get(number) ?? [];
        existing.push(comment);
        state.commentsByIssueNumber.set(number, existing);
        state.counters.lastAddedComment = { issueNumber: number, body: text };
        return { status: 201, body: serializeComment(comment) };
      }
    }
  ];
}

async function handleRequest(req: IncomingMessage, res: ServerResponse, state: MockState): Promise<void> {
  const auth = req.headers.authorization;
  if (typeof auth !== 'string' || !auth.startsWith('Bearer ')) {
    sendResponse(res, 401, { message: 'Requires authentication' });
    return;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const rawUrl = req.url ?? '/';
  const parsed = new URL(rawUrl, 'http://mock-github');
  const pathname = parsed.pathname;

  let rawBody = '';
  if (method === 'POST' || method === 'PATCH') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    rawBody = Buffer.concat(chunks).toString('utf8');
  }
  const parsedBody = rawBody.trim() ? (JSON.parse(rawBody) as unknown) : undefined;

  for (const route of buildRoutes()) {
    if (route.method !== method) {
      continue;
    }
    const match = route.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    try {
      const result = route.handle(match, parsedBody, state);
      sendResponse(res, result.status, result.body);
      return;
    } catch (error) {
      sendResponse(res, 500, { message: 'mock server error', detail: String(error) });
      return;
    }
  }

  sendResponse(res, 404, { message: `no mock route for ${method} ${pathname}` });
}

function sendResponse(res: ServerResponse, status: number, body: unknown): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  // No `Link` header — the fixture always fits on one page, which also
  // exercises `parseGitHubNextLink`'s "no next link" path.
  res.end(JSON.stringify(body));
}

function matchesRepo(match: RegExpMatchArray, state: MockState): boolean {
  return match[1] === state.owner && match[2] === state.repo;
}

function notFound(): { status: number; body: unknown } {
  return { status: 404, body: { message: 'Not Found' } };
}



function serializeIssue(issue: MutableIssueFixture): Record<string, unknown> {
  return {
    id: issue.id,
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    html_url: issue.html_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    user: { login: 'octocat', name: 'The Octocat' },
    assignees: [],
    labels: issue.labels.map(name => ({ name }))
  };
}

function serializeComment(comment: MutableCommentFixture): Record<string, unknown> {
  return {
    id: comment.id,
    body: comment.body,
    created_at: comment.created_at,
    updated_at: comment.updated_at,
    user: { login: 'octocat', name: 'The Octocat' }
  };
}

