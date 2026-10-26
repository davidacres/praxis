import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * Classic mode's project tree after the Workflows section was removed: the
 * project's runs live in one "Runs" ledger group, saved workflow definitions
 * are gone from the sidebar, and every node, icon and label keeps the shared
 * ledger geometry. Captures the sidebar light, dark and at its narrowest so a
 * person can confirm the positions by eye.
 */

test.slow();

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

const artifacts = path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts');

async function seedProject(page: Page, repoPath: string): Promise<void> {
  await page.evaluate(async repo => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Runs Project',
        key: 'RUNS',
        type: 'software',
        purpose: '',
        brief: {},
        startingPoint: 'existing-folder',
        folderPath: repo,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    const now = new Date().toISOString();
    const workflowId = `runs-${project.id}`;
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1, id: workflowId, name: 'Nightly verification', scope: 'project', projectId: project.id, version: 1,
      entryNodeId: 'verify', createdAt: now, updatedAt: now,
      nodes: [
        { type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [], command: 'true', successExitCodes: [0], timeoutMs: 30000, outputs: [{ id: 'log', kind: 'log', required: false }] },
        { type: 'approval', id: 'approve', name: 'Approve', x: 240, y: 0, inputs: [], prompt: 'Ship?', requiredGates: [], allowBypass: false }
      ],
      edges: [{ id: 'e1', from: 'verify', to: 'approve', on: 'success', required: true }]
    } as never);
    // One live run (waiting at its approval stage) and one finished one.
    await window.praxis.workflows.startRun(project.id, workflowId, 'Nightly verification');
    const done = await window.praxis.workflows.startRun(project.id, workflowId, 'Earlier verification');
    await window.praxis.workflows.advanceStage(done.runId, 'verify', 'succeeded');
    await window.praxis.workflows.advanceStage(done.runId, 'approve', 'succeeded');
    await window.praxis.ai.delegate({ provider: 'vercel-gateway', projectId: project.id, toolMode: 'read-only', task: { goal: 'A conversation about the project' } } as never);
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'overview' }));
  }, repoPath);
  await page.reload();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
}

test('classic mode shows one Runs group with no Workflows section, and its rows keep the ledger geometry', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-runs-sidebar-'));
  tempDirs.push(repo);
  const git = (...args: string[]): void => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-m', 'initial');

  mock = await startMockGatewayServer({ mode: 'complete', reply: 'done' });
  app = await launchTestApp(
    { ai: { activeProvider: 'vercel-gateway', gatewayUrl: mock.baseUrl, workingDirectory: repo } },
    undefined,
    { AI_GATEWAY_API_KEY: 'e2e-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_AI_GATEWAY_URL: undefined },
    { openNewSession: false }
  );
  const page = app.window;
  await seedProject(page, repo);
  fs.mkdirSync(artifacts, { recursive: true });

  const sidebar = page.locator('nav.sidebar');
  const projectTree = page.getByTestId('project-tree');

  // The renamed group, with its count and its actions.
  const runsHeader = page.getByTestId('project-workflow-runs-nav-item');
  await expect(runsHeader).toBeVisible();
  await expect(runsHeader).toContainText('Runs');
  await expect(runsHeader).toContainText('2');
  await expect(page.getByRole('button', { name: 'New run', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Collapse runs', exact: true })).toBeVisible();

  // The Workflows section is gone: no header, no saved-definition rows, no Policies child.
  await expect(page.locator('.project-workflows-header')).toHaveCount(0);
  await expect(page.getByTestId('project-workflow-nav-item')).toHaveCount(0);
  await expect(page.getByTestId('project-workflow-policies-nav-item')).toHaveCount(0);
  await expect(projectTree).not.toContainText('Workflows');

  // Two run rows, each leading with the ledger's zap icon and a status dot on its meta line.
  const runRows = page.getByTestId('project-workflow-run-row');
  await expect(runRows).toHaveCount(2);
  for (let index = 0; index < 2; index += 1) {
    const row = runRows.nth(index);
    await expect(row.locator('.ledger-lead')).toBeVisible();
    await expect(row.getByTestId('automation-run-status')).toBeVisible();
  }

  // The run titles and the session rows share the ledger's title column.
  const titleLeft = await runRows.first().locator('.automation-run-title').evaluate(el => Math.round(el.getBoundingClientRect().left));
  const sessionRow = page.getByTestId('project-session-nav-item').first();
  await expect(sessionRow).toBeVisible();
  const sessionTitleLeft = await sessionRow.getByTestId('session-title').first().evaluate(el => Math.round(el.getBoundingClientRect().left));
  expect(Math.abs(titleLeft - sessionTitleLeft), 'run titles and session titles share a column').toBeLessThan(2);

  await sidebar.screenshot({ path: path.join(artifacts, 'classic-runs-sidebar-light.png') });

  // Hovering a run reveals its rename / archive / delete actions inside the row.
  await runRows.first().hover();
  await page.waitForTimeout(180);
  await sidebar.screenshot({ path: path.join(artifacts, 'classic-runs-sidebar-hover.png') });

  // Dark mode keeps the same positions.
  await page.evaluate(() => window.praxis.settings.set({ appearance: { themeId: 'praxis-dark', themeMode: 'dark' } }));
  await page.reload();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await page.mouse.move(900, 120);
  await page.waitForTimeout(180);
  await sidebar.screenshot({ path: path.join(artifacts, 'classic-runs-sidebar-dark.png') });

  // And at the narrowest the sidebar can be dragged, nothing overflows sideways.
  await page.evaluate(() => window.praxis.settings.set({ appearance: { themeId: 'praxis-light', themeMode: 'light' } }));
  await page.evaluate(() => localStorage.setItem('tm-pane-sidebar', '180'));
  await page.reload();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  const scroller = await page.locator('.sidebar-scroll').evaluate(el => ({ scrollW: el.scrollWidth, clientW: el.clientWidth }));
  expect(scroller.scrollW, 'the narrow sidebar does not scroll sideways').toBeLessThanOrEqual(scroller.clientW);
  await sidebar.screenshot({ path: path.join(artifacts, 'classic-runs-sidebar-narrow.png') });
});
