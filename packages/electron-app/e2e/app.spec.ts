import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp;
let window: Page;

test.beforeEach(async () => {
  app = await launchTestApp();
  window = app.window;
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('boards render on launch', async () => {
  await expect(window.locator('nav')).toContainText('Boards');
  const boardItems = window.locator('[data-testid="board-nav-item"]');
  await expect(boardItems.first()).toBeVisible();
});

test('selecting a board renders its columns and issue cards', async () => {
  const boardItems = window.locator('[data-testid="board-nav-item"]');
  await boardItems.first().click();
  const issueCards = window.locator('[data-testid="issue-card"]');
  await expect(issueCards.first()).toBeVisible();
});

test('opening an issue card shows the issue detail panel', async () => {
  await window.locator('[data-testid="board-nav-item"]').first().click();
  await window.locator('[data-testid="issue-card"]').first().click();
  // `exact` matters now: the frameless title bar also has a "Close window" button.
  await expect(window.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  await expect(window.getByText('Comments', { exact: true })).toBeVisible();
});

test('adding a comment appears in the issue detail panel', async () => {
  await window.locator('[data-testid="board-nav-item"]').first().click();
  await window.locator('[data-testid="issue-card"]').first().click();

  const commentBody = `e2e comment ${Date.now()}`;
  await window.getByPlaceholder('Add a comment…').fill(commentBody);
  await window.getByRole('button', { name: 'Add comment' }).click();

  await expect(window.locator(`text=${commentBody}`)).toBeVisible();
});

test('closing the issue detail panel hides it', async () => {
  await window.locator('[data-testid="board-nav-item"]').first().click();
  await window.locator('[data-testid="issue-card"]').first().click();
  await window.getByRole('button', { name: 'Close', exact: true }).click();
  await expect(window.getByRole('button', { name: 'Close', exact: true })).not.toBeVisible();
});

test('navigating to Connections shows the connection management screen', async () => {
  await window.locator('[data-testid="nav-connections"]').click();
  await expect(window.locator('[data-testid="connections-page"]')).toBeVisible();
  await expect(window.locator('[data-testid="add-connection-btn"]')).toBeVisible();
  await expect(window.locator('[data-testid="conn-empty"]')).toBeVisible();
});

test('adding and removing a connection updates the list', async () => {
  await window.locator('[data-testid="nav-connections"]').click();
  await window.locator('[data-testid="add-connection-btn"]').click();

  const name = `e2e-connection-${Date.now()}`;
  await window.locator('[data-testid="conn-field-name"]').fill(name);
  // Mode defaults to demo — no other fields required.
  await window.locator('[data-testid="conn-save-btn"]').click();

  const row = window.locator('[data-testid="connection-row"]', { hasText: name });
  await expect(row).toBeVisible();

  // The saved connection stays selected; removal is a two-step confirm.
  await window.locator('[data-testid="conn-remove-btn"]').click();
  await window.locator('[data-testid="conn-remove-confirm-btn"]').click();

  await expect(window.locator('[data-testid="connection-row"]', { hasText: name })).not.toBeVisible();
});
