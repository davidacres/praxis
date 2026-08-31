import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp;
let window: Page;

test.beforeEach(async () => {
  // Seeded into the per-test settings file (see launchTestApp.ts) — the real
  // shared settings file is never touched.
  app = await launchTestApp({
    connections: [
      {
        id: 'dead-folder',
        name: 'dead-folder',
        mode: 'folder',
        settings: { path: path.join(os.tmpdir(), 'praxis-does-not-exist-9f3a') }
      }
    ]
  });
  window = app.window;
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('an unreachable connection is skipped instead of blanking the board list', async () => {
  // The demo boards must still be listed even though one connection throws.
  const boardItems = window.locator('[data-testid="board-nav-item"]');
  await expect(boardItems.first()).toBeVisible();
  await boardItems.first().click();
  await expect(window.locator('[data-testid="issue-card"]').first()).toBeVisible();
});
