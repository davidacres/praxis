import { test, expect } from '@playwright/test';
import type { UpdateStatus } from '@praxis/core';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp;

test.beforeEach(async () => {
  app = await launchTestApp();
});

test.afterEach(async () => {
  await closeTestApp(app);
});

/** The e2e app is unpackaged, so the real updater never runs; drive the renderer with the pushes it would send. */
async function pushStatus(status: UpdateStatus): Promise<void> {
  await app.electronApp.evaluate(({ BrowserWindow }, next) => {
    for (const win of BrowserWindow.getAllWindows()) win.webContents.send('update:status', next);
  }, status);
}

test('an unpackaged build reports that updates are unsupported and offers no check', async () => {
  const { window } = app;
  await expect(window.getByTestId('titlebar-update')).toHaveCount(0);

  await window.getByTestId('titlebar-settings').click();
  await window.getByTestId('settings-nav-updates').click();
  await expect(window.getByTestId('settings-update-status')).toHaveText('Updates are only checked in a packaged build.');
  await expect(window.getByTestId('settings-update-check')).toBeDisabled();
});

test('shows download progress, then offers a restart once the update is ready', async () => {
  const { window } = app;
  await window.getByTestId('titlebar-settings').click();
  await window.getByTestId('settings-nav-updates').click();

  await pushStatus({ state: 'downloading', version: '9.9.9', percent: 40 });
  await expect(window.getByTestId('settings-update-status')).toHaveText('Downloading version 9.9.9… 40%');
  await expect(window.getByTestId('settings-update-check')).toBeDisabled();
  await expect(window.getByTestId('titlebar-update')).toHaveCount(0);

  await pushStatus({ state: 'ready', version: '9.9.9' });
  await expect(window.getByTestId('settings-update-status')).toContainText('Version 9.9.9 is downloaded');
  await expect(window.getByTestId('settings-update-restart')).toBeVisible();
  await expect(window.getByTestId('titlebar-update')).toHaveText('Restart to update');
});

test('an update this build cannot install links to the release page', async () => {
  const { window } = app;
  await window.getByTestId('titlebar-settings').click();
  await window.getByTestId('settings-nav-updates').click();

  await pushStatus({ state: 'available', version: '9.9.9', canInstall: false, releaseUrl: 'https://github.com/davidacres/praxis/releases/tag/v9.9.9' });
  await expect(window.getByTestId('titlebar-update')).toHaveText('Update available');
  await expect(window.getByTestId('settings-update-status')).toContainText("can't install updates itself");
  await expect(window.getByTestId('settings-update-release')).toBeVisible();
});
