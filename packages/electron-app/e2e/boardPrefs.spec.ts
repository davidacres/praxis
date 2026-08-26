import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

/**
 * Phase C — per-board display preferences. Everything goes through the board
 * toolbar's Display menu and persists via the `boardPrefs` IPC store (a JSON
 * file under the throwaway user-data dir), so relaunching into the same
 * profile is the persistence check.
 */
async function openApplicationBoard(win: Page) {
  await win.locator('[data-testid="nav-board"]').click();
  await win.locator('[data-testid="board-nav-item"]', { hasText: 'Application Board' }).click();
  await win.locator('[data-testid="issue-card"]').first().waitFor();
}

async function openDisplayMenu(win: Page) {
  await win.locator('[data-testid="board-settings-btn"]').click();
  await win.locator('[data-testid="board-settings-menu"]').waitFor();
}

test('board toolbar keeps creation actions left and icon-only tools right', async () => {
  app = await launchTestApp();
  const win = app.window;
  await openApplicationBoard(win);

  const create = win.getByRole('button', { name: 'New issue' });
  const designer = win.getByRole('button', { name: 'Designer' });
  const settings = win.getByRole('button', { name: 'Board settings' });
  await expect(create).toHaveText('');
  await expect(designer).toHaveText('');
  await expect(settings).toHaveText('');

  const [createBox, designerBox, settingsBox] = await Promise.all([
    create.boundingBox(),
    designer.boundingBox(),
    settings.boundingBox()
  ]);
  expect(createBox).not.toBeNull();
  expect(designerBox).not.toBeNull();
  expect(settingsBox).not.toBeNull();
  expect(createBox!.x).toBeLessThan(designerBox!.x);
  expect(designerBox!.x).toBeLessThan(settingsBox!.x);
});

test('list view persists across relaunch', async () => {
  app = await launchTestApp();
  await openApplicationBoard(app.window);

  await openDisplayMenu(app.window);
  await app.window.locator('[data-testid="board-prefs-view-list"]').click();
  const listView = app.window.locator('[data-testid="board-list-view"]');
  await expect(listView).toBeVisible();
  // 25 first-page cards across five status groups.
  await expect(app.window.locator('[data-testid="board-list-group"]')).toHaveCount(5);
  await expect(listView.locator('[data-testid="issue-card"]')).toHaveCount(25);

  // Relaunch into the same profile — the preference must survive the restart.
  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  app = await launchTestApp(undefined, profile);
  await openApplicationBoard(app.window);
  await expect(app.window.locator('[data-testid="board-list-view"]')).toBeVisible();
});

test('custom status color paints the column dot and persists', async () => {
  app = await launchTestApp();
  await openApplicationBoard(app.window);

  await openDisplayMenu(app.window);
  const row = app.window.locator('[data-testid="board-prefs-status-color"]', { hasText: 'To Do' });
  await row.locator('input[type="color"]').fill('#ff0000');

  const todoColumn = app.window.locator('.board-column', { hasText: 'To Do' }).first();
  await expect(todoColumn.locator('[data-testid="board-column-dot"]')).toHaveCSS(
    'background-color',
    'rgb(255, 0, 0)'
  );

  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  app = await launchTestApp(undefined, profile);
  await openApplicationBoard(app.window);
  const todoAfter = app.window.locator('.board-column', { hasText: 'To Do' }).first();
  await expect(todoAfter.locator('[data-testid="board-column-dot"]')).toHaveCSS(
    'background-color',
    'rgb(255, 0, 0)'
  );
});

test('swim lanes group columns by assignee', async () => {
  app = await launchTestApp();
  await openApplicationBoard(app.window);

  await openDisplayMenu(app.window);
  await app.window.locator('[data-testid="board-prefs-swimlane"]').selectOption('assignee');

  const lanes = app.window.locator('[data-testid="board-swimlane"]');
  // Demo issues are assigned to Alex Agent or Jordan Builder — two lanes.
  await expect(lanes).toHaveCount(2);
  await expect(lanes.first().locator('.board-swimlane-title')).toHaveText('Alex Agent');
  // Every lane repeats the full column set so any status stays a drop target.
  await expect(lanes.first().locator('.board-column')).toHaveCount(5);
});

test('max-age preference hides stale issues', async () => {
  app = await launchTestApp();
  await openApplicationBoard(app.window);
  await expect(app.window.locator('[data-testid="issue-card"]')).toHaveCount(25);

  await openDisplayMenu(app.window);
  // Every demo issue was last updated in March 2026, well over a week ago.
  await app.window.locator('[data-testid="board-prefs-max-age"]').selectOption('1');

  await expect(app.window.locator('[data-testid="issue-card"]')).toHaveCount(0);
  await expect(app.window.locator('[data-testid="board-prefs-empty"]')).toBeVisible();

  // Back to all time, cards return.
  await app.window.locator('[data-testid="board-prefs-max-age"]').selectOption('0');
  await expect(app.window.locator('[data-testid="issue-card"]')).toHaveCount(25);
});

test('column visibility and order reshape the board', async () => {
  app = await launchTestApp();
  await openApplicationBoard(app.window);
  await expect(app.window.locator('.board-column')).toHaveCount(5);

  await openDisplayMenu(app.window);

  // Hide Backlog — four columns remain.
  const backlogRow = app.window.locator('[data-testid="board-prefs-column-row"]', {
    hasText: 'Backlog'
  });
  await backlogRow.locator('[data-testid="board-prefs-column-toggle"]').click();
  await expect(app.window.locator('.board-column')).toHaveCount(4);
  // Scope to the column header: card summaries ("Sprint backlog item N")
  // contain the word, so a whole-column hasText filter would match everything.
  await expect(app.window.locator('.board-column .column-name', { hasText: 'Backlog' })).toHaveCount(0);

  // Move "To Do" one later — In Progress becomes the second column.
  const columnNames = app.window.locator('.board-column .column-name');
  await expect(columnNames.nth(0)).toHaveText('To Do');
  const todoRow = app.window.locator('[data-testid="board-prefs-column-row"]', {
    hasText: 'To Do'
  });
  await todoRow.locator('[data-testid="board-prefs-column-down"]').click();
  await expect(columnNames.nth(0)).toHaveText('In Progress');
  await expect(columnNames.nth(1)).toHaveText('To Do');
});
