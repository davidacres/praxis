import * as fs from 'node:fs';
import * as path from 'node:path';
import { openNewWorkflowDialog } from './navigation';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

let app: TestApp;

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });

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
          { id: 'backlog', name: 'Backlog', category: 'todo' },
          { id: 'done', name: 'Done', category: 'done' }
        ],
        starterTickets: [{ summary: 'First task', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id }));
  });
  await app.window.reload();
});

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
  }
});

test('agent records and the Workflow designer sit inside the normal app shell', async () => {
  const page = app.window;

  await expect(page.getByTestId('nav-agents')).toHaveCount(0);
  await page.getByTestId('titlebar-settings').click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Settings' }).getByRole('button', { name: 'Done' }).click();
  await expect(page.getByRole('dialog', { name: 'Settings' })).toHaveCount(0);

  // Workflow designer dialog
  await openNewWorkflowDialog(page, 'Delivery Project');
  const dialog = page.getByRole('dialog', { name: 'New workflow' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('listitem').filter({ hasText: 'Governed delivery' }).click();
  await dialog.getByRole('button', { name: 'Use "Governed delivery"' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByRole('application', { name: 'Workflow canvas' })).toBeVisible();
});
