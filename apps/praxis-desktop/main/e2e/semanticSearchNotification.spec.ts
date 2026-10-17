import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, dismissSplash, launchTestApp, type TestApp } from './launchTestApp';

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
        sizeBytes: 133324998,
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
        sizeBytes: 133324998,
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

test('a finished download that the service then refuses is reported, never shown as enabled', async () => {
  // Proven against the old progress listener, which declared success at 100% downloaded:
  // the success line and the error rendered together.
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' }, { semanticSearchPrompt: true });
  await app.electronApp.evaluate(({ ipcMain, BrowserWindow }) => {
    ipcMain.removeHandler('ai:downloadSemanticModel');
    ipcMain.handle('ai:downloadSemanticModel', async () => {
      for (const window of BrowserWindow.getAllWindows())
        window.webContents.send('ai:semanticModelProgress', { bytesDownloaded: 133324998, totalBytes: 133324998, percent: 100 });
      await new Promise(resolve => setTimeout(resolve, 300));
      throw new Error('The local code intelligence service did not install the model: fixture refusal');
    });
  });

  const notification = app.window.getByTestId('semantic-search-notification');
  await expect(notification).toBeVisible({ timeout: 10000 });
  await notification.getByTestId('semantic-notification-enable-btn').click();
  await expect(notification.getByRole('alert')).toContainText('fixture refusal');
  await expect(notification.getByTestId('semantic-notification-success')).toHaveCount(0);
  // Still offered, so the user can retry.
  await expect(notification.getByTestId('semantic-notification-enable-btn')).toBeVisible();
});

test('offers an update instead of enable when an earlier model is installed', async () => {
  app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key' }, { semanticSearchPrompt: true });
  await app.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('ai:getSemanticModelStatus');
    ipcMain.handle('ai:getSemanticModelStatus', () => ({
      installed: false,
      active: false,
      updateAvailable: true,
      sizeBytes: 0,
      downloading: false,
      progressPercent: 0
    }));
  });

  // The notification reads status once on mount, before this mock existed; remount it.
  const win = app.window;
  await win.reload();
  await win.waitForLoadState('domcontentloaded');
  await dismissSplash(win);
  const notification = win.getByTestId('semantic-search-notification');
  await expect(notification).toBeVisible({ timeout: 10000 });
  await expect(notification.getByTestId('semantic-search-notification-title')).toHaveText('Semantic Search Update');
  await expect(notification).toContainText('A more accurate search model is available');
  await expect(notification.getByTestId('semantic-notification-enable-btn')).toHaveText('Update (~130 MB)');

  // Dismissing the update is remembered on its own key, separate from the enable prompt.
  await notification.getByTestId('semantic-notification-dismiss-btn').click();
  await expect(notification).toHaveCount(0);
  const keys = await win.evaluate(() => ({
    update: localStorage.getItem('praxis:semantic-search-update-dismissed'),
    enable: localStorage.getItem('praxis:semantic-search-prompt-dismissed')
  }));
  expect(keys).toEqual({ update: 'true', enable: null });
});

test('the real main process reports a previously downloaded MiniLM bundle as an update', async () => {
  // No IPC mock: getSemanticModelStatus reads this folder's manifest itself.
  const bundle = mkdtempSync(path.join(tmpdir(), 'praxis-old-model-'));
  try {
    writeFileSync(path.join(bundle, 'manifest.json'), JSON.stringify({
      version: 1, modelId: 'sentence-transformers/all-MiniLM-L6-v2', revision: '1110a243fdf4706b3f48f1d95db1a4f5529b4d41'
    }));
    writeFileSync(path.join(bundle, 'model.onnx'), '');
    writeFileSync(path.join(bundle, 'vocab.txt'), '');
    app = await launchTestApp(undefined, undefined, { AI_GATEWAY_API_KEY: 'gateway-fixture-key', PRAXIS_MODEL_BUNDLE: bundle }, { semanticSearchPrompt: true });
    const status = await app.window.evaluate(() => window.praxis.ai.getSemanticModelStatus());
    expect(status).toMatchObject({ installed: false, updateAvailable: true, modelId: 'BAAI/bge-small-en-v1.5' });
    await expect(app.window.getByTestId('semantic-search-notification-title')).toHaveText('Semantic Search Update', { timeout: 10000 });
  } finally {
    if (app) await closeTestApp(app);
    app = undefined;
    rmSync(bundle, { recursive: true, force: true });
  }
});
