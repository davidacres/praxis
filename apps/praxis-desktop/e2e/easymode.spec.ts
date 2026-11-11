import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { chooseOption } from './chipSelect';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
let userDataDir: string | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (userDataDir) {
    try {
      fs.rmSync(userDataDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup errors
    }
    userDataDir = undefined;
  }
});

test('EasyMode sidebar is visible by default', async () => {
  app = await launchTestApp({ preview: { enableEasyMode: true } });
  const win = app.window;
  const sidebar = win.getByTestId('easymode-sidebar');
  await expect(sidebar).toBeVisible();
});

test('legacy enableEasyMode false still uses the sole sidebar', async () => {
  app = await launchTestApp({
    preview: { enableEasyMode: false }
  });
  const win = app.window;

  // Saved opt-out preferences no longer select a retired sidebar.
  await expect(win.getByTestId('easymode-sidebar')).toBeVisible();
});

test('Preview omits retired switches and the sole sidebar stays active', async () => {
  app = await launchTestApp({ preview: { enableEasyMode: false, enableDeployments: false } });
  const win = app.window;
  await win.getByTestId('titlebar-settings').click();
  const settingsDialog = win.getByRole('dialog', { name: 'Settings' });
  await win.getByTestId('settings-nav-preview').click();
  for (const label of ['Enable Create Idea', 'Enable New Project', 'Boards sidebar — Work Mode', 'EasyMode sidebar (experimental)', 'Scheduled runs (experimental)']) {
    await expect(settingsDialog.getByText(label, { exact: true })).toHaveCount(0);
  }
  await expect(win.getByTestId('toggle-enable-deployments')).toBeVisible();
});

test('sidebar split button offers creation options', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const win = app.window;

  await win.getByTestId('easymode-new-session').click();
  await expect(win.getByTestId('new-session-view')).toBeVisible();

  await chooseOption(win.getByTestId('easymode-new-options'), 'session');
  await expect(win.getByTestId('new-session-view')).toBeVisible();

  await chooseOption(win.getByTestId('easymode-new-options'), 'conversation');
  await expect(win.getByTestId('new-conversation-heading')).toBeVisible();
});
