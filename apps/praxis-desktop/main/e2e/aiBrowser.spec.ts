import { test, expect } from '@playwright/test';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * The in-app AI browser: a full-tools gateway session can drive a WebContentsView
 * docked in the session console, and the user can drive it from the toolbar.
 */

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined
} as const;

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
let pages: http.Server | undefined;
let pageOrigin = '';

test.beforeAll(async () => {
  pages = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      `<!doctype html><title>Praxis Browser Probe</title>` +
        `<h1>Praxis Browser Probe</h1>` +
        `<p>the needle is 4815162342</p>` +
        `<a href="${req.url === '/next' ? '/' : '/next'}">go elsewhere</a>` +
        `<input aria-label="search box" />`
    );
  });
  await new Promise<void>(resolve => pages!.listen(0, '127.0.0.1', resolve));
  pageOrigin = `http://127.0.0.1:${(pages!.address() as AddressInfo).port}`;
});

test('restores the selected session and browser URL and keeps an explicit close closed', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', reply: 'ok', models: [{ id: 'mock/model' }] });
  app = await launchTestApp(
    { ai: { browserTools: { enabled: true, allowedHosts: [] } } },
    undefined,
    { ...NO_GATEWAY_ENV, AI_GATEWAY_API_KEY: 'k', AI_GATEWAY_URL: mock.baseUrl, PRAXIS_BROWSER_ALLOW_LOOPBACK: '1' }
  );
  const win = app.window;
  const session = await win.evaluate(async wd => window.praxis.ai.delegate({
    provider: 'vercel-gateway', model: 'mock/model', toolMode: 'read-only', workingDirectory: wd,
    task: { goal: 'persist browser state' }
  }), app.userDataDir);
  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="session-console-title"]')).toHaveText('persist browser state');
  await win.locator('[data-testid="session-browser-toggle"]').click();
  const url = win.locator('[data-testid="browser-url-input"]');
  await url.fill(`${pageOrigin}/next`);
  await url.press('Enter');
  await expect(url).toHaveValue(new RegExp(`${pageOrigin.replace(/[.]/g, '\\.')}/next`), { timeout: 15000 });
  await win.getByRole('button', { name: 'Close browser' }).click();
  expect(await win.evaluate(() => JSON.parse(localStorage.getItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`) ?? '{}'))).toMatchObject({
    feature: 'sessions', sessionKey: session.issueKey, browserOpen: false
  });

  const userDataDir = app.userDataDir;
  const settingsPath = app.settingsPath;
  await app.electronApp.close();
  app = await launchTestApp(undefined, { userDataDir, settingsPath }, undefined, { workspace: false });
  await expect(app.window.locator('[data-testid="sessions-view"]')).toBeVisible();
  await expect(app.window.locator('[data-testid="session-console-title"]')).toHaveText('persist browser state');
  await expect(app.window.locator('[data-testid="browser-pane"]')).toHaveCount(0);
});

test.afterAll(async () => {
  await new Promise<void>(resolve => pages?.close(() => resolve()));
});

test.afterEach(async () => {
  if (app) { await closeTestApp(app); app = undefined; }
  if (mock) { await mock.close(); mock = undefined; }
});

test('a full-tools session drives the in-app browser and reads the page', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    reply: 'I read the probe page.',
    models: [{ id: 'mock/thorough' }],
    toolCall: { name: 'browser_navigate', arguments: { url: `${pageOrigin}/` } }
  });
  app = await launchTestApp(
    { ai: { browserTools: { enabled: true, allowedHosts: ['127.0.0.1'] } } },
    undefined,
    {
      ...NO_GATEWAY_ENV,
      AI_GATEWAY_API_KEY: 'e2e-gateway-key',
      AI_GATEWAY_URL: mock.baseUrl,
      PRAXIS_BROWSER_ALLOW_LOOPBACK: '1'
    }
  );
  const win = app.window;

  await win.evaluate(async wd => {
    return window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      model: 'mock/thorough',
      toolMode: 'full',
      workingDirectory: wd,
      task: { goal: 'Open the probe page and tell me the needle value.' }
    });
  }, app.userDataDir);

  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="session-console"]')).toBeVisible();

  // The browser pane auto-opens when the agent first drives it, and shows the
  // page the tool navigated to.
  await expect(win.locator('[data-testid="browser-pane"]')).toBeVisible({ timeout: 15000 });
  await expect(win.locator('[data-testid="browser-url-input"]')).toHaveValue(new RegExp(pageOrigin.replace(/[.]/g, '\\.')));

  // The navigate tool result carried the page text back into the transcript.
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('the needle is 4815162342', {
    timeout: 15000
  });
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
});

test('the toolbar navigates the in-app browser by hand', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', reply: 'ok', models: [{ id: 'mock/model' }] });
  app = await launchTestApp(
    { ai: { browserTools: { enabled: true, allowedHosts: [] } } },
    undefined,
    { ...NO_GATEWAY_ENV, AI_GATEWAY_API_KEY: 'k', AI_GATEWAY_URL: mock.baseUrl, PRAXIS_BROWSER_ALLOW_LOOPBACK: '1' }
  );
  const win = app.window;

  await win.evaluate(async wd => {
    return window.praxis.ai.delegate({
      provider: 'vercel-gateway', model: 'mock/model', toolMode: 'read-only', workingDirectory: wd,
      task: { goal: 'nothing' }
    });
  }, app.userDataDir);

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-browser-toggle"]').click();
  // Browser tools are on for this session, so the dock is framed as AI-controlled.
  await expect(win.locator('.session-browser-dock.ai-controlled')).toBeVisible();
  const url = win.locator('[data-testid="browser-url-input"]');
  await expect(url).toBeVisible();
  await url.fill(`${pageOrigin}/`);
  await url.press('Enter');
  await expect(url).toHaveValue(new RegExp(pageOrigin.replace(/[.]/g, '\\.')), { timeout: 15000 });

  // Maximize widens the dock to fill the console; restore brings it back.
  const dock = win.locator('.session-browser-dock');
  const narrow = (await dock.boundingBox())!.width;
  await win.locator('[data-testid="browser-maximize-btn"]').click();
  await expect(win.locator('.session-console.browser-maximized')).toBeVisible();
  expect((await dock.boundingBox())!.width).toBeGreaterThan(narrow + 100);
  await win.locator('[data-testid="browser-maximize-btn"]').click();
  await expect(win.locator('.session-console.browser-maximized')).toHaveCount(0);
});
