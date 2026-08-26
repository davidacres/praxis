// e2e spec for the `appearance.showBrandArtwork` setting: when on (the
// default, matching the VS Code extension) sidebar board rows render the
// per-backend brand artwork from `BrandModeIcon`; when off they render the
// generic per-board-type glyphs from `boardMeta`.

import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGitLabApi, type MockGitLabServer } from './mockGitLabApi';

let app: TestApp | undefined;
let mock: MockGitLabServer | undefined;
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

test('board list shows brand artwork by default', async () => {
  // No appearance seed — the shipped default is showBrandArtwork: true.
  app = await launchTestApp();
  window = app.window;

  await window.locator('[data-testid="nav-board"]').click();

  // The built-in demo boards are always present; with brand artwork on they
  // carry the demo brand mark instead of the Scrum/Kanban type glyph.
  const demoRow = window.locator('[data-testid="board-nav-item"]', { hasText: 'Application Board' });
  await expect(demoRow).toBeVisible();
  await expect(
    demoRow.locator('[data-testid="board-brand-icon"][data-mode="demo"]')
  ).toBeVisible();
});

test('seeded off, board rows use the generic board-type icons', async () => {
  app = await launchTestApp({ appearance: { showBrandArtwork: false } });
  window = app.window;

  await window.locator('[data-testid="nav-board"]').click();

  const demoRow = window.locator('[data-testid="board-nav-item"]', { hasText: 'Application Board' });
  await expect(demoRow).toBeVisible();
  await expect(window.locator('[data-testid="board-brand-icon"]')).toHaveCount(0);
  // The generic glyph still renders (an svg inside the row's tree-icon span).
  await expect(demoRow.locator('.tree-icon svg').first()).toBeVisible();
});

test('toggling the Board Settings artwork option swaps board icons live', async () => {
  app = await launchTestApp();
  window = app.window;

  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance"]').click();

  const toggle = window.getByRole('switch', { name: 'Brand artwork in board list' });
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');

  // Off: the push channel re-renders the sidebar without a reload.
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'false');
  await window.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();
  await window.locator('[data-testid="nav-board"]').click();
  await expect(window.locator('[data-testid="board-brand-icon"]')).toHaveCount(0);

  // Back on.
  await window.locator('[data-testid="titlebar-settings"]').click();
  await window.locator('[data-testid="settings-nav-appearance"]').click();
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-checked', 'true');
  await window.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();
  await window.locator('[data-testid="nav-board"]').click();
  await expect(
    window.locator('[data-testid="board-brand-icon"][data-mode="demo"]').first()
  ).toBeVisible();
});

test('a GitLab board row carries the GitLab brand mark', async () => {
  mock = await startMockGitLabApi();
  app = await launchTestApp({
    connections: [
      {
        id: 'mock-gitlab-rest',
        name: 'Mock GitLab',
        mode: 'gitlab',
        settings: {
          url: mock.baseUrl,
          projectPath: 'group/demo',
          apiKey: 'glpat-test'
        }
      }
    ],
    // Track the mock's one board ("Demo Board", id 7) so it lists in the sidebar.
    boards: [{ connectionId: 'mock-gitlab-rest', boardId: '7' }]
  });
  window = app.window;

  await window.locator('[data-testid="nav-board"]').click();

  const row = window.locator('[data-testid="board-nav-item"]', { hasText: 'Demo Board' });
  await expect(row).toBeVisible();
  await expect(
    row.locator('[data-testid="board-brand-icon"][data-mode="gitlab"]')
  ).toBeVisible();
});
