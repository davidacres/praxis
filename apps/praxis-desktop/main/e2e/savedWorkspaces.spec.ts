import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

const productInput = {
  name: 'Portal', key: 'PORTAL', type: 'product' as const, purpose: 'Workspace membership', brief: {},
  startingPoint: 'app-storage' as const,
  workflowStages: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }],
  starterTickets: [{ summary: 'First task', description: 'Placeholder', issueType: 'Task', status: 'Todo' }],
  defaultAiToolMode: 'project-only' as const
};

test('project creation requires a valid workspace and assigns the first project as default', async () => {
  app = await launchTestApp();
  const result = await app.window.evaluate(async input => {
    const workspace = (await window.praxis.workspaces.list())[0];
    let missingError = '';
    try { await window.praxis.projects.create(input, 'workspace-missing'); }
    catch (error) { missingError = error instanceof Error ? error.message : String(error); }
    const project = await window.praxis.projects.create(input, workspace.id);
    return { missingError, project, workspace: await window.praxis.workspaces.get(workspace.id) };
  }, productInput);

  expect(result.missingError).toContain('valid workspace');
  expect(result.workspace?.projectIds).toContain(result.project.id);
  expect(result.workspace?.defaultProjectId).toBe(result.project.id);

  await app.window.evaluate(() => window.praxis.settings.set({ startup: { reopenLastWorkspace: false } }));
  await app.window.reload();
  await app.window.getByRole('button', { name: /Test Workspace/ }).click();
  await expect(app.window.getByTestId('project-home')).toContainText('Portal');
});

test('deleting the active workspace returns to Getting Started without deleting projects', async () => {
  app = await launchTestApp();
  const win = app.window;
  const project = await win.evaluate(async input => {
    const workspace = (await window.praxis.workspaces.list())[0];
    return window.praxis.projects.create(input, workspace.id);
  }, productInput);
  await win.reload();

  await win.getByRole('button', { name: 'Select workspace' }).click();
  await win.getByRole('button', { name: /Delete workspace Test Workspace/ }).click();

  await expect(win.getByTestId('getting-started')).toBeVisible();
  expect(await win.evaluate(id => window.praxis.projects.get(id), project.id)).toBeTruthy();
});

test('closing the active workspace returns to the Open Workspace screen', async () => {
  app = await launchTestApp();
  const win = app.window;
  await win.reload();
  await win.getByRole('button', { name: 'Select workspace' }).click();
  await expect(win.getByRole('menuitem', { name: 'Close workspace' })).toBeVisible();
  await win.getByRole('menuitem', { name: 'Close workspace' }).click();
  await expect(win.getByTestId('getting-started')).toBeVisible();
  await expect(win.getByRole('heading', { name: 'Open a workspace' })).toBeVisible();
});

test('Create New Workspace uses the Open Workspace screen while blank creation stays separate', async () => {
  app = await launchTestApp();
  const win = app.window;
  await win.reload();
  await win.getByRole('button', { name: 'Select workspace' }).click();
  await expect(win.getByRole('menuitem', { name: 'Create blank workspace' })).toBeVisible();
  await expect(win.getByRole('menuitem', { name: 'Create New Workspace' })).toBeVisible();
  await win.getByRole('menuitem', { name: 'Create New Workspace' }).click();
  await expect(win.getByTestId('getting-started')).toBeVisible();
  await expect(win.getByRole('heading', { name: 'Open a workspace' })).toBeVisible();
  await win.getByRole('button', { name: 'Create Workspace' }).click();
  await expect(win.getByRole('heading', { name: 'Give your work a home' })).toBeVisible();
});
