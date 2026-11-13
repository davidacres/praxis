import { openSession } from './sessionNavigation';
import { test, expect } from '@playwright/test';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * Every navigation the in-app browser makes for an agent is checked, not just the
 * `browser_navigate` call: a link it clicks or a redirect it is sent through that
 * leaves the approved host asks the user first, and a destination on loopback or a
 * private network is refused outright. The e2e server has no native webview, so
 * this drives the fetched-page backend.
 *
 * The pages are served from loopback, so the e2e-only allowance
 * `PRAXIS_E2E_BROWSER_ALLOW_LOOPBACK` (`1`, or a list of ports) lets the start page
 * load. `localhost` names a different host from `127.0.0.1`, which stands in for
 * "another site" in the allow-list tests.
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
let start: http.Server | undefined;
let elsewhere: http.Server | undefined;
let startPort = 0;
let elsewherePort = 0;
let elsewhereHits = 0;

function listen(server: http.Server): Promise<number> {
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve((server.address() as AddressInfo).port)));
}

test.beforeAll(async () => {
  // The destination every refused navigation would have reached; it counts requests.
  elsewhere = http.createServer((_req, res) => {
    elsewhereHits += 1;
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end('<!doctype html><title>Elsewhere</title><p>you should not be here</p>');
  });
  elsewherePort = await listen(elsewhere);
  start = http.createServer((req, res) => {
    if (req.url === '/to-other-host') {
      res.writeHead(302, { Location: `http://localhost:${elsewherePort}/landed` });
      res.end();
      return;
    }
    if (req.url === '/to-loopback') {
      res.writeHead(302, { Location: `http://127.0.0.1:${elsewherePort}/admin` });
      res.end();
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(
      '<!doctype html><title>Start</title><h1>Start</h1>' +
        `<a href="http://localhost:${elsewherePort}/clicked">leave this site</a>`
    );
  });
  startPort = await listen(start);
});

test.afterAll(async () => {
  await new Promise<void>(resolve => start?.close(() => resolve()));
  await new Promise<void>(resolve => elsewhere?.close(() => resolve()));
});

test.beforeEach(() => {
  elsewhereHits = 0;
});

test.afterEach(async () => {
  if (app) { await closeTestApp(app); app = undefined; }
  if (mock) { await mock.close(); mock = undefined; }
});

async function runAgent(
  calls: Array<{ name: string; arguments: Record<string, unknown> }>,
  allowance: string
): Promise<TestApp['window']> {
  mock = await startMockGatewayServer({
    mode: 'complete',
    reply: 'done browsing',
    models: [{ id: 'mock/model' }],
    roundTrips: [...calls.map(call => ({ toolCalls: [call] })), {}]
  });
  app = await launchTestApp(
    { ai: { browserTools: { enabled: true, allowedHosts: ['127.0.0.1'] } } },
    undefined,
    {
      ...NO_GATEWAY_ENV,
      AI_GATEWAY_API_KEY: 'e2e-gateway-key',
      AI_GATEWAY_URL: mock.baseUrl,
      PRAXIS_E2E_BROWSER_ALLOW_LOOPBACK: allowance
    }
  );
  const win = app.window;
  await win.evaluate(async wd => window.praxis.ai.delegate({
    provider: 'vercel-gateway', model: 'mock/model', toolMode: 'full', workingDirectory: wd,
    task: { goal: 'Browse the start page.' }
  }), app.userDataDir);
  await openSession(win);
  return win;
}

/** Everything the agent was told by its tools, as the gateway saw it. */
function toolResults(): string {
  return (mock?.requests ?? []).map(request => request.body).join('\n');
}

async function denyHost(win: TestApp['window'], host: string): Promise<void> {
  const card = win.locator('[data-testid="session-permission-card"]');
  await expect(card).toBeVisible({ timeout: 20000 });
  await expect(card).toContainText(`open ${host} in the in-app browser`);
  await win.locator('[data-testid="session-permission-deny"]').click();
}

test('a link the agent clicks to an unapproved host asks first, and a refusal keeps it off that host', async () => {
  const win = await runAgent([
    { name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${startPort}/` } },
    { name: 'browser_click', arguments: { ref: 'e1' } }
  ], '1');

  await denyHost(win, 'localhost');
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 20000 });
  expect(toolResults()).toContain('Permission denied to open localhost.');
  expect(elsewhereHits).toBe(0);
  await expect(win.locator('[data-testid="browser-url-input"]')).toHaveValue(`http://127.0.0.1:${startPort}/`);
});

test('a redirect to an unapproved host asks first, and a refusal stops the request', async () => {
  const win = await runAgent([
    { name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${startPort}/to-other-host` } }
  ], '1');

  await denyHost(win, 'localhost');
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 20000 });
  expect(toolResults()).toContain('Permission denied to open localhost.');
  expect(elsewhereHits).toBe(0);
});

test('a redirect or a name that leads to loopback is refused without asking', async () => {
  // Only the start page's port is let through; every other loopback address is
  // refused, as every loopback address is in a normal launch.
  const win = await runAgent([
    { name: 'browser_navigate', arguments: { url: `http://127.0.0.1:${startPort}/to-loopback` } },
    { name: 'browser_navigate', arguments: { url: `http://localhost:${elsewherePort}/` } }
  ], String(startPort));

  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 20000 });
  await expect(win.locator('[data-testid="session-permission-card"]')).toHaveCount(0);
  const results = toolResults();
  expect(results).toContain(`Refusing to open a loopback / private-network host (127.0.0.1)`);
  expect(results).toContain(`Refusing to open a loopback / private-network host (localhost`);
  expect(elsewhereHits).toBe(0);
});
