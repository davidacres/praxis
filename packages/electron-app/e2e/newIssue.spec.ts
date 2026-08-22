import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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

/** Same fixture shape as liveFolder.spec.ts: one feature with one task. */
function writeFixtureLiveFolder(root: string): void {
  const featureDir = path.join(root, 'features', 'feature-01-demo-feature');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(
    path.join(featureDir, 'feature.md'),
    ['# Demo Feature', '', '**Status:** 📋 Proposed', '**Type:** Feature', '', '## Description', '', 'A demo feature for e2e testing.', ''].join(
      '\n'
    )
  );
  fs.writeFileSync(
    path.join(featureDir, 'task-01-01-do-the-thing.md'),
    [
      '# Do the thing',
      '',
      '**Status:** 📋 Proposed',
      '**Type:** Task',
      '',
      '## Description',
      '',
      'Do the thing for e2e testing.',
      '',
      '## Comments',
      ''
    ].join('\n')
  );
}

async function launchWithLiveFolder(liveFolderDir: string, allowIssueCreation: boolean): Promise<void> {
  app = await launchTestApp({
    connections: [
      {
        id: 'e2e-live-create',
        name: 'e2e-livefolder-create',
        mode: 'livefolder',
        settings: {
          path: liveFolderDir,
          projectKey: 'LIVE',
          projectName: 'Live E2E',
          ...(allowIssueCreation ? { allowIssueCreation: true } : {})
        }
      }
    ]
  });
  window = app.window;
  await window.locator('[data-testid="nav-board"]').click();
  await window.locator('[data-testid="board-nav-item"]', { hasText: '(Live)' }).click();
}

test('creating a demo issue with the full field set shows it on the board', async () => {
  app = await launchTestApp();
  window = app.window;

  await window.locator('[data-testid="board-nav-item"]').first().click();
  await window.locator('[data-testid="board-new-issue-btn"]').click();
  await expect(window.locator('[data-testid="new-issue-page"]')).toBeVisible();

  const summary = `e2e new issue ${Date.now()}`;
  await window.locator('[data-testid="new-issue-type"]').selectOption('Task');
  await window.locator('[data-testid="new-issue-summary"]').fill(summary);
  await window.locator('[data-testid="new-issue-description"]').fill('Created by the e2e suite.');
  await window.locator('[data-testid="new-issue-priority"]').selectOption('High');
  await window.locator('[data-testid="new-issue-assignee"]').fill('E2E Tester');
  await window.locator('[data-testid="new-issue-severity"]').selectOption('Medium');
  await window.locator('[data-testid="new-issue-reported-by"]').fill('Playwright');
  await window.locator('[data-testid="new-issue-submit"]').click();

  // The create flow navigates to the new ticket; the board behind it refreshes.
  await expect(window.locator('[data-testid="issue-card"]', { hasText: summary })).toBeVisible();
  await expect(window.locator('[data-testid="new-issue-error"]')).toHaveCount(0);
});

test('creating a live folder task under a feature writes the markdown file', async () => {
  const liveFolderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-manager-newissue-'));
  try {
    writeFixtureLiveFolder(liveFolderDir);
    await launchWithLiveFolder(liveFolderDir, true);

    await window.locator('[data-testid="board-new-issue-btn"]').click();
    await expect(window.locator('[data-testid="new-issue-page"]')).toBeVisible();

    await window.locator('[data-testid="new-issue-type"]').selectOption('Task');
    const summary = `e2e live task ${Date.now()}`;
    await window.locator('[data-testid="new-issue-summary"]').fill(summary);

    // Live folder children must belong to a Feature — pick the fixture's from
    // the datalist rather than typing a key the test can't know up front.
    const parentOptions = window.locator('#new-issue-parent-options option');
    await expect(parentOptions).toHaveCount(1);
    const parentValue = await parentOptions.first().getAttribute('value');
    expect(parentValue).toBeTruthy();
    await window.locator('[data-testid="new-issue-parent"]').fill(parentValue!);

    await window.locator('[data-testid="new-issue-priority"]').selectOption('High');
    await window.locator('[data-testid="new-issue-submit"]').click();

    await expect(window.locator('[data-testid="issue-card"]', { hasText: summary })).toBeVisible();

    // The live folder backend physically writes a new markdown file under the
    // feature's folder, with the type/priority meta lines from the form.
    const featureDir = path.join(liveFolderDir, 'features', 'feature-01-demo-feature');
    const newTaskFiles = () =>
      fs.readdirSync(featureDir).filter(name => name.startsWith('task-') && !name.includes('do-the-thing'));
    await expect.poll(newTaskFiles).toHaveLength(1);
    const content = fs.readFileSync(path.join(featureDir, newTaskFiles()[0]), 'utf-8');
    expect(content).toContain('**Type:** Task');
    expect(content).toContain(summary);
    expect(content).toMatch(/\*\*Priority:\*\*\s*High/);
  } finally {
    fs.rmSync(liveFolderDir, { recursive: true, force: true });
  }
});

test('live folder without allowIssueCreation shows a disabled create button with a hint', async () => {
  const liveFolderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-manager-newissue-gated-'));
  try {
    writeFixtureLiveFolder(liveFolderDir);
    await launchWithLiveFolder(liveFolderDir, false);

    const button = window.locator('[data-testid="board-new-issue-btn"]');
    await expect(button).toBeVisible();
    await expect(button).toBeDisabled();
    await expect(button).toHaveAttribute('title', /Allow issue creation/);
  } finally {
    fs.rmSync(liveFolderDir, { recursive: true, force: true });
  }
});
