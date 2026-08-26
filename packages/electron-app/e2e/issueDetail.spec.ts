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
test('issue detail shows sub-tasks, linked issues, attachments and essential header actions', async () => {
  app = await launchTestApp();
  window = app.window;

  await window.locator('[data-testid="nav-board"]').click();
  await window.locator('[data-testid="board-nav-item"]', { hasText: 'Platform Overview' }).click();
  await window.locator('[data-testid="issue-card"]', { hasText: 'APP-100' }).click();

  await expect(window.locator('[data-testid="issue-copy-key-btn"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="issue-open-browser-btn"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="issue-refresh-btn"]')).toBeVisible();
  await expect(window.locator('[data-testid="issue-primary-ai-btn"]')).toHaveAttribute('data-ai-mode', 'start');
  await expect(window.locator('[data-testid="issue-ai-delegate-btn"]')).toHaveCount(0);
  const expandButton = window.locator('[data-testid="issue-expand-btn"]');
  await expect(expandButton).toHaveAttribute('aria-pressed', 'false');
  await expandButton.click();
  await expect(expandButton).toHaveAttribute('aria-pressed', 'true');
  await expect(window.locator('[data-testid="main-content-pane"]')).toHaveCount(0);
  await expect(window.locator('[data-testid="issue-details-pane"]')).toHaveClass(/is-expanded/);
  await expandButton.click();
  await expect(window.locator('[data-testid="main-content-pane"]')).toBeVisible();

  // Desktop-native detail actions remain in the narrow auxiliary pane.
  await expect(window.locator('[data-testid="issue-assign-me-btn"]')).toBeVisible();
  const description = window.locator('[data-testid="issue-description"]');
  await expect(description).toBeVisible();
  await description.click();
  const descriptionEditor = window.locator('[data-testid="issue-edit-description"]');
  await expect(descriptionEditor).toBeFocused();
  await descriptionEditor.press('Tab');
  await expect(description).toBeVisible();

  const assignee = window.locator('[data-testid="issue-edit-assignee"]');
  await assignee.fill('Someone Else');
  await window.locator('[data-testid="issue-edit-save-btn"]').click();
  await expect(assignee).toHaveValue('Someone Else');
  await window.locator('[data-testid="issue-assign-me-btn"]').click();
  await expect(assignee).toHaveValue('Alex Agent');

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
  await expect(window.locator('[data-testid="issue-edit-summary"]')).toHaveValue(
    'Implement dependency-injected backend router'
  );

  // …which shows its parent chip, leading back to APP-100.
  const parentLink = window.locator('[data-testid="issue-parent-link"]');
  await expect(parentLink).toContainText('APP-100');
  await parentLink.click();
  await expect(window.locator('[data-testid="issue-edit-summary"]')).toHaveValue('Core platform feature');
  await expect(window.locator('[data-testid="issue-subtask-row"]')).toHaveCount(3);
});
