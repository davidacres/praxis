import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * Phase I — Shell polish:
 *
 * 1. The bottom panel's Output tab backfills from the main-process log bus
 *    (the `[app] … started` line written at launch proves the ring buffer and
 *    the `log:getRecent` channel end to end).
 * 2. Lines appended later stream live into the open Output tab: delegating a
 *    free-form goal against the mock gateway makes the AI service log
 *    `[VercelAgent] Starting session…`, which must appear without reopening
 *    the panel (the `log:appended` push channel).
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
let gateway: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (gateway) {
    await gateway.close();
    gateway = undefined;
  }
});

test('output tab backfills the main-process log buffer', async () => {
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;

  await win.locator('[aria-label="Toggle panel"]').click();
  await win.locator('[data-testid="panel-tab-output"]').click();

  const output = win.locator('[data-testid="output-log"]');
  await expect(output).toContainText('[app]');
  await expect(output).toContainText('started');
});

test('output tab streams lines appended while it is open', async () => {
  gateway = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: gateway.baseUrl
  });
  const win = app.window;

  // Open the Output tab first — the line must arrive over the push channel,
  // not via a reopen backfill.
  await win.locator('[aria-label="Toggle panel"]').click();
  await win.locator('[data-testid="panel-tab-output"]').click();
  await win.locator('[data-testid="output-log"]').waitFor();

  const composer = win.locator('[data-testid="new-session-view"]');
  await composer.waitFor();
  await composer.locator('textarea').fill('Refactor the demo board store');
  await win.locator('[data-testid="new-session-submit"]').click();

  await expect(win.locator('[data-testid="output-log"]')).toContainText('Starting session', {
    timeout: 15000
  });
  await expect(win.locator('[data-testid="output-log"]')).toContainText('[ai]');
});

test('output tab filters, copies and clears the log', async () => {
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;

  await win.locator('[aria-label="Toggle panel"]').click();
  await win.locator('[data-testid="panel-tab-output"]').click();
  const output = win.locator('[data-testid="output-log"]');
  await expect(output).toContainText('[app]');

  // Terms are ANDed and case-insensitive; the [tag] prefix is searchable.
  await win.locator('[data-testid="output-filter"]').fill('STARTED [app]');
  await expect(output).toContainText('started');
  await win.locator('[data-testid="output-filter"]').fill('no-such-line-anywhere');
  await expect(win.locator('[data-testid="output-no-match"]')).toBeVisible();
  await expect(win.locator('[data-testid="output-copy"]')).toBeDisabled();

  await win.locator('[data-testid="output-filter"]').fill('');
  await expect(output).toContainText('[app]');
  await win.locator('[data-testid="output-clear"]').click();
  await expect(output).toContainText('No output yet.');
});

test('output history survives a restart', async () => {
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  await app.window.locator('[aria-label="Toggle panel"]').click();
  await app.window.locator('[data-testid="panel-tab-output"]').click();
  await expect(app.window.locator('[data-testid="output-log"]')).toContainText('started');
  // Let the serialised file writer flush before the process goes away.
  await app.window.waitForTimeout(500);

  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  app = await launchTestApp(undefined, reuse, { ...NO_GATEWAY_ENV });

  // The panel's open state is remembered across launches; only open it if it is shut.
  if (await app.window.locator('[data-testid="panel-tab-output"]').count() === 0) {
    await app.window.locator('[aria-label="Toggle panel"]').click();
  }
  await app.window.locator('[data-testid="panel-tab-output"]').click();
  await expect(app.window.locator('[data-testid="output-log"]')).toContainText('previous session above');
});

