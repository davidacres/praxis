import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

/**
 * The sidebar seeds a single "My Workspace" the first time the app has projects
 * but no saved workspaces. That seeding must not run again once a workspace
 * exists — on relaunch `projects.list()` resolves before `workspaces.list()`, so
 * a bootstrap that only checks the in-memory workspace count re-seeds and the
 * switcher then lists "My Workspace" twice.
 */
test('does not seed a second "My Workspace" across relaunches', async () => {
  app = await launchTestApp();
  let win = app.window;

  await win.evaluate(() => window.praxis.projects.create({
    name: 'Portal', key: 'PORTAL', type: 'product', purpose: 'Switcher seeding', brief: {},
    startingPoint: 'app-storage',
    workflowStages: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }],
    starterTickets: [{ summary: 'First task', description: 'Placeholder', issueType: 'Task', status: 'todo' }],
    defaultAiToolMode: 'read-only'
  }));
  await win.reload();

  const openSwitcher = async () => {
    await win.getByRole('button', { name: 'Select workspace' }).click();
    return win.locator('.workspace-menu');
  };

  // First launch: exactly one seeded workspace.
  await expect(win.getByTestId('project-nav-item').filter({ hasText: 'Portal' })).toBeVisible();
  let menu = await openSwitcher();
  await expect(menu.locator('button', { hasText: 'My Workspace' })).toHaveCount(1);
  await win.keyboard.press('Escape');

  await expect
    .poll(() => win.evaluate(() => window.praxis.workspaces.list().then(w => w.length)))
    .toBe(1);

  // Relaunch into the same profile — the seed must not run a second time.
  const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  app = await launchTestApp(undefined, reuse);
  win = app.window;

  await expect(win.getByTestId('project-nav-item').filter({ hasText: 'Portal' })).toBeVisible();
  menu = await openSwitcher();
  await expect(menu.locator('button', { hasText: 'My Workspace' })).toHaveCount(1);

  expect(await win.evaluate(() => window.praxis.workspaces.list().then(w => w.length))).toBe(1);
});

/**
 * The switcher's per-row trash icon removes a saved workspace (the grouped
 * projects are untouched). This is the only in-app way to clear a stray
 * workspace — e.g. a duplicate left behind by the pre-fix seeding bug.
 */
test('trash icon in the switcher deletes a saved workspace', async () => {
  app = await launchTestApp();
  const win = app.window;

  const projectId = await win.evaluate(() => window.praxis.projects.create({
    name: 'Portal', key: 'PORTAL', type: 'product', purpose: 'Delete workspace', brief: {},
    startingPoint: 'app-storage',
    workflowStages: [{ id: 'todo', name: 'Todo' }, { id: 'done', name: 'Done' }],
    starterTickets: [{ summary: 'First task', description: 'Placeholder', issueType: 'Task', status: 'todo' }],
    defaultAiToolMode: 'read-only'
  }).then(project => project.id));
  await win.reload(); // seeds "My Workspace"

  // Let the seed finish before adding a second workspace — creating one while
  // the seed's write is still in flight races two saves onto the same file.
  await expect
    .poll(() => win.evaluate(() => window.praxis.workspaces.list().then(w => w.length)))
    .toBe(1);

  // A second workspace alongside the seed. It carries the project too, so the
  // Projects tree stays populated whichever workspace ends up active.
  await win.evaluate(id => window.praxis.workspaces.create({ name: 'Client work', description: '', projectIds: [id] }), projectId);
  await win.reload();

  await expect(win.getByTestId('project-nav-item').filter({ hasText: 'Portal' })).toBeVisible();
  await win.getByRole('button', { name: 'Select workspace' }).click();
  const menu = win.locator('.workspace-menu');
  await expect(menu.locator('.workspace-menu-row')).toHaveCount(2);

  await menu.getByRole('button', { name: 'Delete workspace Client work' }).click();

  await expect(menu.locator('.workspace-menu-row')).toHaveCount(1);
  await expect(menu.locator('.workspace-menu-row', { hasText: 'My Workspace' })).toHaveCount(1);
  expect(await win.evaluate(() => window.praxis.workspaces.list().then(w => w.length))).toBe(1);
});
