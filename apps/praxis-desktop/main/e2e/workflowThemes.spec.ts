import { expect, test } from '@playwright/test';
import { DEFAULT_APP_SETTINGS } from '@praxis/core';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BE-030 / FX-BF-014 — the workflow screens under a non-default palette.
 *
 * Boots on `one-dark` so a hardcoded colour or a missing token breaks a
 * snapshot. Default-theme layout is covered by workflowDesigner / workflowRun.
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
    localStorage.setItem('praxis-last-workspace-route', JSON.stringify({ projectId: project.id, feature: 'workflows' }));
  });
  await app.window.reload();
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('the designer and run monitor hold up on a dark theme', async () => {
  const page = app.window;
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'one-dark');

  await page.getByRole('button', { name: 'New workflow in Delivery Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New workflow' });
  await expect(page).toHaveScreenshot('workflow-themes-new-dialog-dark.png');
  await dialog.getByRole('listitem').filter({ hasText: 'Governed delivery' }).getByRole('button', { name: 'Use' }).click();
  await expect(dialog).toBeHidden();

  const canvas = page.getByRole('application', { name: 'Workflow canvas' });
  await expect(canvas.getByRole('button', { name: /^Plan \(agent-task\), entry stage/ })).toBeVisible();
  await expect(page.getByRole('main')).toHaveScreenshot('workflow-themes-designer-dark.png');

  // The stage/connection inspector lives in the shell's right pane.
  const inspector = page.getByRole('region', { name: 'Stage inspector' });
  await expect(inspector).toHaveScreenshot('workflow-themes-inspector-dark.png');
  await inspector.getByRole('tab', { name: /^Connections/ }).click();
  await expect(inspector.getByRole('heading', { name: 'Connections' })).toBeVisible();
  await expect(inspector).toHaveScreenshot('workflow-themes-connections-dark.png');
  await inspector.getByRole('tab', { name: 'Stage' }).click();

  // Save, then cross to the run monitor via the sidebar Runs node.
  await canvas.getByRole('button', { name: /^Plan \(agent-task\), entry stage/ }).click();
  await page.getByLabel('Name').fill('Plan the work');
  await page.getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  await page.getByTestId('project-workflow-runs-nav-item').click();
  await expect(page.getByRole('region', { name: 'Run detail' })).toBeVisible();
  await expect(page.getByRole('main')).toHaveScreenshot('workflow-themes-monitor-dark.png');
});
