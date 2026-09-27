import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

test("What's new opens over the workspace and provides version history", async () => {
  app = await launchTestApp();
  const win = app.window;

  await expect(win.locator('[data-testid="whats-new-dialog"]')).toHaveCount(0);
  await win.getByRole('button', { name: "What's new" }).click();

  const dialog = win.locator('[data-testid="whats-new-dialog"]');
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Standalone conversations, custom AI endpoints, and floating chat');
  await expect(dialog).toContainText('Features');
  await expect(dialog).toContainText('Fixes');

  await win.locator('[data-testid="whats-new-version-0.2.0"]').click();
  await expect(win.locator('[data-testid="whats-new-content"]')).toContainText(
    'Boards and connected work'
  );

  await win.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
});
