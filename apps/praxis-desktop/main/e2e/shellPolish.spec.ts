import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { startMockGitLabApi, type MockGitLabServer } from './mockGitLabApi';

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
 * 3. Selecting an issue pins a compact peek card above the sidebar footer.
 * 4. Non-demo connection groups in the sidebar carry a health dot fed by
 *    `connection.check` (a mock GitLab server answers `ok`); the demo group
 *    carries none.
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
let gitlab: MockGitLabServer | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (gateway) {
    await gateway.close();
    gateway = undefined;
  }
  if (gitlab) {
    await gitlab.close();
    gitlab = undefined;
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

test('selecting an issue pins a peek card above the sidebar footer', async () => {
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;

  // No selection yet — no card.
  await expect(win.locator('[data-testid="issue-peek"]')).toHaveCount(0);

  // APP-100 is the seed feature on the Platform Overview board.
  await win.locator('[data-testid="board-nav-item"]', { hasText: 'Platform Overview' }).click();
  await win.locator('[data-testid="issue-card"]', { hasText: 'APP-100' }).click();

  const peek = win.locator('[data-testid="issue-peek"]');
  await peek.waitFor();
  await expect(peek).toContainText('APP-100');
  await expect(peek).toContainText('Core platform feature');
  await expect(peek).toContainText('In Progress');
  await expect(peek).toContainText('High');
  await expect(peek).toContainText('Alex Agent');

  // Closing the detail pane clears the selection — the card goes with it.
  await win.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(peek).toHaveCount(0);
});

test('connection groups carry a health dot from connection checks', async () => {
  gitlab = await startMockGitLabApi();
  app = await launchTestApp(
    {
      connections: [
        {
          id: 'mock-gitlab-rest',
          name: 'Mock GitLab',
          mode: 'gitlab',
          settings: {
            url: gitlab.baseUrl,
            projectPath: 'group/demo',
            apiKey: 'glpat-test'
          }
        }
      ]
    },
    undefined,
    { ...NO_GATEWAY_ENV }
  );
  const win = app.window;

  // The sidebar lists boards flat rather than grouping them under a connection
  // header, so the health dot rides on the board row itself.
  const gitlabBoard = win.locator('[data-testid="board-nav-item"]', { hasText: 'Demo Board' });
  await gitlabBoard.waitFor();
  await expect(gitlabBoard.locator('[data-testid="status-dot"]')).toHaveAttribute(
    'data-status',
    'ok',
    { timeout: 15000 }
  );

  // The built-in boards are local and carry no connection — so no dot.
  const builtInBoard = win.locator('[data-testid="board-nav-item"]', { hasText: 'Application Board' });
  await expect(builtInBoard.locator('[data-testid="status-dot"]')).toHaveCount(0);
});
