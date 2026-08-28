import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp;

test.beforeEach(async () => { app = await launchTestApp(); });
test.afterEach(async () => { await closeTestApp(app); });

test('Git Graph explains that a project workspace is required', async () => {
  // Git is per-project now, so the explainer is reached through a project that
  // has no workspace folder yet. The entry point stays enabled on purpose: the
  // setup screen is what tells the user what is missing and offers a way out.
  const project = await app.window.evaluate(() => window.ticketManager.projects.create({
    name: 'Folderless', key: 'NOFOLDER', type: 'product', purpose: 'Workspace explainer', brief: {},
    startingPoint: 'app-storage', workflowStages: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }],
    starterTickets: [{ summary: 'First task', description: 'Placeholder', issueType: 'Task', status: 'todo' }],
    defaultAiToolMode: 'read-only'
  }));
  await app.window.reload();
  await app.window.getByTestId('project-nav-item').filter({ hasText: project.name }).click();
  await app.window.getByTestId('project-git-nav-item').click();

  await expect(app.window.getByTestId('git-onboarding')).toBeVisible();
  await expect(app.window.getByRole('heading', { name: 'Attach a workspace to use Git Graph' })).toBeVisible();
  await expect(app.window.getByText(/Git history, branches, and diffs belong to a project folder/)).toBeVisible();
  await expect(app.window.getByText(/rev-parse|not a git repository/i)).toHaveCount(0);
  // The screen must offer a way forward, not just describe the problem.
  await expect(app.window.getByTestId('git-choose-workspace')).toBeVisible();
});

test('project Git navigation opens the graph for its workspace repository', async () => {
  const repository = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-project-git-'));
  try {
    execFileSync('git', ['init', '-b', 'main'], { cwd: repository });
    execFileSync('git', ['config', 'user.name', 'Praxis Test'], { cwd: repository });
    execFileSync('git', ['config', 'user.email', 'praxis@example.test'], { cwd: repository });
    fs.writeFileSync(path.join(repository, 'README.md'), 'project\n');
    execFileSync('git', ['add', 'README.md'], { cwd: repository });
    execFileSync('git', ['commit', '-m', 'project repository'], { cwd: repository });
    const project = await app.window.evaluate(async folder => window.ticketManager.projects.create({
      name: 'Git Project', key: 'GITTEST', type: 'software', purpose: 'Repository test', brief: {},
      startingPoint: 'existing-folder', folderPath: folder, workflowStages: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }],
      starterTickets: [{ summary: 'Repository work', description: 'Verify Git context', issueType: 'Task', status: 'todo' }], defaultAiToolMode: 'read-only'
    }), repository);
    await app.window.reload();
    await app.window.getByTestId('project-nav-item').filter({ hasText: project.name }).click();
    await app.window.getByTestId('project-git-nav-item').click();
    await expect(app.window.getByTestId('git-graph-page')).toBeVisible();
    await expect(app.window.getByRole('list', { name: 'Commit history' })).toContainText('project repository');
  } finally {
    fs.rmSync(repository, { recursive: true, force: true });
  }
});
