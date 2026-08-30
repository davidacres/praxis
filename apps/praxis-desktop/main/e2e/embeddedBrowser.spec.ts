import * as http from 'node:http';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * A link in an AI session chat opens the page in the right-hand pane instead
 * of leaving the conversation for the system browser. Covers the whole path:
 * the plain-text reply is linkified, the click fills the aux pane with an
 * Electron `<webview>` guest, and the guest actually loads the page (asserted
 * through its reported title, which only arrives from a real load).
 */

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined
} as const;

const PAGE_TITLE = 'Praxis embedded page';

/** A one-page site for the guest to load, so the test never touches the internet. */
async function startPageServer(): Promise<{ baseUrl: string; close: () => Promise<void> }> {
  const server = http.createServer((_req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(`<!doctype html><html><head><title>${PAGE_TITLE}</title></head><body><h1>Docs</h1></body></html>`);
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;
  return {
    baseUrl: `http://127.0.0.1:${port}`,
    close: () => new Promise<void>(resolve => server.close(() => resolve()))
  };
}

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
let site: { baseUrl: string; close: () => Promise<void> } | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
  if (site) {
    await site.close();
    site = undefined;
  }
});

test('a link in a session chat opens an embedded browser in the right-hand pane', async () => {
  site = await startPageServer();
  const pageUrl = `${site.baseUrl}/docs`;
  mock = await startMockGatewayServer({
    mode: 'complete',
    reply: `The setup notes live at ${pageUrl} — worth a read.`
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  await win.evaluate(async () => {
    await window.praxis.ai.delegate({
      issueKey: 'APP-101',
      provider: 'vercel-gateway',
      task: { goal: 'Point me at the setup notes.' }
    });
  });
  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', {
    timeout: 15000
  });

  // The reply is plain text, so the URL inside it has to be linkified here —
  // and the trailing em dash must not be swallowed into the href.
  const link = win.locator('[data-testid="session-chat-link"]', { hasText: pageUrl });
  await expect(link).toHaveCount(1);
  await expect(link).toHaveAttribute('href', pageUrl);

  // Nothing is embedded until the link is clicked.
  await expect(win.locator('[data-testid="embedded-browser"]')).toHaveCount(0);
  await link.click();

  const browser = win.locator('[data-testid="embedded-browser"]');
  await expect(browser).toBeVisible();
  // The browser takes over the right-hand pane rather than opening a window.
  await expect(win.locator('[data-testid="issue-details-pane"]').locator(browser)).toHaveCount(1);
  await expect(win.locator('[data-testid="embedded-browser-address"]')).toHaveValue(pageUrl);
  // A title only arrives once the guest has really loaded the page.
  await expect(win.locator('[data-testid="embedded-browser-title"]')).toHaveText(PAGE_TITLE, {
    timeout: 20000
  });
  await expect(win.locator('[data-testid="embedded-browser-error"]')).toHaveCount(0);
  // The conversation is still on screen beside it.
  await expect(win.locator('[data-testid="session-chat-thread"]')).toBeVisible();

  // Closing gives the pane back to the issue details it normally shows.
  await win.getByLabel('Close browser').click();
  await expect(win.locator('[data-testid="embedded-browser"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="aux-empty"]')).toBeVisible();
});
