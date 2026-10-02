import { openSession } from './sessionNavigation';
import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Locator } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * A very long name must never push a row's action buttons out of reach. Every row that carries
 * archive / delete / cancel (a workflow, a run node, a session — in the sidebar tree and in the panes)
 * truncates its name and keeps its buttons inside its container, at the narrowest the sidebar (180px) and
 * the right pane (280px) can be dragged to.
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

const LONG = 'An extremely long name that keeps going and going well past the width of any sidebar you could reasonably drag open '.repeat(2).trim();
const UNBROKEN = 'x'.repeat(240);

/** Every button in `container` is on screen and inside `container`'s own right edge. */
async function expectButtonsInside(container: Locator, what: string): Promise<void> {
  const result = await container.evaluate(el => {
    const box = el.getBoundingClientRect();
    return [...el.querySelectorAll('button')].map(button => {
      const b = button.getBoundingClientRect();
      return { name: button.getAttribute('data-testid') ?? button.getAttribute('aria-label') ?? button.textContent?.trim() ?? '', right: b.right, width: b.width, containerRight: box.right };
    });
  });
  expect(result.length, `${what} has buttons`).toBeGreaterThan(0);
  for (const button of result) {
    expect(button.width, `${what}: ${button.name} is rendered`).toBeGreaterThan(0);
    expect(button.right, `${what}: ${button.name} stays inside its row (${JSON.stringify(button)})`).toBeLessThanOrEqual(button.containerRight + 0.5);
  }
}

test('long workflow, run and session names leave their action buttons reachable at the narrowest widths', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-long-repo-'));
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
  await page.evaluate(async ({ repoPath, long, unbroken }) => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      { name: 'Long Names', key: 'LNG', type: 'software', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }], defaultAiToolMode: 'read-only' },
      workspace.id
    );
    const now = new Date().toISOString();
    const workflowId = `long-${project.id}`;
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1, id: workflowId, name: long, scope: 'project', projectId: project.id, version: 1,
      entryNodeId: 'verify', createdAt: now, updatedAt: now,
      nodes: [
        { type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [], command: 'true', successExitCodes: [0], timeoutMs: 30000, outputs: [{ id: 'log', kind: 'log', required: false }] },
        { type: 'approval', id: 'approve', name: 'Approve', x: 240, y: 0, inputs: [], prompt: 'Ship?', requiredGates: [], allowBypass: false }
      ],
      edges: [{ id: 'e1', from: 'verify', to: 'approve', on: 'success', required: true }]
    } as never);
    await window.praxis.workflows.startRun(project.id, workflowId, unbroken);
    await window.praxis.ai.delegate({ provider: 'vercel-gateway', toolMode: 'read-only', task: { goal: `${long} ${unbroken}` } } as never);
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
    localStorage.setItem('tm-pane-sidebar', '180');
    localStorage.setItem('tm-pane-aux', '280');
  }, { repoPath: repo, long: LONG, unbroken: UNBROKEN });
  await page.reload();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });

  // The sidebar tree: a workflow row, a run node, and a session row (each revealed on hover).
  const workflowRow = page.locator('.project-workflow-row').first();
  await workflowRow.hover();
  await expectButtonsInside(workflowRow, 'workflow row');
  const runRow = page.getByTestId('project-workflow-run-row').first();
  await runRow.hover();
  await expectButtonsInside(runRow, 'run node');
  const sessionRow = page.getByTestId('session-list-row').first();
  await expect(sessionRow).toBeVisible();
  await sessionRow.hover();
  await expectButtonsInside(sessionRow, 'session row');
  // And the sidebar itself never grows a horizontal scroll to hide them behind.
  const scroller = await page.locator('.sidebar-scroll').evaluate(el => ({ scrollW: el.scrollWidth, clientW: el.clientWidth }));
  expect(scroller.scrollW, 'the sidebar does not scroll sideways').toBeLessThanOrEqual(scroller.clientW);

  // The panes: the run panel, the runs browser, and the session browser tab.
  await runRow.getByTestId('automation-run-open').click();
  const runPanel = page.getByTestId('wf-run-panel');
  await expect(runPanel).toBeVisible();
  await expectButtonsInside(runPanel, 'run panel');
  await page.getByTestId('project-workflow-runs-nav-item').click();
  const card = page.locator('.wf-run-card').first();
  await expect(card).toBeVisible();
  await expectButtonsInside(card, 'runs browser row');

  await openSession(page);
  await sessionRow.click();
  await page.getByRole('tablist', { name: 'Session detail' }).getByRole('tab', { name: 'Sessions' }).click();
  await expectButtonsInside(page.getByTestId('session-browser-row').first(), 'session browser row');
});
