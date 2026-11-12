import { openConnections } from './connectionNavigation';
// SPDX-License-Identifier: MIT
//
// e2e spec for the Jira MCP connection flow on the desktop app. Seeds the
// per-test settings file (see `launchTestApp`) with a `jiracloud` connection
// whose `settings` point at the standalone `mockJiraMcpServer.mjs` MCP server
// via stdio: `command: process.execPath` (node) + the absolute path to the
// mock.
//
// The mock implements the community adapter name set declared in
// `packages/core/src/jira/jiraService.ts` (`COMMUNITY_TOOLS`); the
// `checkConnection`/`getBoards` flows reach it through the resolver chain
// described in `packages/core/src/jira/jiraMcpConnectionResolver.ts`
// (legacy stdio → workspace MCP → user MCP).

import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

/** Absolute path the resolver will launch as the stdio MCP server. */
const MOCK_MCP_PATH = path.resolve(__dirname, 'mockJiraMcpServer.mjs');

/**
 * Builds the seed `settings.json` payload so the resolver can find the mock
 * MCP server. The connection's `settings` carry the legacy stdio keys
 * expected by `tryLegacyStdio` / the per-connection resolver port:
 *   * `stdioCommand` — process to spawn (we use Node shipped with Electron)
 *   * `stdioArgs` — args passed to the command, here `[mockJiraMcpServer.mjs]`
 *   * `stdioCwd` — optional working directory
 * `process.execPath` is what `StdioClientTransport` recommends anyway — the
 * bundled Node is on disk next to the Electron binary, so the spawn does not
 * rely on the system `node` being installed.
 */
function seededSettings(mockPath = MOCK_MCP_PATH): Record<string, unknown> {
  return {
    connections: [
      {
        id: 'mock-jira-mcp',
        name: 'Mock Jira MCP',
        mode: 'jiracloud',
        settings: {
          stdioCommand: process.execPath,
          stdioArgs: [mockPath],
          stdioCwd: process.cwd()
        }
      }
    ]
  };
}

let app: TestApp | undefined;
let window: Page;

test.beforeEach(async () => {
  app = await launchTestApp(seededSettings());
  window = app.window;
});

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

/** Open the connections panel and select the seeded jiracloud connection. */
async function openSeededConnection(): Promise<void> {
  await openConnections(window);
  const row = window.locator('[data-testid="connection-row"]', {
    hasText: 'Mock Jira MCP'
  });
  await expect(row).toBeVisible();
  await row.click();
  await expect(window.locator('[data-testid="conn-form"]')).toBeVisible();
}

test('test connection against the mock MCP server reports success', async () => {
  await openSeededConnection();

  // The form's self-test button is the same path the production app uses for
  // jira MCP. The text we look for — absence of "ERROR" / "Jira MCP is not
  // configured" — matches both the shipped stub error and the success shape
  // emitted by `JiraService.checkConnection`.
  await window.locator('[data-testid="conn-test-btn"]').click();
  const result = window.locator('[data-testid="conn-test-result"]');
  await expect(result).toBeVisible();
  await expect(result).not.toContainText('ERROR');
  await expect(result).not.toContainText('Jira MCP is not configured');
});

test('board picker lists the boards the mock MCP server reports', async () => {
  await openSeededConnection();

  // `supportsManualBoardSelection('jiracloud')` is `true` so the picker
  // button is rendered for jiracloud connections.
  await expect(window.locator('[data-testid="conn-pick-boards-btn"]')).toBeVisible();
  await window.locator('[data-testid="conn-pick-boards-btn"]').click();

  const picker = window.locator('[data-testid="board-picker"]');
  await expect(picker).toBeVisible();
  // Mock returns a single "Demo Board" entry — no `board-picker-empty`
  // placeholder should appear.
  await expect(window.locator('[data-testid="board-picker-empty"]')).toHaveCount(0);
  await expect(
    window.locator('[data-testid="board-picker-row"]', { hasText: 'Demo Board' })
  ).toBeVisible();
});

// ── write operations, over both tool sets ───────────────────────────────────

const ATLASSIAN_MOCK_PATH = path.resolve(__dirname, 'mockAtlassianMcpServer.mjs');

async function relaunch(mockPath: string): Promise<void> {
  if (app) await closeTestApp(app);
  app = await launchTestApp(seededSettings(mockPath));
  window = app.window;
}

/** create, edit, comment and (where the surface has it) delete through the issue IPC. */
async function writeRoundTrip(canDelete: boolean): Promise<void> {
  const id = 'mock-jira-mcp';
  const created = await window.evaluate(
    async connectionId =>
      window.praxis.issue.create(
        { projectKey: 'DEMO', issueType: 'Task', summary: ' Written by e2e ', description: 'First body' },
        connectionId
      ),
    id
  );
  expect(created.summary).toBe('Written by e2e');
  expect(created.description).toBe('First body');

  const edited = await window.evaluate(
    async ([connectionId, key]) =>
      window.praxis.issue.update(
        key,
        { summary: 'Edited by e2e', description: 'Second body', priority: 'High', assignee: 'Sam' },
        connectionId
      ),
    [id, created.key]
  );
  expect(edited.summary).toBe('Edited by e2e');
  expect(edited.priority).toBe('High');
  expect(edited.assignee).toBe('Sam');

  await window.evaluate(
    async ([connectionId, key]) => window.praxis.issue.addComment(key, '  a comment ', connectionId),
    [id, created.key]
  );
  const reread = await window.evaluate(
    async ([connectionId, key]) => window.praxis.issue.get(key, connectionId),
    [id, created.key]
  );
  expect(reread.comments?.map(comment => comment.body)).toEqual(['a comment']);

  const deletion = window.evaluate(
    async ([connectionId, key]) =>
      window.praxis.issue.delete(key, connectionId).then(
        () => 'deleted',
        (error: Error) => String(error.message)
      ),
    [id, created.key]
  );
  if (canDelete) {
    expect(await deletion).toBe('deleted');
    const gone = await window.evaluate(
      async ([connectionId, key]) =>
        window.praxis.issue.get(key, connectionId).then(
          () => 'found',
          () => 'missing'
        ),
      [id, created.key]
    );
    expect(gone).toBe('missing');
  } else {
    expect(await deletion).toContain('does not expose a tool for deleteIssue');
  }
}

test('create, edit, comment and delete issues over the community tool set', async () => {
  await writeRoundTrip(true);
});

test('create, edit and comment on issues over the official Atlassian tool set', async () => {
  await relaunch(ATLASSIAN_MOCK_PATH);
  await writeRoundTrip(false);
});

test('a parent that breaks the hierarchy is refused before any write', async () => {
  const message = await window.evaluate(async () =>
    window.praxis.issue
      .create({ projectKey: 'DEMO', issueType: 'Subtask', summary: 'Orphan' }, 'mock-jira-mcp')
      .then(
        () => 'created',
        (error: Error) => String(error.message)
      )
  );
  expect(message).toContain('is required');
});
