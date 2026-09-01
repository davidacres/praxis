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
 * Application Board with 33 issues (3 hand-written + 30 bulk). The board
 * loads up to ten cards per status, so the stock fixture fits in one load:
 * each bulk status has six cards, while To Do, In Progress and Blocked each
 * have one additional hand-written ticket. "Assigned to me" = 15 even-indexed
 * bulk + APP-101 + APP-103.
 */
async function openApplicationBoard(win: Page) {
  await win.locator('[data-testid="board-nav-item"]', { hasText: 'Application Board' }).click();
  await win.locator('[data-testid="issue-card"]').first().waitFor();
  await win.locator('[data-testid="titlebar-context"]').click();
  await win.locator('[data-testid="titlebar-filter-popover"]').waitFor();
  await win.locator('[data-testid="board-filter-bar"]').waitFor();
}

test('load-more fetches the next ten for a busy status without starving the other lanes', async () => {
  app = await launchTestApp();
  window = app.window;
  // The fixture's largest lane has seven cards. Add five more Backlog tickets
  // before opening the board so only that lane needs a second page.
  await window.evaluate(async () => {
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        window.praxis.issue.create({
          projectKey: 'APP',
          issueType: 'Task',
          summary: `Paging verification ${index + 1}`,
          boardId: 'board-app'
        })
      )
    );
  });
  await openApplicationBoard(window);

  const cards = window.locator('[data-testid="issue-card"]');
  const backlog = window.locator('[data-testid="board-column-lane"][data-target-status="Backlog"]');
  await expect(backlog.locator('[data-testid="issue-card"]')).toHaveCount(10);
  await expect(cards).toHaveCount(37);
  await expect(window.locator('[data-testid="board-filter-count"]')).toHaveText('37 of 38 items');

  await window.locator('[data-testid="board-load-more"]').click();

  await expect(backlog.locator('[data-testid="issue-card"]')).toHaveCount(11);
  await expect(cards).toHaveCount(38);
  await expect(window.locator('[data-testid="board-filter-count"]')).toHaveText('38 items');
  await expect(window.locator('[data-testid="board-load-more"]')).toHaveCount(0);
});

test('dropping a ticket into another lane still applies its workflow transition', async () => {
  app = await launchTestApp();
  window = app.window;
  await openApplicationBoard(window);

  const toDo = window.locator('[data-testid="board-column-lane"][data-target-status="To Do"]');
  const inProgress = window.locator('[data-testid="board-column-lane"][data-target-status="In Progress"]');
  await expect(toDo.locator('[data-testid="issue-card"]', { hasText: 'APP-101' })).toHaveCount(1);

  // Dispatch the same HTML drag events that a pointer drag produces. The
  // handler resolves the workflow transition (To Do → In Progress) through
  // IPC, then refreshes the board data.
  await window.evaluate(() => {
    const card = [...document.querySelectorAll<HTMLElement>('[data-testid="issue-card"]')]
      .find(element => element.textContent?.includes('APP-101'));
    const target = document.querySelector<HTMLElement>(
      '[data-testid="board-column-lane"][data-target-status="In Progress"]'
    );
    if (!card || !target) {
      throw new Error('Expected source ticket and target lane.');
    }
    const transfer = new DataTransfer();
    card.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    target.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }));
    card.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: transfer }));
  });

  await expect(inProgress.locator('[data-testid="issue-card"]', { hasText: 'APP-101' })).toHaveCount(1);
  await expect(toDo.locator('[data-testid="issue-card"]', { hasText: 'APP-101' })).toHaveCount(0);
});

test('dragging shows a precise insertion rule instead of highlighting a whole lane', async () => {
  app = await launchTestApp();
  window = app.window;
  await openApplicationBoard(window);

  const source = window.locator('[data-testid="issue-card"]', { hasText: 'APP-101' });
  const target = window.locator('[data-testid="board-column-lane"][data-target-status="In Progress"]');
  await source.evaluate(element => {
    const transfer = new DataTransfer();
    element.dispatchEvent(new DragEvent('dragstart', { bubbles: true, dataTransfer: transfer }));
  });
  await expect(source).toHaveClass(/dragging-from/);

  await target.evaluate(element => {
    const card = element.querySelector<HTMLElement>('[data-testid="issue-card"]');
    if (!card) throw new Error('Expected a target card.');
    const rect = card.getBoundingClientRect();
    element.dispatchEvent(new DragEvent('dragover', {
      bubbles: true,
      cancelable: true,
      clientY: rect.top + rect.height / 2,
      dataTransfer: new DataTransfer()
    }));
  });
  await expect(target.locator('[data-testid="board-drop-indicator"]')).toBeVisible();
  await expect(target).not.toHaveClass(/drag-over/);

  await source.evaluate(element => {
    element.dispatchEvent(new DragEvent('dragend', { bubbles: true, dataTransfer: new DataTransfer() }));
  });
  await expect(target.locator('[data-testid="board-drop-indicator"]')).toHaveCount(0);
});

test('search and status filters narrow the board', async () => {
  app = await launchTestApp();
  window = app.window;
  await openApplicationBoard(window);
  const cards = window.locator('[data-testid="issue-card"]');
  await expect(cards).toHaveCount(33);

  // Search narrows to the one matching card.
  await window.locator('[data-testid="board-filter-search-input"]').fill('dependency-injected');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText('APP-101');
  await expect(window.locator('[data-testid="board-filter-count"]')).toHaveText('1 item');

  // Clearing search, then picking a status, narrows to that column's worth.
  await window.locator('[data-testid="board-filter-search-input"]').fill('');
  await expect(cards).toHaveCount(33);
  await window.locator('[data-testid="board-filter-status"]').click();
  await window
    .locator('[data-testid="board-filter-status-option"]', { hasText: 'Blocked' })
    .click();
  await expect(cards).toHaveCount(7);
  await expect(window.locator('[data-testid="board-filter-status"]')).toContainText('Status (1)');

  // The criteria stay active when the title-bar popover is closed, and the
  // badge makes the hidden filter discoverable.
  await window.locator('[data-testid="titlebar-context"]').click();
  await expect(window.locator('[data-testid="titlebar-filter-popover"]')).toBeHidden();
  await expect(window.locator('[data-testid="titlebar-filter-count"]')).toHaveText('1');
  await window.locator('[data-testid="titlebar-context"]').click();
  await expect(window.locator('[data-testid="board-filter-status"]')).toContainText('Status (1)');

  // Clear restores the full first page.
  await window.locator('[data-testid="board-filter-clear"]').click();
  await expect(cards).toHaveCount(33);
  await expect(window.locator('[data-testid="board-filter-count"]')).toHaveText('33 items');
});

test('assignee and parent scope filters narrow the board', async () => {
  app = await launchTestApp();
  window = app.window;
  await openApplicationBoard(window);
  const cards = window.locator('[data-testid="issue-card"]');
  await expect(cards).toHaveCount(33);

  await window.locator('[data-testid="board-filter-assignee"]').selectOption('me');
  await expect(cards).toHaveCount(17);

  // Parent scope: only APP-100's three sub-tasks match (it is the sole
  // Feature, so the parent select exists on this board).
  await window.locator('[data-testid="board-filter-assignee"]').selectOption('all');
  await expect(cards).toHaveCount(33);
  await window.locator('[data-testid="board-filter-parent"]').selectOption('APP-100');
  await expect(cards).toHaveCount(3);
  await expect(window.locator('[data-testid="board-filter-count"]')).toHaveText('3 items');
});

test('switching boards resets hidden title-bar criteria', async () => {
  app = await launchTestApp();
  window = app.window;
  await openApplicationBoard(window);

  await window.locator('[data-testid="board-filter-status"]').click();
  await window
    .locator('[data-testid="board-filter-status-option"]', { hasText: 'Blocked' })
    .click();
  await expect(window.locator('[data-testid="issue-card"]')).toHaveCount(7);

  await window.locator('[data-testid="board-nav-item"]', { hasText: 'Operations Board' }).click();
  await window.locator('[data-testid="issue-card"]').first().waitFor();
  await window.locator('[data-testid="board-nav-item"]', { hasText: 'Application Board' }).click();
  await expect(window.locator('[data-testid="issue-card"]')).toHaveCount(33);

  await window.locator('[data-testid="titlebar-context"]').click();
  await expect(window.locator('[data-testid="board-filter-status"]')).toHaveText('Status');
  await expect(window.locator('[data-testid="titlebar-filter-count"]')).toHaveCount(0);
});
