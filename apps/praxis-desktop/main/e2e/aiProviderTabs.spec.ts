import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockAnthropicServer, type MockAnthropicServer } from './mockAnthropicServer';
import { chooseOption, chipOptionValues } from './chipSelect';

/**
 * Settings → AI Provider is tabbed (Providers · Defaults · Spend · Tools), and
 * each provider is one row with an on/off switch. Turning a provider off keeps
 * it out of every picker and refuses new sessions on it; nothing is deleted.
 */

let app: TestApp | undefined;
let anthropic: MockAnthropicServer | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (anthropic) await anthropic.close();
  app = undefined;
  anthropic = undefined;
});

async function launchWithTwoProviders(): Promise<Page> {
  anthropic = await startMockAnthropicServer({ mode: 'complete' });
  // The gateway is configured through its env key (the default provider); Anthropic through a stored key.
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-e2e-key' });
  const win = app.window;
  await win.evaluate(
    async ({ baseUrl }) => {
      await window.praxis.settings.set({ ai: { providers: { anthropic: { baseUrl } } } });
      await window.praxis.ai.setProviderApiKey('anthropic', 'e2e-anthropic-key');
    },
    { baseUrl: anthropic.baseUrl }
  );
  await win.reload();
  await win.waitForSelector('[data-testid="new-session-view"]');
  return win;
}

async function openAiSettings(win: Page): Promise<void> {
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-ai').click();
  await win.getByTestId('ai-provider-list').waitFor();
  // Wait for the status probe so switch states are settled.
  await expect(win.getByTestId('ai-provider-status')).not.toHaveText('Checking…');
}

async function closeSettings(win: Page): Promise<void> {
  await win.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();
}

const providerOptionCount = async (win: Page): Promise<number> => {
  await win.getByTestId('new-session-provider-chip').click();
  const count = await win.getByTestId('new-session-provider-option-anthropic').count();
  await win.keyboard.press('Escape');
  return count;
};

test('the page is split into tabs and each tab shows only its own settings', async () => {
  const win = await launchWithTwoProviders();
  await openAiSettings(win);

  const tabs = win.getByRole('tablist', { name: 'AI provider settings' });
  await expect(tabs.getByRole('tab')).toHaveText(['Providers', 'Defaults', 'Spend', 'Tools']);
  await expect(tabs.getByRole('tab', { name: 'Providers' })).toHaveAttribute('aria-selected', 'true');

  // Providers: the rows, and none of the other tabs' content.
  await expect(win.getByTestId('ai-provider-list')).toBeVisible();
  await expect(win.getByTestId('ai-spend-report')).toHaveCount(0);
  await expect(win.getByTestId('ai-browser-tools-toggle')).toHaveCount(0);
  await expect(win.getByTestId('ai-recommendation-provider-select')).toHaveCount(0);

  await tabs.getByRole('tab', { name: 'Defaults' }).click();
  await expect(win.getByTestId('ai-recommendation-provider-select')).toBeVisible();
  await expect(win.getByLabel('AI agent display name')).toBeVisible();
  await expect(win.getByTestId('ai-provider-list')).toHaveCount(0);

  await win.screenshot({ path: path.join(path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts'), 'ai-provider-tabs-defaults.png') });

  await tabs.getByRole('tab', { name: 'Spend' }).click();
  await expect(win.getByTestId('ai-spend-report')).toBeVisible();
  await expect(win.getByLabel('Spend limit')).toBeVisible();

  await tabs.getByRole('tab', { name: 'Tools' }).click();
  await expect(win.getByTestId('ai-browser-tools-toggle')).toBeVisible();

  await tabs.getByRole('tab', { name: 'Providers' }).click();
  await expect(win.getByTestId('ai-provider-list')).toBeVisible();
});

test('each provider is one row with a switch; the default and unconfigured ones cannot be switched', async () => {
  const win = await launchWithTwoProviders();
  await openAiSettings(win);

  const rows = win.getByTestId('ai-provider-list').locator('[data-testid^="ai-provider-row-"]');
  expect(await rows.count()).toBeGreaterThanOrEqual(5);

  // The default (gateway) is on and cannot be turned off without choosing another default.
  const gateway = win.getByTestId('ai-provider-enabled-vercel-gateway');
  await expect(gateway).toHaveAttribute('aria-checked', 'true');
  await expect(gateway).toBeDisabled();
  await expect(win.getByTestId('ai-provider-default-vercel-gateway')).toBeVisible();

  // Anthropic is configured, so it can be switched.
  const anthropicSwitch = win.getByTestId('ai-provider-enabled-anthropic');
  await expect(anthropicSwitch).toHaveAttribute('aria-checked', 'true');
  await expect(anthropicSwitch).toBeEnabled();

  // OpenAI has no key: off, and its switch says so and leads into setup rather than being dead.
  const openai = win.getByTestId('ai-provider-enabled-openai');
  await expect(openai).toHaveAttribute('aria-checked', 'false');
  await expect(openai).toBeEnabled();
  await expect(openai).toHaveAttribute('title', /API key/);

  const artifacts = path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await win.screenshot({ path: path.join(artifacts, 'ai-provider-tabs-providers.png') });

  // Only the selected row shows its connection details.
  await expect(win.getByTestId('ai-provider-body-vercel-gateway')).toBeVisible();
  await expect(win.getByTestId('ai-provider-body-anthropic')).toHaveCount(0);
  await win.getByTestId('ai-provider-row-anthropic').locator('.ai-provider-head').click();
  await expect(win.getByTestId('ai-provider-body-anthropic')).toBeVisible();
  await expect(win.getByTestId('ai-provider-body-vercel-gateway')).toHaveCount(0);
  await expect(win.getByLabel('Anthropic base URL')).toHaveValue(anthropic!.baseUrl);
});

test('turning a provider off removes it from the composer and refuses new sessions on it; turning it on restores it', async () => {
  const win = await launchWithTwoProviders();

  // Baseline: Anthropic is offered.
  expect(await providerOptionCount(win)).toBe(1);

  await openAiSettings(win);
  await win.getByTestId('ai-provider-enabled-anthropic').click();
  await expect(win.getByTestId('ai-provider-enabled-anthropic')).toHaveAttribute('aria-checked', 'false');
  await expect(win.getByTestId('ai-provider-row-anthropic')).toContainText('Turned off');

  // Persisted as an explicit false; the key and base URL are untouched.
  const stored = await win.evaluate(async () => (await window.praxis.settings.get()).ai.providers.anthropic);
  expect(stored?.enabled).toBe(false);
  expect(stored?.baseUrl).toBe(anthropic!.baseUrl);
  const status = await win.evaluate(async () => (await window.praxis.ai.listProviderStatuses()).find(s => s.provider === 'anthropic'));
  expect(status).toMatchObject({ configured: true, enabled: false });

  // The main process refuses a new session on it.
  const refused = await win.evaluate(async () => {
    try {
      await window.praxis.ai.delegate({ provider: 'anthropic', toolMode: 'read-only', task: { goal: 'hello' } });
      return 'started';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  });
  expect(refused).toMatch(/turned off/i);

  await closeSettings(win);
  await win.reload();
  await win.waitForSelector('[data-testid="new-session-view"]');
  expect(await providerOptionCount(win)).toBe(0);

  // Back on: offered again.
  await openAiSettings(win);
  await win.getByTestId('ai-provider-enabled-anthropic').click();
  await expect(win.getByTestId('ai-provider-enabled-anthropic')).toHaveAttribute('aria-checked', 'true');
  await closeSettings(win);
  await win.reload();
  await win.waitForSelector('[data-testid="new-session-view"]');
  expect(await providerOptionCount(win)).toBe(1);
});

test('making another provider the default frees the previous default to be switched off', async () => {
  const win = await launchWithTwoProviders();
  await openAiSettings(win);

  await win.getByTestId('ai-provider-set-active-anthropic').click();
  await expect(win.getByTestId('ai-provider-default-anthropic')).toBeVisible();
  await expect(win.getByTestId('ai-provider-enabled-anthropic')).toBeDisabled();
  await expect(win.getByTestId('ai-provider-enabled-vercel-gateway')).toBeEnabled();
});

test('pressing the switch on a provider that is not set up opens its setup, and it turns on once a key is saved', async () => {
  const win = await launchWithTwoProviders();
  // Point OpenAI at a closed local port so the key check that follows a save fails fast and offline.
  await win.evaluate(async () => {
    await window.praxis.settings.set({ ai: { providers: { openai: { baseUrl: 'http://127.0.0.1:9' } } } });
  });
  await openAiSettings(win);

  const openai = win.getByTestId('ai-provider-enabled-openai');
  await expect(openai).toHaveAttribute('aria-checked', 'false');
  await expect(win.getByTestId('ai-provider-body-openai')).toHaveCount(0);

  await openai.click();

  // Its setup opens, says what to do, and the key field is focused ready to paste into.
  await expect(win.getByTestId('ai-provider-body-openai')).toBeVisible();
  await expect(win.getByTestId('ai-provider-setup-hint-openai')).toContainText(/API key/);
  await expect(win.getByTestId('ai-api-key-input')).toBeFocused();
  await expect(openai).toHaveAttribute('aria-checked', 'false');
  await win.screenshot({ path: path.join(path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts'), 'ai-provider-setup.png') });

  // Saving a key turns it on by itself — there is nothing else to switch.
  await win.getByTestId('ai-api-key-input').fill('sk-e2e-openai-key');
  await win.getByTestId('ai-api-key-save').click();
  await expect(openai).toHaveAttribute('aria-checked', 'true');
  await expect(win.getByTestId('ai-provider-setup-hint-openai')).toHaveCount(0);
  const status = await win.evaluate(async () => (await window.praxis.ai.listProviderStatuses()).find(s => s.provider === 'openai'));
  expect(status).toMatchObject({ configured: true, enabled: true });
});

test('the Recommendations provider list leaves out providers that are turned off, but keeps a chosen one visible', async () => {
  const win = await launchWithTwoProviders();
  await openAiSettings(win);

  const select = () => win.getByTestId('ai-recommendation-provider-select');
  const optionValues = async () => chipOptionValues(select());

  await win.getByTestId('ai-tab-defaults').click();
  expect(await optionValues()).toContain('anthropic');

  // Off: no longer offered.
  await win.getByTestId('ai-tab-providers').click();
  await win.getByTestId('ai-provider-enabled-anthropic').click();
  await expect(win.getByTestId('ai-provider-enabled-anthropic')).toHaveAttribute('aria-checked', 'false');
  await win.getByTestId('ai-tab-defaults').click();
  expect(await optionValues()).not.toContain('anthropic');

  // Chosen first, then turned off: still listed, marked, so the select does not blank a stored value.
  await win.getByTestId('ai-tab-providers').click();
  await win.getByTestId('ai-provider-enabled-anthropic').click();
  await win.getByTestId('ai-tab-defaults').click();
  await chooseOption(select(), 'anthropic');
  await win.getByTestId('ai-tab-providers').click();
  await win.getByTestId('ai-provider-enabled-anthropic').click();
  await win.getByTestId('ai-tab-defaults').click();
  await expect(select()).toHaveAttribute('data-value', 'anthropic');
  await select().click();
  await expect(win.locator('[role="option"][data-value="anthropic"]')).toHaveText(/Anthropic.*turned off/);
  await win.keyboard.press('Escape');
});
