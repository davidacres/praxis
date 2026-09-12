import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, expandAllIssueStacks, type TestApp } from './launchTestApp';

let app: TestApp;
let window: Page;
let plansDir: string;

function writeFixturePlansFolder(root: string): void {
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

test.beforeEach(async () => {
  plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-folder-'));
  writeFixturePlansFolder(plansDir);

  app = await launchTestApp();
  window = app.window;
});

test.afterEach(async () => {
  await closeTestApp(app);
  fs.rmSync(plansDir, { recursive: true, force: true });
});

async function addFolderConnection(name: string): Promise<void> {
  await window.locator('[data-testid="nav-connections"]').click();
  await window.locator('[data-testid="add-connection-btn"]').click();
  await window.locator('[data-testid="conn-field-name"]').fill(name);
  await window.locator('[data-testid="conn-field-mode"]').selectOption('folder');
  await window.locator('[data-testid="conn-field-root-0"]').fill(plansDir);
  await window.locator('[data-testid="conn-save-btn"]').click();
  await expect(window.locator('[data-testid="connection-row"]', { hasText: name })).toBeVisible();
}

test('folder board lists the fixture feature task', async () => {
  await addFolderConnection('e2e-folder');

  const boardItem = window.locator('[data-testid="board-nav-item"]', { hasText: 'Folder' });
  await expect(boardItem).toBeVisible();
  await boardItem.click();
  await expandAllIssueStacks(window);

  const issueCard = window.locator('[data-testid="issue-card"]', { hasText: 'Do the thing' });
  await expect(issueCard).toBeVisible();
});

test('transitioning a live folder issue writes the new status back to markdown', async () => {
  await addFolderConnection('e2e-folder');
  await window.locator('[data-testid="board-nav-item"]', { hasText: 'Folder' }).click();
  await expandAllIssueStacks(window);
  await window.locator('[data-testid="issue-card"]', { hasText: 'Do the thing' }).click();

  const status = window.locator('[data-testid="issue-edit-status"]');
  await status.selectOption({ label: 'Done' });
  await window.locator('[data-testid="issue-edit-save-btn"]').click();
  await expect(status.locator('option:checked')).toHaveText('Done');

  const taskPath = path.join(plansDir, 'features', 'feature-01-demo-feature', 'task-01-01-do-the-thing.md');
  await expect
    .poll(() => fs.readFileSync(taskPath, 'utf-8'))
    .toMatch(/\*\*Status:\*\*.*Complete/);
});

test('adding a comment on a live folder issue writes it back to markdown', async () => {
  await addFolderConnection('e2e-folder');
  await window.locator('[data-testid="board-nav-item"]', { hasText: 'Folder' }).click();
  await expandAllIssueStacks(window);
  await window.locator('[data-testid="issue-card"]', { hasText: 'Do the thing' }).click();

  const commentBody = `e2e live folder comment ${Date.now()}`;
  await window.getByPlaceholder('Add a comment…').fill(commentBody);
  await window.getByRole('button', { name: 'Add comment' }).click();

  await expect(window.locator(`text=${commentBody}`)).toBeVisible();

  const taskPath = path.join(plansDir, 'features', 'feature-01-demo-feature', 'task-01-01-do-the-thing.md');
  await expect.poll(() => fs.readFileSync(taskPath, 'utf-8')).toContain(commentBody);
});
