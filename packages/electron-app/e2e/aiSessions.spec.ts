import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * Phase E — AI sessions UI. Exercises the renderer against the real IPC
 * surface with a mock gateway (no live API key):
 *
 * 1. The New Session composer delegates a free-form goal, lands on the
 *    Sessions view, and the console streams the session's events live until
 *    the mock completes it.
 * 2. The issue detail pane can delegate its issue to the agent and abort the
 *    in-flight session.
 * 3. Without any API key, the composer surfaces the provider-not-configured
 *    error instead of failing silently.
 */

/** Env that guarantees "no key anywhere" unless a test sets one explicitly. */
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

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
});

test('composer delegates a free-form goal and the sessions console streams to completion', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  // The app opens on the New Session composer.
  const composer = win.locator('[data-testid="new-session-view"]');
  await composer.waitFor();
  await composer.locator('textarea').fill('Refactor the demo board store');
  await win.locator('[data-testid="new-session-submit"]').click();

  // Lands on the Sessions view with the new session selected.
  await win.locator('[data-testid="sessions-view"]').waitFor();
  const row = win.locator('[data-testid="session-list-row"]', {
    hasText: 'Refactor the demo board store'
  });
  await row.waitFor();

  // The agent runs to completion against the mock; the badge and console follow.
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', {
    timeout: 15000
  });
  await expect(win.locator('[data-testid="session-event-row"]').first()).toBeVisible();
  await expect(win.locator('[data-testid="session-response"]')).toContainText(
    'Mock gateway reply'
  );
  // Completed is terminal — no abort button.
  await expect(win.locator('[data-testid="session-abort-btn"]')).toHaveCount(0);
});

test('issue detail delegates its issue to the agent and aborts the in-flight session', async () => {
  mock = await startMockGatewayServer({ mode: 'hang' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  // Open a demo issue in the aux detail pane.
  await win.locator('[data-testid="board-nav-item"]').first().click();
  await win.locator('[data-testid="issue-card"]').first().click();
  await win.locator('[data-testid="issue-ai-delegate-btn"]').waitFor();

  await win.locator('[data-testid="issue-ai-delegate-btn"]').click();

  // Session starts; the mock hangs, so the state stays in-flight and Abort shows.
  await expect(win.locator('[data-testid="issue-ai-state"]')).toBeVisible();
  await expect(win.locator('[data-testid="issue-ai-state"]')).not.toHaveText('Completed');
  await win.locator('[data-testid="issue-ai-abort-btn"]').click();
  await expect(win.locator('[data-testid="issue-ai-state"]')).toHaveText('Aborted');
  // Terminal state offers a restart instead of abort.
  await expect(win.locator('[data-testid="issue-ai-restart-btn"]')).toBeVisible();
});

test('composer surfaces the provider-not-configured error when no API key exists', async () => {
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;

  const composer = win.locator('[data-testid="new-session-view"]');
  await composer.waitFor();
  await composer.locator('textarea').fill('Try without a key');
  await win.locator('[data-testid="new-session-submit"]').click();

  await expect(win.locator('[data-testid="new-session-error"]')).toContainText(
    'No Vercel AI Gateway API key configured'
  );
  // Still on the composer — no navigation happened.
  await expect(win.locator('[data-testid="sessions-view"]')).toHaveCount(0);
});
