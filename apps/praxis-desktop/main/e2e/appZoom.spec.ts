import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

let app: TestApp;

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('whole-window zoom scales the Praxis shell and supports VS Code shortcuts', async () => {
  const page = app.window;
  const zoomValue = page.getByTestId('titlebar-zoom-reset');

  await expect(zoomValue).toHaveText('100%');
  await page.getByTestId('titlebar-zoom-in').click();
  await expect(zoomValue).toHaveText('110%');
  await expect(page.evaluate(() => window.praxis.window.getZoomFactor())).resolves.toBe(1.1);

  await page.getByTestId('titlebar-zoom-out').click();
  await expect(zoomValue).toHaveText('100%');

  const modifier = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${modifier}+=`);
  await expect(zoomValue).toHaveText('110%');
  await page.keyboard.press(`${modifier}+0`);
  await expect(zoomValue).toHaveText('100%');
});

test('zoom setting is preserved across app restart', async () => {
  const page = app.window;
  const zoomValue = page.getByTestId('titlebar-zoom-reset');

  await expect(zoomValue).toHaveText('100%');
  await page.getByTestId('titlebar-zoom-in').click();
  await expect(zoomValue).toHaveText('110%');
  await page.getByTestId('titlebar-zoom-in').click();
  await expect(zoomValue).toHaveText('120%');

  // Verify settings backend recorded the change
  await expect.poll(async () => {
    const settings = await page.evaluate(() => window.praxis.settings.get());
    return settings.appearance.zoomFactor;
  }).toBe(1.2);

  // Close app and relaunch with the same profile and settings
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();

  app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
  const restartedPage = app.window;
  const restartedZoomValue = restartedPage.getByTestId('titlebar-zoom-reset');

  await expect(restartedZoomValue).toHaveText('120%');
  await expect(restartedPage.evaluate(() => window.praxis.window.getZoomFactor())).resolves.toBe(1.2);
});

