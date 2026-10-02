import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockAnthropicServer, type MockAnthropicServer } from './mockAnthropicServer';

/**
 * First-run AI setup: a profile with no usable provider is held at a wizard
 * (choose → connect → review) until at least one provider works. Every other
 * spec skips it through `launchTestApp`'s default.
 */

let app: TestApp | undefined;
let mock: MockAnthropicServer | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
});

const shots = path.resolve(process.cwd(), 'output', 'playwright');

/** No key anywhere, so nothing counts as configured through the environment. */
const NOTHING_CONFIGURED = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined,
  GITHUB_TOKEN: undefined,
  GH_TOKEN: undefined
};

/** CLI agents resolve through the developer's login shell, so pin each to a path that cannot exist. */
const missing = (name: string) => ({ cliPath: `/nonexistent/${name}` });
const seed = (anthropicBaseUrl: string) => ({
  ai: { providers: { 'claude-code-cli': missing('claude'), 'codex-cli': missing('codex'), 'copilot-cli': missing('copilot'), 'antigravity-cli': missing('agy'), anthropic: { baseUrl: anthropicBaseUrl } } }
});

test('an unconfigured profile must connect one provider before reaching the app', async () => {
  mock = await startMockAnthropicServer({ mode: 'complete' });
  app = await launchTestApp(seed(mock.baseUrl), undefined, NOTHING_CONFIGURED, { workspace: false, aiOnboarding: true });
  const win = app.window;

  await expect(win.getByTestId('ai-setup-wizard')).toBeVisible();
  await expect(win.getByTestId('getting-started')).toHaveCount(0);

  // The titlebar controls are locked until a provider is connected; the window's own buttons are not.
  expect(await win.evaluate(() => document.querySelectorAll('.titlebar [inert]').length)).toBeGreaterThan(0);
  expect(await win.evaluate(() => document.querySelectorAll('.titlebar .caption-controls[inert]').length)).toBe(0);

  // Global shortcuts must not reach the app behind the wizard (palette, new session, quick session).
  // Checked after each key: Ctrl+K toggles, so a batch of presses could cancel itself out.
  for (const combo of ['Control+k', 'Meta+k', 'Control+n', 'Meta+n', 'Control+Shift+n', 'Meta+Shift+n']) {
    await win.keyboard.press(combo);
    // Assertions on absence pass instantly, before a wrongly-opened palette would render.
    await win.waitForTimeout(250);
    await expect(win.locator('.command-palette'), combo).toHaveCount(0);
    await expect(win.getByTestId('new-session-view'), combo).toHaveCount(0);
  }
  await expect(win.getByTestId('ai-setup-wizard')).toBeVisible();
  expect(await win.evaluate(() => window.praxis.ai.listSessions().then(list => list.length))).toBe(0);

  // Step 1 refuses to move on with nothing chosen.
  await win.getByTestId('ai-setup-continue').click();
  await expect(win.getByTestId('ai-setup-error')).toContainText('at least one');
  await win.screenshot({ path: path.join(shots, 'ai-setup-choose.png') });

  // Step 2 refuses to move on until the chosen provider actually connects.
  await win.getByTestId('ai-setup-choice-anthropic').click();
  await win.getByTestId('ai-setup-continue').click();
  await expect(win.getByTestId('ai-setup-card-anthropic')).toBeVisible();
  await win.getByTestId('ai-setup-continue').click();
  await expect(win.getByTestId('ai-setup-error')).toContainText('Connect at least one');

  await win.getByTestId('ai-setup-key-anthropic').fill('e2e-anthropic-key');
  await win.getByTestId('ai-setup-connect-anthropic').click();
  await expect(win.getByTestId('ai-setup-card-anthropic')).toContainText('Connected');
  await win.screenshot({ path: path.join(shots, 'ai-setup-connect.png') });

  // Step 3 sets the default and lets the user in.
  await win.getByTestId('ai-setup-continue').click();
  await expect(win.getByTestId('ai-setup-default-anthropic')).toHaveAttribute('aria-checked', 'true');
  await win.screenshot({ path: path.join(shots, 'ai-setup-review.png') });
  await win.getByTestId('ai-setup-finish').click();

  await expect(win.getByTestId('ai-setup-wizard')).toHaveCount(0);
  await expect(win.getByTestId('getting-started')).toBeVisible();
  expect(await win.evaluate(() => document.querySelectorAll('.titlebar [inert]').length)).toBe(0);
  const settings = await win.evaluate(() => window.praxis.settings.get());
  expect(settings.ai.activeProvider).toBe('anthropic');
  expect(await win.evaluate(() => localStorage.getItem('praxis-ai-onboarded'))).toBe('1');
});

test('a profile that already has a usable provider never sees the wizard', async () => {
  app = await launchTestApp(seed('http://127.0.0.1:9'), undefined, { ...NOTHING_CONFIGURED, AI_GATEWAY_API_KEY: 'gateway-e2e-key' }, { workspace: false, aiOnboarding: true });
  await expect(app.window.getByTestId('getting-started')).toBeVisible();
  await expect(app.window.getByTestId('ai-setup-wizard')).toHaveCount(0);
  await expect.poll(() => app!.window.evaluate(() => localStorage.getItem('praxis-ai-onboarded'))).toBe('1');
});
