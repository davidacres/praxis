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

test('groups all layout toggles on the right side of the title bar', async () => {
  const group = window.locator('.titlebar-layout-toggles');
  await expect(group.getByRole('button', { name: 'Toggle sidebar' })).toBeVisible();
  await expect(group.getByRole('button', { name: 'Toggle panel' })).toBeVisible();
  await expect(group.getByRole('button', { name: 'Toggle secondary sidebar' })).toBeVisible();
  const labels = await group.locator('button').evaluateAll(buttons => buttons.slice(0, 3).map(button => button.getAttribute('aria-label')));
  expect(labels).toEqual([
    'Toggle sidebar',
    'Toggle panel',
    'Toggle secondary sidebar'
  ]);

  await group.getByRole('button', { name: 'Toggle sidebar' }).click();
  await expect(window.locator('.pane-sidebar')).toHaveCount(0);
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
  await expect(window.locator('.overview-board-card').first()).toBeVisible();
});

test('normal launch does not include built-in demo data', async () => {
  await app.electronApp.close();
  app = await launchTestApp(undefined, undefined, undefined, { demoMode: false });
  window = app.window;

  await window.locator('[data-testid="nav-overview"]').click();
  await expect(window.locator('.overview-board-card')).toHaveCount(0);
  await expect(window.getByText('Boards from your connections will appear here.', { exact: true })).toBeVisible();
  await expect(window.locator('[data-testid="board-nav-item"]')).toHaveCount(0);
});

test('selecting a board renders its columns and issue cards', async () => {
  await window.locator('[data-testid="nav-overview"]').click();
  await window.locator('.overview-board-card').first().click();
  const issueCards = window.locator('[data-testid="issue-card"]');
  await expect(issueCards.first()).toBeVisible();
});

test('opening an issue card shows the issue detail panel', async () => {
  await window.locator('[data-testid="nav-overview"]').click();
  await window.locator('.overview-board-card').first().click();
  await window.locator('[data-testid="issue-card"]').first().click();
  // `exact` matters now: the frameless title bar also has a "Close window" button.
  await expect(window.getByRole('button', { name: 'Close', exact: true })).toBeVisible();
  await expect(window.getByText('Comments', { exact: true })).toBeVisible();
});

test('adding a comment appears in the issue detail panel', async () => {
  await window.locator('[data-testid="nav-overview"]').click();
  await window.locator('.overview-board-card').first().click();
  await window.locator('[data-testid="issue-card"]').first().click();

  const commentBody = `e2e comment ${Date.now()}`;
  await window.getByPlaceholder('Add a comment…').fill(commentBody);
  await window.getByRole('button', { name: 'Add comment' }).click();

  await expect(window.locator(`text=${commentBody}`)).toBeVisible();
});

test('closing the issue detail panel hides it', async () => {
  await window.locator('[data-testid="nav-overview"]').click();
  await window.locator('.overview-board-card').first().click();
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

  // The saved connection stays selected; removal is a two-step confirm. Both
  // buttons carry `disabled={busy}`, and the row can appear from the list
  // refresh while the form is still saving — so wait for each to be *enabled*
  // rather than merely present, otherwise the click lands in the disabled
  // window and is dropped. This was an intermittent failure under load.
  const removeButton = window.locator('[data-testid="conn-remove-btn"]');
  await expect(removeButton).toBeEnabled();
  await removeButton.click();

  const confirmButton = window.locator('[data-testid="conn-remove-confirm-btn"]');
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(window.locator('[data-testid="connection-row"]', { hasText: name })).not.toBeVisible();
});
