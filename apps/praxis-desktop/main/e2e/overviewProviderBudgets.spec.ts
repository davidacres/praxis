import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

// FX-BF-050: the Overview provider budgets section reads every enabled provider
// in one batched IPC call (`aiUsage:providerSnapshots`). These tests pin the
// three states the panel must distinguish — quota, consumption-only, and no data
// with a reason — because flattening them into one shape would imply a limit
// where none exists.

let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

const BUILT_IN = ['openai', 'anthropic', 'gemini', 'z-ai', 'claude-code-cli', 'codex-cli', 'copilot-cli', 'antigravity-cli', 'cursor-cli'];

/**
 * Launches with the named providers enabled and every other built-in turned off,
 * so a card's presence is a real signal rather than an accident of which
 * providers the test profile happens to have.
 */
function launchWithProviders(enabled: string[]): Promise<TestApp> {
  const providers = Object.fromEntries(BUILT_IN.map(id => [id, { enabled: enabled.includes(id) }]));
  return launchTestApp({ ai: { providers } });
}

test('a provider with no usage API is shown as no data, with the reason', async () => {
  // Anthropic has no adapter wired up, so this exercises the honest-empty
  // path rather than a network read.
  app = await launchWithProviders(['anthropic']);
  const page = app.window;
  await page.getByTestId('nav-overview').click();

  const section = page.getByTestId('overview-budgets-section');
  await expect(section).toBeVisible();
  await expect(page.getByTestId('overview-budgets-card-anthropic')).toBeVisible();
  await expect(page.getByTestId('overview-budgets-nodata-anthropic')).toContainText('No data');
  // The reason is the useful part: a bare "no data" hides whether the fix is a
  // missing CLI, a missing API, or a rejected key.
  await expect(page.getByTestId('overview-budgets-nodata-anthropic')).toContainText('does not expose an account usage API');
});

test('a disabled provider gets no card', async () => {
  // Anthropic is on, Gemini is explicitly off: only the enabled one is reported.
  app = await launchWithProviders(['anthropic']);
  const page = app.window;
  await page.getByTestId('nav-overview').click();

  await expect(page.getByTestId('overview-budgets-section')).toBeVisible();
  await expect(page.getByTestId('overview-budgets-card-anthropic')).toBeVisible();
  await expect(page.getByTestId('overview-budgets-card-gemini')).toHaveCount(0);
});

test('every enabled provider gets its own card, whatever each one reports', async () => {
  // Whether Codex and Claude Code succeed here depends on what is installed on
  // the machine running the suite, so this asserts the invariant that holds in
  // both cases: every enabled provider is reported on, and one provider's
  // outcome never suppresses the others. A machine with a working Codex shows
  // quota windows; one without shows "no data" with a reason. Both are correct,
  // so the test must pass either way — `readProviderSnapshots`' unit test pins
  // the failure path deterministically instead.
  app = await launchWithProviders(['anthropic', 'gemini', 'codex-cli', 'claude-code-cli']);
  const page = app.window;
  await page.getByTestId('nav-overview').click();

  // The section renders once the slowest provider answers, and Codex and Claude
  // Code each spawn their own CLI (Claude's `/usage` takes a few seconds cold).
  await expect(page.getByTestId('overview-budgets-section')).toBeVisible({ timeout: 20_000 });
  for (const id of ['anthropic', 'gemini', 'codex-cli', 'claude-code-cli']) {
    await expect(page.getByTestId(`overview-budgets-card-${id}`)).toBeVisible();
  }
  // The batch itself succeeded, so there is no section-level error.
  await expect(page.getByTestId('overview-budgets-error')).toHaveCount(0);
  // A provider with no adapter always reports the reason it has no data.
  await expect(page.getByTestId('overview-budgets-nodata-anthropic')).toContainText('No data');
});

test('provider budgets render even when the usage ledger is empty', async () => {
  // The two sections read different stores: provider budgets are account state
  // at the provider, the tiles are this workspace's ledger. A fresh workspace
  // has no ledger entries but may still have a configured provider, and hiding
  // the budgets behind "no usage yet" would be wrong.
  app = await launchWithProviders(['anthropic']);
  const page = app.window;
  await page.getByTestId('nav-overview').click();

  await expect(page.getByTestId('overview-usage-empty')).toBeVisible();
  await expect(page.getByTestId('overview-budgets-section')).toBeVisible();
  await expect(page.getByTestId('overview-budgets-card-anthropic')).toBeVisible();
});

test('no enabled providers explains how to add one', async () => {
  app = await launchWithProviders([]);
  const page = app.window;
  await page.getByTestId('nav-overview').click();

  await expect(page.getByTestId('overview-budgets-empty')).toContainText('No providers enabled');
});

test('a provider that exposes no usage API is never badged Offline', async () => {
  // The bug this pins: status was derived from "has an unavailableReason",
  // so a provider that will never report usage was badged Offline.
  app = await launchWithProviders(['anthropic']);
  const page = app.window;
  await page.getByTestId('nav-overview').click();

  const card = page.getByTestId('overview-budgets-card-anthropic');
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('Offline');
  await expect(page.getByTestId('overview-budgets-status-anthropic')).toHaveText('No data');
});

test('a card shows no invented spend, rate limit or reset figures', async () => {
  // These used to come from a hardcoded table and rendered identically to a
  // real reading. A provider with no measurement must show nothing.
  app = await launchWithProviders(['anthropic']);
  const page = app.window;
  await page.getByTestId('nav-overview').click();

  const card = page.getByTestId('overview-budgets-card-anthropic');
  await expect(card).not.toContainText('MTD Spend');
  await expect(card).not.toContainText('RPM');
  await expect(card).not.toContainText('Tier');
  await expect(card).not.toContainText(/\$[\d.]+/);
});
