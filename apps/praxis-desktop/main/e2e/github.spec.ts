// SPDX-License-Identifier: MIT
//
// e2e spec for the GitHub REST connection flow on the desktop app (FX-BE-035).
//
// Follows `gitlab.spec.ts`'s pattern: seeds the per-test settings file with a
// `github` connection whose `settings` point at the in-process
// `mockGitHubApi.ts` server, `pat` inline (the fallback
// `GitHubConfigStore.getGitHubApiKey()` reads before the OS secret store —
// necessary here because `connection:setSecret` needs `safeStorage`, which
// this sandbox has no keychain backend for; see AGENTS.md).
//
// GitHub is `autoSynthesizesBoard('github')` — one repository is one board,
// same "no picker" model as folder/demo — so unlike GitLab's manually-tracked
// board, the seed also writes the `boards` (tracked-board) entry directly,
// the same shape `syncSynthesizedTrackedBoard` would write on a real save.

import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGitHubApi, type MockGitHubServer } from './mockGitHubApi';
import { chooseOption } from './chipSelect';

const OWNER = 'octocat';
const REPO = 'demo';
const CONNECTION_ID = 'mock-github-rest';

let app: TestApp | undefined;
let mock: MockGitHubServer | undefined;
let window: Page;

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

function seededSettings(url: string, options?: { allowIssueCreation?: boolean }): Record<string, unknown> {
  return {
    connections: [
      {
        id: CONNECTION_ID,
        name: 'Mock GitHub',
        mode: 'github',
        settings: {
          url,
          owner: OWNER,
          repo: REPO,
          pat: 'ghp-test',
          ...(options?.allowIssueCreation ? { allowIssueCreation: true } : {})
        }
      }
    ],
    boards: [
      {
        connectionId: CONNECTION_ID,
        boardId: `github:${OWNER}/${REPO}`,
        displayName: `${OWNER}/${REPO}`
      }
    ]
  };
}

async function launchWithGitHubConnection(options?: { allowIssueCreation?: boolean }): Promise<void> {
  mock = await startMockGitHubApi({ owner: OWNER, repo: REPO });
  app = await launchTestApp(seededSettings(mock.baseUrl, options));
  window = app.window;
}

async function openSeededConnection(): Promise<void> {
  await window.locator('[data-testid="nav-connections"]').click();
  const row = window.locator('[data-testid="connection-row"]', { hasText: 'Mock GitHub' });
  await expect(row).toBeVisible();
  await row.click();
  await expect(window.locator('[data-testid="conn-form"]')).toBeVisible();
}

async function openBoard(): Promise<void> {
  const boardItem = window.locator('[data-testid="board-nav-item"]', { hasText: `${OWNER}/${REPO}` });
  await expect(boardItem).toBeVisible();
  await boardItem.click();
}

test('test connection against the mock REST server reports success', async () => {
  await launchWithGitHubConnection();
  await openSeededConnection();
  await window.locator('[data-testid="conn-test-btn"]').click();

  const result = window.locator('[data-testid="conn-test-result"]');
  await expect(result).toBeVisible();
  await expect(result).toContainText('OK');
  // Two "status: …" labels are seeded; checkConnection reports the count.
  await expect(result).toContainText('2 status column');
  expect(mock?.counters.getRepoHits ?? 0).toBeGreaterThanOrEqual(1);
  expect(mock?.counters.listLabelsHits ?? 0).toBeGreaterThanOrEqual(1);
  await window.screenshot({ path: 'output/playwright/github-connection-form.png', fullPage: true });
});

test('board renders every synthesized column with its issue', async () => {
  await launchWithGitHubConnection();
  await openBoard();

  // Backlog (no status label), Doing, Review, Closed — one issue in each.
  await expect(window.locator('[data-testid="issue-card"]', { hasText: 'Backlog candidate' })).toBeVisible();
  await expect(window.locator('[data-testid="issue-card"]', { hasText: 'Wire GitHub token setup' })).toBeVisible();
  await expect(window.locator('[data-testid="issue-card"]', { hasText: 'Polish board rendering' })).toBeVisible();
  await expect(window.locator('[data-testid="issue-card"]', { hasText: 'Close stale migration issue' })).toBeVisible();
  expect(mock?.counters.listIssuesHits ?? 0).toBeGreaterThanOrEqual(1);
  await window.screenshot({ path: 'output/playwright/github-board.png', fullPage: true });
});

test('adding a comment and editing summary round-trips through the mock', async () => {
  await launchWithGitHubConnection();
  await openBoard();
  await window.locator('[data-testid="issue-card"]', { hasText: 'Backlog candidate' }).click();

  const textarea = window.locator('textarea[placeholder="Add a comment…"]');
  await expect(textarea).toBeVisible();
  const commentBody = `e2e comment from Playwright ${Date.now()}`;
  await textarea.fill(commentBody);
  await window.getByRole('button', { name: 'Add comment' }).click();

  await expect.poll(() => mock?.counters.addIssueCommentHits ?? 0).toBeGreaterThanOrEqual(1);
  expect(mock?.counters.lastAddedComment?.body).toBe(commentBody);
  await expect.poll(() => mock?.counters.getIssueHits ?? 0).toBeGreaterThanOrEqual(1);
  await expect.poll(() => mock?.counters.listIssueCommentsHits ?? 0).toBeGreaterThanOrEqual(1);

  // GitHub supports summary/description/assignee edits only, same three
  // fields as GitLab — never labels or milestone through this panel (those
  // move only via board drag-drop transitions).
  await expect(window.locator('[data-testid="issue-edit-priority"]')).toBeDisabled();
  await expect(window.locator('[data-testid="issue-edit-issueType"]')).toBeDisabled();
  const summary = window.locator('[data-testid="issue-edit-summary"]');
  await summary.fill('Updated from the desktop detail pane');
  await window.locator('[data-testid="issue-edit-save-btn"]').click();
  await expect.poll(() => mock?.counters.updateIssueHits ?? 0).toBeGreaterThanOrEqual(1);
  await expect(summary).toHaveValue('Updated from the desktop detail pane');
});

test('moving a card to a status column adds the label and preserves unrelated labels', async () => {
  await launchWithGitHubConnection();
  await openBoard();
  // Issue 2 carries "status: Review" + the unrelated "bug" label.
  await window.locator('[data-testid="issue-card"]', { hasText: 'Polish board rendering' }).click();

  const status = window.locator('[data-testid="issue-edit-status"]');
  await chooseOption(status, { label: 'Doing' });
  await window.locator('[data-testid="issue-edit-save-btn"]').click();
  await expect(status.locator('.chip-select-label')).toHaveText('Doing');

  await expect.poll(() => mock?.counters.lastUpdatedIssue?.labels).toEqual(['bug', 'status: Doing']);
});

test('issue creation is disabled until the connection allows it', async () => {
  await launchWithGitHubConnection();
  await openBoard();

  const button = window.locator('[data-testid="board-new-issue-btn"]');
  await expect(button).toBeVisible();
  await expect(button).toBeDisabled();
  await expect(button).toHaveAttribute('title', /Allow issue creation/);
});

test('issue creation round-trips a new issue once enabled', async () => {
  await launchWithGitHubConnection({ allowIssueCreation: true });
  await openBoard();

  await window.locator('[data-testid="board-new-issue-btn"]').click();
  await expect(window.locator('[data-testid="new-issue-page"]')).toBeVisible();
  await window.locator('[data-testid="new-issue-summary"]').fill('Created from the desktop app');
  await window.locator('[data-testid="new-issue-submit"]').click();

  await expect.poll(() => mock?.counters.createIssueHits ?? 0).toBeGreaterThanOrEqual(1);
  await expect(window.locator('[data-testid="issue-card"]', { hasText: 'Created from the desktop app' })).toBeVisible();
});
