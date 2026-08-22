// SPDX-License-Identifier: MIT
//
// In-process mock GitLab REST API for Playwright e2e tests of the
// `@ticket-manager/electron-app` package.
//
// Starts an internal `node:http` server on 127.0.0.1 with an ephemeral port
// and serves the subset of the GitLab REST API that
// `GitLabApiService` (see `packages/core/src/gitlab/gitLabApiService.ts`)
// calls. Field names match the real GitLab snake_case wire format
// (`path_with_namespace`, `iid`, `state_event`, etc.) because the API
// service normalizes incoming shapes via dedicated helpers — keeping the
// fixture wire-accurate means any normalization regression surfaces on the
// mock instead of being silently absorbed.
//
// The desktop main process issues the `fetch`es against this server from the
// Electron main process (no CORS concerns). The mock accepts the
// `PRIVATE-TOKEN` header as a presence check; it does not compare its value,
// per the task brief's "assert it loosely if you like" guidance.
//
// Fixture shape, anchored around the seed in `gitlab.spec.ts`:
//   • One project `group/demo` (id 1)
//   • One board "Demo Board" (id 7) with `hide_backlog_list: false` and
//     `hide_closed_list: false`. Two label-typed lists ("Doing" / "Review")
//     are present; Backlog and Closed columns are the implicit ones the
//     service renders from those flags (see
//     `GitLabBoardService.buildBoardColumns`).
//   • Four issues occupy every column so the board renders end-to-end:
//     iid 1 (Doing), iid 2 (Review), iid 3 (Closed), iid 4 (Backlog).
//   • One user "alex" plus the canonical `/api/v4/user` response.
//
// Counters exposed via `counters` track how often each endpoint was hit and
// capture the last write payloads — the e2e uses them to assert that the
// desktop app drives the mock (a "the test passed because of cache" failure
// mode is otherwise hard to distinguish from a "the app drove the wrong path"
// failure mode).
//
// Usage (e.g. from a Playwright spec):
//
//   import { startMockGitLabApi } from './mockGitLabApi';
//   const mock = await startMockGitLabApi();
//   try {
//     // baseUrl is `http://127.0.0.1:<port>` — feed it as the GitLab `url`
//     // setting in the e2e's seed settings.json.
//   } finally {
//     await mock.close();
//   }

import * as http from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export interface MockGitLabCounters {
  /** Number of `/api/v4/user` calls (driven by `getCurrentUser`). */
  currentUserHits: number;
  /** Number of `/api/v4/projects` (paginated list) calls. */
  listProjectsHits: number;
  /** Number of `/api/v4/projects/:ref` calls. */
  getProjectHits: number;
  /** Number of `/api/v4/projects/:ref/boards` calls. */
  listBoardsHits: number;
  /** Number of `/api/v4/projects/:ref/boards/:id` calls. */
  getBoardHits: number;
  /** Number of `/api/v4/projects/:ref/boards/:id/lists` calls. */
  boardListsHits: number;
  /** Number of `/api/v4/projects/:ref/issues` calls. */
  listIssuesHits: number;
  /** Number of `/api/v4/projects/:ref/issues/:iid` calls. */
  getIssueHits: number;
  /** Number of `/api/v4/projects/:ref/issues/:iid/notes` GET calls. */
  listIssueNotesHits: number;
  /** Number of `/api/v4/projects/:ref/issues/:iid/notes` POST calls. */
  addIssueNoteHits: number;
  /** Number of `/api/v4/projects/:ref/issues/:iid` PUT calls. */
  updateIssueHits: number;
  /** Last `POST …/issues/:iid/notes` payload, for assertions on body content. */
  lastAddedComment: { iid: number; body: string } | undefined;
}

export interface MockGitLabServer {
  /** `http://127.0.0.1:<port>` — use as the connection `url` in the e2e seed. */
  baseUrl: string;
  /** Server-side counters; mutated by every request the mock serves. */
  counters: MockGitLabCounters;
  /** Stops the http server. Safe to call multiple times. */
  close(): Promise<void>;
}

interface MutableIssueFixture {
  id: number;
  iid: number;
  project_id: number;
  title: string;
  description: string;
  state: string;
  author_id: number;
  assignee_ids: number[];
  labels: string[];
  created_at: string;
  updated_at: string;
  web_url: string;
  references: { full: string; relative: string; short: string };
}

interface MutableNoteFixture {
  id: string;
  issue_iid: number;
  body: string;
  author_id: number;
  created_at: string;
  updated_at: string;
}

interface Route {
  method: 'GET' | 'POST' | 'PUT';
  pattern: RegExp;
  /** Capture-group names (in order) so handlers know what each capture means. */
  captureKeys: readonly string[];
  handle(
    match: RegExpMatchArray,
    params: URLSearchParams,
    rawBody: string,
    state: MockState
  ): { status: number; body: unknown; extraHeaders?: Record<string, string> };
}

interface MockState {
  project: Record<string, unknown>;
  board: Record<string, unknown>;
  boardLists: Record<string, unknown>[];
  issues: MutableIssueFixture[];
  notesByIssueIid: Map<number, MutableNoteFixture[]>;
  counters: MockGitLabCounters;
}

/**
 * Start a fresh GitLab REST mock on an ephemeral port. Each call returns a
 * pristine fixture so restarting between tests is a single line.
 *
 * The `projectPath` option lets a future spec use a different `path` /
 * `path_with_namespace` without rewriting the fixture defaults — current
 * callers leave it unset.
 */
export async function startMockGitLabApi(options?: {
  projectPath?: string;
}): Promise<MockGitLabServer> {
  const projectPath = options?.projectPath ?? 'group/demo';

  const state = buildInitialState(projectPath);

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

// ── Fixture construction ─────────────────────────────────────────────────────

function buildInitialState(projectPath: string): MockState {
  const projectId = 1;
  const boardId = 7;
  const userId = 1;

  const project: Record<string, unknown> = {
    id: projectId,
    name: 'Demo Project',
    path: projectPath.split('/').pop() ?? 'demo',
    path_with_namespace: projectPath,
    web_url: `http://mock-gitlab/${projectPath}`,
    default_branch: 'main',
    description: 'Mock GitLab project for e2e tests.',
    visibility: 'private'
  };

  // Two label lists — `Doing` is position 0 so the "Doing" issue lands first;
  // "Review" follows. The board doesn't pin labels at board level, so the
  // issue's own labels determine which column it occupies.
  const boardLists: Record<string, unknown>[] = [
    {
      id: 101,
      title: 'Doing',
      position: 0,
      list_type: 'label',
      label: { id: 11, name: 'Doing' }
    },
    {
      id: 102,
      title: 'Review',
      position: 1,
      list_type: 'label',
      label: { id: 12, name: 'Review' }
    }
  ];

  // Order by position so the service's "explicitly sorted" pass is a no-op.
  boardLists.sort((left, right) => Number(left.position) - Number(right.position));

  const board: Record<string, unknown> = {
    id: boardId,
    name: 'Demo Board',
    hide_backlog_list: false,
    hide_closed_list: false,
    project,
    web_url: `http://mock-gitlab/${projectPath}/-/boards/${boardId}`,
    // The service normalizes `board.labels` (used by `getBoardDetails` to
    // filter the issue list) — leaving it empty lets listIssues bring back
    // every issue in the project.
    labels: [],
    weight: undefined,
    assignees: undefined,
    milestone: undefined,
    lists: boardLists
  };

  const issueBase = {
    project_id: projectId,
    author_id: userId,
    assignee_ids: [userId],
    web_url: '',
    references: { full: '', relative: '', short: '' }
  };

  const make = (
    iid: number,
    title: string,
    description: string,
    state: string,
    labels: string[],
    createdAt: string,
    updatedAt: string
  ): MutableIssueFixture => {
    const ref = `${projectPath}#${iid}`;
    return {
      ...issueBase,
      id: iid,
      iid,
      title,
      description,
      state,
      labels,
      created_at: createdAt,
      updated_at: updatedAt,
      web_url: `http://mock-gitlab/${projectPath}/-/issues/${iid}`,
      references: { full: ref, relative: `#${iid}`, short: `#${iid}` }
    };
  };

  const issues: MutableIssueFixture[] = [
    make(
      1,
      'Wire OAuth sign-in',
      'Add the GitLab OAuth flow to the desktop app login screen.',
      'opened',
      ['Doing'],
      '2026-08-19T08:00:00.000Z',
      '2026-08-20T09:00:00.000Z'
    ),
    make(
      2,
      'Polish board picker',
      'Surface the new board picker inline on the connections panel.',
      'opened',
      ['Review'],
      '2026-08-19T09:00:00.000Z',
      '2026-08-20T11:30:00.000Z'
    ),
    make(
      3,
      'Close stale migration issue',
      'Mark the v1 migration ticket as closed after release.',
      'closed',
      [],
      '2026-08-18T08:00:00.000Z',
      '2026-08-19T18:00:00.000Z'
    ),
    make(
      4,
      'Backlog candidate',
      'Stretch goal: add MR review helpers.',
      'opened',
      [],
      '2026-08-17T08:00:00.000Z',
      '2026-08-18T12:00:00.000Z'
    )
  ];

  return {
    project,
    board,
    boardLists,
    issues,
    notesByIssueIid: new Map(),
    counters: {
      currentUserHits: 0,
      listProjectsHits: 0,
      getProjectHits: 0,
      listBoardsHits: 0,
      getBoardHits: 0,
      boardListsHits: 0,
      listIssuesHits: 0,
      getIssueHits: 0,
      listIssueNotesHits: 0,
      addIssueNoteHits: 0,
      updateIssueHits: 0,
      lastAddedComment: undefined
    }
  };
}

// ── Route table ──────────────────────────────────────────────────────────────

/**
 * The full method × path table the mock implements. Patterns reflect the
 * exact `pathname` the GitLabApiService builds; `projectPath` is matched as a
 * single segment because `encodeURIComponent('group/demo')` produces
 * `group%2Fdemo` (which has no slashes) — splitting on `/` does the right
 * thing for everything the service encodes today.
 *
 * The `captureKeys` parser is positional; if a pattern's capture order
 * changes, update the keys alongside it.
 */
const ROUTES: readonly Route[] = [
  {
    method: 'GET',
    pattern: /^\/api\/v4\/user$/,
    captureKeys: [],
    handle: (_m, _p, _b, state) => {
      state.counters.currentUserHits += 1;
      return { status: 200, body: buildUserBody() };
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/v4\/users$/,
    captureKeys: [],
    handle: (_m, params, _b, _state) => {
      const username = params.get('username');
      const search = params.get('search');
      if (username !== null && username.length > 0) {
        if (username === 'alex') {
          return { status: 200, body: [buildUserBody()] };
        }
        return { status: 200, body: [] };
      }
      if (search !== null && search.length > 0) {
        if (search.toLowerCase().includes('alex')) {
          return { status: 200, body: [buildUserBody()] };
        }
        return { status: 200, body: [] };
      }
      return { status: 200, body: [] };
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/v4\/projects$/,
    captureKeys: [],
    handle: (_m, _p, _b, state) => {
      state.counters.listProjectsHits += 1;
      // `requestJsonPaginated` reads `x-next-page` between requests; an empty
      // value tells it "stop paginating". Returning one page is enough.
      return {
        status: 200,
        body: [state.project],
        extraHeaders: { 'x-next-page': '' }
      };
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/v4\/projects\/([^/]+)$/,
    captureKeys: ['projectRef'],
    handle: (match, _p, _b, state) => {
      state.counters.getProjectHits += 1;
      if (!matchesConfiguredProject(match[1], state.project)) {
        return notFound();
      }
      return { status: 200, body: state.project };
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/boards$/,
    captureKeys: ['projectRef'],
    handle: (match, _p, _b, state) => {
      state.counters.listBoardsHits += 1;
      if (!matchesConfiguredProject(match[1], state.project)) {
        return notFound();
      }
      // The list-boards endpoint on GitLab returns boards with a `lists`
      // field that may not be present in the list view; the service
      // normalizes both shapes, so we send the full board here.
      return { status: 200, body: [state.board] };
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/boards\/(\d+)$/,
    captureKeys: ['projectRef', 'boardId'],
    handle: (match, _p, _b, state) => {
      state.counters.getBoardHits += 1;
      if (!matchesConfiguredProject(match[1], state.project)) {
        return notFound();
      }
      if (Number(match[2]) !== Number(state.board.id)) {
        return notFound();
      }
      return { status: 200, body: state.board };
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/boards\/(\d+)\/lists$/,
    captureKeys: ['projectRef', 'boardId'],
    handle: (match, _p, _b, state) => {
      state.counters.boardListsHits += 1;
      if (!matchesConfiguredProject(match[1], state.project)) {
        return notFound();
      }
      if (Number(match[2]) !== Number(state.board.id)) {
        return notFound();
      }
      return { status: 200, body: state.boardLists };
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/issues$/,
    captureKeys: ['projectRef'],
    handle: (match, params, _b, state) => {
      state.counters.listIssuesHits += 1;
      if (!matchesConfiguredProject(match[1], state.project)) {
        return notFound();
      }
      // GitLab issues API supports many filters — we honour the subset the
      // service sends (`state`, `labels`, `assignee_username`, `iteration_title`).
      // Anything unsupplied passes everything through.
      const stateFilter = params.get('state') ?? 'all';
      const labelsFilter = (params.get('labels') ?? '').split(',').map(label => label.trim()).filter(label => label.length > 0);
      const filtered = state.issues.filter(issue => {
        if (stateFilter !== 'all' && issue.state !== stateFilter) {
          return false;
        }
        if (labelsFilter.length > 0) {
          const issueLabels = issue.labels.map(label => label.toLowerCase());
          const allMatch = labelsFilter.every(label => issueLabels.includes(label.toLowerCase()));
          if (!allMatch) {
            return false;
          }
        }
        return true;
      });
      const serialized = filtered
        .map(issue => serializeIssue(issue))
        .sort((left, right) => String(right.updated_at).localeCompare(String(left.updated_at)));
      return {
        status: 200,
        body: serialized,
        extraHeaders: { 'x-next-page': '' }
      };
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/issues\/(\d+)$/,
    captureKeys: ['projectRef', 'issueIid'],
    handle: (match, _p, _b, state) => {
      state.counters.getIssueHits += 1;
      if (!matchesConfiguredProject(match[1], state.project)) {
        return notFound();
      }
      const issue = state.issues.find(candidate => candidate.iid === Number(match[2]));
      if (!issue) {
        return { status: 404, body: { message: '404 Issue Not Found' } };
      }
      return { status: 200, body: serializeIssue(issue) };
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/issues\/(\d+)\/notes$/,
    captureKeys: ['projectRef', 'issueIid'],
    handle: (match, _p, _b, state) => {
      state.counters.listIssueNotesHits += 1;
      if (!matchesConfiguredProject(match[1], state.project)) {
        return notFound();
      }
      const iid = Number(match[2]);
      if (!state.issues.some(candidate => candidate.iid === iid)) {
        return { status: 404, body: { message: '404 Issue Not Found' } };
      }
      const notes = (state.notesByIssueIid.get(iid) ?? []).map(serializeNote);
      notes.sort((left, right) => String(left.created_at).localeCompare(String(right.created_at)));
      return { status: 200, body: notes };
    }
  },
  {
    method: 'POST',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/issues\/(\d+)\/notes$/,
    captureKeys: ['projectRef', 'issueIid'],
    handle: (match, _p, rawBody, state) => {
      state.counters.addIssueNoteHits += 1;
      if (!matchesConfiguredProject(match[1], state.project)) {
        return notFound();
      }
      const iid = Number(match[2]);
      const params = new URLSearchParams(rawBody);
      const body = (params.get('body') ?? '').trim();
      if (body.length === 0) {
        return { status: 400, body: { message: 'body cannot be empty' } };
      }
      // IssueDetail disables the Add comment button while the body is empty,
      // but the mock still validates server-side for parity with the real
      // GitLab behavior.
      const note: MutableNoteFixture = {
        id: `${iid}-note-${state.notesByIssueIid.get(iid)?.length ?? 0 + 1}`,
        issue_iid: iid,
        body,
        author_id: 1,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      const existing = state.notesByIssueIid.get(iid) ?? [];
      existing.push(note);
      state.notesByIssueIid.set(iid, existing);
      state.counters.lastAddedComment = { iid, body };
      return { status: 201, body: serializeNote(note) };
    }
  },
  {
    method: 'PUT',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/issues\/(\d+)$/,
    captureKeys: ['projectRef', 'issueIid'],
    handle: (match, _p, rawBody, state) => {
      state.counters.updateIssueHits += 1;
      if (!matchesConfiguredProject(match[1], state.project)) {
        return notFound();
      }
      const iid = Number(match[2]);
      const issue = state.issues.find(candidate => candidate.iid === iid);
      if (!issue) {
        return { status: 404, body: { message: '404 Issue Not Found' } };
      }
      const params = new URLSearchParams(rawBody);
      const title = params.get('title');
      const description = params.get('description');
      const stateEvent = params.get('state_event');
      const addLabels = (params.get('add_labels') ?? '').split(',').map(value => value.trim()).filter(value => value.length > 0);
      const removeLabels = (params.get('remove_labels') ?? '').split(',').map(value => value.trim()).filter(value => value.length > 0);
      const assigneeIdsRaw = params.get('assignee_ids');
      const milestoneIdRaw = params.get('milestone_id');
      const iterationIdRaw = params.get('iteration_id');

      if (title !== null && title.length > 0) {
        issue.title = title;
      }
      if (description !== null) {
        issue.description = description;
      }
      if (stateEvent === 'close') {
        issue.state = 'closed';
      } else if (stateEvent === 'reopen') {
        issue.state = 'opened';
      }
      if (removeLabels.length > 0) {
        const lower = removeLabels.map(label => label.toLowerCase());
        issue.labels = issue.labels.filter(label => !lower.includes(label.toLowerCase()));
      }
      if (addLabels.length > 0) {
        for (const label of addLabels) {
          if (!issue.labels.some(existing => existing.toLowerCase() === label.toLowerCase())) {
            issue.labels.push(label);
          }
        }
      }
      if (assigneeIdsRaw !== null && assigneeIdsRaw.length > 0) {
        // GitLab's "clear assignees" convention is the literal string `0`.
        if (assigneeIdsRaw === '0') {
          issue.assignee_ids = [];
        } else {
          issue.assignee_ids = assigneeIdsRaw
            .split(',')
            .map(value => Number(value.trim()))
            .filter(value => Number.isFinite(value));
        }
      }
      if (milestoneIdRaw !== null && milestoneIdRaw.length > 0) {
        // Milestone updates are not reflected into the issue fixture because
        // the e2e does not read `issue.milestone` — the field exists in the
        // wire format but the service does not normalize it.
        void milestoneIdRaw;
      }
      if (iterationIdRaw !== null && iterationIdRaw.length > 0) {
        void iterationIdRaw;
      }
      issue.updated_at = new Date().toISOString();
      return { status: 200, body: serializeIssue(issue) };
    }
  },
  // The mock implements the merge-request endpoints the service can hit
  // during MR review flows (see `gitLabApiService.listMergeRequests…`,
  // `…discussions`, `…addMergeRequestNote`, `…replyToMergeRequestDiscussion`).
  // Returns empty arrays so reviewers see "no notes found" rather than 404s.
  {
    method: 'GET',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/merge_requests$/,
    captureKeys: ['projectRef'],
    handle: (match, _p, _b, state) => {
      if (!matchesConfiguredProject(match[1], state.project)) {
        return notFound();
      }
      void state;
      return { status: 200, body: [], extraHeaders: { 'x-next-page': '' } };
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)$/,
    captureKeys: ['projectRef', 'mergeRequestIid'],
    handle: (match, _p, _b, _state) => {
      if (!matchesConfiguredProject(match[1], _state.project)) {
        return notFound();
      }
      return { status: 404, body: { message: '404 Merge Request Not Found' } };
    }
  },
  {
    method: 'POST',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/merge_requests$/,
    captureKeys: ['projectRef'],
    handle: (match, _p, _b, _state) => {
      if (!matchesConfiguredProject(match[1], _state.project)) {
        return notFound();
      }
      // The e2e does not exercise create-merge-request; return a synthesized
      // MR so an accidental hit does not 4xx the test.
      return {
        status: 201,
        body: {
          id: 100,
          iid: 1,
          project_id: _state.project.id,
          title: 'mock-mr',
          description: '',
          source_branch: 'feature/mock',
          target_branch: 'main',
          state: 'opened',
          web_url: 'http://mock-gitlab/group/demo/-/merge_requests/1',
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
          sha: 'mock-sha'
        }
      };
    }
  },
  {
    method: 'GET',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)\/discussions$/,
    captureKeys: ['projectRef', 'mergeRequestIid'],
    handle: (match, _p, _b, _state) => {
      if (!matchesConfiguredProject(match[1], _state.project)) {
        return notFound();
      }
      void match;
      return { status: 200, body: [] };
    }
  },
  {
    method: 'POST',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)\/notes$/,
    captureKeys: ['projectRef', 'mergeRequestIid'],
    handle: (match, _p, _b, _state) => {
      if (!matchesConfiguredProject(match[1], _state.project)) {
        return notFound();
      }
      void match;
      return { status: 201, body: { id: 'mr-note-mock', body: _p.get('body') ?? '' } };
    }
  },
  {
    method: 'POST',
    pattern: /^\/api\/v4\/projects\/([^/]+)\/merge_requests\/(\d+)\/discussions\/([^/]+)\/notes$/,
    captureKeys: ['projectRef', 'mergeRequestIid', 'discussionId'],
    handle: (match, _p, _b, _state) => {
      if (!matchesConfiguredProject(match[1], _state.project)) {
        return notFound();
      }
      void match;
      return { status: 201, body: { id: 'mr-discussion-note-mock', body: _p.get('body') ?? '' } };
    }
  }
];

// ── Request handling ─────────────────────────────────────────────────────────

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  state: MockState
): Promise<void> {
  // The mock does not implement auth beyond presence-of-header, so a missing
  // PRIVATE-TOKEN from the test is the test author's bug — log it (visible
  // when the spec runs in verbose mode) but still serve the response.
  const token = req.headers['private-token'];
  if (typeof token !== 'string' || token.length === 0) {
    res.statusCode = 401;
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ message: '401 Unauthorized — PRIVATE-TOKEN header missing' }));
    return;
  }

  const method = (req.method ?? 'GET').toUpperCase();
  const rawUrl = req.url ?? '/';
  const parsed = new URL(rawUrl, 'http://mock-gitlab');
  const pathname = parsed.pathname;
  const params = parsed.searchParams;

  // Read the body once — `URLSearchParams` parses the GitLabApiService's
  // application/x-www-form-urlencoded POST/PUT bodies.
  let rawBody = '';
  if (method === 'POST' || method === 'PUT') {
    const chunks: Buffer[] = [];
    for await (const chunk of req) {
      chunks.push(chunk as Buffer);
    }
    rawBody = Buffer.concat(chunks).toString('utf8');
  }

  for (const route of ROUTES) {
    if (route.method !== method) {
      continue;
    }
    const match = route.pattern.exec(pathname);
    if (!match) {
      continue;
    }
    try {
      const result = route.handle(match, params, rawBody, state);
      sendResponse(res, result.status, result.body, result.extraHeaders);
      return;
    } catch (error) {
      res.statusCode = 500;
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ message: 'mock server error', detail: String(error) }));
      return;
    }
  }

  // No matching route — return a recognisable GitLab-shaped 404 so the
  // service can format any error gracefully instead of choking on raw HTML.
  res.statusCode = 404;
  res.setHeader('Content-Type', 'application/json');
  res.end(
    JSON.stringify({ message: `404 Not Found — no mock route for ${method} ${pathname}` })
  );
}

function sendResponse(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders?: Record<string, string>
): void {
  res.statusCode = status;
  res.setHeader('Content-Type', 'application/json');
  if (extraHeaders) {
    for (const [key, value] of Object.entries(extraHeaders)) {
      res.setHeader(key, value);
    }
  }
  res.end(JSON.stringify(body));
}

// ── Helpers ──────────────────────────────────────────────────────────────────

function buildUserBody(): Record<string, unknown> {
  return {
    id: 1,
    username: 'alex',
    name: 'Alex Agent',
    state: 'active'
  };
}

function matchesConfiguredProject(
  // `encodeURIComponent('group/demo')` becomes `group%2Fdemo`. The projectRef
  // arrives already URL-encoded by the GitLabApiService; we compare the
  // decoded value so both `group/demo` style seeds and `group%2Fdemo` style
  // seeds match the configured project path.
  candidate: string | undefined,
  project: Record<string, unknown>
): boolean {
  if (typeof candidate !== 'string' || candidate.length === 0) {
    return false;
  }
  let decoded = candidate;
  try {
    decoded = decodeURIComponent(candidate);
  } catch {
    // Ignored — fall back to the raw candidate.
  }
  const configured = String(project.path_with_namespace ?? '');
  if (decoded === configured) {
    return true;
  }
  // The service also addresses project routes by the project's numeric id —
  // `listBoardsForProjects` calls `client.listBoards(project.id)`, so
  // `/api/v4/projects/1/boards` must resolve to the configured project too.
  return decoded === String(project.id ?? '');
}

function notFound(): { status: number; body: unknown } {
  return { status: 404, body: { message: '404 Not Found' } };
}

/**
 * Build the wire-shape the service expects from `normalizeIssue`. The
 * `assignees` array is built from the numeric IDs in `assignee_ids` (the
 * service looks only at username/name, so the synthesized placeholders are
 * fine for the e2e).
 */
function serializeIssue(issue: MutableIssueFixture): Record<string, unknown> {
  return {
    id: issue.id,
    iid: issue.iid,
    project_id: issue.project_id,
    title: issue.title,
    description: issue.description,
    state: issue.state,
    confidential: false,
    web_url: issue.web_url,
    created_at: issue.created_at,
    updated_at: issue.updated_at,
    closed_at: issue.state === 'closed' ? issue.updated_at : null,
    author: { id: issue.author_id, username: 'alex', name: 'Alex Agent' },
    assignees: issue.assignee_ids.map(id => ({ id, username: 'alex', name: 'Alex Agent' })),
    labels: issue.labels,
    references: issue.references,
    // Iteration / milestone are unused by the current service path; left
    // undefined intentionally so the JSON omits the keys (the service
    // normalizers treat undefined as "not present").
    type: 'issue',
    severity: 'unknown'
  };
}

function serializeNote(note: MutableNoteFixture): Record<string, unknown> {
  return {
    id: note.id,
    body: note.body,
    author: { id: note.author_id, username: 'alex', name: 'Alex Agent' },
    created_at: note.created_at,
    updated_at: note.updated_at,
    system: false,
    noteable_id: note.issue_iid,
    noteable_type: 'Issue'
  };
}
