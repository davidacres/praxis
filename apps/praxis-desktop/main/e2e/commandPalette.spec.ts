import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * ⌘K navigation. The palette is one flat index over projects, boards,
 * sessions, agents, workflows and settings — built from state the shell
 * already holds — so every destination is one shortcut and a few keystrokes
 * away rather than a mouse trip through the tree.
 */

let app: TestApp;

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('opens with the shortcut, filters, and navigates on Enter', async () => {
  const page = app.window;
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Go to' });
  await expect(palette).toBeVisible();

  // Every feature destination is indexed even with no projects yet.
  await palette.getByRole('textbox').fill('git');
  await expect(palette.getByRole('option', { name: /Git Graph/ })).toBeVisible();

  await palette.getByRole('textbox').fill('connections');
  await page.keyboard.press('Enter');
  await expect(palette).toBeHidden();
  await expect(page.getByRole('main')).toContainText('Connection');
});

test('closes on Escape without navigating', async () => {
  const page = app.window;
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Go to' });
  await expect(palette).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(palette).toBeHidden();
});

test('surfaces a settings page and opens the settings dialog', async () => {
  const page = app.window;
  await expect(page.getByRole('navigation', { name: 'Workspace' })).toBeVisible();

  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Go to' });
  await palette.getByRole('textbox').fill('themes');
  await palette.getByRole('option', { name: /Themes/ }).first().click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await expect(page.locator('.settings-section-title')).toHaveText('Themes');
});
