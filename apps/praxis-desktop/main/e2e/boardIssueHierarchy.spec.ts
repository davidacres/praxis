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

test('a feature clusters its children directly beneath it, in sequence order', async () => {
  await launchWithFixture();

  const cards = window.locator('[data-testid="issue-card"]');
  await expect(cards).toHaveCount(6);

  // Feature first, its three stories next in authored sequence, then its
  // task, then the unrelated feature last — not the fetch/update order the
  // three story files were written in above.
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

  // The parent shows a children badge; the unrelated feature (no children) does not.
  const parentCard = window.locator('[data-testid="issue-card"][data-issue-key="HIER-F01"]');
  await expect(parentCard.locator('[data-testid="issue-card-child-count"]')).toHaveText('4');
  const otherFeatureCard = window.locator('[data-testid="issue-card"][data-issue-key="HIER-F02"]');
  await expect(otherFeatureCard.locator('[data-testid="issue-card-child-count"]')).toHaveCount(0);

  // Every child in the family is visually marked as a child of the feature;
  // the feature itself and the unrelated feature are not.
  for (const key of ['HIER-S01-1', 'HIER-S01-2', 'HIER-S01-3', 'HIER-T01-1']) {
    const child = window.locator(`[data-testid="issue-card"][data-issue-key="${key}"]`);
    await expect(child).toHaveClass(/issue-card-child/);
    await expect(child).toHaveAttribute('data-child-of', 'HIER-F01');
  }
  await expect(parentCard).not.toHaveClass(/issue-card-child/);
  await expect(otherFeatureCard).not.toHaveClass(/issue-card-child/);
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
});
