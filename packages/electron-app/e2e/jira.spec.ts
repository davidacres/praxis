// SPDX-License-Identifier: MIT
//
// e2e spec for the Jira MCP connection flow on the desktop app. Seeds the
// per-test settings file (see `launchTestApp`) with a `jiracloud` connection
// whose `settings` point at the standalone `mockJiraMcpServer.mjs` MCP server
// via stdio: `command: process.execPath` (node) + the absolute path to the
// mock.
//
// The mock implements the community adapter name set declared in
// `packages/vscode-extension/src/jira/jiraService.ts` (`COMMUNITY_TOOLS`); the
// `checkConnection`/`getBoards` flows reach it through the resolver chain
// described in `packages/vscode-extension/src/jira/jiraMcpConnectionResolver.ts`
// (legacy stdio → workspace MCP → user MCP).
//
// Status: forward-looking. The Electron app's Jira MCP backend is not yet
// ported (see `packages/electron-app/src/main/serviceRegistry.ts` — jiracloud
// falls through to `StubBackendService` for now), so these tests may fail at
// runtime while the port lands. They are kept here so the spec, the mock and
// the seeding shape stay in sync against the resolver contract.

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
function seededSettings(): Record<string, unknown> {
  return {
    connections: [
      {
        id: 'mock-jira-mcp',
        name: 'Mock Jira MCP',
        mode: 'jiracloud',
        settings: {
          stdioCommand: process.execPath,
          stdioArgs: [MOCK_MCP_PATH],
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
  await window.locator('[data-testid="nav-connections"]').click();
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
