// SPDX-License-Identifier: MIT
//
// e2e spec for the user-workspace connection flow on the desktop app.
//
// Seeds a single `userworkspace` connection into the per-test settings file
// (see `launchTestApp.ts`) and drives the create-board wizard it surfaces in
// the connections UI. Two filesystem fixtures are used:
//
//   - `workspaceDir`  — a temp dir laid out like a real plans folder, with
//                       one feature under `features/feature-01-demo-feature/`
//                       and one child task, mirroring `liveFolder.spec.ts`'s
//                       `writeFixtureLiveFolder`. Discovery on this dir must
//                       yield exactly one plans root, so the wizard completes
//                       selection and submits in tests 1 and 2.
//   - `emptyDir`      — a fresh temp dir with no `features/` child, used by
//                       test 3 to assert the empty-state branch.
//
// Per-test isolation: `launchTestApp` points both `--user-data-dir` and
// `TICKET_MANAGER_SETTINGS_PATH` at throwaway paths inside a fresh tmp dir,
// so the connection list and the `userWorkspace.json` board store cannot
// leak between tests.

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
let window: Page;
let workspaceDir: string;
let emptyDir: string;

const CONNECTION_NAME = 'E2E User Workspace';
const CONNECTION_ID = 'e2e-userworkspace';
const BOARD_NAME = 'E2E UW Board';
const PROJECT_KEY = 'UW1';

/** Same fixture shape as liveFolder.spec.ts — one feature with one task. */
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

test.beforeEach(async () => {
  workspaceDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-manager-uw-'));
  writeFixtureLiveFolder(workspaceDir);
  emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ticket-manager-uw-empty-'));

  app = await launchTestApp({
    connections: [
      {
        id: CONNECTION_ID,
        name: CONNECTION_NAME,
        mode: 'userworkspace',
        settings: {}
      }
    ]
  });
  window = app.window;
});

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (workspaceDir) {
    fs.rmSync(workspaceDir, { recursive: true, force: true });
  }
  if (emptyDir) {
    fs.rmSync(emptyDir, { recursive: true, force: true });
  }
});

/**
 * Drives the create-board wizard to completion against the given plans
 * folder, using the board name and project key passed in. Opens the
 * connections page, selects the seeded connection, opens the wizard,
 * discovers the folder, picks the single plans root, fills the form, and
 * submits.
 */
async function createBoardViaWizard(folderPath: string, boardName: string, projectKey: string): Promise<void> {
  await window.locator('[data-testid="nav-connections"]').click();
  await window.locator('[data-testid="connection-row"]', { hasText: CONNECTION_NAME }).click();

  await expect(window.locator('[data-testid="conn-boards"]')).toBeVisible();
  await window.locator('[data-testid="uw-create-board-btn"]').click();
  await expect(window.locator('[data-testid="uw-wizard"]')).toBeVisible();

  await window.locator('[data-testid="uw-wizard-folder-input"]').fill(folderPath);
  await window.locator('[data-testid="uw-wizard-discover-btn"]').click();

  // The fixture lays out exactly one plans root, so there is exactly one row
  // to click. Discovery reads from the real filesystem, so the fixture dir
  // must already exist on disk when the button is clicked.
  const planRootRow = window.locator('[data-testid="uw-plan-root-row"]');
  await expect(planRootRow).toHaveCount(1);
  await planRootRow.click();

  await window.locator('[data-testid="uw-field-name"]').fill(boardName);
  await window.locator('[data-testid="uw-field-projectKey"]').fill(projectKey);
  await window.locator('[data-testid="uw-wizard-submit-btn"]').click();

  // Wizard closes on success; the new board row appears under conn-boards.
  await expect(window.locator('[data-testid="uw-wizard"]')).toHaveCount(0);
  await expect(
    window.locator('[data-testid="uw-board-row"]', { hasText: boardName })
  ).toBeVisible();
}

test('creating a workspace board through the wizard lists it and shows it in the sidebar', async () => {
  await createBoardViaWizard(workspaceDir, BOARD_NAME, PROJECT_KEY);

  // The boards section row carries the project key on its meta line.
  await expect(window.locator('[data-testid="uw-board-row"]', { hasText: BOARD_NAME })).toContainText(
    PROJECT_KEY
  );

  // The board also surfaces in the sidebar nav and its cards render.
  await window.locator('[data-testid="nav-board"]').click();
  await expect(window.locator('[data-testid="board-nav-item"]', { hasText: BOARD_NAME })).toBeVisible();

  await window.locator('[data-testid="board-nav-item"]', { hasText: BOARD_NAME }).click();
  await expect(window.locator('[data-testid="issue-card"]', { hasText: 'Do the thing' })).toBeVisible();
});

test('deleting a workspace board removes it', async () => {
  await createBoardViaWizard(workspaceDir, BOARD_NAME, PROJECT_KEY);

  const boardRow = window.locator('[data-testid="uw-board-row"]', { hasText: BOARD_NAME });
  await boardRow.locator('[data-testid="uw-board-delete-btn"]').click();

  await expect(boardRow).toHaveCount(0);

  // Sidebar entry is gone too.
  await window.locator('[data-testid="nav-board"]').click();
  await expect(window.locator('[data-testid="board-nav-item"]', { hasText: BOARD_NAME })).toHaveCount(0);
});

test('discovering under a folder without plans folders shows the empty state', async () => {
  await window.locator('[data-testid="nav-connections"]').click();
  await window.locator('[data-testid="connection-row"]', { hasText: CONNECTION_NAME }).click();

  await expect(window.locator('[data-testid="conn-boards"]')).toBeVisible();
  await window.locator('[data-testid="uw-create-board-btn"]').click();
  await expect(window.locator('[data-testid="uw-wizard"]')).toBeVisible();

  await window.locator('[data-testid="uw-wizard-folder-input"]').fill(emptyDir);
  await window.locator('[data-testid="uw-wizard-discover-btn"]').click();

  // No plans roots under an empty dir, so the empty state surfaces instead
  // of any plan-root rows.
  await expect(window.locator('[data-testid="uw-wizard-empty"]')).toBeVisible();
  await expect(window.locator('[data-testid="uw-plan-root-row"]')).toHaveCount(0);

  await window.locator('[data-testid="uw-wizard-cancel-btn"]').click();
  await expect(window.locator('[data-testid="uw-wizard"]')).toHaveCount(0);
});
