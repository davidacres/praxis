import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

// FX-BF-050: the provider budgets section (now Settings -> AI Usage, since the Overview was retired in f977690f) reads every enabled provider
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
async function openAiUsage(page: import('@playwright/test').Page): Promise<void> {
  await page.locator('[data-testid="titlebar-settings"]').click();
  await page.getByTestId('settings-nav-ai-usage').click();
}

function launchWithProviders(enabled: string[]): Promise<TestApp> {
  const providers = Object.fromEntries(BUILT_IN.map(id => [id, { enabled: enabled.includes(id) }]));
  return launchTestApp({ ai: { providers } });
}

test('a provider with no usage API is shown as no data, with the reason', async () => {
  // Anthropic has no adapter wired up, so this exercises the honest-empty
  // path rather than a network read.
  app = await launchWithProviders(['anthropic']);
  const page = app.window;
  await openAiUsage(page);

  const section = page.getByTestId('ai-usage-budgets-section');
  await expect(section).toBeVisible();
  const card = page.getByTestId('ai-usage-budgets-card-anthropic');
  await expect(card).toBeVisible();
  await expect(card).toHaveClass(/is-compact/);
  await expect(page.getByTestId('ai-usage-budgets-nodata-anthropic')).toContainText('No data');
  // The reason is the useful part: a bare "no data" hides whether the fix is a
  // missing CLI, a missing API, or a rejected key.
  await expect(page.getByTestId('ai-usage-budgets-nodata-anthropic')).toContainText('does not expose an account usage API');

  const shot = path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'compact-provider-budget-card.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await card.screenshot({ path: shot });
});

test('a disabled provider gets no card', async () => {
  // Anthropic is on, Gemini is explicitly off: only the enabled one is reported.
  app = await launchWithProviders(['anthropic']);
  const page = app.window;
  await openAiUsage(page);

  await expect(page.getByTestId('ai-usage-budgets-section')).toBeVisible();
  await expect(page.getByTestId('ai-usage-budgets-card-anthropic')).toBeVisible();
  await expect(page.getByTestId('ai-usage-budgets-card-gemini')).toHaveCount(0);
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
  await openAiUsage(page);

  // The section renders once the slowest provider answers, and Codex and Claude
  // Code each spawn their own CLI (Claude's `/usage` takes a few seconds cold).
  await expect(page.getByTestId('ai-usage-budgets-section')).toBeVisible({ timeout: 20_000 });
  for (const id of ['anthropic', 'gemini', 'codex-cli', 'claude-code-cli']) {
    await expect(page.getByTestId(`ai-usage-budgets-card-${id}`)).toBeVisible();
  }
  // The batch itself succeeded, so there is no section-level error.
  await expect(page.getByTestId('ai-usage-budgets-error')).toHaveCount(0);
  // A provider with no adapter always reports the reason it has no data.
  await expect(page.getByTestId('ai-usage-budgets-nodata-anthropic')).toContainText('No data');
});

test('provider budgets render even when the usage ledger is empty', async () => {
  // The two sections read different stores: provider budgets are account state
  // at the provider, the tiles are this workspace's ledger. A fresh workspace
  // has no ledger entries but may still have a configured provider, and hiding
  // the budgets behind "no usage yet" would be wrong.
  app = await launchWithProviders(['anthropic']);
  const page = app.window;
  await openAiUsage(page);

  await expect(page.getByTestId('ai-usage-empty')).toBeVisible();
  await expect(page.getByTestId('ai-usage-budgets-section')).toBeVisible();
  await expect(page.getByTestId('ai-usage-budgets-card-anthropic')).toBeVisible();
});

test('no enabled providers lists no cards', async () => {
  // The Overview's "No providers enabled" prose has no counterpart on the Settings page; the
  // invariant that survives is that nothing is reported on when nothing is enabled.
  app = await launchWithProviders([]);
  const page = app.window;
  await openAiUsage(page);

  await expect(page.getByTestId('ai-usage-budgets-section')).toContainText('0 of 0');
  await expect(page.locator('[data-testid^="ai-usage-budgets-card-"]')).toHaveCount(0);
});

test('a provider that exposes no usage API is never badged Offline', async () => {
  // The bug this pins: status was derived from "has an unavailableReason",
  // so a provider that will never report usage was badged Offline.
  app = await launchWithProviders(['anthropic']);
  const page = app.window;
  await openAiUsage(page);

  const card = page.getByTestId('ai-usage-budgets-card-anthropic');
  await expect(card).toBeVisible();
  await expect(card).not.toContainText('Offline');
  await expect(page.getByTestId('ai-usage-budgets-status-anthropic')).toHaveText('No data');
});

test('a card shows no invented spend, rate limit or reset figures', async () => {
  // These used to come from a hardcoded table and rendered identically to a
  // real reading. A provider with no measurement must show nothing.
  app = await launchWithProviders(['anthropic']);
  const page = app.window;
  await openAiUsage(page);

  const card = page.getByTestId('ai-usage-budgets-card-anthropic');
  // The footer labels remain, but with nothing measured they carry no value.
  await expect(card.locator('.ai-rate-limit-pill')).toHaveCount(0);
  await expect(card.locator('.ai-quota-row')).toHaveCount(0);
  await expect(card).toContainText('Not reported');
  await expect(card).not.toContainText('RPM');
  await expect(card).not.toContainText('Tier');
  await expect(card).not.toContainText(/\$[\d.]+/);
});
