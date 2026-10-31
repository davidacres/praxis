import * as fs from 'node:fs';
import { listedBoards, openBoard } from './navigation';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import type { Page } from 'playwright';
import { launchTestApp, closeTestApp, expandAllIssueStacks, type TestApp } from './launchTestApp';

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
  const boards = await listedBoards(window);
  expect(boards.filter(name => name === 'E2E Multi')).toHaveLength(1);
  expect(boards.filter(name => /^proj-(alpha|beta)$/.test(name))).toHaveLength(1);
});

test('each board shows only its own root’s issues', async () => {
  await launchWithMultiRootFixture();


  // Two roots, two boards. The primary carries the connection's project name;
  // the extra is named for its own folder. Which root is promoted to primary
  // depends on readdir order, so pick whichever extra is present.
  const boards = await listedBoards(window);
  expect(boards.filter(name => name === 'E2E Multi')).toHaveLength(1);
  const extraIsBeta = boards.includes('proj-beta');
  const extraBoard = extraIsBeta ? /^proj-beta$/ : /^proj-alpha$/;
  const extraOwnTitle = extraIsBeta ? 'Beta task card' : 'Alpha task card';
  const otherTitle = extraIsBeta ? 'Alpha task card' : 'Beta task card';

  // Click the extra. It must show its own root's cards and not the other's.
  // (A folder board renders the feature AND its tasks as cards.)
  await openBoard(window, extraBoard);
  await expandAllIssueStacks(window);
  await expect(window.locator('[data-testid="issue-card"]', { hasText: extraOwnTitle })).toBeVisible();
  await expect(window.locator('[data-testid="issue-card"]', { hasText: otherTitle })).toHaveCount(0);

  // Click the primary. It must show the OTHER root's cards (the extra
  // already covers the extra's root, and the two boards do not share plans
  // roots): that root's feature card plus its task card — two cards.
  const otherFeature = extraIsBeta ? 'Alpha Feature' : 'Beta Feature';
  const extraOwnFeature = extraIsBeta ? 'Beta Feature' : 'Alpha Feature';
  await openBoard(window, /^E2E Multi$/);
  await expandAllIssueStacks(window);
  const primaryCards = window.locator('[data-testid="issue-card"]');
  await expect(primaryCards).toHaveCount(2);
  const primaryTexts = await primaryCards.allInnerTexts();
  expect(primaryTexts.some(text => text.includes(otherTitle))).toBe(true);
  expect(primaryTexts.some(text => text.includes(otherFeature))).toBe(true);
  expect(primaryTexts.some(text => text.includes(extraOwnTitle))).toBe(false);
  expect(primaryTexts.some(text => text.includes(extraOwnFeature))).toBe(false);
});

test('a secondary plans root disables New issue up front and says why', async () => {
  await launchWithMultiRootFixture();

  await openBoard(window, /^E2E Multi$/);
  await expect(window.locator('[data-testid="board-new-issue-btn"]')).toBeEnabled();

  await openBoard(window, /^proj-(alpha|beta)$/);
  const newIssue = window.locator('[data-testid="board-new-issue-btn"]');
  await expect(newIssue).toBeDisabled();
  await expect(newIssue).toHaveAttribute('title', /specific plans root is not supported yet.*primary board/);
});
