import { expect, test } from '@playwright/test';
import { DEFAULT_APP_SETTINGS } from '@praxis/core';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BE-030 / TASK-131 — the workflow screens under a non-default palette.
 *
 * The designer and run monitor own a large `wf-`-prefixed stylesheet; this
 * boots the app on a dark theme (`one-dark`) so a hardcoded colour or a
 * missing token shows up as a broken snapshot rather than shipping silently.
 * The default-theme layout is covered by workflowDesigner / workflowRun.
 */

test.slow();

let app: TestApp;

test.beforeEach(async () => {
  app = await launchTestApp(
    { appearance: { ...DEFAULT_APP_SETTINGS.appearance, themeId: 'one-dark' } },
    undefined,
    undefined,
    { openNewSession: false }
  );
  await app.window.evaluate(async () => {
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
    localStorage.setItem('praxis-last-workspace-route', JSON.stringify({ projectId: project.id }));
  });
  await app.window.reload();
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('the designer and run monitor hold up on a dark theme', async () => {
  const page = app.window;
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'one-dark');

  await page.getByTestId('project-workflows-nav-item').click();
  await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();

  // Library, then the instantiated graph.
  await expect(page.getByRole('main')).toHaveScreenshot('workflow-themes-library-dark.png');
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Governed delivery' })
    .first()
    .getByRole('button', { name: 'Use template' })
    .click();

  const canvas = page.getByRole('application', { name: 'Workflow canvas' });
  await expect(canvas.getByRole('button', { name: /^Plan \(agent-task\), entry stage/ })).toBeVisible();
  await expect(page.getByRole('main')).toHaveScreenshot('workflow-themes-designer-dark.png');

  // An edit flips the footer to "Save workflow"; save so the monitor has a
  // runnable workflow, then cross to it.
  await canvas.getByRole('button', { name: /^Plan \(agent-task\), entry stage/ }).click();
  await page.getByLabel('Name').fill('Plan the work');
  await page.getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  await page.getByRole('tab', { name: 'Runs' }).click();
  await expect(page.getByRole('region', { name: 'Run detail' })).toBeVisible();
  await expect(page.getByRole('main')).toHaveScreenshot('workflow-themes-monitor-dark.png');
});
