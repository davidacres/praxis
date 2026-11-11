import { openConnections } from './connectionNavigation';
import { listedBoards, openBoard, openFromPalette } from './navigation';
import { test, expect } from '@playwright/test';
import type { Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp;
let window: Page;

test.beforeEach(async () => {
  app = await launchTestApp();
  window = app.window;
});

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
  }
});

test('groups all layout toggles on the right side of the title bar', async () => {
  const group = window.locator('.titlebar-layout-toggles');
  await expect(group.getByRole('button', { name: 'Toggle sidebar' })).toBeVisible();
  await expect(group.getByRole('button', { name: 'Toggle panel' })).toBeVisible();
  await expect(group.getByRole('button', { name: 'Toggle secondary sidebar' })).toBeVisible();
  await expect(group.getByRole('button', { name: 'Toggle focus mode' })).toHaveCount(0);
  const labels = await group.locator('button').evaluateAll(buttons => buttons.slice(0, 3).map(button => button.getAttribute('aria-label')));
  expect(labels).toEqual([
    'Toggle sidebar',
    'Toggle panel',
    'Toggle secondary sidebar'
  ]);

  await group.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(window.locator('.pane-sidebar')).toHaveCount(0);
});

test('focus mode button in titlebar is available in a session and toggles panels', async () => {
  const toggles = window.locator('.titlebar-layout-toggles');

  // Not available when not in a session
  await expect(toggles.getByRole('button', { name: 'Toggle focus mode' })).toHaveCount(0);

  // Navigate to Conversations
  await openFromPalette(window, 'Conversations');

  // Focus mode button is now available in a session
  const focusBtn = toggles.getByRole('button', { name: 'Toggle focus mode' });
  await expect(focusBtn).toBeVisible();

  if (await window.locator('.pane-sidebar').count() === 0) {
    await toggles.getByRole('button', { name: 'Toggle sidebar' }).click();
  }
  await expect(window.locator('.pane-sidebar')).toBeVisible();

  if (await window.locator('[data-testid="bottom-panel"]').count() === 0) {
    await toggles.getByRole('button', { name: 'Toggle panel' }).click();
  }
  await expect(window.locator('[data-testid="bottom-panel"]')).toBeVisible();

  await focusBtn.click();
  await expect(window.locator('.pane-sidebar')).toHaveCount(0);
  await expect(window.locator('.pane-aux')).toHaveCount(0);
  await expect(window.locator('[data-testid="bottom-panel"]')).toHaveCount(0);

  await focusBtn.click();
  await expect(window.locator('.pane-sidebar')).toBeVisible();
  await expect(window.locator('[data-testid="bottom-panel"]')).toBeVisible();
});

test('reports the running Praxis version on the Settings control', async () => {
  const version = await window.evaluate(() => window.praxis.app.getVersion());
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  await expect(window.getByTestId('titlebar-settings')).toHaveAttribute('title', `Settings · Praxis v${version}`);
});

test('boards render on launch', async () => {
  await expect(window.locator('[data-testid="new-session-view"] h1')).toContainText('No board');
  await expect(window.locator('[data-testid="new-session-board-select"]')).toContainText('No board');
  await window.locator('[data-testid="titlebar-home"]').click();
  expect(await listedBoards(window)).not.toHaveLength(0);
  await openBoard(window);
});

test('normal launch does not include built-in demo data', async () => {
  await closeTestApp(app);
  app = await launchTestApp(undefined, undefined, undefined, { demoMode: false });
  window = app.window;

  await window.locator('[data-testid="titlebar-home"]').click();
  await expect(window.locator('[data-testid="overview-page"], .easymode-canvas')).toBeVisible();
  expect(await listedBoards(window)).toEqual([]);
});

test('titlebar Home opens Overview without blank/black screen and preserves navigation history', async () => {
  await window.getByTestId('session-focus-new').click();
  await window.getByTestId('titlebar-home').click();

  // Overview / EasyMode canvas should render without throwing or causing a black screen
  await expect(window.locator('[data-testid="overview-page"], .easymode-canvas')).toBeVisible();
  await expect(window.locator('#root')).not.toBeEmpty();

  // Navigation history buttons work
  await window.getByRole('button', { name: 'Back', exact: true }).click();
  await expect(window.locator('[data-testid="overview-page"], .easymode-canvas')).toHaveCount(0);
  await window.getByRole('button', { name: 'Forward', exact: true }).click();
  await expect(window.locator('[data-testid="overview-page"], .easymode-canvas')).toBeVisible();

  // Navigation from new session to home
  await window.getByTestId('session-focus-new').click();
  await expect(window.locator('[data-testid="overview-page"], .easymode-canvas')).toHaveCount(0);
  await window.getByTestId('titlebar-home').click();
  await expect(window.locator('[data-testid="overview-page"], .easymode-canvas')).toBeVisible();
  await expect(window.getByTestId('easymode-sidebar')).toBeVisible();
});
