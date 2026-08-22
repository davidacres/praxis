import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
let window: Page;
let liveFolderDir: string;

/**
 * One feature with one task. The task carries a `**Priority:**` line so the
 * edit save can replace it via the live folder backend; newIssue.spec.ts
 * shows the same fixture shape.
 */
function writeFixtureLiveFolder(root: string): void {
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
  liveFolderDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-manager-edit-'));
  writeFixtureLiveFolder(liveFolderDir);

  app = await launchTestApp({
    connections: [
      {
        id: 'e2e-edit',
        name: 'e2e-edit',
        mode: 'livefolder',
        settings: {
          path: liveFolderDir,
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
  if (liveFolderDir) {
    fs.rmSync(liveFolderDir, { recursive: true, force: true });
    liveFolderDir = '';
  }
});

test('editing a live folder issue writes the priority back to markdown', async () => {
  await launchWithEditFixture();

  await window.locator('[data-testid="nav-board"]').click();
  await window.locator('[data-testid="board-nav-item"]', { hasText: 'Edit E2E' }).click();

  await window.locator('[data-testid="issue-card"]', { hasText: 'Edit me task' }).click();
  await window.locator('[data-testid="issue-edit-btn"]').click();

  // The form is prefilled from the loaded issue.
  await expect(window.locator('[data-testid="issue-edit-summary"]')).toHaveValue('Edit me task');
  await expect(window.locator('[data-testid="issue-edit-priority"]')).toHaveValue('Medium');

  await window.locator('[data-testid="issue-edit-summary"]').fill('Edited task title');
  await window.locator('[data-testid="issue-edit-priority"]').fill('High');

  const taskPath = path.join(
    liveFolderDir,
    'features',
    'feature-01-demo-feature',
    'task-01-01-edit-me-task.md'
  );

  await window.locator('[data-testid="issue-edit-save-btn"]').click();

  // Save exits edit mode and surfaces the new priority on the markdown file.
  await expect(window.locator('[data-testid="issue-edit-form"]')).toHaveCount(0);
  await expect.poll(() => fs.readFileSync(taskPath, 'utf-8')).toMatch(/\*\*Priority:\*\*\s*High/);

  // The summary is persisted too: the `# ` title heading is rewritten and the
  // reloaded detail view shows the new title.
  await expect.poll(() => fs.readFileSync(taskPath, 'utf-8')).toMatch(/^# Edited task title$/m);
  await expect(window.locator('.detail-panel h4')).toHaveText('Edited task title');
});
