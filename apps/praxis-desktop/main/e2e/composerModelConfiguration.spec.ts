import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { openSession } from './sessionNavigation';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
});

// Proven with the composer cog removed: the entry-point visibility assertion fails.
test('composer model settings curate provider chips and preserve the conversation draft', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', models: [
    { id: 'mock/nimbus-4', name: 'Nimbus 4' },
    { id: 'mock/nimbus-4-mini', name: 'Nimbus 4 Mini' },
    { id: 'mock/nimbus-4-pro', name: 'Nimbus 4 Pro' }
  ] });
  app = await launchTestApp({ ai: {
    activeProvider: 'vercel-gateway', defaultModel: 'mock/nimbus-4',
    providers: { openai: { enabledModelIds: ['other-provider-model'] } }
  } }, undefined, { AI_GATEWAY_API_KEY: 'model-settings-test', AI_GATEWAY_URL: mock.baseUrl }, { demoMode: false });
  const page = app.window;
  await page.getByTestId('conversations-new-btn').click();
  const draft = page.getByTestId('new-session-view').locator('textarea');
  await draft.fill('Keep this conversation draft.');
  const modelChip = page.getByTestId('new-session-model-chip');
  await expect(modelChip).toHaveText('Nimbus 4');
  await expect(modelChip.locator('.composer-chip-meta')).toHaveCount(0);
  await expect(page.getByTestId('new-session-git-branch-chip')).toBeVisible();
  await modelChip.click();
  const filter = page.getByTestId('new-session-model-filter');
  const cog = page.getByTestId('new-session-model-settings');
  await expect(cog).toBeVisible();
  const filterBox = await filter.boundingBox();
  const cogBox = await cog.boundingBox();
  expect(cogBox!.x).toBeGreaterThanOrEqual(filterBox!.x + filterBox!.width);
  expect(Math.abs(cogBox!.y + cogBox!.height / 2 - filterBox!.y - filterBox!.height / 2)).toBeLessThan(2);
  await page.getByRole('listbox', { name: 'Model', exact: true }).screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/composer-model-settings-cog.png') });
  await cog.click();
  const dialog = page.getByRole('dialog', { name: 'Vercel AI Gateway model configuration' });
  await expect(dialog.getByRole('switch')).toHaveCount(3);
  await expect(page.getByRole('listbox', { name: 'Model', exact: true })).toHaveCount(0);
  await dialog.getByTestId('model-manager-toggle-mock/nimbus-4-mini').click();
  await dialog.getByTestId('model-manager-toggle-mock/nimbus-4-pro').click();
  await expect(dialog.getByTestId('model-manager-toggle-mock/nimbus-4-mini')).toHaveAttribute('aria-checked', 'false');
  await expect(dialog.getByTestId('model-manager-count')).toHaveText('1 of 3 selected');
  await expect.poll(() => page.evaluate(async () => (await window.praxis.settings.get()).ai.providers['vercel-gateway']?.enabledModelIds))
    .toEqual(['mock/nimbus-4']);
  expect(await page.evaluate(async () => (await window.praxis.settings.get()).ai.providers.openai?.enabledModelIds))
    .toEqual(['other-provider-model']);
  await dialog.getByTestId('model-manager-filter').fill('mini');
  await expect(dialog.getByRole('switch')).toHaveCount(1);
  await dialog.getByTestId('model-manager-toggle-mock/nimbus-4-mini').click();
  await dialog.getByTestId('model-manager-filter').fill('');
  await expect(dialog.getByTestId('model-manager-count')).toHaveText('2 of 3 selected');
  await page.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/composer-model-configuration.png') });
  await dialog.getByTestId('model-manager-toggle-mock/nimbus-4-pro').focus();
  await page.keyboard.press('Tab');
  await expect(dialog.getByTestId('model-manager-done')).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByTestId('model-manager-toggle-mock/nimbus-4-pro')).toBeFocused();
  await dialog.getByTestId('model-manager-done').click();
  await expect(draft).toHaveValue('Keep this conversation draft.');
  await expect(page.getByTestId('new-session-model-chip')).toBeFocused();
  await page.getByTestId('new-session-model-chip').click();
  await expect(page.getByTestId('new-session-model-option-mock/nimbus-4-mini')).toBeVisible();
  await expect(page.getByTestId('new-session-model-option-mock/nimbus-4-pro')).toHaveCount(0);
  await page.getByTestId('new-session-model-settings').click();
  await expect(dialog.getByTestId('model-manager-toggle-mock/nimbus-4-pro')).toHaveAttribute('aria-checked', 'false');
  await dialog.getByTestId('model-manager-select-none').click();
  await expect.poll(() => page.evaluate(async () => (await window.praxis.settings.get()).ai.providers['vercel-gateway']?.enabledModelIds))
    .toEqual([]);
  await dialog.getByTestId('model-manager-select-all').click();
  await expect.poll(() => page.evaluate(async () => (await window.praxis.settings.get()).ai.providers['vercel-gateway']?.enabledModelIds))
    .toBeUndefined();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await page.reload();
  await page.getByTestId('conversations-new-btn').click();
  await page.getByTestId('new-session-model-chip').click();
  await expect(page.getByTestId('new-session-model-option-mock/nimbus-4-pro')).toBeVisible();
});

test('an existing session configures its selected provider rather than the app default', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', models: [
    { id: 'mock/model' }, { id: 'mock/other' }
  ] });
  app = await launchTestApp({ ai: { activeProvider: 'vercel-gateway' }, appearance: { themeId: 'praxis-dark', themeMode: 'dark' } }, undefined, {
    AI_GATEWAY_API_KEY: 'model-settings-test', AI_GATEWAY_URL: mock.baseUrl
  });
  const page = app.window;
  await page.evaluate(async baseUrl => {
    await window.praxis.settings.set({ ai: { providers: { openai: { baseUrl } } } });
    await window.praxis.ai.setProviderApiKey('openai', 'openai-model-settings-test');
    await window.praxis.ai.delegate({ provider: 'openai', task: { goal: 'Configure this provider.' } });
  }, mock.baseUrl);
  await openSession(page);
  await expect(page.getByTestId('session-state-badge')).toHaveText('Completed', { timeout: 15000 });
  await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setSize(720, 800));
  const sessionModel = page.getByTestId('session-model');
  await expect(sessionModel).toHaveText('gpt-4o-mini');
  await expect(sessionModel.locator('.composer-chip-meta')).toHaveCount(0);
  await expect(page.getByTestId('session-git-branch-chip')).toBeVisible();
  await sessionModel.click();
  await page.getByTestId('session-model-settings').click();
  const dialog = page.getByRole('dialog', { name: 'OpenAI model configuration' });
  await expect(dialog.getByRole('switch')).toHaveCount(2);
  const dialogBox = await dialog.boundingBox();
  expect(dialogBox!.x + dialogBox!.width).toBeLessThanOrEqual(720);
  await dialog.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/composer-model-configuration-dark-narrow.png') });
  await dialog.getByTestId('model-manager-toggle-mock/other').click();
  await expect.poll(() => page.evaluate(async () => (await window.praxis.settings.get()).ai.providers.openai?.enabledModelIds))
    .toEqual(['mock/model']);
  expect(await page.evaluate(async () => (await window.praxis.settings.get()).ai.providers['vercel-gateway']?.enabledModelIds))
    .toBeUndefined();
  await dialog.getByTestId('model-manager-done').click();
  await expect(page.getByTestId('session-model-menu')).toBeVisible();
  await expect(page.getByTestId('session-model-option-mock/other')).toHaveCount(0);
});

test('model search stays fixed when scrolling models in the model menu and manager', async () => {
  const models = Array.from({ length: 25 }, (_, i) => ({
    id: `mock/model-${i.toString().padStart(2, '0')}`,
    name: `Model Variant ${i.toString().padStart(2, '0')}`
  }));
  mock = await startMockGatewayServer({ mode: 'complete', models });
  app = await launchTestApp({
    ai: { activeProvider: 'vercel-gateway', defaultModel: 'mock/model-00' }
  }, undefined, {
    AI_GATEWAY_API_KEY: 'fixed-search-test',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const page = app.window;
  await page.getByTestId('conversations-new-btn').click();
  await page.getByTestId('new-session-model-chip').click();

  const menu = page.getByRole('listbox', { name: 'Model', exact: true });
  await expect(menu).toBeVisible();
  const filter = page.getByTestId('new-session-model-filter');
  await expect(filter).toBeVisible();

  const initialFilterBox = await filter.boundingBox();
  expect(initialFilterBox).not.toBeNull();

  // Scroll down the menu to the bottom options
  await menu.evaluate(el => { el.scrollTop = 400; });
  await page.waitForTimeout(100);

  // The search filter must still be visible and its Y position fixed
  await expect(filter).toBeVisible();
  const scrolledFilterBox = await filter.boundingBox();
  expect(scrolledFilterBox).not.toBeNull();
  expect(Math.abs(scrolledFilterBox!.y - initialFilterBox!.y)).toBeLessThan(2);

  // Verify the fixed search still functions after scroll
  await filter.fill('24');
  await expect(page.getByTestId('new-session-model-option-mock/model-24')).toBeVisible();
  await filter.fill('');

  // Now test the model configuration manager
  await page.getByTestId('new-session-model-settings').click();
  const dialog = page.getByRole('dialog', { name: 'Vercel AI Gateway model configuration' });
  await expect(dialog).toBeVisible();

  const managerFilter = dialog.getByTestId('model-manager-filter');
  await expect(managerFilter).toBeVisible();
  const initialManagerBox = await managerFilter.boundingBox();
  expect(initialManagerBox).not.toBeNull();

  // Scroll the dialog body
  const formBody = dialog.locator('.conn-form-body');
  await formBody.evaluate(el => { el.scrollTop = 300; });
  await page.waitForTimeout(100);

  // Search filter must remain visible and fixed in place
  await expect(managerFilter).toBeVisible();
  const scrolledManagerBox = await managerFilter.boundingBox();
  expect(scrolledManagerBox).not.toBeNull();
  expect(Math.abs(scrolledManagerBox!.y - initialManagerBox!.y)).toBeLessThan(2);
});

