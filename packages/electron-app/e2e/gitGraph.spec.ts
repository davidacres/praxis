import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp;

async function expectHistoryColumnsAligned(window: TestApp['window']) {
  const textLeft = async (selector: string) => window.locator(selector).first().evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getBoundingClientRect().left;
  });
  const headerCells = window.locator('.git-history-header > span');
  expect(Math.abs(await textLeft('.git-history-header > span:nth-child(2)') - await textLeft('.git-commit-message strong'))).toBeLessThanOrEqual(1);
  expect(Math.abs(await textLeft('.git-history-header > span:nth-child(3)') - await textLeft('.git-commit-author'))).toBeLessThanOrEqual(1);
  expect(Math.abs(await textLeft('.git-history-header > span:nth-child(4)') - await textLeft('.git-commit-date'))).toBeLessThanOrEqual(1);
  await expect(headerCells).toHaveCount(4);
  const edges = await window.locator('.git-history').evaluate(history => {
    const header = history.querySelector('.git-history-header');
    const row = history.querySelector('.git-commit-row');
    return { headerRight: header?.getBoundingClientRect().right ?? 0, rowRight: row?.getBoundingClientRect().right ?? 0 };
  });
  expect(Math.abs(edges.headerRight - edges.rowRight)).toBeLessThanOrEqual(1);
  expect(await window.locator('.git-history').evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  const dateFits = await window.locator('.git-history').evaluate((history) => {
    const date = history.querySelector('.git-commit-date');
    if (!date) return false;
    return date.getBoundingClientRect().right <= history.getBoundingClientRect().right + 1;
  });
  expect(dateFits).toBe(true);
}

/** Repositories created by a test, removed in afterEach. */
let repositories: string[] = [];

/**
 * A small but structurally complete repository: two branches joined by a real
 * merge commit (so the graph has edges and the "Merges only" filter has
 * something to find) plus an uncommitted edit for the diff and staging flows.
 */
function createFixtureRepository(): string {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-gitgraph-e2e-'));
  repositories.push(repository);
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'Praxis Test');
  git('config', 'user.email', 'praxis@example.test');
  fs.writeFileSync(path.join(repository, 'README.md'), 'line one\nline two\nline three\n');
  git('add', '.');
  git('commit', '-m', 'initial commit');
  git('switch', '-c', 'feature');
  fs.writeFileSync(path.join(repository, 'feature.txt'), 'feature work\n');
  git('add', '.');
  git('commit', '-m', 'feature work');
  git('switch', 'main');
  fs.writeFileSync(path.join(repository, 'main.txt'), 'main work\n');
  git('add', '.');
  git('commit', '-m', 'main work');
  git('merge', '--no-ff', 'feature', '-m', 'merge feature into main');
  // Left dirty on purpose — "Review unstaged" and the hunk staging controls
  // need a real working-tree change to act on.
  fs.writeFileSync(path.join(repository, 'README.md'), 'line one\nline two edited\nline three\nline four\n');
  return repository;
}

/**
 * Git is per-project now, so the graph is reached by attaching the repository
 * to a project and navigating through that project's Git entry.
 */
async function openProjectGit(repository: string): Promise<void> {
  const project = await app.window.evaluate(async folder => window.ticketManager.projects.create({
    name: 'Git Fixture', key: 'GITFIX', type: 'software', purpose: 'Git graph fixture', brief: {},
    startingPoint: 'existing-folder', folderPath: folder,
    workflowStages: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }],
    starterTickets: [{ summary: 'Repository work', description: 'Fixture', issueType: 'Task', status: 'todo' }],
    defaultAiToolMode: 'read-only'
  }), repository);
  await app.window.reload();
  await app.window.getByTestId('project-nav-item').filter({ hasText: project.name }).click();
  await app.window.getByTestId('project-git-nav-item').click();
}

test.beforeEach(async () => {
  repositories = [];
  app = await launchTestApp();
});

test.afterEach(async () => {
  await closeTestApp(app);
  for (const repository of repositories) {
    fs.rmSync(repository, { recursive: true, force: true });
  }
  repositories = [];
});

test('renders the visual Git graph and commit inspector', async () => {
  const window = app.window;
  await window.setViewportSize({ width: 1280, height: 720 });
  await openProjectGit(createFixtureRepository());
  await expect(window.getByTestId('git-graph-page')).toBeVisible();
  await expect(window.getByText('History', { exact: true })).toBeVisible();
  await expect(window.getByRole('complementary', { name: 'Branches' })).toContainText('Branches');
  await expect(window.getByRole('complementary', { name: 'Branches' })).not.toContainText('%x00');
  await expect(window.getByRole('list', { name: 'Commit history' }).getByRole('listitem').first()).toBeVisible();
  const firstCommit = window.locator('.git-commit-row').first();
  await expectHistoryColumnsAligned(window);
  await firstCommit.focus();
  await firstCommit.press('Enter');
  await expect(window.getByRole('complementary', { name: 'Commit details' })).toContainText('COMMIT DETAILS');
  await firstCommit.click({ button: 'right' });
  await expect(window.getByRole('menu', { name: 'Commit actions' })).toBeVisible();
  await window.getByRole('menu', { name: 'Commit actions' }).getByRole('button', { name: '×' }).click();
  await expect(window.locator('.git-lines .git-edge, .git-horizontal-lines .git-edge')).not.toHaveCount(0);
  await window.getByRole('button', { name: '◇ Merges only' }).click();
  await expect(window.getByRole('button', { name: '◇ Merges only' })).toHaveClass(/active/);
  await window.getByRole('button', { name: 'Zoom in' }).click();
  await expect(window.getByRole('region', { name: 'Git Graph' })).toContainText('110%');
  await window.getByTestId('git-changes').click();
  await expect(window.getByTestId('git-changes-panel')).toContainText('changed files');
  await window.getByRole('button', { name: 'Git settings' }).click();
  await expect(window.getByRole('region', { name: 'Git Graph' })).toContainText('Git Graph settings');
  await expect(window.getByLabel('Git executable path')).toBeVisible();
  const branchColors = window.getByRole('checkbox', { name: 'Branch colors' });
  await branchColors.click();
  await expect(branchColors).not.toBeChecked();
  await window.getByRole('button', { name: 'Git settings' }).click();
  await window.getByRole('button', { name: 'Git settings' }).click();
  await expect(window.getByRole('checkbox', { name: 'Branch colors' })).not.toBeChecked();
  await window.getByRole('combobox', { name: 'Graph orientation' }).selectOption('horizontal');
  await expect(window.locator('.git-history-horizontal')).toBeVisible();
  await expect(window.getByRole('list', { name: 'Commit history' }).getByRole('listitem').first()).toBeVisible();
  await window.screenshot({ path: 'output/playwright/git-graph-horizontal.png', fullPage: true });
  await window.screenshot({ path: 'output/playwright/git-graph.png', fullPage: true });

  await window.getByRole('button', { name: 'Review unstaged' }).click();
  await expect(window.getByTestId('git-diff-workspace')).toBeVisible();
  await expect(window.getByRole('complementary', { name: 'Changed files' })).toBeVisible();
  await expect(window.getByRole('button', { name: 'Split' })).toHaveClass(/active/);
  await window.getByRole('button', { name: 'Inline' }).click();
  await expect(window.locator('.git-diff-line.addition, .git-diff-line.deletion').first()).toBeVisible();
  await window.getByRole('button', { name: 'Hunks' }).click();
  await expect(window.locator('[data-hunk-action="stage"]').first()).toBeVisible();
  await window.locator('.git-diff-line.addition input, .git-diff-line.deletion input').first().click();
  await expect(window.getByRole('button', { name: /Stage 1 selected/ }).first()).toBeVisible();
  await window.getByRole('button', { name: 'Split' }).click();
  await window.getByRole('button', { name: 'Toggle word wrap' }).click();
  await window.getByRole('button', { name: 'History' }).click();
  await expect(window.getByRole('region', { name: 'File history' })).toBeVisible();
  await window.getByRole('region', { name: 'File history' }).getByRole('button', { name: 'Close' }).click();
  await window.getByRole('button', { name: 'Blame' }).click();
  await expect(window.getByRole('region', { name: 'File blame' })).toBeVisible();
  await window.getByRole('region', { name: 'File blame' }).getByRole('button', { name: 'Close' }).click();
  await window.screenshot({ path: 'output/playwright/praxis-diff-workspace.png', fullPage: true });
  await window.setViewportSize({ width: 780, height: 650 });
  await expect(window.getByTestId('git-diff-workspace')).toBeVisible();
  await window.screenshot({ path: 'output/playwright/praxis-diff-workspace-narrow.png', fullPage: true });
});

test('keeps the graph usable in a narrow reduced-motion window', async () => {
  const window = app.window;
  await window.setViewportSize({ width: 900, height: 650 });
  await window.emulateMedia({ reducedMotion: 'reduce' });
  await openProjectGit(createFixtureRepository());
  await expect(window.getByTestId('git-graph-page')).toBeVisible();
  await expect(window.getByRole('list', { name: 'Commit history' })).toBeVisible();
  await expect(window.getByText('History', { exact: true })).toBeVisible();
  await expect(window.getByRole('button', { name: '↻ Refresh' })).toBeVisible();
  await expectHistoryColumnsAligned(window);
  await window.setViewportSize({ width: 760, height: 650 });
  await expectHistoryColumnsAligned(window);
  await window.screenshot({ path: 'output/playwright/git-graph-narrow-reduced-motion.png', fullPage: true });
});

test('presents a clear three-way conflict editor and saves a resolution', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-conflict-e2e-'));
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repository, stdio: 'pipe' });
  try {
    git('init', '-b', 'main');
    git('config', 'user.name', 'Praxis Test');
    git('config', 'user.email', 'praxis@example.test');
    fs.writeFileSync(path.join(repository, 'story.txt'), 'shared beginning\nchoose this line\nshared ending\n');
    git('add', 'story.txt');
    git('commit', '-m', 'shared story');
    git('switch', '-c', 'incoming');
    fs.writeFileSync(path.join(repository, 'story.txt'), 'shared beginning\nincoming choice\nshared ending\n');
    git('commit', '-am', 'incoming story');
    git('switch', 'main');
    fs.writeFileSync(path.join(repository, 'story.txt'), 'shared beginning\ncurrent choice\nshared ending\n');
    git('commit', '-am', 'current story');
    try { git('merge', 'incoming'); } catch { /* expected conflict */ }

    const window = app.window;
    await window.setViewportSize({ width: 1280, height: 720 });
    // Attach the conflicted repository to a project — the graph is per-project.
    await openProjectGit(repository);
    await expect(window.getByTestId('git-conflict-workspace')).toBeVisible();
    await expect(window.getByRole('region', { name: 'Merge conflict editor' })).toContainText('Current branch');
    await expect(window.getByRole('region', { name: 'Merge conflict editor' })).toContainText('Incoming branch');
    await expect(window.getByLabel('Resolved file content')).toHaveValue(/<<<<<<< /);
    await window.screenshot({ path: 'output/playwright/praxis-conflict-editor.png', fullPage: true });
    await window.getByRole('button', { name: 'Use all' }).first().click();
    await window.getByRole('button', { name: 'Save resolved file' }).click();
    await expect(window.getByTestId('git-conflict-workspace')).not.toBeVisible();
    expect(fs.readFileSync(path.join(repository, 'story.txt'), 'utf8')).toContain('current choice');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
