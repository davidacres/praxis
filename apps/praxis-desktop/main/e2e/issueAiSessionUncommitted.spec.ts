import * as child_process from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect, type Page } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { chooseOption } from './chipSelect';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
  for (const dir of tempDirs.splice(0)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {}
  }
});

function initRepo(root: string): string {
  fs.mkdirSync(root, { recursive: true });
  const git = (...args: string[]) => child_process.execFileSync('git', args, { cwd: root, stdio: 'pipe' });
  git('init', '-b', 'main');
  git('config', 'user.name', 'test');
  git('config', 'user.email', 'test@test.local');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  return root;
}

test('starting an AI session from a ticket warns about uncommitted changes and offers choices', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    reply: 'Session started from ticket.'
  });
  const repo = initRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-ticket-uncommitted-')));
  tempDirs.push(repo);

  app = await launchTestApp(
    {
      ai: {
        activeProvider: 'vercel-gateway',
        defaultModel: 'mock/model'
      }
    },
    undefined,
    { AI_GATEWAY_API_KEY: 'test-key', AI_GATEWAY_URL: mock.baseUrl },
    { demoMode: true, openNewSession: false }
  );
  const win = app.window;

  // Create project with workflow backed by git repo and attach to demo connection
  const seeded = await win.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Ticket Uncommitted Project',
        key: 'TUP',
        type: 'software',
        purpose: '',
        brief: {},
        startingPoint: 'existing-folder',
        folderPath: repoPath,
        workflowStages: [
          { id: 'todo', name: 'To do', category: 'todo' },
          { id: 'done', name: 'Done', category: 'done' }
        ],
        starterTickets: [],
        defaultAiToolMode: 'project-only'
      },
      workspace.id
    );
    const now = new Date().toISOString();
    const workflowId = `wf-${project.id}`;
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1,
      id: workflowId,
      name: 'Custom ticket workflow',
      scope: 'project',
      projectId: project.id,
      version: 1,
      entryNodeId: 'review',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          type: 'approval',
          id: 'review',
          name: 'Review',
          x: 0,
          y: 0,
          prompt: 'Approve this change',
          inputs: []
        }
      ],
      edges: []
    });

    for (const connection of await window.praxis.connection.list()) {
      if (connection.mode === 'demo') {
        await window.praxis.connection.update({
          ...connection,
          settings: { ...connection.settings, projectId: project.id }
        });
      }
    }
    return { project, workflowId };
  }, repo);

  // Add an uncommitted file to the project's repository
  fs.writeFileSync(path.join(repo, 'dirty-feature.ts'), 'export const dirty = true;\n');

  await win.reload();

  // Open demo ticket APP-100
  await win.locator('[data-testid="nav-overview"]').click();
  await win.getByTestId('board-nav-item').filter({ hasText: 'Platform Overview' }).click();
  await win.locator('[data-testid="issue-card"]', { hasText: 'APP-100' }).click();

  // Open Start AI session dialog
  await win.locator('[data-testid="issue-primary-ai-btn"]').click();
  const dialog = win.locator('[data-testid="issue-session-dialog"]');
  await expect(dialog).toBeVisible();

  // Select the governed workflow
  await chooseOption(dialog.locator('[data-testid="issue-session-workflow"]'), { label: 'Custom ticket workflow' });

  // Attempt to start session with uncommitted files present
  await win.locator('[data-testid="issue-session-start"]').click();

  // UncommittedBaseNotice appears in the dialog with options
  const notice = dialog.locator('[data-testid="uncommitted-base-notice"]');
  await expect(notice).toBeVisible();
  await expect(notice).toContainText('1 uncommitted file in this checkout');
  await expect(notice).toContainText('dirty-feature.ts');
  await expect(dialog.locator('[data-testid="uncommitted-base-include"]')).toBeVisible();
  await expect(dialog.locator('[data-testid="uncommitted-base-omit"]')).toBeVisible();
  await expect(dialog.locator('[data-testid="uncommitted-base-commit"]')).toBeVisible();

  // Capture screenshot of the dialog showing the uncommitted base notice
  await dialog.screenshot({
    path: path.resolve(__dirname, '../../.praxis/session-artifacts/ticket-session-uncommitted-notice.png')
  });

  // Verify dismissing the notice works and re-evaluates on next start click
  await notice.getByRole('button', { name: 'Dismiss', exact: true }).click();
  await expect(notice).not.toBeVisible();
  await win.locator('[data-testid="issue-session-start"]').click();
  await expect(notice).toBeVisible();

  // Clicking "Include my changes" proceeds and starts the session
  await dialog.locator('[data-testid="uncommitted-base-include"]').click();

  // Verify it navigates into the session console
  await expect(win.locator('[data-testid="sessions-view"]')).toBeVisible();
});

test('starting an AI session from a ticket can omit uncommitted files', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    reply: 'Session started from ticket without uncommitted changes.'
  });
  const repo = initRepo(fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-ticket-uncommitted-omit-')));
  tempDirs.push(repo);

  app = await launchTestApp(
    {
      ai: {
        activeProvider: 'vercel-gateway',
        defaultModel: 'mock/model'
      }
    },
    undefined,
    { AI_GATEWAY_API_KEY: 'test-key', AI_GATEWAY_URL: mock.baseUrl },
    { demoMode: true, openNewSession: false }
  );
  const win = app.window;

  await win.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Ticket Omit Project',
        key: 'TOP',
        type: 'software',
        purpose: '',
        brief: {},
        startingPoint: 'existing-folder',
        folderPath: repoPath,
        workflowStages: [
          { id: 'todo', name: 'To do', category: 'todo' },
          { id: 'done', name: 'Done', category: 'done' }
        ],
        starterTickets: [],
        defaultAiToolMode: 'project-only'
      },
      workspace.id
    );
    const now = new Date().toISOString();
    const workflowId = `wf-${project.id}`;
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1,
      id: workflowId,
      name: 'Custom ticket workflow',
      scope: 'project',
      projectId: project.id,
      version: 1,
      entryNodeId: 'review',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          type: 'approval',
          id: 'review',
          name: 'Review',
          x: 0,
          y: 0,
          prompt: 'Approve this change',
          inputs: []
        }
      ],
      edges: []
    });

    for (const connection of await window.praxis.connection.list()) {
      if (connection.mode === 'demo') {
        await window.praxis.connection.update({
          ...connection,
          settings: { ...connection.settings, projectId: project.id }
        });
      }
    }
  }, repo);

  fs.writeFileSync(path.join(repo, 'dirty-feature.ts'), 'export const dirty = true;\n');

  await win.reload();
  await win.locator('[data-testid="nav-overview"]').click();
  await win.getByTestId('board-nav-item').filter({ hasText: 'Platform Overview' }).click();
  await win.locator('[data-testid="issue-card"]', { hasText: 'APP-100' }).click();

  await win.locator('[data-testid="issue-primary-ai-btn"]').click();
  const dialog = win.locator('[data-testid="issue-session-dialog"]');
  await expect(dialog).toBeVisible();

  await chooseOption(dialog.locator('[data-testid="issue-session-workflow"]'), { label: 'Custom ticket workflow' });
  await win.locator('[data-testid="issue-session-start"]').click();

  const notice = dialog.locator('[data-testid="uncommitted-base-notice"]');
  await expect(notice).toBeVisible();

  // Clicking "Start from last commit" proceeds and starts the session without changes
  await dialog.locator('[data-testid="uncommitted-base-omit"]').click();
  await expect(win.locator('[data-testid="sessions-view"]')).toBeVisible();
});
