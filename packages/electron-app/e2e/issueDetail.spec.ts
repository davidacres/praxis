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
 * Phase A — issue detail depth. The demo backend seeds APP-100 with three
 * sub-tasks, one linked issue and two attachments, and APP-101 with a parent
 * back-reference, so the new sections can be asserted end-to-end without a
 * live tracker.
 */
test('issue detail shows sub-tasks, linked issues, attachments and header actions', async () => {
  app = await launchTestApp();
  window = app.window;

  await window.locator('[data-testid="nav-board"]').click();
  await window.locator('[data-testid="board-nav-item"]', { hasText: 'Platform Overview' }).click();
  await window.locator('[data-testid="issue-card"]', { hasText: 'APP-100' }).click();

  // Header actions: copy key and open-in-browser (every demo issue has a browseUrl).
  await expect(window.locator('[data-testid="issue-copy-key-btn"]')).toBeVisible();
  await expect(window.locator('[data-testid="issue-open-browser-btn"]')).toBeEnabled();

  // The seeded sub-tasks, linked issue and attachments render as list rows.
  await expect(window.locator('[data-testid="issue-subtask-row"]')).toHaveCount(3);
  await expect(window.locator('[data-testid="issue-subtask-row"]').first()).toContainText('APP-101');
  await expect(window.locator('[data-testid="issue-linked-row"]')).toHaveCount(1);
  await expect(window.locator('[data-testid="issue-linked-row"]').first()).toContainText('OPS-200');
  await expect(window.locator('[data-testid="issue-attachment-row"]')).toHaveCount(2);
  await expect(
    window.locator('[data-testid="issue-attachment-row"]').first()
  ).toContainText('platform-design-notes.pdf');

  // Clicking a sub-task key navigates the panel to that issue…
  await window
    .locator('[data-testid="issue-subtask-row"]', { hasText: 'APP-101' })
    .locator('button')
    .first()
    .click();
  await expect(window.locator('.detail-panel h4')).toHaveText(
    'Implement dependency-injected backend router'
  );

  // …which shows its parent chip, leading back to APP-100.
  const parentLink = window.locator('[data-testid="issue-parent-link"]');
  await expect(parentLink).toContainText('APP-100');
  await parentLink.click();
  await expect(window.locator('.detail-panel h4')).toHaveText('Core platform feature');
  await expect(window.locator('[data-testid="issue-subtask-row"]')).toHaveCount(3);
});
