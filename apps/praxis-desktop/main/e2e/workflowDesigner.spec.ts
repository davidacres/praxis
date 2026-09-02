import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BE-021 — the visual workflow designer.
 *
 * Covers the vertical slice: reach the designer for a project, instantiate the
 * built-in Governed delivery template, edit a stage, save, and prove the edit
 * survives closing and reopening the workflow. Plus the accessibility surface —
 * labelled stage buttons and a live validation status region.
 */

let app: TestApp;

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  // Seed one app-storage project and route the active workspace to it.
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

test('instantiates the governed delivery template, edits a stage, and persists it', async () => {
  const page = app.window;

  await page.getByTestId('project-workflows-nav-item').click();
  await expect(page.getByRole('heading', { name: 'Workflow designer' })).toBeVisible();

  // The built-in template is offered in the library.
  const templateCard = page.getByRole('listitem').filter({ hasText: 'Governed delivery' }).first();
  await expect(templateCard).toBeVisible();
  await templateCard.getByRole('button', { name: 'Use template' }).click();

  // The graph loads with its stages as labelled buttons.
  await expect(page.getByRole('button', { name: /^Plan \(agent-task\), entry stage/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Approve \(approval\)/ })).toBeVisible();

  // Edit the Plan stage name through the inspector.
  await page.getByRole('button', { name: /^Plan \(agent-task\), entry stage/ }).click();
  const nameField = page.getByLabel('Name');
  await expect(nameField).toHaveValue('Plan');
  await nameField.fill('Plan the work');

  // Save is enabled only while the graph validates; the template is valid.
  const saveButton = page.getByRole('button', { name: 'Save workflow' });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

  // Close back to the library, reopen, and confirm the rename stuck.
  await page.getByRole('button', { name: 'Close' }).click();
  await page.getByRole('button', { name: /Governed delivery.*v1/ }).click();
  await expect(page.getByRole('button', { name: /^Plan the work \(agent-task\), entry stage/ })).toBeVisible();
});

test('blocks save while the graph is invalid and announces the errors', async () => {
  const page = app.window;

  await page.getByTestId('project-workflows-nav-item').click();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Quick change' })
    .first()
    .getByRole('button', { name: 'Use template' })
    .click();

  // Blank the implement stage's agent id — that is a node-level error.
  await page.getByRole('button', { name: /^Implement \(agent-task\)/ }).click();
  await page.getByLabel('Agent Hub id').fill('');

  const status = page.getByRole('status').filter({ hasText: /error/ });
  await expect(status).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save workflow' })).toBeDisabled();

  // The offending stage carries a visible issue badge.
  await expect(page.getByRole('button', { name: /^Implement \(agent-task\).*issue/ })).toBeVisible();
});
