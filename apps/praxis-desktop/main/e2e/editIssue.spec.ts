import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, expandAllIssueStacks, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
let window: Page;
let plansDir: string;

/**
 * One feature with one task. The task carries a `**Priority:**` line so the
 * edit save can replace it via the live folder backend; newIssue.spec.ts
 * shows the same fixture shape.
 */
function writeFixturePlansFolder(root: string): void {
  const featureDir = path.join(root, 'features', 'feature-01-demo-feature');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(
    path.join(featureDir, 'feature.md'),
    [
      '# Demo Feature',
      '',
      '**Status:** 📋 Proposed',
      '**Type:** Feature',
      '',
      '## Description',
      '',
      'A demo feature for e2e testing.',
      ''
    ].join('\n')
  );
  fs.writeFileSync(
    path.join(featureDir, 'task-01-01-edit-me-task.md'),
    [
      '# Edit me task',
      '',
      '**Status:** 📋 Proposed',
      '**Type:** Task',
      '**Priority:** Medium',
      '',
      '## Description',
      '',
      'Edit me for e2e testing.',
      '',
      '## Comments',
      ''
    ].join('\n')
  );
}

async function launchWithEditFixture(): Promise<void> {
  plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-edit-'));
  writeFixturePlansFolder(plansDir);

  app = await launchTestApp({
    connections: [
      {
        id: 'e2e-edit',
        name: 'e2e-edit',
        mode: 'folder',
        settings: {
          path: plansDir,
          projectKey: 'EDIT',
          projectName: 'Edit E2E',
          allowIssueCreation: true
        }
      }
    ]
  });
  window = app.window;
}

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (plansDir) {
    fs.rmSync(plansDir, { recursive: true, force: true });
    plansDir = '';
  }
});

test('editing a live folder issue writes the priority back to markdown', async () => {
  await launchWithEditFixture();

  await window.locator('[data-testid="board-nav-item"]', { hasText: 'Edit E2E' }).click();
  await expandAllIssueStacks(window);

  await window.locator('[data-testid="issue-card"]', { hasText: 'Edit me task' }).click();

  // The details form is visible immediately and prefilled from the loaded issue.
  await expect(window.locator('[data-testid="issue-edit-form"]')).toBeVisible();
  await expect(window.locator('[data-testid="issue-edit-summary"]')).toHaveValue('Edit me task');
  await expect(window.locator('[data-testid="issue-edit-priority"]')).toHaveValue('Medium');

  await window.locator('[data-testid="issue-edit-summary"]').fill('Edited task title');
  await window.locator('[data-testid="issue-edit-priority"]').selectOption('High');

  const taskPath = path.join(
    plansDir,
    'features',
    'feature-01-demo-feature',
    'task-01-01-edit-me-task.md'
  );

  await window.locator('[data-testid="issue-edit-save-btn"]').click();

  // Save keeps the form visible and writes the new priority to the markdown file.
  await expect(window.locator('[data-testid="issue-edit-form"]')).toBeVisible();
  await expect.poll(() => fs.readFileSync(taskPath, 'utf-8')).toMatch(/\*\*Priority:\*\*\s*High/);

  // The summary is persisted too: the `# ` title heading is rewritten and the
  // reloaded form shows the new title.
  await expect.poll(() => fs.readFileSync(taskPath, 'utf-8')).toMatch(/^# Edited task title$/m);
  await expect(window.locator('[data-testid="issue-edit-summary"]')).toHaveValue('Edited task title');
});
