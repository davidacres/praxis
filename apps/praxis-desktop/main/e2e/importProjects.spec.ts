// SPDX-License-Identifier: MIT
//
// e2e spec for importing plans folders as projects — the flow that replaced the
// User Workspace connection's create-board wizard.
//
// A folder of markdown plans becomes a `storage: 'folder'` project whose board
// reads those files directly. The wizard is reached from the "no boards" empty
// state, so these tests launch with a workspace but no connections.
//
// Two filesystem fixtures are used:
//
//   - `plansDir` — a temp dir laid out like a real plans folder, with one
//                  feature under `features/feature-01-demo-feature/` and one
//                  child task (same shape as `folder.spec.ts`). Discovery on it
//                  must yield exactly one row.
//   - `emptyDir` — a fresh temp dir with no `features/` child, for the
//                  empty-state branch.
//
// Per-test isolation: `launchTestApp` points both `--user-data-dir` and
// `PRAXIS_SETTINGS_PATH` at throwaway paths inside a fresh tmp dir, so projects
// and settings cannot leak between tests.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
let window: Page;
let plansDir: string;
let emptyDir: string;

const PROJECT_NAME = 'E2E Imported Project';
const PROJECT_KEY = 'IMP1';

/** Same fixture shape as folder.spec.ts — one feature with one task. */
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
  plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-import-'));
  writeFixturePlansFolder(plansDir);
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-import-empty-'));

  // No connections: the app lands on the "no boards" empty state, which is
  // where the import wizard is offered.
  app = await launchTestApp({ connections: [] }, undefined, undefined, { openNewSession: false });
  window = app.window;
});

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (plansDir) {
    fs.rmSync(plansDir, { recursive: true, force: true });
  }
  if (emptyDir) {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

/** Opens the wizard from the empty state and scans the given folder. */
async function discover(folderPath: string): Promise<void> {
  await window.locator('[data-testid="no-boards-import-btn"]').click();
  await expect(window.locator('[data-testid="import-projects-wizard"]')).toBeVisible();
  await window.locator('[data-testid="import-folder-input"]').fill(folderPath);
  await window.locator('[data-testid="import-discover-btn"]').click();
}

test('importing a plans folder creates a folder-backed project whose board shows its markdown', async () => {
  await discover(plansDir);

  const row = window.locator('[data-testid="import-row"]');
  await expect(row).toHaveCount(1);
  await row.locator('[data-testid="import-row-name"]').fill(PROJECT_NAME);
  await row.locator('[data-testid="import-row-projectName"]').fill(PROJECT_NAME);
  await row.locator('[data-testid="import-row-projectKey"]').fill(PROJECT_KEY);
  await window.locator('[data-testid="import-submit-btn"]').click();

  await expect(window.locator('[data-testid="import-projects-wizard"]')).toHaveCount(0);

  // The project's board appears in the sidebar and renders the folder's tickets.
  const sidebarBoard = window.locator('[data-testid="board-nav-item"]', { hasText: PROJECT_NAME });
  await expect(sidebarBoard).toBeVisible();
  await sidebarBoard.click();
  await expect(window.locator('[data-testid="issue-card"]', { hasText: 'Do the thing' })).toBeVisible();
});

test('rows can be deselected before importing', async () => {
  await discover(plansDir);

  const row = window.locator('[data-testid="import-row"]');
  await expect(row).toHaveCount(1);
  const selection = row.locator('[data-testid="import-row-select"]');
  await expect(selection).toBeChecked();
  await selection.uncheck();
  await expect(selection).not.toBeChecked();
  await expect(window.locator('[data-testid="import-submit-btn"]')).toBeDisabled();
});

test('a folder with no plans shows the empty state', async () => {
  await discover(emptyDir);

  await expect(window.locator('[data-testid="import-empty"]')).toBeVisible();
  await expect(window.locator('[data-testid="import-row"]')).toHaveCount(0);

  await window.locator('[data-testid="import-cancel-btn"]').click();
  await expect(window.locator('[data-testid="import-projects-wizard"]')).toHaveCount(0);
});

test('a Git repository with no plans content is skipped, not guessed at', async () => {
  // Deliberate reversal of the old User Workspace behaviour, which offered a
  // plansless repository as a row pointed at a guessed `<repo>/docs/plans`.
  // When that guessed path happened to exist, the board was created and
  // silently showed nothing. Starting fresh work in a repo is the New Project
  // wizard's job; this one only imports plans that already exist.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-import-repo-'));
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });

  try {
    await discover(repoDir);
    await expect(window.locator('[data-testid="import-empty"]')).toBeVisible();
    await expect(window.locator('[data-testid="import-row"]')).toHaveCount(0);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('a repository whose plans sit outside docs/plans is still found', async () => {
  // The old planner only kept a repo's own plans root when it had `features/`
  // entries, and otherwise guessed `docs/plans`. A repo whose plans live at its
  // root — or anywhere else — is now discovered where it actually is.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-import-nested-'));
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
  const plansRoot = path.join(repoDir, 'planning');
  writeFixturePlansFolder(plansRoot);

  try {
    await discover(repoDir);
    const row = window.locator('[data-testid="import-row"]');
    await expect(row).toHaveCount(1);
    await expect(row.locator('.board-draft-path')).toContainText('planning');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});
