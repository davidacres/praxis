import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import * as path from 'node:path';
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

  // Navigate to Sessions
  await window.getByTestId('nav-conversations').click();

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

test('Praxis section in sidebar can expand to full sidebar and restore', async () => {
  const sidebar = window.locator('.pane-sidebar');
  await expect(sidebar).toBeVisible();

  const maximizeBtn = sidebar.getByTestId('toggle-features-maximize');
  await expect(maximizeBtn).toBeVisible();
  await expect(maximizeBtn).toHaveAttribute('aria-label', 'Use full sidebar');

  // Upper scroll area with projects/boards is visible
  await expect(sidebar.locator('.sidebar-scroll')).toBeVisible();

  // Click maximize to use full sidebar
  await maximizeBtn.click();
  await expect(maximizeBtn).toHaveAttribute('aria-label', 'Restore sidebar');
  await expect(sidebar.locator('.sidebar-scroll')).toBeHidden();
  await expect(sidebar.locator('.sidebar-footer-maximized')).toBeVisible();

  // Click restore to return to normal
  await maximizeBtn.click();
  await expect(maximizeBtn).toHaveAttribute('aria-label', 'Use full sidebar');
  await expect(sidebar.locator('.sidebar-scroll')).toBeVisible();
  await expect(sidebar.locator('.sidebar-footer-maximized')).toHaveCount(0);
});

test('remembers which panels are open across a relaunch', async () => {
  const toggles = window.locator('.titlebar-layout-toggles');
  await expect(window.locator('.pane-sidebar')).toBeVisible();

  // Collapse the sidebar and open the bottom panel.
  await toggles.getByRole('button', { name: 'Toggle sidebar' }).click();
  await toggles.getByRole('button', { name: 'Toggle panel' }).click();
  await expect(window.locator('.pane-sidebar')).toHaveCount(0);
  await expect(window.locator('[data-testid="bottom-panel"]')).toBeVisible();

  await window.reload();
  await window.locator('[data-testid="startup-splash"]').waitFor({ state: 'detached' }).catch(() => undefined);

  await expect(window.locator('.pane-sidebar')).toHaveCount(0);
  await expect(window.locator('[data-testid="bottom-panel"]')).toBeVisible();
});

test('displays the running Praxis version in the title bar', async () => {
  const version = await window.evaluate(() => window.praxis.app.getVersion());
  expect(version).toMatch(/^\d+\.\d+\.\d+$/);
  await expect(window.locator('.titlebar-version')).toHaveText(`v${version}`);
});

test('boards render on launch', async () => {
  await expect(window.locator('[data-testid="new-session-view"] h1')).toContainText('No board');
  await expect(window.locator('[data-testid="new-session-board-select"]')).toContainText('No board');
  await window.locator('[data-testid="nav-overview"]').click();
  await expect(window.getByTestId('board-nav-item').first()).toBeVisible();
});

test('normal launch does not include built-in demo data', async () => {
  await app.electronApp.close();
  app = await launchTestApp(undefined, undefined, undefined, { demoMode: false });
  window = app.window;

  await window.locator('[data-testid="nav-overview"]').click();
  await expect(window.getByTestId('overview-page')).toBeVisible();
  await expect(window.locator('[data-testid="board-nav-item"]')).toHaveCount(0);
});

// Proven against the original connectionCount === 0 notice: the first absence assertion fails.
test('a folder conversation without trackers does not claim to use demo boards', async () => {
  await closeTestApp(app);
  app = await launchTestApp(undefined, undefined, undefined, { demoMode: false });
  window = app.window;

  expect(await window.evaluate(() => window.praxis.connection.list())).toEqual([]);
  // The isolated launcher supplies a real temporary working folder.
  await expect(window.getByTestId('new-session-working-directory')).toContainText(path.basename(app.userDataDir));
  await expect(window.getByText('No tracker connected', { exact: true })).toHaveCount(0);

  await window.getByTestId('conversations-new-btn').click();
  await expect(window.getByTestId('new-session-view').getByRole('heading', { name: 'New conversation', exact: true })).toBeVisible();
  await expect(window.getByTestId('new-session-working-directory')).toContainText(path.basename(app.userDataDir));
  await expect(window.getByText('No tracker connected', { exact: true })).toHaveCount(0);
  await expect(window.getByText(/You're working against the built-in demo boards/)).toHaveCount(0);
  await window.getByTestId('new-session-view').locator('textarea').fill('Help me understand this folder.');
  await window.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/folder-conversation.png') });
});

test('selecting a board renders its columns and issue cards', async () => {
  // Board selection owns the secondary sidebar even when the user previously
  // hid it: selecting a board is an explicit request for board context.
  await window.getByRole('button', { name: 'Toggle secondary sidebar' }).click();
  await window.locator('[data-testid="nav-overview"]').click();
  await window.getByTestId('board-nav-item').first().click();
  const issueCards = window.locator('[data-testid="issue-card"]');
  await expect(issueCards.first()).toBeVisible();

  const details = window.locator('[data-testid="board-details-panel"]');
  await expect(details).toBeVisible();
  await expect(details.getByRole('heading', { name: 'Application Board' })).toBeVisible();
  const boardIdentityIcon = details.locator('.board-details-icon');
  await expect(boardIdentityIcon).toHaveCSS('border-top-width', '0px');
  await expect(boardIdentityIcon).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(details.locator('[data-testid="board-detail-connection"]')).toContainText('Demo');
  await expect(details.locator('[data-testid="board-detail-creator"]')).toHaveText('Alex Agent');
  await expect(details.getByRole('heading', { name: 'Work item stats' })).toBeVisible();
  await expect(details.locator('[data-testid="board-stat-total"]')).not.toHaveText('0');
  await expect(details.locator('[data-testid="board-stat-stories"]')).toBeVisible();
  await expect(details.locator('[data-testid="board-status-breakdown"]')).toContainText('Done');
});

test('opening an issue card shows the issue detail panel', async () => {
  await window.locator('[data-testid="nav-overview"]').click();
  await window.getByTestId('board-nav-item').first().click();
  await window.locator('[data-testid="issue-card"]').first().click();
  // `exact` matters now: the frameless title bar also has a "Close window" button.
  await expect(window.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  await expect(window.getByText('Comments', { exact: true })).toBeVisible();
});

test('adding a comment appears in the issue detail panel', async () => {
  await window.locator('[data-testid="nav-overview"]').click();
  await window.getByTestId('board-nav-item').first().click();
  await window.locator('[data-testid="issue-card"]').first().click();

  const commentBody = `e2e comment ${Date.now()}`;
  await window.getByPlaceholder('Add a comment…').fill(commentBody);
  await window.getByRole('button', { name: 'Add comment' }).click();

  await expect(window.locator(`text=${commentBody}`)).toBeVisible();
});

test('closing the issue detail panel hides it', async () => {
  await window.locator('[data-testid="nav-overview"]').click();
  await window.getByTestId('board-nav-item').first().click();
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

  // A connection with a board cannot be deleted until the board is removed.
  await window.locator('[data-testid="tracked-board-row"]', { hasText: name }).getByRole('button').click();
  const removeButton = row.getByRole('button', { name: `Remove ${name}` });
  await expect(removeButton).toBeEnabled();
  await removeButton.click();

  const confirmButton = window.getByRole('button', { name: 'Remove', exact: true });
  await expect(confirmButton).toBeVisible();
  await confirmButton.click();

  await expect(window.locator('[data-testid="connection-row"]', { hasText: name })).not.toBeVisible();
});

test('a returning user gets the brief splash, not the full crawl', async () => {
  // Opening the seeded workspace marks the profile onboarded; the reload then
  // brings back the brief brand mark, which retires in about a second rather
  // than running the ~6.5s crawl.
  await expect(window.locator('[data-testid="overview-page"], .project-dashboard, [data-testid="new-session-view"]').first()).toBeVisible();
  const onboarded = await window.evaluate(() => localStorage.getItem('praxis-onboarded'));
  expect(onboarded).toBe('1');

  const startedAt = Date.now();
  await window.reload();
  await window.locator('[data-testid="startup-splash"]').waitFor({ state: 'detached', timeout: 5000 });
  expect(Date.now() - startedAt).toBeLessThan(4000);
});
