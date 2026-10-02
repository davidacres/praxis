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

test('New workspace opens the workspace creation dialog', async () => {
  app = await launchTestApp();
  const win = app.window;
  await win.reload();
  await win.getByRole('button', { name: 'Select workspace' }).click();
  await win.getByRole('menuitem', { name: 'New workspace' }).click();
  await expect(win.getByRole('heading', { name: 'Create workspace' })).toBeVisible();

});

test('each workspace resumes at its own last route, not the other one\'s', async () => {
  app = await launchTestApp();
  const win = app.window;

  const ids = await win.evaluate(async () => {
    const base = {
      type: 'product' as const, purpose: '', brief: {}, startingPoint: 'app-storage' as const,
      workflowStages: [{ id: 'backlog', name: 'Backlog' }, { id: 'done', name: 'Done' }],
      starterTickets: [{ summary: 'Slice', description: '', issueType: 'Task', status: 'Backlog' }],
      defaultAiToolMode: 'project-only' as const
    };
    const first = (await window.praxis.workspaces.list())[0];
    const second = await window.praxis.workspaces.create({ name: 'Second Workspace', projectIds: [] });
    await window.praxis.projects.create({ ...base, name: 'Alpha', key: 'ALPHA' }, first.id);
    await window.praxis.projects.create({ ...base, name: 'Beta', key: 'BETA' }, second.id);
    return { first: first.id };
  });
  await win.reload();

  const switchTo = async (name: string) => {
    await win.getByRole('button', { name: 'Select workspace' }).click();
    await win.getByRole('menuitem', { name: new RegExp(name) }).click();
  };

  await switchTo('Second Workspace');
  await expect(win.getByTestId('project-dashboard')).toContainText('Beta');

  // Seed workspace one's route while it is *not* active, so the live route
  // writer cannot overwrite it. Connections is a place its landing route would
  // never pick on its own, which is what makes the restore observable.
  await win.evaluate(first => {
    localStorage.setItem(`praxis-last-workspace-route:${first}`, JSON.stringify({ feature: 'connections' }));
  }, ids.first);

  await switchTo('Test Workspace');
  await expect(win.getByTestId('connections-page')).toBeVisible();

  // And back again: workspace one's route must not have leaked into two.
  await switchTo('Second Workspace');
  await expect(win.getByTestId('project-dashboard')).toContainText('Beta');
});
