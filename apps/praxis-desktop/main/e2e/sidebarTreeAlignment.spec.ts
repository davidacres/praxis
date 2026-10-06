import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, showProjectBoard, type TestApp } from './launchTestApp';

/**
 * The project tree in the sidebar: rows at the same depth line up (same icon column, same label column),
 * every icon sits the same 6px from its label, and deeper levels step in. Measured, not eyeballed — this
 * drifted before (the Run row borrowed the run-node indent; the workflow rows had no icon gap).
 */

test.slow();

let app: TestApp | undefined;
const tempDirs: string[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  while (tempDirs.length) fs.rmSync(tempDirs.pop() as string, { recursive: true, force: true });
});

test('rows at the same depth of the project tree share an icon column and a label column', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-tree-repo-'));
  tempDirs.push(repo);
  const git = (...args: string[]): void => execFileSync('git', args, { cwd: repo, stdio: 'ignore' });
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  fs.writeFileSync(path.join(repo, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-m', 'initial');

  app = await launchTestApp({ preview: { enableDeployments: true } }, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      { name: 'Tree Project', key: 'TRE', type: 'software', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }], defaultAiToolMode: 'read-only' },
      workspace.id
    );
    const now = new Date().toISOString();
    const workflowId = `tree-${project.id}`;
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1, id: workflowId, name: 'Tree workflow', scope: 'project', projectId: project.id, version: 1,
      entryNodeId: 'verify', createdAt: now, updatedAt: now,
      nodes: [
        { type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [], command: 'true', successExitCodes: [0], timeoutMs: 30000, outputs: [{ id: 'log', kind: 'log', required: false }] },
        { type: 'approval', id: 'approve', name: 'Approve', x: 240, y: 0, inputs: [], prompt: 'Ship?', requiredGates: [], allowBypass: false }
      ],
      edges: [{ id: 'e1', from: 'verify', to: 'approve', on: 'success', required: true }]
    } as never);
    await window.praxis.workflows.startRun(project.id, workflowId, 'Alpha run');
    await window.praxis.workflows.startRun(project.id, workflowId, 'Beta run');
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
  }, repo);
  await page.reload();
  await expect(page.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  await page.waitForTimeout(1500);

  // Where a row's icon (or status dot / chevron) and its label start, and how far apart they are.
  const measure = (selector: string, iconSelector: string) =>
    page.locator(selector).first().evaluate((row, icon) => {
      const iconEl = row.querySelector(icon) as HTMLElement;
      const labelEl = row.querySelector('.tree-label') as HTMLElement;
      const i = iconEl.getBoundingClientRect();
      const l = labelEl.getBoundingClientRect();
      return { icon: Math.round(i.left), label: Math.round(l.left), gap: Math.round(l.left - i.right) };
    }, iconSelector);

  // Depth 2 (--tree-indent-2): a board, a workflow and Policies. Workflows and
  // Automations are project-level peer sections beside Sessions.
  await showProjectBoard(page);
  const depth2 = {
    board: await measure('.project-board-row', '.tree-icon'),
    workflow: await measure('.project-workflow-row', '.tree-icon'),
    policies: await measure('.project-workflow-child', '.tree-icon')
  };
  // Depth 1 (--tree-indent-1): flat leaves with no children (deployments).
  const depth1 = {
    deployments: await measure('[data-testid=project-deployments-nav-item]', '.tree-icon')
  };
  // Depth 3 (--tree-indent-3): workflow run rows under the Sessions subgroup.
  const runNodes = [
    await page.getByTestId('project-workflow-run-row').nth(0).evaluate(row => {
      const icon = row.querySelector('.automation-state-mark') as HTMLElement;
      return Math.round(icon.getBoundingClientRect().left);
    }),
    await page.getByTestId('project-workflow-run-row').nth(1).evaluate(row => {
      const icon = row.querySelector('.automation-state-mark') as HTMLElement;
      return Math.round(icon.getBoundingClientRect().left);
    })
  ];
  const [sessionsHeader, automationsHeader] = await Promise.all([
    page.getByTestId('project-sessions-nav-item').boundingBox(),
    page.getByTestId('project-workflow-runs-nav-item').boundingBox()
  ]);
  await expect(page.locator('.project-workflows-header')).toBeVisible();
  await expect(page.locator('.project-automations-header')).toBeVisible();
  await expect(page.locator('.project-workflow-row')).toHaveCount(1);
  expect(Math.abs(sessionsHeader!.x - automationsHeader!.x)).toBeLessThan(2);
  await expect(page.getByTestId('project-workflow-run-row').first().locator('.automation-state-mark')).toBeVisible();
  await expect(page.getByTestId('project-general-sessions-nav-item')).toContainText('General');
  await expect(page.getByTestId('project-ticket-sessions-nav-item')).toContainText('Ticket');
  await expect(page.getByTestId('project-workflow-runs-nav-item')).toContainText('Automations');

  // Verify header action buttons (Graph, Changes, Run) are visible on the project node header
  await expect(page.getByTestId('project-git-nav-item')).toBeVisible();
  await expect(page.getByTestId('project-git-changes-nav-item')).toBeVisible();
  await expect(page.getByTestId('project-run-nav-item')).toBeVisible();

  const iconCols = (rows: Record<string, { icon: number }>) => [...new Set(Object.values(rows).map(row => row.icon))];
  const labelCols = (rows: Record<string, { label: number }>) => [...new Set(Object.values(rows).map(row => row.label))];
  expect(iconCols(depth2), `depth-2 icons should share one column: ${JSON.stringify(depth2)}`).toHaveLength(1);
  expect(labelCols(depth2), `depth-2 labels should share one column: ${JSON.stringify(depth2)}`).toHaveLength(1);
  expect(iconCols(depth1), `depth-1 icons should share one column: ${JSON.stringify(depth1)}`).toHaveLength(1);
  expect(labelCols(depth1), `depth-1 labels should share one column: ${JSON.stringify(depth1)}`).toHaveLength(1);
  // Every icon is the same distance from its label (.tree-row's 6px gap) — none touching, none floating.
  for (const [name, row] of Object.entries({ ...depth2, ...depth1 })) expect(row.gap, `${name} icon→label gap`).toBe(6);
  // Deeper levels step in, and never the other way round.
  expect(depth1.deployments.icon).toBeLessThan(depth2.board.icon);
  expect(runNodes[0]).toBeGreaterThan(depth2.board.icon);
  expect(runNodes[0]).toBe(runNodes[1]);

  await page.screenshot({ path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'sidebar-tree-alignment.png'), clip: { x: 0, y: 40, width: 270, height: 700 } });
});
