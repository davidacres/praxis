import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

/**
 * A feature with three stories (deliberately authored out of filename order,
 * so a naive fetch order would not already happen to match) plus one task and
 * one unrelated standalone feature — same shape a folder board synthesizes
 * from `docs/plans/features/<feature>/`.
 */
function writeFixture(parent: string): void {
  const featureDir = path.join(parent, 'features', 'feature-01-checkout-flow');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(
    path.join(featureDir, 'feature.md'),
    '# Checkout flow\n\n**Status:** 🚧 In Progress\n**Type:** Feature\n'
  );
  fs.writeFileSync(
    path.join(featureDir, 'story-01-3-confirm-and-receipt.md'),
    '# Confirm order and show receipt\n\n**Status:** 🚧 In Progress\n**Type:** Story\n'
  );
  fs.writeFileSync(
    path.join(featureDir, 'story-01-1-collect-shipping-address.md'),
    '# Collect shipping address\n\n**Status:** 🚧 In Progress\n**Type:** Story\n'
  );
  fs.writeFileSync(
    path.join(featureDir, 'story-01-2-select-payment-method.md'),
    '# Select payment method\n\n**Status:** 🚧 In Progress\n**Type:** Story\n'
  );
  fs.writeFileSync(
    path.join(featureDir, 'task-01-1-fix-flaky-webhook-retry.md'),
    '# Fix flaky webhook retry\n\n**Status:** 🚧 In Progress\n**Type:** Task\n'
  );
  const otherFeatureDir = path.join(parent, 'features', 'feature-02-unrelated');
  fs.mkdirSync(otherFeatureDir, { recursive: true });
  fs.writeFileSync(
    path.join(otherFeatureDir, 'feature.md'),
    '# Unrelated standalone card\n\n**Status:** 🚧 In Progress\n**Type:** Feature\n'
  );
}

let app: TestApp | undefined;
let window: Page;
let parentDir: string;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (parentDir) {
    fs.rmSync(parentDir, { recursive: true, force: true });
    parentDir = '';
  }
});

async function launchWithFixture(): Promise<void> {
  parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-hierarchy-'));
  writeFixture(parentDir);
  app = await launchTestApp({
    connections: [
      {
        id: 'e2e-hierarchy',
        name: 'e2e-hierarchy',
        mode: 'folder',
        settings: {
          path: parentDir,
          projectKey: 'HIER',
          projectName: 'E2E Hierarchy',
          allowIssueCreation: true
        }
      }
    ]
  });
  window = app.window;
  await window
    .locator('[data-testid="board-nav-item"]')
    .getByText('E2E Hierarchy', { exact: true })
    .click();
  await window.waitForSelector('[data-testid="issue-card"]');
}

test('a feature clusters its children behind a collapsed stack, expanding in sequence order', async () => {
  await launchWithFixture();

  // Children start collapsed behind the stack — only the two top-level
  // features are real cards until the stack is expanded.
  const cards = window.locator('[data-testid="issue-card"]');
  await expect(cards).toHaveCount(2);

  const parentCard = window.locator('[data-testid="issue-card"][data-issue-key="HIER-F01"]');
  const otherFeatureCard = window.locator('[data-testid="issue-card"][data-issue-key="HIER-F02"]');

  // The parent shows a children badge; the unrelated feature (no children) does not.
  await expect(parentCard.locator('[data-testid="issue-card-child-count"]')).toHaveText('4');
  await expect(otherFeatureCard.locator('[data-testid="issue-card-child-count"]')).toHaveCount(0);

  // The stack sits right after the parent, collapsed, and names the count;
  // the unrelated childless feature has no stack at all.
  const stack = window.locator('[data-testid="issue-card-stack"]');
  await expect(stack).toHaveCount(1);
  await expect(stack).toHaveAttribute('aria-expanded', 'false');
  await expect(stack).toContainText('4 linked tickets');

  // Clicking the stack expands it, revealing the children in authored
  // sequence order, clustered directly beneath the parent.
  await stack.click();
  await expect(stack).toHaveAttribute('aria-expanded', 'true');
  await expect(cards).toHaveCount(6);

  const keys = await cards.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.issueKey));
  const featureIndex = keys.indexOf('HIER-F01');
  expect(featureIndex).toBeGreaterThanOrEqual(0);
  expect(keys.slice(featureIndex, featureIndex + 5)).toEqual([
    'HIER-F01',
    'HIER-S01-1',
    'HIER-S01-2',
    'HIER-S01-3',
    'HIER-T01-1'
  ]);
  expect(keys[keys.length - 1]).toBe('HIER-F02');

  // Every child in the family is visually marked as a child of the feature;
  // the feature itself and the unrelated feature are not.
  for (const key of ['HIER-S01-1', 'HIER-S01-2', 'HIER-S01-3', 'HIER-T01-1']) {
    const child = window.locator(`[data-testid="issue-card"][data-issue-key="${key}"]`);
    await expect(child).toHaveClass(/issue-card-child/);
    await expect(child).toHaveAttribute('data-child-of', 'HIER-F01');
  }
  await expect(parentCard).not.toHaveClass(/issue-card-child/);
  await expect(otherFeatureCard).not.toHaveClass(/issue-card-child/);

  // The parent itself is marked distinctly (its own left-rail colour) from a
  // child, and from a childless feature.
  await expect(parentCard).toHaveClass(/issue-card-parent/);
  await expect(otherFeatureCard).not.toHaveClass(/issue-card-parent/);
  const child = window.locator('[data-testid="issue-card"][data-issue-key="HIER-S01-1"]');
  await expect(child).not.toHaveClass(/issue-card-parent/);

  // Clicking the (now open) stack again collapses it back down.
  await stack.click();
  await expect(stack).toHaveAttribute('aria-expanded', 'false');
  await expect(cards).toHaveCount(2);
});

test('right-click moves a ticket to the top or bottom of its column, carrying a parent\'s children with it', async () => {
  await launchWithFixture();

  const otherFeatureCard = window.locator('[data-testid="issue-card"][data-issue-key="HIER-F02"]');
  const cards = window.locator('[data-testid="issue-card"]');

  // The unrelated feature (no children) moves alone.
  await otherFeatureCard.click({ button: 'right' });
  await window.locator('[data-testid="board-issue-menu-move-top"]').click();
  await expect(cards.first()).toHaveAttribute('data-issue-key', 'HIER-F02');

  // Right-clicking the parent and sending it to the bottom carries its
  // (still-collapsed) stack along with it — the last card is the parent.
  const parentCard = window.locator('[data-testid="issue-card"][data-issue-key="HIER-F01"]');
  await parentCard.click({ button: 'right' });
  await window.locator('[data-testid="board-issue-menu-move-bottom"]').click();
  await expect(cards.last()).toHaveAttribute('data-issue-key', 'HIER-F01');

  // Expanding confirms the children travelled with it, immediately after it.
  await window.locator('[data-testid="issue-card-stack"]').click();
  const keys = await cards.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.issueKey));
  const featureIndex = keys.indexOf('HIER-F01');
  expect(keys.slice(featureIndex)).toEqual(['HIER-F01', 'HIER-S01-1', 'HIER-S01-2', 'HIER-S01-3', 'HIER-T01-1']);
});

test('list view shows the same grouping and ordering', async () => {
  await launchWithFixture();

  await window.locator('[data-testid="board-settings-btn"]').click();
  await window.locator('[data-testid="board-prefs-view-list"]').click();
  // List rows have no `data-issue-key` (only the card view sets that); read
  // the visible key text instead.
  const rows = window.locator('[data-testid="board-list-view"] [data-testid="issue-card"]');
  await rows.first().waitFor();
  await expect(rows).toHaveCount(6);
  const keys = await rows.locator('.issue-card-key').allInnerTexts();
  const featureIndex = keys.indexOf('HIER-F01');
  expect(keys.slice(featureIndex, featureIndex + 5)).toEqual([
    'HIER-F01',
    'HIER-S01-1',
    'HIER-S01-2',
    'HIER-S01-3',
    'HIER-T01-1'
  ]);

  const child = window.locator('[data-testid="board-list-view"] [data-testid="issue-card"]', {
    has: window.locator('.issue-card-key', { hasText: 'HIER-S01-1' })
  });
  await expect(child).toHaveClass(/board-list-row-child/);
  await expect(child).not.toHaveClass(/board-list-row-parent/);

  const parentRow = window.locator('[data-testid="board-list-view"] [data-testid="issue-card"]', {
    has: window.locator('.issue-card-key', { hasText: 'HIER-F01' })
  });
  await expect(parentRow).toHaveClass(/board-list-row-parent/);
  await expect(parentRow).not.toHaveClass(/board-list-row-child/);
});
