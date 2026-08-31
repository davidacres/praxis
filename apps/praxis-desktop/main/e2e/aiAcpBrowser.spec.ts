import * as path from 'node:path';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

/**
 * ACP agents (Claude Code / Codex) reach the in-app browser through an HTTP MCP
 * server Praxis hosts. The fake ACP agent advertises `mcpCapabilities.http`,
 * connects to the `praxis-browser` server it's handed in `session/new`, and
 * drives one navigation — proving the whole path end to end.
 */

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

let app: TestApp | undefined;
let pages: http.Server | undefined;
let pageOrigin = '';

test.beforeAll(async () => {
  pages = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>ACP Probe</title><h1>ACP Probe</h1><p>needle 90210</p>');
  });
  await new Promise<void>(resolve => pages!.listen(0, '127.0.0.1', resolve));
  pageOrigin = `http://127.0.0.1:${(pages!.address() as AddressInfo).port}`;
});

test.afterAll(async () => {
  await new Promise<void>(resolve => pages?.close(() => resolve()));
});

test.afterEach(async () => {
  if (app) { await closeTestApp(app); app = undefined; }
});

async function startAcpBrowserSession(win: TestApp['window'], wd: string, goal: string): Promise<void> {
  await win.evaluate(async ({ cliPath, wd, goal }) => {
    await window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath } } } });
    await window.praxis.ai.delegate({
      provider: 'claude-code-cli',
      toolMode: 'full',
      workingDirectory: wd,
      task: { goal }
    });
  }, { cliPath: FIXTURE_PATH, wd, goal });
}

test('an ACP session drives the in-app browser via the MCP server', async () => {
  app = await launchTestApp(
    { ai: { browserTools: { enabled: true, allowedHosts: ['127.0.0.1'] } } },
    undefined,
    { PRAXIS_BROWSER_ALLOW_LOOPBACK: '1', FAKE_ACP_BROWSER_URL: `${pageOrigin}/` }
  );
  const win = app.window;
  await startAcpBrowserSession(win, app.userDataDir, 'USE_BROWSER and report the needle');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]').first().click();

  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('needle 90210', { timeout: 20000 });
  await expect(win.locator('[data-testid="browser-pane"]')).toBeVisible({ timeout: 15000 });
  await expect(win.locator('[data-testid="browser-url-input"]')).toHaveValue(
    new RegExp(pageOrigin.replace(/[.]/g, '\\.'))
  );
});

test('the browser stays connected across a follow-up turn', async () => {
  app = await launchTestApp(
    { ai: { browserTools: { enabled: true, allowedHosts: ['127.0.0.1'] } } },
    undefined,
    { PRAXIS_BROWSER_ALLOW_LOOPBACK: '1', FAKE_ACP_BROWSER_URL: `${pageOrigin}/` }
  );
  const win = app.window;
  await startAcpBrowserSession(win, app.userDataDir, 'USE_BROWSER first pass');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]').first().click();
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('needle 90210', { timeout: 20000 });
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });

  // A follow-up turn must reach the same MCP endpoint — no "disconnected".
  await win.locator('[data-testid="session-follow-up-input"]').fill('USE_BROWSER second pass');
  await win.locator('[data-testid="session-follow-up-send"]').click();
  await expect(win.locator('[data-testid="session-chat-thread"]')).not.toContainText('NO_MCP_SERVER', { timeout: 20000 });
  await win.waitForTimeout(1500);
  const logs = await win.evaluate(() => window.praxis.log.getRecent());
  console.log('FAKE_ACP lines:\n' + logs.filter(l => l.includes('FAKE_ACP')).join('\n'));
  const results = await win.locator('[data-testid="session-chat-thread"]').innerText();
  expect((results.match(/BROWSER RESULT/g) ?? []).length).toBeGreaterThanOrEqual(2);
});

test('an unlisted host prompts on the session card, then proceeds when allowed', async () => {
  app = await launchTestApp(
    { ai: { browserTools: { enabled: true, allowedHosts: [] } } },
    undefined,
    { PRAXIS_BROWSER_ALLOW_LOOPBACK: '1', FAKE_ACP_BROWSER_URL: `${pageOrigin}/` }
  );
  const win = app.window;
  await startAcpBrowserSession(win, app.userDataDir, 'USE_BROWSER');

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]').first().click();

  const card = win.locator('[data-testid="session-permission-card"]');
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card).toContainText('in-app browser');
  await win.locator('[data-testid="session-permission-allow-once"]').click();

  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('needle 90210', { timeout: 20000 });
});
