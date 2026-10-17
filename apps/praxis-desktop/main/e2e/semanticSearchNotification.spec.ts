import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

test('shows semantic search recommendation notification on startup if model not installed', async ({}, testInfo) => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' }, { semanticSearchPrompt: true });
  await app.electronApp.evaluate(({ ipcMain }) => {
    let modelInstalled = false;

    ipcMain.removeHandler('ai:getSemanticModelStatus');
    ipcMain.handle('ai:getSemanticModelStatus', () => ({
      installed: modelInstalled,
      active: modelInstalled,
      fingerprint: undefined,
      sizeBytes: 0,
      downloading: false,
      progressPercent: 0
    }));

    ipcMain.removeHandler('ai:downloadSemanticModel');
    ipcMain.handle('ai:downloadSemanticModel', () => {
      modelInstalled = true;
      return {
        installed: true,
        active: true,
        fingerprint: 'sha256:fixture-fingerprint',
        sizeBytes: 90636722,
        downloading: false,
        progressPercent: 100
      };
    });
  });

  const win = app.window;
  const notification = win.getByTestId('semantic-search-notification');
  await expect(notification).toBeVisible({ timeout: 10000 });
  await expect(notification.getByTestId('semantic-search-notification-title')).toHaveText('Semantic Code Search');
  await expect(notification).toContainText('Recommended');
  await expect(notification).toContainText('Enable natural language semantic search');

  // Verify visual screenshot
  await notification.screenshot({ path: testInfo.outputPath('semantic-search-notification.png') });

  // Test dismiss
  const dismissBtn = notification.getByTestId('semantic-notification-dismiss-btn');
  await expect(dismissBtn).toBeVisible();
  await dismissBtn.click();
  await expect(notification).toHaveCount(0);
});

test('enables semantic search from startup notification and shows success feedback', async () => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' }, { semanticSearchPrompt: true });
  await app.electronApp.evaluate(({ ipcMain }) => {
    let modelInstalled = false;

    ipcMain.removeHandler('ai:getSemanticModelStatus');
    ipcMain.handle('ai:getSemanticModelStatus', () => ({
      installed: modelInstalled,
      active: modelInstalled,
      fingerprint: undefined,
      sizeBytes: 0,
      downloading: false,
      progressPercent: 0
    }));

    ipcMain.removeHandler('ai:downloadSemanticModel');
    ipcMain.handle('ai:downloadSemanticModel', () => {
      modelInstalled = true;
      return {
        installed: true,
        active: true,
        fingerprint: 'sha256:fixture-fingerprint',
        sizeBytes: 90636722,
        downloading: false,
        progressPercent: 100
      };
    });
  });

  const win = app.window;
  const notification = win.getByTestId('semantic-search-notification');
  await expect(notification).toBeVisible({ timeout: 10000 });

  const enableBtn = notification.getByTestId('semantic-notification-enable-btn');
  await expect(enableBtn).toBeVisible();
  await enableBtn.click();

  const success = notification.getByTestId('semantic-notification-success');
  await expect(success).toBeVisible();
  await expect(success).toContainText('Semantic search is now enabled and active!');
});

test('configure button in notification opens Code Intelligence settings page', async () => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' }, { semanticSearchPrompt: true });
  await app.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:getSemanticModelStatus');
    ipcMain.handle('ai:getSemanticModelStatus', () => ({
      installed: false,
      active: false,
      fingerprint: undefined,
      sizeBytes: 0,
      downloading: false,
      progressPercent: 0
    }));

    ipcMain.removeHandler('ai:codeIntelligence');
    ipcMain.handle('ai:codeIntelligence', (_event, request: Record<string, unknown>) => {
      if (request.action === 'list') return { data: [] };
      return { data: {} };
    });
  });

  const win = app.window;
  const notification = win.getByTestId('semantic-search-notification');
  await expect(notification).toBeVisible({ timeout: 10000 });

  const configBtn = notification.getByTestId('semantic-notification-settings-btn');
  await expect(configBtn).toBeVisible();
  await configBtn.click();

  // Notification is dismissed and settings dialog opens directly to Code Intelligence
  await expect(notification).toHaveCount(0);
  const settingsPanel = win.getByTestId('code-intelligence-panel');
  await expect(settingsPanel).toBeVisible();
});
