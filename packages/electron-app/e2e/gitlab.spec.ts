// SPDX-License-Identifier: MIT
//
// e2e spec for the GitLab REST connection flow on the desktop app.
//
// Seeds the per-test settings file (see `launchTestApp`) with a `gitlab`
// connection whose `settings` point at the in-process `mockGitLabApi.ts`
// (an `node:http` server bound to 127.0.0.1:<ephemeral>):
//
//   • `url` — the mock's `baseUrl`, so `GitLabApiService` builds paths like
//     `${baseUrl}/api/v4/projects/${encodeURIComponent(projectPath)}/…`.
//   • `projectPath` — `group/demo`, the path the mock's configured project
//     (id 1) "lives" at. The seed deliberately hard-codes `group/demo` because
//     the fixture in `mockGitLabApi.ts` (see `buildInitialState`) anchors on
//     the same namespace.
//   • `apiKey` — `glpat-test`. Inline `apiKey` in `settings` is a supported
//     fallback to the OS secret store (see `GitLabConfigStore.getGitLabApiKey`),
//     so the spec does not need to seed the secret store.
//
// Assertions deliberately prefer server-side counters and direct DOM access
// over remoted behaviour where possible: the mock's `counters.addIssueNoteHits`
// is the cheapest way to assert "the desktop app sent a POST to the right URL",
// since the IssueDetail panel reloads on success and would mask an upstream
// issue by showing the caption that came back from the mock anyway.
//
// Status: forward-looking. The desktop app's GitLab backend lands in a
// later phase (see `packages/electron-app/src/main/serviceRegistry.ts` — gitlab
// falls through to `StubBackendService` for now). These tests are kept here so
// the spec, the mock, and the seeding shape stay in sync against the
// `GitLabApiService` contract — when the wiring lands, the suite starts passing
// without further edits.

import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGitLabApi, type MockGitLabServer } from './mockGitLabApi';

let app: TestApp | undefined;
let mock: MockGitLabServer | undefined;
let window: Page;
let baseUrl: string;

test.beforeEach(async () => {
  mock = await startMockGitLabApi();
  baseUrl = mock.baseUrl;
  app = await launchTestApp(seededSettings(baseUrl, 'group/demo'));
  window = app.window;
});

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
});

/**
 * Build the seed `settings.json` payload. Matches the connection shape
 * `packages/electron-app/src/main/connectionStoreInstance.ts` expects:
 * `{ id, name, mode, settings }`. `apiKey` lives inline in `settings` —
 * the host adapter that feeds `GitLabApiConfig.token` reads it from there
 * before falling back to the secret store (see `GitLabConfigStore`).
 */
function seededSettings(url: string, projectPath: string): Record<string, unknown> {
  return {
    connections: [
      {
        id: 'mock-gitlab-rest',
        name: 'Mock GitLab',
        mode: 'gitlab',
        settings: {
          url,
          projectPath,
          apiKey: 'glpat-test'
        }
      }
    ]
  };
}

/** Open the connections panel and select the seeded gitlab connection. */
async function openSeededConnection(): Promise<void> {
  await window.locator('[data-testid="nav-connections"]').click();
  const row = window.locator('[data-testid="connection-row"]', {
    hasText: 'Mock GitLab'
  });
  await expect(row).toBeVisible();
  await row.click();
  await expect(window.locator('[data-testid="conn-form"]')).toBeVisible();
}

test('test connection against the mock REST server reports success', async () => {
  await openSeededConnection();

  // `GitLabBoardService.checkConnection` resolves the project's boards and
  // composes an `OK` message containing the project's `path_with_namespace`
  // and the number of boards it found. The mock reports a single board with
  // id 7 named "Demo Board".
  await window.locator('[data-testid="conn-test-btn"]').click();

  const result = window.locator('[data-testid="conn-test-result"]');
  await expect(result).toBeVisible();
  // The status badge from `ConnectionForm.tsx` uppercases `testResult.status`;
  // anything other than "OK" is a wiring or fixture mismatch.
  await expect(result).toContainText('OK');
  // Hits `getProject` once during project resolution and again during the
  // boards-for-project pass — assert at least one hit to confirm we drove
  // the mock (and not, for example, a cached stub response).
  expect(mock?.counters.getProjectHits ?? 0).toBeGreaterThanOrEqual(1);
  expect(mock?.counters.listBoardsHits ?? 0).toBeGreaterThanOrEqual(1);
});

test('board picker lists the boards the mock REST server reports', async () => {
  await openSeededConnection();

  // GitLab is `supportsManualBoardSelection('gitlab')` true, so the picker
  // button renders on the conn-form — same selector as jira.
  await expect(window.locator('[data-testid="conn-pick-boards-btn"]')).toBeVisible();
  await window.locator('[data-testid="conn-pick-boards-btn"]').click();

  const picker = window.locator('[data-testid="board-picker"]');
  await expect(picker).toBeVisible();
  // Mock returns one "Demo Board" entry — no empty-state placeholder should
  // appear (the stub, in contrast, returns no boards and would show this).
  await expect(window.locator('[data-testid="board-picker-empty"]')).toHaveCount(0);
  await expect(
    window.locator('[data-testid="board-picker-row"]', { hasText: 'Demo Board' })
  ).toBeVisible();
});

test('tracked board renders issue cards and accepts a new comment via the mock', async () => {
  await openSeededConnection();

  // The board-picker row uses the board name as the only specific selector;
  // there is exactly one board in the mock's listBoards response.
  await window.locator('[data-testid="conn-pick-boards-btn"]').click();
  const pickerRow = window.locator('[data-testid="board-picker-row"]', { hasText: 'Demo Board' });
  await expect(pickerRow).toBeVisible();
  await pickerRow.locator('input[type="checkbox"]').check();
  await window.locator('[data-testid="board-picker-save"]').click();

  // Saving in the conn-form chain calls `onSaved('boards')`; the parent
  // hides the form and surfaces the connections panel. To see the board we
  // switch to the Boards nav (the sidebar entry labelled "Boards"), which
  // refreshes `boards` and reveals the now-tracked "Demo Board" entry.
  const navItem = window.locator('[data-testid="board-nav-item"]', { hasText: 'Demo Board' });
  await expect(navItem).toBeVisible();
  await navItem.click();

  // `getBoardDetails` resolves the full board view including the two label
  // list columns and the Backlog/Closed columns — five columns total. Pick
  // the first issue card in any column and assert it renders.
  const firstIssueCard = window.locator('[data-testid="issue-card"]').first();
  await expect(firstIssueCard).toBeVisible();
  // BoardView.tsx renders the issue key inside a `.issue-card-key` span; the
  // anchor format is `<path>#<iid>` (e.g. `group/demo#1`).
  const issueKey = (await firstIssueCard.locator('.issue-card-key').first().textContent())?.trim() ?? '';
  expect(issueKey).toMatch(/#\d+$/);

  // Open the issue — IssueDetail re-fetches via `issue:get` and renders the
  // header, transitions list, and the "Add comment" textarea.
  await firstIssueCard.click();
  const textarea = window.locator('textarea[placeholder="Add a comment…"]');
  await expect(textarea).toBeVisible();

  const commentBody = `e2e comment from Playwright ${Date.now()}`;
  await textarea.fill(commentBody);
  await window.getByRole('button', { name: 'Add comment' }).click();

  // After write, IssueDetail re-fetches via `issue:get`, which retriggers
  // `getIssue` and `listIssueNotes`. Asserting on the mock's counters means
  // we don't have to wait for the DOM to repaint with the new comment — the
  // mock's view of the world is canonical.
  await expect.poll(() => mock?.counters.addIssueNoteHits ?? 0).toBeGreaterThanOrEqual(1);
  expect(mock?.counters.lastAddedComment?.body).toBe(commentBody);
  // `IssueDetail.reload()` calls `getIssue` and `listIssueNotes` after a
  // successful add — confirm both fired at least once.
  await expect.poll(() => mock?.counters.getIssueHits ?? 0).toBeGreaterThanOrEqual(1);
  await expect.poll(() => mock?.counters.listIssueNotesHits ?? 0).toBeGreaterThanOrEqual(1);

  // GitLab supports summary/description/assignee edits only. The desktop form
  // keeps unsupported controls visibly read-only and sends a changed-field
  // patch, so changing a title cannot be rejected because an untouched Jira
  // or live-folder field leaked into the request.
  await expect(window.locator('[data-testid="issue-edit-priority"]')).toBeDisabled();
  await expect(window.locator('[data-testid="issue-edit-issueType"]')).toBeDisabled();
  const summary = window.locator('[data-testid="issue-edit-summary"]');
  await summary.fill('Updated from the desktop detail pane');
  await window.locator('[data-testid="issue-edit-save-btn"]').click();
  await expect.poll(() => mock?.counters.updateIssueHits ?? 0).toBeGreaterThanOrEqual(1);
  await expect(summary).toHaveValue('Updated from the desktop detail pane');
});
