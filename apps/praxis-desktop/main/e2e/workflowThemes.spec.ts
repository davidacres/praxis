import { expect, test } from '@playwright/test';
import { DEFAULT_APP_SETTINGS } from '@praxis/core';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BE-030 / FX-BF-014 — the workflow screens under a non-default palette.
 *
 * Boots on One Dark's exact colours (seeded as a custom theme — One Dark
 * itself is now a marketplace-only add-on, not bundled) so a hardcoded colour
 * or a missing token breaks a snapshot. Default-theme layout is covered by
 * workflowDesigner / workflowRun.
 */

test.slow();

let app: TestApp;

const ONE_DARK_PREVIEW = { canvas: '#282c34', panel: '#21252b', raised: '#1b1d23', border: '#3e4451', text: '#abb2bf', muted: '#7f848e', accent: '#61afef', success: '#98c379', warning: '#e5c07b', danger: '#e06c75' };

test.beforeEach(async () => {
  app = await launchTestApp(
    {
      appearance: {
        ...DEFAULT_APP_SETTINGS.appearance,
        themeId: 'custom-one-dark',
        themeMode: 'dark',
        installedThemeIds: [...DEFAULT_APP_SETTINGS.appearance.installedThemeIds, 'custom-one-dark'],
        customThemes: [{ id: 'custom-one-dark', name: 'One Dark', mode: 'dark', description: 'A balanced editor-dark palette inspired by Atom.', preview: ONE_DARK_PREVIEW }]
      }
    },
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
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
  });
  await app.window.reload();
});

test.afterEach(async () => {
  await closeTestApp(app);
});

test('the designer and run monitor hold up on a dark theme', async () => {
  const page = app.window;
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'custom-one-dark');

  await page.getByRole('button', { name: 'New workflow in Delivery Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New workflow' });
  await expect(page).toHaveScreenshot('workflow-themes-new-dialog-dark.png');
  await dialog.getByRole('listitem').filter({ hasText: 'Governed delivery' }).click();
  await dialog.getByRole('button', { name: /^Use/ }).click();
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

  // Save, then open the start-run dialog from the sidebar Runs node.
  await canvas.getByRole('button', { name: /^Plan \(agent-task\), entry stage/ }).click();
  await page.getByLabel('Name').fill('Plan the work');
  await page.getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  await page.getByTestId('project-workflow-run-new').click();
  await expect(page.getByTestId('wf-runstart-dialog')).toBeVisible();
  await expect(page.getByTestId('wf-runstart-dialog')).toHaveScreenshot('workflow-themes-start-run-dark.png');
});
