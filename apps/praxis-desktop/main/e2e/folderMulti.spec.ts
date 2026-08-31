import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

// Mirrors the markdown shape used by liveFolder.spec.ts: one feature with
// `**Status:**` front matter and one child task. Two distinct task titles
// ("Alpha task card" / "Beta task card") let assertions distinguish which
// plans root a given board is showing.
function writeFixtureMultiRoot(parent: string): void {
  const projects = [
    {
      folder: 'proj-alpha',
      featureTitle: '# Alpha Feature',
      taskFile: 'task-01-01-alpha-task.md',
      taskTitle: '# Alpha task card',
      taskDescription: 'Alpha task description for e2e.'
    },
    {
      folder: 'proj-beta',
      featureTitle: '# Beta Feature',
      taskFile: 'task-01-01-beta-task.md',
      taskTitle: '# Beta task card',
      taskDescription: 'Beta task description for e2e.'
    }
  ];
  for (const project of projects) {
    const featureDir = path.join(parent, project.folder, 'features', `feature-01-${project.folder}-work`);
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(
      path.join(featureDir, 'feature.md'),
      [
        project.featureTitle,
        '',
        '**Status:** 📋 Proposed',
        '**Type:** Feature',
        '',
        '## Description',
        '',
        `${project.folder} feature for e2e multi-root testing.`,
        ''
      ].join('\n')
    );
    fs.writeFileSync(
      path.join(featureDir, project.taskFile),
      [
        project.taskTitle,
        '',
        '**Status:** 📋 Proposed',
        '**Type:** Task',
        '',
        '## Description',
        '',
        project.taskDescription,
        '',
        '## Comments',
        ''
      ].join('\n')
    );
  }
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

async function launchWithMultiRootFixture(): Promise<void> {
  parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-multi-'));
  writeFixtureMultiRoot(parentDir);
  app = await launchTestApp({
    connections: [
      {
        id: 'e2e-multi-root',
        name: 'e2e-multi-root',
        mode: 'folder',
        settings: {
          path: parentDir,
          projectKey: 'E2EM',
          projectName: 'E2E Multi',
          allowIssueCreation: true
        }
      }
    ]
  });
  window = app.window;
}

test('a parent folder with two plans roots lists one board per root', async () => {
  await launchWithMultiRootFixture();


  // The primary root takes the connection's own project name; every other
  // discovered root is named for itself, so the two are distinguishable.
  const primary = window
    .locator('[data-testid="board-nav-item"]')
    .getByText('E2E Multi', { exact: true });
  await expect(primary).toHaveCount(1);

  const extra = window.locator('[data-testid="board-nav-item"]', {
    hasText: /^proj-(alpha|beta)$/
  });
  await expect(extra).toHaveCount(1);
});

test('each board shows only its own root’s issues', async () => {
  await launchWithMultiRootFixture();


  // Two roots, two boards. The primary carries the connection's project name;
  // the extra is named for its own folder. Which root is promoted to primary
  // depends on readdir order, so pick whichever extra is present.
  const primary = window
    .locator('[data-testid="board-nav-item"]')
    .getByText('E2E Multi', { exact: true });
  const betaExtra = window.locator('[data-testid="board-nav-item"]', { hasText: /^proj-beta$/ });
  const alphaExtra = window.locator('[data-testid="board-nav-item"]', { hasText: /^proj-alpha$/ });

  await expect(primary).toHaveCount(1);
  const extraIsBeta = (await betaExtra.count()) === 1;
  const extraBoard = extraIsBeta ? betaExtra : alphaExtra;
  const extraOwnTitle = extraIsBeta ? 'Beta task card' : 'Alpha task card';
  const otherTitle = extraIsBeta ? 'Alpha task card' : 'Beta task card';

  // Click the extra. It must show its own root's cards and not the other's.
  // (A folder board renders the feature AND its tasks as cards.)
  await extraBoard.click();
  await expect(window.locator('[data-testid="issue-card"]', { hasText: extraOwnTitle })).toBeVisible();
  await expect(window.locator('[data-testid="issue-card"]', { hasText: otherTitle })).toHaveCount(0);

  // Click the primary. It must show the OTHER root's cards (the extra
  // already covers the extra's root, and the two boards do not share plans
  // roots): that root's feature card plus its task card — two cards.
  const otherFeature = extraIsBeta ? 'Alpha Feature' : 'Beta Feature';
  const extraOwnFeature = extraIsBeta ? 'Beta Feature' : 'Alpha Feature';
  await primary.click();
  const primaryCards = window.locator('[data-testid="issue-card"]');
  await expect(primaryCards).toHaveCount(2);
  const primaryTexts = await primaryCards.allInnerTexts();
  expect(primaryTexts.some(text => text.includes(otherTitle))).toBe(true);
  expect(primaryTexts.some(text => text.includes(otherFeature))).toBe(true);
  expect(primaryTexts.some(text => text.includes(extraOwnTitle))).toBe(false);
  expect(primaryTexts.some(text => text.includes(extraOwnFeature))).toBe(false);
});
