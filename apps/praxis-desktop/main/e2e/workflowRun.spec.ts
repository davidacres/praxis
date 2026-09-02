import { execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BE-022 — the run monitor and the governed delivery pipeline end to end.
 *
 * Drives the built-in Governed delivery template through a run: the parallel
 * review / QA / security branches converge at the join, approval stays
 * unavailable until every required gate resolves, a run can be cancelled, and a
 * run's completed stages survive an app restart without being re-run.
 *
 * Stages are advanced explicitly from the monitor (FX-BF-011 will drive them
 * from real agent sessions); that is exactly the seam this test exercises.
 */

let app: TestApp;

async function seedProject(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Delivery Project',
        key: 'DELIV',
        type: 'product',
        purpose: '',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [
          { id: 'backlog', name: 'Backlog' },
          { id: 'done', name: 'Done' }
        ],
        starterTickets: [{ summary: 'First task', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    // Instantiate the built-in template as this project's workflow up front.
    await window.praxis.workflows.instantiate(project.id, 'governed-delivery');
    localStorage.setItem('praxis-last-workspace-route', JSON.stringify({ projectId: project.id, feature: 'workflows' }));
  });
  await page.reload();
}

async function openRunsTab(page: Page): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
  await page.getByRole('tab', { name: 'Runs' }).click();
}

/** Marks a ready stage done from the monitor's stage table. */
async function markDone(page: Page, stageName: string): Promise<void> {
  const row = page.getByRole('row').filter({ hasText: stageName });
  await row.getByRole('button', { name: 'Mark done' }).click();
}

test.afterEach(async () => {
  await closeTestApp(app);
});

test('runs the governed pipeline: parallel branches converge, then approval unlocks', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seedProject(page);
  await openRunsTab(page);

  // Start a run of the project's Governed delivery workflow.
  await page.getByLabel('Run workflow').selectOption({ label: 'Governed delivery' });
  await page.getByLabel('Run task').fill('Ship the widget');
  await page.getByRole('button', { name: 'Start' }).click();

  const runDetail = page.getByRole('region', { name: 'Run detail' });
  await expect(runDetail.getByRole('status')).toContainText(/waiting for the next stage|Stage in progress|Plan/i);

  // Plan → Implement are serial (Implement writes the worktree).
  await markDone(page, 'Plan');
  await markDone(page, 'Implement');

  // Review / QA / Security are now all ready in parallel.
  await markDone(page, 'Review');
  await markDone(page, 'QA');

  // Approval is still blocked — the security gate has not resolved.
  await expect(page.getByRole('button', { name: 'Approve' })).toBeDisabled();
  await expect(runDetail).toContainText('Security scan');
  await expect(runDetail).toContainText('waiting to converge');

  await expect(page.getByRole('region', { name: 'Run detail' })).toHaveScreenshot('workflow-run-monitor.png');

  await markDone(page, 'Security scan');

  // The branch group has converged and every gate passed.
  await expect(runDetail).toContainText('converged');
  await expect(runDetail.getByRole('status')).toContainText('waiting for a human approval');

  const approve = page.getByRole('button', { name: 'Approve' });
  await expect(approve).toBeEnabled();
  await approve.click();

  await expect(runDetail.getByRole('status')).toContainText('completed');
});

test('a run can be cancelled from the monitor', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seedProject(page);
  await openRunsTab(page);

  await page.getByLabel('Run workflow').selectOption({ label: 'Governed delivery' });
  await page.getByLabel('Run task').fill('Abandon this one');
  await page.getByRole('button', { name: 'Start' }).click();

  await markDone(page, 'Plan');
  await page.getByRole('button', { name: 'Cancel run' }).click();

  await expect(page.getByRole('region', { name: 'Run detail' }).getByRole('status')).toContainText('cancelled');
});

test('completed stages are not re-run after an app restart', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  let page = app.window;
  await seedProject(page);
  await openRunsTab(page);

  await page.getByLabel('Run workflow').selectOption({ label: 'Governed delivery' });
  await page.getByLabel('Run task').fill('Survive a restart');
  await page.getByRole('button', { name: 'Start' }).click();
  await markDone(page, 'Plan');
  await markDone(page, 'Implement');

  const implementRow = page.getByRole('row').filter({ hasText: 'Implement' });
  await expect(implementRow).toContainText('succeeded');

  // Relaunch into the same profile. The seeded workspace clears the durable
  // route on launch, so navigate back to Workflows through the sidebar.
  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  app = await launchTestApp(undefined, profile, undefined, { openNewSession: false });
  page = app.window;
  await page.getByTestId('project-workflows-nav-item').click();
  await openRunsTab(page);
  await page.getByRole('button', { name: /Governed delivery/ }).first().click();

  // The two completed stages are still done, each with a single attempt.
  const restoredImplement = page.getByRole('row').filter({ hasText: 'Implement' });
  await expect(restoredImplement).toContainText('succeeded');
  await expect(restoredImplement).toContainText('(1/2)');
});

/** A throwaway git repository the run can branch a worktree from. */
function createRepository(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-repo-'));
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: root, stdio: 'ignore' });
  };
  git('init', '--initial-branch=main');
  git('config', 'user.email', 'e2e@example.com');
  git('config', 'user.name', 'E2E');
  fs.writeFileSync(path.join(root, 'README.md'), '# fixture\n');
  git('add', '.');
  git('commit', '-m', 'initial');
  return root;
}

test('a deterministic check runs on its own in the run worktree and unblocks approval', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  const started = await page.evaluate(async repoPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Checked Delivery',
        key: 'CHKD',
        type: 'software',
        purpose: '',
        brief: {},
        startingPoint: 'existing-folder',
        folderPath: repoPath,
        workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );

    // A check-only workflow: `git --version` always exits 0 and needs nothing
    // installed, so this asserts the orchestrator, not the toolchain.
    const now = new Date().toISOString();
    await window.praxis.workflows.save(project.id, {
      schemaVersion: 1,
      id: `checks-${project.id}`,
      name: 'Checks only',
      scope: 'project',
      projectId: project.id,
      version: 1,
      entryNodeId: 'verify',
      createdAt: now,
      updatedAt: now,
      nodes: [
        {
          type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [],
          command: 'git', args: ['--version'], successExitCodes: [0],
          outputs: [{ id: 'verify-log', kind: 'log', required: true }],
          satisfiesGate: 'qa'
        },
        {
          type: 'approval', id: 'approve', name: 'Approve', x: 200, y: 0, inputs: ['verify-log'],
          prompt: 'Ship?', requiredGates: ['qa'], allowBypass: false
        }
      ],
      edges: [{ id: 'e1', from: 'verify', to: 'approve', on: 'success', required: true }]
    } as never);

    const summary = await window.praxis.workflows.startRun(project.id, `checks-${project.id}`, 'Automated');
    return { runId: summary.runId, projectId: project.id };
  }, repo);

  // No manual advancement: poll until the orchestrator has driven the check.
  await expect
    .poll(
      async () =>
        page.evaluate(async runId => (await window.praxis.workflows.getRun(runId))?.status, started.runId),
      { timeout: 20000 }
    )
    .toBe('awaiting-approval');

  const detail = await page.evaluate(
    async runId => {
      const summary = await window.praxis.workflows.getRun(runId);
      const stage = summary?.stages.find(row => row.nodeId === 'verify');
      return {
        outcome: stage?.outcome,
        artifacts: stage?.artifacts.map(artifact => artifact.contractId),
        gate: summary?.gates.find(gate => gate.gate === 'qa')?.state
      };
    },
    started.runId
  );

  expect(detail.outcome).toBe('succeeded');
  expect(detail.artifacts).toEqual(['verify-log']);
  expect(detail.gate).toBe('passed');

  // The run branched a worktree off the fixture repository.
  const worktrees = execFileSync('git', ['worktree', 'list'], { cwd: repo, encoding: 'utf8' });
  expect(worktrees.split('\n').length).toBeGreaterThan(1);

  fs.rmSync(repo, { recursive: true, force: true });
});

/** Seeds a folder-backed project with a saved check-only workflow. */
async function seedCheckWorkflow(
  page: Page,
  repoPath: string,
  check: { command: string; args: string[]; successExitCodes?: number[]; timeoutMs?: number }
): Promise<{ projectId: string; workflowId: string }> {
  return page.evaluate(
    async ({ repo, checkSpec }) => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create(
        {
          name: 'Auto Delivery',
          key: 'AUTO',
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
      const workflowId = `auto-${project.id}`;
      const now = new Date().toISOString();
      await window.praxis.workflows.save(project.id, {
        schemaVersion: 1,
        id: workflowId,
        name: 'Auto checks',
        scope: 'project',
        projectId: project.id,
        version: 1,
        entryNodeId: 'verify',
        createdAt: now,
        updatedAt: now,
        nodes: [
          {
            type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [],
            command: checkSpec.command,
            args: checkSpec.args,
            successExitCodes: checkSpec.successExitCodes ?? [0],
            ...(checkSpec.timeoutMs ? { timeoutMs: checkSpec.timeoutMs } : {}),
            outputs: [{ id: 'verify-log', kind: 'log', required: true }],
            satisfiesGate: 'qa'
          },
          {
            type: 'approval', id: 'approve', name: 'Approve', x: 200, y: 0, inputs: ['verify-log'],
            prompt: 'Ship?', requiredGates: ['qa'], allowBypass: false
          }
        ],
        edges: [{ id: 'e1', from: 'verify', to: 'approve', on: 'success', required: true }]
      } as never);
      localStorage.setItem('praxis-last-workspace-route', JSON.stringify({ projectId: project.id, feature: 'workflows' }));
      return { projectId: project.id, workflowId };
    },
    { repo: repoPath, checkSpec: check }
  );
}

test('the run monitor reflects an unattended run as the orchestrator drives it', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  const seeded = await seedCheckWorkflow(page, repo, { command: 'git', args: ['--version'] });
  await page.reload();
  await openRunsTab(page);

  await page.getByLabel('Run workflow').selectOption({ label: 'Auto checks' });
  await page.getByLabel('Run task').fill('Hands off');
  await page.getByRole('button', { name: 'Start' }).click();

  const runDetail = page.getByRole('region', { name: 'Run detail' });
  // No Mark done anywhere: the check runs and the status region updates itself.
  await expect(runDetail.getByRole('status')).toContainText('waiting for a human approval', { timeout: 20000 });
  await expect(page.getByRole('row').filter({ hasText: 'Verify' })).toContainText('succeeded');
  await expect(page.getByRole('button', { name: 'Approve' })).toBeEnabled();

  await page.getByRole('button', { name: 'Approve' }).click();
  await expect(runDetail.getByRole('status')).toContainText('completed');
  expect(seeded.workflowId).toContain('auto-');

  fs.rmSync(repo, { recursive: true, force: true });
});

test('a check that outruns its timeout is failed with a stated reason', async () => {
  const repo = createRepository();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;

  // `sleep 30` will be killed by the 1s timeout long before it exits.
  await seedCheckWorkflow(page, repo, { command: 'sleep', args: ['30'], timeoutMs: 1000 });
  await page.reload();
  await openRunsTab(page);

  await page.getByLabel('Run workflow').selectOption({ label: 'Auto checks' });
  await page.getByLabel('Run task').fill('Too slow');
  await page.getByRole('button', { name: 'Start' }).click();

  const verifyRow = page.getByRole('row').filter({ hasText: 'Verify' });
  await expect(verifyRow).toContainText('failed', { timeout: 20000 });
  await expect(verifyRow).toContainText(/timed out/i);
  await expect(page.getByRole('region', { name: 'Run detail' })).toContainText(/failed|retried/);

  fs.rmSync(repo, { recursive: true, force: true });
});
