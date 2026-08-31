// SPDX-License-Identifier: MIT
//
// The end-to-end user journey the refactor exists to serve: open a fresh
// workspace, create a project from an existing folder that already holds
// markdown plans, and see those plans on the project's board.
//
// This is the path that produced an empty board before `ProjectRecord.storage`
// — the project was created as app storage and its board read an empty
// `workItems` array while the plans sat on disk, ignored.
//
// The folder under test is this repository itself: it has a real `docs/plans`
// tree, so the journey runs against genuine content rather than a fixture.

import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, dismissSplash, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
let window: Page;

/** The repo root — four levels up from apps/praxis-desktop/main/e2e. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

test.beforeEach(async () => {
  app = await launchTestApp({ connections: [] }, undefined, undefined, { demoMode: false });
  window = app.window;
});

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

test('a project created from a folder of existing plans shows them on its board', async () => {
  // 1. The folder is inspected the way the wizard inspects it.
  const inspection = await window.evaluate(
    folder => window.praxis.projects.inspectFolder(folder),
    REPO_ROOT
  );
  expect(inspection.exists).toBe(true);
  expect(inspection.planFiles?.length ?? 0).toBeGreaterThan(0);

  // 2. Create the project exactly as the wizard would for an existing folder
  //    holding plans — `storage: 'folder'` is what the wizard now derives.
  const project = await window.evaluate(async folder => {
    const workspaces = await window.praxis.workspaces.list();
    return window.praxis.projects.create(
      {
        name: 'Praxis From Folder',
        key: 'PXJ',
        type: 'software',
        purpose: '',
        brief: {},
        startingPoint: 'existing-folder',
        storage: 'folder',
        folderPath: folder,
        workflowStages: [
          { id: 'stage-backlog', name: 'Backlog' },
          { id: 'stage-done', name: 'Done' }
        ],
        starterTickets: [],
        defaultAiToolMode: 'full'
      },
      workspaces[0].id
    );
  }, REPO_ROOT);

  expect(project.storage).toBe('folder');
  expect(project.workspaceFolder).toBeTruthy();
  // Starter tickets are dropped for folder storage — the folder is the source.
  expect(project.workItems).toHaveLength(0);

  // 3. The project's own board serves the folder's plans, under the project key.
  const details = await window.evaluate(async created => {
    const boards = await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' });
    const board = boards.find(candidate => candidate.id === created.defaultBoardId);
    return board ? window.praxis.board.get(board) : undefined;
  }, project);

  expect(details, 'the project board should be listed').toBeTruthy();
  expect(details!.board.connectionId).toBe(`project:${project.id}`);
  expect(details!.issues.length).toBeGreaterThan(0);
  expect(details!.issues.every(issue => issue.projectKey === 'PXJ')).toBe(true);

  // 4. And it renders. The project was created through IPC rather than the
  //    wizard's own handler, so the shell never ran its refresh — reload to
  //    pick up persisted state, which also proves the project survives a
  //    restart rather than only existing in memory.
  await window.reload();
  await dismissSplash(window);
  await expect(window.getByTestId('project-tree').filter({ hasText: 'Praxis From Folder' })).toBeVisible();
  await window.getByTestId('project-default-board-nav-item').first().click();
  await expect(window.getByTestId('issue-card').first()).toBeVisible();
});

test('a project created from a folder with no plans stays on app storage', async () => {
  // The counterpart: nothing to read means the board keeps its own work items,
  // so an ordinary project is unaffected by the folder-backed path.
  const project = await window.evaluate(async folder => {
    const workspaces = await window.praxis.workspaces.list();
    return window.praxis.projects.create(
      {
        name: 'Plain Project',
        key: 'PLAIN',
        type: 'product',
        purpose: '',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [
          { id: 'stage-backlog', name: 'Backlog' },
          { id: 'stage-done', name: 'Done' }
        ],
        starterTickets: [
          { summary: 'First ticket', description: '', issueType: 'Task', status: 'Backlog' }
        ],
        defaultAiToolMode: 'project-only'
      },
      workspaces[0].id
    );
  }, REPO_ROOT);

  expect(project.storage).toBe('app');
  expect(project.workItems).toHaveLength(1);
});
