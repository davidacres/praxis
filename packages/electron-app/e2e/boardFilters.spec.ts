import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
let window: Page;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

/**
 * Phase B — issue filter bar + load-more paging. The demo backend seeds the
 * Application Board with 33 issues (3 hand-written + 30 bulk) and the board
 * view pages at 25, so page 2 exists to fetch. Status math: the bulk seeds
 * rotate through five statuses six times each, so Blocked = 6 bulk + APP-103;
 * "Assigned to me" = 15 even-indexed bulk + APP-101 + APP-103.
 */
async function openApplicationBoard(win: Page) {
  await win.locator('[data-testid="nav-board"]').click();
  await win.locator('[data-testid="board-nav-item"]', { hasText: 'Application Board' }).click();
  await win.locator('[data-testid="board-filter-bar"]').waitFor();
}

test('load-more pages through the board', async () => {
  app = await launchTestApp();
  window = app.window;
  await openApplicationBoard(window);

  const cards = window.locator('[data-testid="issue-card"]');
  await expect(cards).toHaveCount(25);
  await expect(window.locator('[data-testid="board-filter-count"]')).toHaveText('25 of 33 items');

  await window.locator('[data-testid="board-load-more"]').click();

  await expect(cards).toHaveCount(33);
  await expect(window.locator('[data-testid="board-filter-count"]')).toHaveText('33 items');
  await expect(window.locator('[data-testid="board-load-more"]')).toHaveCount(0);
});

test('search and status filters narrow the board', async () => {
  app = await launchTestApp();
  window = app.window;
  await openApplicationBoard(window);
  const cards = window.locator('[data-testid="issue-card"]');
  await expect(cards).toHaveCount(25);

  // Search narrows to the one matching card.
  await window.locator('[data-testid="board-filter-search-input"]').fill('dependency-injected');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('APP-101');
  await expect(window.locator('[data-testid="board-filter-count"]')).toHaveText('1 item');

  // Clearing search, then picking a status, narrows to that column's worth.
  await window.locator('[data-testid="board-filter-search-input"]').fill('');
  await expect(cards).toHaveCount(25);
  await window.locator('[data-testid="board-filter-status"]').click();
  await window
    .locator('[data-testid="board-filter-status-option"]', { hasText: 'Blocked' })
    .click();
  await expect(cards).toHaveCount(7);
  await expect(window.locator('[data-testid="board-filter-status"]')).toContainText('Status (1)');

  // Clear restores the full first page.
  await window.locator('[data-testid="board-filter-clear"]').click();
  await expect(cards).toHaveCount(25);
  await expect(window.locator('[data-testid="board-filter-count"]')).toHaveText('25 of 33 items');
});

test('assignee and parent scope filters narrow the board', async () => {
  app = await launchTestApp();
  window = app.window;
  await openApplicationBoard(window);
  const cards = window.locator('[data-testid="issue-card"]');
  await expect(cards).toHaveCount(25);

  await window.locator('[data-testid="board-filter-assignee"]').selectOption('me');
  await expect(cards).toHaveCount(17);

  // Parent scope: only APP-100's three sub-tasks match (it is the sole
  // Feature, so the parent select exists on this board).
  await window.locator('[data-testid="board-filter-assignee"]').selectOption('all');
  await expect(cards).toHaveCount(25);
  await window.locator('[data-testid="board-filter-parent"]').selectOption('APP-100');
  await expect(cards).toHaveCount(3);
  await expect(window.locator('[data-testid="board-filter-count"]')).toHaveText('3 items');
});
