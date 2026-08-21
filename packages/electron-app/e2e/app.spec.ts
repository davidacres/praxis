import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { _electron as electron, type ElectronApplication, type Page } from 'playwright';

let electronApp: ElectronApplication;
let window: Page;
let userDataDir: string;

test.beforeEach(async () => {
  userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-manager-e2e-'));
  electronApp = await electron.launch({
    args: [path.join(__dirname, '..'), `--user-data-dir=${userDataDir}`],
    cwd: path.join(__dirname, '..')
  });
  window = await electronApp.firstWindow();
  await window.waitForLoadState('domcontentloaded');
});

test.afterEach(async () => {
  await electronApp.close();
  fs.rmSync(userDataDir, { recursive: true, force: true });
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
  await expect(window.locator('h3', { hasText: 'Connections' })).toBeVisible();
  await expect(window.getByPlaceholder('Connection name')).toBeVisible();
});

test('adding and removing a connection updates the list', async () => {
  await window.locator('[data-testid="nav-connections"]').click();

  const name = `e2e-connection-${Date.now()}`;
  await window.getByPlaceholder('Connection name').fill(name);
  await window.getByRole('button', { name: 'Add' }).click();

  const row = window.locator('[data-testid="connection-row"]', { hasText: name });
  await expect(row).toBeVisible();

  await row.getByRole('button', { name: 'Remove' }).click();

  await expect(window.locator('[data-testid="connection-row"]', { hasText: name })).not.toBeVisible();
});
