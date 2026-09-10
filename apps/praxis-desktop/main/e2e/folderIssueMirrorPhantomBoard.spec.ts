import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

/**
 * Reproduces the shape of a real-world "multi-AI issue mirror" export sitting
 * alongside a real plans root: every feature folder carries `feature-issues.md`
 * instead of `feature.md` (so it never matches as a feature root), and only
 * one story out of the whole feature happens to carry a recognized
 * `**Type:**` line. Before the fix, `discoverPlanFolders` would walk past the
 * unmatched feature folder into its `stories/` subfolder and accept THAT as
 * its own board, named after the folder itself — "stories" — once per
 * feature. See `markdownPlanParser.ts`'s `allowStandaloneChildItems`.
 */
function writeFixture(parent: string): void {
  const plansFeature = path.join(parent, 'docs', 'plans', 'features', 'feature-01-real');
  fs.mkdirSync(plansFeature, { recursive: true });
  fs.writeFileSync(
    path.join(plansFeature, 'feature.md'),
    ['# Real feature', '', '**Status:** 📋 Proposed', '**Type:** Feature', ''].join('\n')
  );

  const mirrorFeature = path.join(parent, 'docs', 'issues', 'features', 'fx-bf-999-example');
  const storyA = path.join(mirrorFeature, 'stories', 'fx-be-001-untyped');
  const storyB = path.join(mirrorFeature, 'stories', 'fx-be-002-typed');
  fs.mkdirSync(storyA, { recursive: true });
  fs.mkdirSync(storyB, { recursive: true });
  fs.writeFileSync(path.join(mirrorFeature, 'feature-issues.md'), '# Example feature issues\n');
  fs.writeFileSync(path.join(storyA, 'issue.md'), '# FX-BE-001\n\n**Status:** Complete\n');
  fs.writeFileSync(path.join(storyB, 'issue.md'), '# FX-BE-002\n\n**Type:** Story\n**Status:** Complete\n');
}

let app: TestApp | undefined;
let window: Page;
let parentDir: string;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (parentDir) {
    fs.rmSync(parentDir, { recursive: true, force: true });
    parentDir = '';
  }
});

test('an issue-mirror stories/ folder next to a real plans root does not surface as its own board', async () => {
  parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-phantom-board-'));
  writeFixture(parentDir);

  app = await launchTestApp(
    {
      connections: [
        {
          id: 'e2e-issue-mirror',
          name: 'e2e-issue-mirror',
          mode: 'folder',
          settings: {
            path: parentDir,
            projectKey: 'E2EI',
            projectName: 'E2E Issue Mirror',
            allowIssueCreation: true
          }
        }
      ]
    },
    undefined,
    undefined,
    { demoMode: false }
  );
  window = app.window;

  const primary = window
    .locator('[data-testid="board-nav-item"]')
    .getByText('E2E Issue Mirror', { exact: true });
  await expect(primary).toHaveCount(1);

  // The whole point of the fix: no board named after the mirror's stories/
  // folder, and no second board at all — only the one real plans root.
  const phantom = window.locator('[data-testid="board-nav-item"]', { hasText: /^stories$/ });
  await expect(phantom).toHaveCount(0);
  await expect(window.locator('[data-testid="board-nav-item"]')).toHaveCount(1);
});
