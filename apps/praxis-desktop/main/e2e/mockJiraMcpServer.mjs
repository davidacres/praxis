// SPDX-License-Identifier: MIT
//
// Standalone mock Jira MCP server for Playwright e2e tests of the
// `@praxis/desktop-main` package.
//
// Runs over stdio following the Model Context Protocol (MCP) and serves the
// subset of `atlassian-jira_*` tools the production `JiraService` calls — see
// `apps/vscode-extension/src/jira/jiraService.ts` (COMMUNITY_TOOLS) and the
// companion in-process fixture
// `apps/vscode-extension/src/test/fixtures/fakeJiraMcpServer.ts` for the
// shape each handler must return.
//
// Design notes:
//   * Uses the low-level `Server` class (vs `McpServer`) because the request
//     handlers route through the same `tools/list` / `tools/call` JSON-RPC
//     methods that the extension's `McpClientWrapper` already speaks.
//   * State (issues, boards) is in-memory and process-local — the e2e only
//     exercises a few happy-path calls so persistence is unnecessary.
//   * Tool call responses are wrapped as a single JSON `text` content block so
//     the client's `extractTextBlocks` + `JSON.parse` path produces the same
//     payload the production servers do.
//
// Launch (from anywhere):
//   node mockJiraMcpServer.mjs
//
// Launch (from inside the e2e launched Electron app):
//   command: process.execPath               // node bundled with Electron
//   args:    [absolutePathTo(mockJiraMcpServer.mjs)]

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  ListToolsRequestSchema,
  CallToolRequestSchema
} from '@modelcontextprotocol/sdk/types.js';

// ── Fixture data ────────────────────────────────────────────────────────────

/** Single Jira project the mock reports. The e2e only needs a non-empty list
 *  to satisfy `checkConnection` / `getProjects`. */
const PROJECTS = [
  { id: '1', key: 'DEMO', name: 'Demo Project' }
];

/** Three Jira issues spread across To Do / In Progress / Done so a board view
 *  has multiple columns populated. The shapes match what `normalizeIssue`
 *  expects in `packages/core/src/jira/jiraShape.ts`. */
const FIXTURE_ISSUES = [
  {
    id: '10000',
    key: 'DEMO-1',
    self: 'https://mock.atlassian.net/rest/api/3/issue/DEMO-1',
    fields: {
      summary: 'Bootstrap mock Jira MCP server',
      status: { name: 'To Do', statusCategory: { name: 'todo' } },
      issuetype: { name: 'Task' },
      assignee: { displayName: 'Alex Agent' },
      reporter: { displayName: 'Alex Agent' },
      priority: { name: 'Medium' },
      created: '2026-08-20T08:00:00.000Z',
      updated: '2026-08-20T08:15:00.000Z',
      project: { key: 'DEMO', name: 'Demo Project' },
      description: 'Wire the stdio mock so the desktop e2e suite can drive Jira.',
      comment: { comments: [] }
    }
  },
  {
    id: '10001',
    key: 'DEMO-2',
    self: 'https://mock.atlassian.net/rest/api/3/issue/DEMO-2',
    fields: {
      summary: 'List agile boards from the mock',
      status: { name: 'In Progress', statusCategory: { name: 'indeterminate' } },
      issuetype: { name: 'Story' },
      assignee: { displayName: 'Alex Agent' },
      reporter: { displayName: 'Alex Agent' },
      priority: { name: 'High' },
      created: '2026-08-20T08:05:00.000Z',
      updated: '2026-08-20T08:45:00.000Z',
      project: { key: 'DEMO', name: 'Demo Project' },
      description: 'Surface the agile-board list in the board picker.',
      parent: { key: 'DEMO-1', fields: { summary: 'Bootstrap mock Jira MCP server', issuetype: { name: 'Task' } } },
      comment: { comments: [] }
    }
  },
  {
    id: '10002',
    key: 'DEMO-3',
    self: 'https://mock.atlassian.net/rest/api/3/issue/DEMO-3',
    fields: {
      summary: 'Mark first issue as Done',
      status: { name: 'Done', statusCategory: { name: 'done' } },
      issuetype: { name: 'Task' },
      assignee: { displayName: 'Alex Agent' },
      reporter: { displayName: 'Alex Agent' },
      priority: { name: 'Low' },
      created: '2026-08-20T08:10:00.000Z',
      updated: '2026-08-20T09:00:00.000Z',
      project: { key: 'DEMO', name: 'Demo Project' },
      description: 'Confirm transition_issue moves the column.',
      comment: { comments: [] }
    }
  }
];

/** Mutable copy the create/update handlers mutate; the fixture stays pristine. */
const issues = FIXTURE_ISSUES.map(issue => structuredClone(issue));

/** Single agile board the picker surfaces. The shape matches
 *  `normalizeAgileBoard` so it round-trips into the `Board` type. */
const BOARDS = [
  {
    id: '42',
    name: 'Demo Board',
    type: 'scrum',
    location: {
      projectKey: 'DEMO',
      projectName: 'Demo Project',
      name: 'Demo Project'
    }
  }
];

// ── Tool registry ───────────────────────────────────────────────────────────

/** Tool metadata the server advertises via `tools/list`. Each entry pairs
 *  with a handler in the `toolHandlers` map; `inputSchema` is declared so
 *  strict MCP clients do not reject the call as malformed. */
const TOOL_DESCRIPTORS = [
  {
    name: 'atlassian-jira_get_all_projects',
    description: 'Return the mock Jira project list.',
    inputSchema: {
      type: 'object',
      properties: {
        include_archived: { type: 'boolean' }
      }
    }
  },
  {
    name: 'atlassian-jira_search',
    description: 'Search mock Jira issues using a simple JQL subset.',
    inputSchema: {
      type: 'object',
      properties: {
        jql: { type: 'string' },
        fields: { type: 'string' },
        limit: { type: 'number' },
        start_at: { type: 'number' }
      }
    }
  },
  {
    name: 'atlassian-jira_get_agile_boards',
    description: 'List mock Jira agile boards.',
    inputSchema: {
      type: 'object',
      properties: {
        board_name: { type: 'string' },
        project_key: { type: 'string' },
        board_type: { type: 'string' },
        start_at: { type: 'number' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'atlassian-jira_get_board_issues',
    description: 'Get mock Jira issues for a board.',
    inputSchema: {
      type: 'object',
      properties: {
        board_id: { type: 'string' },
        jql: { type: 'string' },
        fields: { type: 'string' },
        start_at: { type: 'number' },
        limit: { type: 'number' }
      }
    }
  },
  {
    name: 'atlassian-jira_get_issue',
    description: 'Get a mock Jira issue by key.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'string' },
        fields: { type: 'string' }
      }
    }
  },
  {
    name: 'atlassian-jira_create_issue',
    description: 'Create a mock Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        project_key: { type: 'string' },
        summary: { type: 'string' },
        issue_type: { type: 'string' },
        description: { type: 'string' },
        additional_fields: { type: 'string' }
      }
    }
  },
  {
    name: 'atlassian-jira_update_issue',
    description: 'Update a mock Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'string' },
        fields: { type: 'string' },
        additional_fields: { type: 'string' }
      }
    }
  },
  {
    name: 'atlassian-jira_delete_issue',
    description: 'Delete a mock Jira issue by key.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'string' }
      }
    }
  },
  {
    name: 'atlassian-jira_add_comment',
    description: 'Add a comment to a mock Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'string' },
        body: { type: 'string' }
      }
    }
  },
  {
    name: 'atlassian-jira_get_transitions',
    description: 'Return available transitions for a mock Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'string' }
      }
    }
  },
  {
    name: 'atlassian-jira_transition_issue',
    description: 'Apply a transition to a mock Jira issue.',
    inputSchema: {
      type: 'object',
      properties: {
        issue_key: { type: 'string' },
        transition_id: { type: 'string' }
      }
    }
  }
];

// ── Handlers ─────────────────────────────────────────────────────────────────

/** Wrap a JSON payload in the single text-content block the client's
 *  `extractTextBlocks` + `tryParseJson` path expects. */
function jsonResult(value) {
  return {
    content: [
      { type: 'text', text: JSON.stringify(value) }
    ]
  };
}

/** Return a tool error in the same envelope — MCP clients synthesize the
 *  thrown-text into the failure message (`getErrorMessage`). */
function errorResult(message) {
  return {
    isError: true,
    content: [
      { type: 'text', text: String(message) }
    ]
  };
}

/** Cheap JQL subset used for `search` and `get_board_issues`. The production
 *  service filters results in JS anyway so a permissive match is enough for
 *  the e2e to observe non-empty boards. */
function matchesJql(issue, jql) {
  if (!jql || typeof jql !== 'string') {
    return true;
  }
  const normalized = jql.replace(/\s+/g, ' ').trim();
  if (normalized === '' || normalized === 'ORDER BY updated DESC') {
    return true;
  }

  const projectMatch = /project\s*=\s*"([^"]+)"/i.exec(normalized);
  if (projectMatch && issue.fields.project.key !== projectMatch[1]) {
    return false;
  }

  const statusMatch = /status\s*=\s*"([^"]+)"/i.exec(normalized);
  if (statusMatch && issue.fields.status.name !== statusMatch[1]) {
    return false;
  }

  const textMatch = /text\s*~\s*"([^"]+)"/i.exec(normalized);
  if (textMatch) {
    const needle = textMatch[1].toLowerCase();
    const haystack = `${issue.key} ${issue.fields.summary}`.toLowerCase();
    if (!haystack.includes(needle)) {
      return false;
    }
  }

  return true;
}

/** Status → list of legal transitions. Kept small — the e2e only confirms
 *  the workflow endpoint round-trips. */
function transitionsForStatus(statusName) {
  switch (statusName) {
    case 'To Do':
      return [
        { id: 'start-progress', name: 'Start Progress', to: { name: 'In Progress' } },
        { id: 'mark-done', name: 'Mark Done', to: { name: 'Done' } }
      ];
    case 'In Progress':
      return [
        { id: 'mark-done', name: 'Mark Done', to: { name: 'Done' } },
        { id: 'send-back', name: 'Send Back', to: { name: 'To Do' } }
      ];
    case 'Done':
      return [
        { id: 'reopen', name: 'Reopen', to: { name: 'In Progress' } }
      ];
    default:
      return [];
  }
}

/** Build the next available issue key for a project. Mirrors the fake fixture
 *  in `fakeJiraMcpServer.ts`. */
function nextIssueKey(projectKey) {
  const used = issues
    .map(issue => issue.key)
    .filter(key => key.startsWith(`${projectKey}-`))
    .map(key => Number.parseInt(key.slice(projectKey.length + 1), 10))
    .filter(n => Number.isFinite(n));
  const max = used.length > 0 ? Math.max(...used) : 0;
  return `${projectKey}-${max + 1}`;
}

const toolHandlers = {
  'atlassian-jira_get_all_projects': () => jsonResult(PROJECTS),

  'atlassian-jira_search': args => {
    const jql = typeof args?.jql === 'string' ? args.jql : '';
    const limit = typeof args?.limit === 'number' ? args.limit : 50;
    const startAt = typeof args?.start_at === 'number' ? args.start_at : 0;

    const matching = issues
      .filter(issue => matchesJql(issue, jql))
      .sort((a, b) => b.fields.updated.localeCompare(a.fields.updated));

    const paged = matching.slice(startAt, startAt + limit);

    return jsonResult({
      issues: paged,
      total: matching.length,
      isLast: startAt + paged.length >= matching.length
    });
  },

  'atlassian-jira_get_agile_boards': () =>
    jsonResult({ values: BOARDS, total: BOARDS.length, isLast: true }),

  'atlassian-jira_get_board_issues': args => {
    const boardId = typeof args?.board_id === 'string' ? args.board_id : '';
    if (boardId !== '42') {
      return errorResult(`Board ${boardId} was not found.`);
    }

    const jql = typeof args?.jql === 'string' ? args.jql : '';
    const limit = typeof args?.limit === 'number' ? args.limit : 50;
    const startAt = typeof args?.start_at === 'number' ? args.start_at : 0;

    const matching = issues
      .filter(issue => matchesJql(issue, jql))
      .sort((a, b) => b.fields.updated.localeCompare(a.fields.updated));
    const paged = matching.slice(startAt, startAt + limit);

    return jsonResult({
      issues: paged,
      total: matching.length,
      isLast: startAt + paged.length >= matching.length
    });
  },

  'atlassian-jira_get_issue': args => {
    const issueKey = typeof args?.issue_key === 'string' ? args.issue_key : '';
    const found = issues.find(issue => issue.key === issueKey);
    if (!found) {
      return errorResult(`Issue ${issueKey} was not found.`);
    }
    return jsonResult(found);
  },

  'atlassian-jira_create_issue': args => {
    const projectKey = typeof args?.project_key === 'string' ? args.project_key.trim() : '';
    const summary = typeof args?.summary === 'string' ? args.summary.trim() : '';
    const issueType = typeof args?.issue_type === 'string' ? args.issue_type.trim() : '';
    const description = typeof args?.description === 'string' ? args.description : '';
    if (!projectKey || !summary || !issueType) {
      return errorResult('project_key, summary and issue_type are required.');
    }
    const created = {
      id: String(issues.length + 1),
      key: nextIssueKey(projectKey),
      self: `https://mock.atlassian.net/rest/api/3/issue/${projectKey}-${issues.length + 1}`,
      fields: {
        summary,
        status: { name: 'To Do', statusCategory: { name: 'todo' } },
        issuetype: { name: issueType },
        assignee: null,
        reporter: { displayName: 'Alex Agent' },
        priority: { name: 'Medium' },
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        project: { key: projectKey, name: 'Demo Project' },
        description: description || '',
        comment: { comments: [] }
      }
    };
    issues.push(created);
    return jsonResult(created);
  },

  'atlassian-jira_update_issue': args => {
    const issueKey = typeof args?.issue_key === 'string' ? args.issue_key : '';
    const target = issues.find(issue => issue.key === issueKey);
    if (!target) {
      return errorResult(`Issue ${issueKey} was not found.`);
    }

    let parsedFields = {};
    if (typeof args?.fields === 'string' && args.fields.length > 0) {
      try {
        parsedFields = JSON.parse(args.fields);
      } catch {
        parsedFields = {};
      }
    }

    if (typeof parsedFields.summary === 'string') {
      target.fields.summary = parsedFields.summary;
    }
    if (typeof parsedFields.description === 'string') {
      target.fields.description = parsedFields.description;
    }

    target.fields.updated = new Date().toISOString();
    return jsonResult(target);
  },

  'atlassian-jira_delete_issue': args => {
    const issueKey = typeof args?.issue_key === 'string' ? args.issue_key : '';
    const index = issues.findIndex(issue => issue.key === issueKey);
    if (index < 0) {
      return errorResult(`Issue ${issueKey} was not found.`);
    }
    const [removed] = issues.splice(index, 1);
    return jsonResult({ ok: true, issueKey: removed.key });
  },

  'atlassian-jira_add_comment': args => {
    const issueKey = typeof args?.issue_key === 'string' ? args.issue_key : '';
    const body = typeof args?.body === 'string' ? args.body.trim() : '';
    const target = issues.find(issue => issue.key === issueKey);
    if (!target) {
      return errorResult(`Issue ${issueKey} was not found.`);
    }
    if (body.length === 0) {
      return errorResult('Comment cannot be empty.');
    }
    const comment = {
      id: `${issueKey}-comment-${target.fields.comment.comments.length + 1}`,
      author: { displayName: 'Alex Agent' },
      body,
      created: new Date().toISOString(),
      updated: new Date().toISOString()
    };
    target.fields.comment.comments.push(comment);
    target.fields.updated = comment.created;
    return jsonResult({ ok: true, issueKey, commentId: comment.id });
  },

  'atlassian-jira_get_transitions': args => {
    const issueKey = typeof args?.issue_key === 'string' ? args.issue_key : '';
    const target = issues.find(issue => issue.key === issueKey);
    if (!target) {
      return errorResult(`Issue ${issueKey} was not found.`);
    }
    return jsonResult({
      transitions: transitionsForStatus(target.fields.status.name)
    });
  },

  'atlassian-jira_transition_issue': args => {
    const issueKey = typeof args?.issue_key === 'string' ? args.issue_key : '';
    const transitionId = typeof args?.transition_id === 'string' ? args.transition_id : '';
    const target = issues.find(issue => issue.key === issueKey);
    if (!target) {
      return errorResult(`Issue ${issueKey} was not found.`);
    }
    const transition = transitionsForStatus(target.fields.status.name)
      .find(candidate => candidate.id === transitionId);
    if (!transition) {
      return errorResult(`Transition ${transitionId} is not valid for ${issueKey}.`);
    }
    target.fields.status = { name: transition.to.name, statusCategory: { name: statusCategoryFor(transition.to.name) } };
    target.fields.updated = new Date().toISOString();
    return jsonResult({ ok: true, issueKey, status: target.fields.status.name });
  }
};

function statusCategoryFor(statusName) {
  switch (statusName) {
    case 'Done':
      return 'done';
    case 'In Progress':
    case 'Blocked':
      return 'indeterminate';
    default:
      return 'todo';
  }
}

// ── Server wiring ────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'mock-jira-mcp', version: '1.0.0' },
  { capabilities: { tools: {} } }
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOL_DESCRIPTORS
}));

server.setRequestHandler(CallToolRequestSchema, async request => {
  const name = request?.params?.name;
  const args = request?.params?.arguments ?? {};

  const handler = toolHandlers[name];
  if (!handler) {
    return errorResult(`Unknown tool: ${name}`);
  }

  try {
    return await handler(args);
  } catch (error) {
    return errorResult(error instanceof Error ? error.message : String(error));
  }
});

// `Server.connect` may resolve once the transport is wired; cancellation of
// the running MCP request loop happens automatically when stdin closes.
// No explicit teardown is needed on exit.
const transport = new StdioServerTransport();
await server.connect(transport);

/**
 * Defensive exit: kill the process on stdin/signal as well. The MCP transport
 * listens for stdin EOF and closes gracefully, but a noisy stderr inside the
 * MCP server can otherwise cause zombies when Electron reaps the child
 * abruptly. `exit` instead of `disconnect()` mirrors what the in-process fake
 * fixture accomplishes via disconnect.
 */
process.stdin.on('close', () => {
  process.exit(0);
});
