// SPDX-License-Identifier: MIT
//
// e2e spec for importing plans folders as projects — the flow that replaced the
// User Workspace connection's create-board wizard.
//
// A folder of markdown plans becomes a `storage: 'folder'` project whose board
// reads those files directly. These tests drive the `projects:*` import IPC
// directly (same idiom as boardSettingsFile.spec.ts) and then assert on the UI
// the import produces; the planner's own row-selection rules are unit-tested in
// `packages/core/src/projects/projectImportPlanner.test.ts`.
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

/** Scans a folder through the real IPC and returns the rows the wizard would show. */
function discover(win: Page, folderPath: string) {
  return win.evaluate(
    folder => window.praxis.projects.discoverImports(folder),
    folderPath
  );
}

test.beforeEach(async () => {
  plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-import-'));
  writeFixturePlansFolder(plansDir);
  app = await launchTestApp({ connections: [] }, undefined, undefined, { demoMode: false });
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
});

test('importing a plans folder creates a folder-backed project whose board shows its markdown', async () => {
  const rows = await discover(window, plansDir);
  expect(rows).toHaveLength(1);

  const projects = await window.evaluate(async row => {
    const workspaces = await window.praxis.workspaces.list();
    return window.praxis.projects.createFromImports(
      [{ ...row, projectName: 'E2E Imported', projectKey: 'IMP1' }],
      workspaces[0].id
    );
  }, rows[0]);

  expect(projects).toHaveLength(1);
  expect(projects[0].storage).toBe('folder');
  expect(projects[0].key).toBe('IMP1');
  // The folder is the source of truth — no work items are copied into the record.
  expect(projects[0].workItems).toHaveLength(0);

  // The project board is the folder connection's board, with no project-only
  // proxy service or synthetic board identity.
  const details = await window.evaluate(async project => {
    const connection = (await window.praxis.connection.list()).find(
      candidate => candidate.settings.projectId === project.id
    );
    const boards = await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' });
    const board = boards.find(candidate => candidate.connectionId === connection?.id);
    return board ? { connection, details: await window.praxis.board.get(board) } : undefined;
  }, projects[0]);

  expect(details).toBeTruthy();
  expect(details!.connection.mode).toBe('folder');
  expect(details!.details.board.connectionId).toBe(details!.connection.id);
  expect(details!.details.issues.map(issue => issue.summary)).toContain('Do the thing');
  expect(details!.details.issues.every(issue => issue.projectKey === 'IMP1')).toBe(true);
});

test('a repository with no plans content is skipped, not guessed at', async () => {
  // Deliberate reversal of the old User Workspace behaviour, which offered a
  // plansless repository as a row pointed at a guessed `<repo>/docs/plans`.
  // When that guessed path happened to exist, the board was created and
  // silently showed nothing. Starting fresh work in a repo is the New Project
  // wizard's job; this one only imports plans that already exist.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-import-repo-'));
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
  try {
    expect(await discover(window, repoDir)).toHaveLength(0);
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('a repository whose plans sit outside docs/plans is still found', async () => {
  // The old planner only kept a repo's own plans root when it had `features/`
  // entries, and otherwise guessed `docs/plans`. A repo whose plans live
  // anywhere else is now discovered where they actually are.
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-import-nested-'));
  fs.mkdirSync(path.join(repoDir, '.git'), { recursive: true });
  writeFixturePlansFolder(path.join(repoDir, 'planning'));
  try {
    const rows = await discover(window, repoDir);
    expect(rows).toHaveLength(1);
    expect(rows[0].plansFolderPath).toContain('planning');
  } finally {
    fs.rmSync(repoDir, { recursive: true, force: true });
  }
});

test('the wizard is reachable from the sidebar New menu and imports through the UI', async () => {
  // The only entry point used to be the "no boards" empty state, which demo
  // fixtures or the New Session composer pre-empt — so the wizard was dead UI.
  await window.getByTestId('new-menu').click();
  await window.getByTestId('import-projects').click();
  await expect(window.getByTestId('import-projects-wizard')).toBeVisible();

  await window.getByTestId('import-folder-input').fill(plansDir);
  await window.getByTestId('import-discover-btn').click();

  const row = window.getByTestId('import-row');
  await expect(row).toHaveCount(1);
  await row.getByTestId('import-row-projectKey').fill('UIIMP');
  await row.getByTestId('import-row-projectName').fill('UI Imported');
  await window.getByTestId('import-submit-btn').click();

  await expect(window.getByTestId('import-projects-wizard')).toHaveCount(0);
  await expect(
    window.getByTestId('project-tree').filter({ hasText: 'UI Imported' })
  ).toBeVisible();
});

test('re-scanning an imported folder flags it rather than offering it twice', async () => {
  const rows = await discover(window, plansDir);
  await window.evaluate(async row => {
    const workspaces = await window.praxis.workspaces.list();
    await window.praxis.projects.createFromImports(
      [{ ...row, projectKey: 'IMP2' }],
      workspaces[0].id
    );
  }, rows[0]);

  const again = await discover(window, plansDir);
  expect(again).toHaveLength(1);
  expect(again[0].alreadyAdded).toBe(true);
});
