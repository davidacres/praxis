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
// The folder under test is a *copy* of this repository's own planning content:
// its real `docs/plans` tree, `project.praxis.md` and `board.praxis.json`. That keeps
// the original intent — the journey runs against genuine content rather than a
// hand-built fixture — without pointing Praxis's write paths at the working
// tree.
//
// It used to run against the repository directly, and that is not theoretical:
// `FolderService.loadFromDisk` runs a template-upgrade pass that rewrites plan
// markdown (`ensureFrontMatter` injects **Status:** / **Created:** / **Type:** /
// **Priority:** and appends `## Description` / `## Comments`), and
// `writeProjectSnapshot` used to rewrite `project.praxis.md`. Both fired on the real
// repo during ordinary test runs — the second one overwrote it outright. The
// `assertRepositoryUntouched` guard below fails loudly if a future change aims
// a write path back at the working tree.

import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, dismissSplash, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
let window: Page;

/** The repo root — four levels up from apps/praxis-desktop/main/e2e. */
const REPO_ROOT = path.resolve(__dirname, '../../../..');

/**
 * Everything in the working tree this spec could plausibly cause a write to.
 *
 * Derived from the naming rule rather than listed, so a Praxis file added later
 * is covered without anyone remembering to add it here — every root-level
 * `*.praxis.*` (project.praxis.md, board.praxis.json,
 * <slug>.workspace.praxis.json) plus the plans tree the folder backend parses
 * and its template-upgrade pass can rewrite.
 */
function guardedPaths(): string[] {
  const rootPraxisFiles = fs
    .readdirSync(REPO_ROOT)
    .filter(name => name.includes('.praxis.'))
    .sort();
  return [...rootPraxisFiles, path.join('docs', 'plans')];
}

/** A stable fingerprint of the guarded paths, so a stray write is visible. */
function repositoryFingerprint(): string {
  const parts: string[] = [];
  const walk = (absolute: string, relative: string): void => {
    const stat = fs.statSync(absolute);
    if (stat.isDirectory()) {
      for (const entry of fs.readdirSync(absolute).sort()) {
        walk(path.join(absolute, entry), path.join(relative, entry));
      }
      return;
    }
    parts.push(`${relative}:${createHash('sha1').update(fs.readFileSync(absolute)).digest('hex')}`);
  };
  for (const target of guardedPaths()) {
    const absolute = path.join(REPO_ROOT, target);
    if (fs.existsSync(absolute)) walk(absolute, target);
  }
  return parts.join('\n');
}

let repositoryBefore = '';

/** A temp copy of the repo's planning content — the folder actually under test. */
let repoCopy: string;

function copyRepositoryContent(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-journey-repo-'));
  fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
  fs.cpSync(path.join(REPO_ROOT, 'docs', 'plans'), path.join(root, 'docs', 'plans'), { recursive: true });
  for (const file of ['project.praxis.md', 'board.praxis.json']) {
    const source = path.join(REPO_ROOT, file);
    if (fs.existsSync(source)) fs.copyFileSync(source, path.join(root, file));
  }
  return root;
}

test.beforeAll(() => {
  repositoryBefore = repositoryFingerprint();
});

test.afterAll(() => {
  expect(
    repositoryFingerprint(),
    'this spec must never write into the working tree — point it at repoCopy, not REPO_ROOT'
  ).toBe(repositoryBefore);
});

test.beforeEach(async () => {
  repoCopy = copyRepositoryContent();
  app = await launchTestApp({ connections: [] }, undefined, undefined, { demoMode: false });
  window = app.window;
});

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (repoCopy) fs.rmSync(repoCopy, { recursive: true, force: true });
});

test('a project created from a folder of existing plans shows them on its board', async () => {
  // 1. The folder is inspected the way the wizard inspects it.
  const inspection = await window.evaluate(
    folder => window.praxis.projects.inspectFolder(folder),
    repoCopy
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
  }, repoCopy);

  expect(project.storage).toBe('folder');
  expect(project.workspaceFolder).toBeTruthy();
  // Starter tickets are dropped for folder storage — the folder is the source.
  expect(project.workItems).toHaveLength(0);

  // 2b. The project owns a real folder connection, so its board resolves from
  //     the same connection list and folder service as every other live board.
  const owned = await window.evaluate(async created => {
    const list = await window.praxis.connection.list();
    return list.find(candidate => candidate.settings.projectId === created.id);
  }, project);
  expect(owned, 'the project should own a connection row').toBeTruthy();
  expect(owned!.mode).toBe('folder');
  expect(owned!.settings.source).toBe('folder');
  expect(owned!.settings.roots).toEqual([project.workspaceFolder]);

  // 3. The project's own board serves the folder's plans, under the project key.
  const details = await window.evaluate(async created => {
    const connection = (await window.praxis.connection.list()).find(
      candidate => candidate.settings.projectId === created.id
    );
    const boards = await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' });
    const board = boards.find(candidate => candidate.connectionId === connection?.id);
    return board ? window.praxis.board.get(board) : undefined;
  }, project);

  expect(details, 'the project board should be listed').toBeTruthy();
  expect(details!.board.connectionId).toBe(owned!.id);
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
  }, repoCopy);

  expect(project.storage).toBe('app');
  expect(project.workItems).toHaveLength(1);
});

test('a broken-era project record heals to folder-backed at startup', async () => {
  // Reproduces the reported stale state: a project created before
  // `ProjectRecord.storage` existed — no storage field, a folder full of
  // plans, zero work items, and the old `project-plans-*` companion link that
  // made the sidebar hide the project's own board.
  await closeTestApp(app!);

  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-heal-'));
  const plans = path.join(dataDir, 'fixture-plans');
  const featureDir = path.join(plans, 'features', 'feature-01-legacy');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'feature.md'),
    '# Legacy Feature\n\n**Type:** Feature\n**Status:** Backlog\n');

  const legacy = {
    id: 'legacy-1', name: 'Legacy Project', key: 'LEG', type: 'software',
    purpose: '', brief: {}, workspaceFolder: plans,
    workflowStages: [{ id: 's1', name: 'Backlog' }, { id: 's2', name: 'Done' }],
    defaultBoardId: 'legacy-1-board', workItems: [],
    linkedBoards: [{ connectionId: 'project-plans-legacy-1', boardId: 'folder-leg', displayName: 'Legacy plans' }],
    defaultAiToolMode: 'full',
    createdAt: new Date().toISOString(), updatedAt: new Date().toISOString()
  };
  fs.writeFileSync(path.join(dataDir, 'projects.json'),
    JSON.stringify({ 'praxis.projects.v1': [legacy] }, null, 2));

  const settingsPath = path.join(dataDir, 'test-settings.json');
  app = await launchTestApp(
    { connections: [{ id: 'project-plans-legacy-1', name: 'Legacy plans', mode: 'folder', settings: { roots: [plans], projectKey: 'LEG' } }] },
    { userDataDir: dataDir, settingsPath },
    undefined,
    { demoMode: false }
  );
  window = app.window;

  // The heal is fire-and-forget at startup, so poll for the flip.
  await expect.poll(async () =>
    window.evaluate(async () => (await window.praxis.projects.get('legacy-1'))?.storage)
  ).toBe('folder');

  const healed = await window.evaluate(() => window.praxis.projects.get('legacy-1'));
  expect(healed!.linkedBoards).toHaveLength(0);
  const stillThere = await window.evaluate(() =>
    window.praxis.connection.list().then(list => list.some(c => c.id === 'project-plans-legacy-1')));
  expect(stillThere).toBe(false);

  // And the board now actually serves the plans.
  const details = await window.evaluate(async () => {
    const connection = (await window.praxis.connection.list()).find(
      candidate => candidate.settings.projectId === 'legacy-1'
    );
    const boards = await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' });
    const board = boards.find(candidate => candidate.connectionId === connection?.id);
    return board ? window.praxis.board.get(board) : undefined;
  });
  expect(details!.issues.map(issue => issue.summary)).toContain('Legacy Feature');

  // The heal also gives the project a persisted folder connection row.
  const owned = await window.evaluate(async () => {
    const list = await window.praxis.connection.list();
    return list.find(candidate => candidate.settings.projectId === 'legacy-1');
  });
  expect(owned, 'the healed project should own a connection row').toBeTruthy();
  expect(owned!.mode).toBe('folder');
  expect(owned!.settings.source).toBe('folder');

  // And exactly one board, served by that real folder connection.
  const boardIds = await window.evaluate(async () => {
    const boards = await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' });
    const connection = (await window.praxis.connection.list()).find(
      candidate => candidate.settings.projectId === 'legacy-1'
    );
    return boards.filter(board => board.connectionId === connection?.id).map(board => board.id);
  });
  expect(boardIds).toEqual(['folder-leg']);
});
