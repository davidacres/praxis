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
