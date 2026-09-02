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
