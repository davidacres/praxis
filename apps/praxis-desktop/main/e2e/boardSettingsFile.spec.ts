import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

/**
 * `board.praxis.json` — per-plans-folder board settings. Praxis both honours the
 * file on read and writes it back so a board's identity travels with its folder.
 */

let app: TestApp | undefined;
let folder: string | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (folder) {
    fs.rmSync(folder, { recursive: true, force: true });
    folder = undefined;
  }
});

/** A minimal plans folder: one feature with one task. */
function writePlansFolder(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-boardcfg-e2e-'));
  const featureDir = path.join(dir, 'features', 'feature-01-demo');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(
    path.join(featureDir, 'feature.md'),
    ['# Demo Feature', '', '**Status:** 📋 Proposed', '**Type:** Feature', '', '## Description', '', 'Demo.', ''].join('\n')
  );
  fs.writeFileSync(
    path.join(featureDir, 'task-01-01-do-it.md'),
    ['# Do it', '', '**Status:** 📋 Proposed', '**Type:** Task', '', '## Description', '', 'Do it.', '', '## Comments', ''].join('\n')
  );
  return dir;
}

function readConfig(dir: string): Record<string, unknown> {
  return JSON.parse(fs.readFileSync(path.join(dir, 'board.praxis.json'), 'utf8'));
}

test('creating a user-workspace board writes board.praxis.json into the plans folder', async () => {
  folder = writePlansFolder();
  app = await launchTestApp({
    connections: [{ id: 'e2e-uw', name: 'E2E UW', mode: 'userworkspace', settings: {} }]
  });
  const win = app.window;

  const board = await win.evaluate(async liveFolderPath => {
    return window.praxis.userWorkspace.createBoard('e2e-uw', {
      name: 'Widgets',
      projectKey: 'WIDG',
      projectName: 'Widgets Project',
      liveFolderPath
    });
  }, folder);
  expect(board.projectKey).toBe('WIDG');

  expect(fs.existsSync(path.join(folder, 'board.praxis.json'))).toBe(true);
  // Create seeds identity only — allowIssueCreation stays an app-wide toggle here.
  expect(readConfig(folder)).toEqual({ projectKey: 'WIDG', projectName: 'Widgets Project' });
});

test('editing a live-folder connection re-syncs board.praxis.json', async () => {
  folder = writePlansFolder();
  // Pre-seed a stale file so we can prove the edit overwrites it.
  fs.writeFileSync(
    path.join(folder, 'board.praxis.json'),
    JSON.stringify({ projectKey: 'OLD', projectName: 'Old Name' }, null, 2)
  );
  app = await launchTestApp({
    connections: [
      {
        id: 'e2e-lf',
        name: 'E2E LF',
        mode: 'livefolder',
        settings: { path: folder, projectKey: 'OLD', projectName: 'Old Name', allowIssueCreation: false }
      }
    ]
  });
  const win = app.window;

  // Load the board once so the service exists, then edit the connection.
  await win.evaluate(async folderPath => {
    await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' }, 'e2e-lf');
    await window.praxis.connection.update({
      id: 'e2e-lf',
      name: 'E2E LF',
      mode: 'livefolder',
      settings: { path: folderPath, projectKey: 'NEW', projectName: 'New Name', allowIssueCreation: true }
    });
  }, folder);

  await expect.poll(() => readConfig(folder!)).toEqual({
    projectKey: 'NEW',
    projectName: 'New Name',
    allowIssueCreation: true
  });
});
