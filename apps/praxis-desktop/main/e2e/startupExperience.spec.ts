import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

test('first launch leads directly into workspace setup beneath the title bar', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;

  const initialSize = await app.electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getSize()
  );
  expect(initialSize).toEqual([1664, 936]);

  await expect(win.getByTestId('getting-started')).toBeVisible();
  await expect(win.getByRole('heading', { name: 'Give your work a home' })).toBeVisible();
  await expect(win.getByTestId('main-content-pane')).toHaveCount(0);
  await expect(win.getByRole('textbox', { name: 'Workspace name' })).toBeEditable();
  await win.screenshot({ path: 'output/playwright/getting-started-dark.png', fullPage: true });
});

test('workspace setup can be skipped to the empty Praxis shell', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;

  await expect(win.getByRole('heading', { name: 'Give your work a home' })).toBeVisible();
  await win.getByRole('button', { name: 'Skip for now' }).click();
  await expect(win.getByTestId('getting-started')).toHaveCount(0);
  await expect(win.getByTestId('main-content-pane')).toBeVisible();
  await expect(win.getByRole('button', { name: 'Select workspace' })).toBeVisible();
});

test('workspace setup offers project handoff and cancelling the wizard opens the empty shell', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;

  await win.getByRole('textbox', { name: 'Workspace name' }).fill('Client Delivery');
  await win.getByRole('textbox', { name: /Description/ }).fill('Release planning');
  await win.getByRole('button', { name: 'Create Workspace' }).click();
  await expect(win.getByTestId('workspace-created-actions')).toBeVisible();
  await expect(win.getByRole('button', { name: /Create New Project/ })).toBeVisible();
  await expect(win.getByRole('button', { name: /Create from existing folder/ })).toBeVisible();

  await win.getByRole('button', { name: /Create New Project/ }).click();
  await expect(win.getByTestId('project-wizard-onboarding')).toBeVisible();
  await expect(win.getByRole('heading', { name: 'Choose a project type' })).toBeVisible();
  await expect(win.locator('.project-choice')).toHaveCount(4);
  await expect(win.locator('.project-choice').last()).toHaveCSS('opacity', '1');
  await win.screenshot({ path: 'output/playwright/project-wizard-onboarding.png', fullPage: true });
  await win.getByRole('button', { name: /Product Development/ }).click();
  await win.getByRole('button', { name: 'Continue' }).click();
  await expect(win.getByRole('heading', { name: 'Name and locate your project' })).toBeVisible();
  await expect(win.getByLabel('Project name')).toBeFocused();
  await win.screenshot({ path: 'output/playwright/project-wizard-onboarding-details.png', fullPage: true });
  await win.getByRole('button', { name: 'Cancel' }).click();
  await expect(win.getByTestId('getting-started')).toHaveCount(0);
  await expect(win.getByRole('button', { name: 'Select workspace' })).toContainText('Client Delivery');
});

test('walks through every workspace and project onboarding screen to a created project', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;

  await expect(win.getByRole('heading', { name: 'Give your work a home' })).toBeVisible();
  await win.screenshot({ path: 'output/playwright/full-onboarding-01-workspace.png', fullPage: true });
  await win.getByRole('textbox', { name: 'Workspace name' }).fill('Product Studio');
  await win.getByRole('textbox', { name: /Description/ }).fill('Customer product planning and delivery');
  await win.getByRole('button', { name: 'Create Workspace' }).click();

  await expect(win.getByTestId('workspace-created-actions')).toBeVisible();
  await win.screenshot({ path: 'output/playwright/full-onboarding-02-workspace-ready.png', fullPage: true });
  await win.getByRole('button', { name: /Create New Project/ }).click();

  await expect(win.getByRole('heading', { name: 'Choose a project type' })).toBeVisible();
  await expect(win.locator('.project-choice')).toHaveCount(4);
  await expect(win.locator('.project-choice').last()).toHaveCSS('opacity', '1');
  await win.screenshot({ path: 'output/playwright/full-onboarding-03-project-type.png', fullPage: true });
  await win.getByRole('button', { name: /Product Development/ }).click();
  await win.getByRole('button', { name: 'Continue' }).click();

  await expect(win.getByRole('heading', { name: 'Name and locate your project' })).toBeVisible();
  await win.getByRole('textbox', { name: 'Project name', exact: true }).fill('Customer Hub');
  await win.getByRole('button', { name: /Keep in Praxis only/ }).click();
  await win.screenshot({ path: 'output/playwright/full-onboarding-04-name-location.png', fullPage: true });
  await win.getByRole('button', { name: 'Continue' }).click();

  await expect(win.getByRole('heading', { name: 'A useful brief is ready' })).toHaveCount(0);
  await expect(win.getByText('Deliver the smallest coherent release that can test the core value.')).toBeVisible();
  await expect(win.locator('.brief-section-option')).toHaveCount(6);
  // The recommended brief for the type is included by default.
  await expect(win.locator('.brief-section-option.included')).toHaveCount(6);
  await expect(win.getByRole('button', { name: 'Deselect MVP' })).toHaveAttribute('aria-pressed', 'true');
  await win.screenshot({ path: 'output/playwright/full-onboarding-05-guided-brief.png', fullPage: true });
  await win.getByRole('button', { name: 'Continue' }).click();

  await expect(win.getByRole('heading', { name: 'Set up the initial plan' })).toBeVisible();
  await expect(win.locator('.plan-section-heading > span')).toHaveCount(0);
  await expect(win.getByRole('button', { name: 'Recommended: Standard product development workflow' })).toHaveAttribute('aria-pressed', 'true');
  await expect(win.getByRole('button', { name: 'Recommended: Add suggested tickets' })).toHaveAttribute('aria-pressed', 'true');
  await expect(win.locator('.plan-illustration')).toHaveCount(0);
  await win.screenshot({ path: 'output/playwright/full-onboarding-06-initial-plan.png', fullPage: true });
  await win.getByRole('button', { name: 'Continue' }).click();

  await expect(win.getByRole('heading', { name: 'Choose tool access' })).toBeVisible();
  await expect(win.getByText('Project-board tools only')).toBeVisible();
  await expect(win.locator('.tool-access-illustration')).toHaveCount(0);
  await win.screenshot({ path: 'output/playwright/full-onboarding-07-tool-access.png', fullPage: true });
  await win.getByRole('button', { name: 'Continue' }).click();

  await expect(win.getByRole('heading', { name: 'Review and create' })).toBeVisible();
  await expect(win.getByText('Praxis only — no local folder')).toBeVisible();
  await expect(win.locator('.review-illustration, .review-project-card, .review-details-card')).toHaveCount(0);
  await expect(win.locator('.review-summary-list > div')).toHaveCount(4);
  await expect(win.getByText('6 brief sections drafted')).toBeVisible();
  await win.screenshot({ path: 'output/playwright/full-onboarding-08-review.png', fullPage: true });
  await win.getByRole('button', { name: 'Create project' }).click();

  await expect(win.getByTestId('project-home')).toContainText('Customer Hub');
  await expect(win.getByRole('button', { name: 'Select workspace' })).toContainText('Product Studio');
  await win.screenshot({ path: 'output/playwright/full-onboarding-09-created-project.png', fullPage: true });
});

test('reopens a validated workspace and its last durable route', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const firstWindow = app.window;
  await firstWindow.evaluate(async () => {
    const workspace = await window.praxis.workspaces.create({ name: 'Client Delivery', projectIds: [] });
    localStorage.setItem('praxis-active-workspace', workspace.id);
  });
  await firstWindow.reload();
  await expect(firstWindow.getByRole('button', { name: 'Select workspace' })).toContainText('Client Delivery');
  await firstWindow.getByTestId('nav-connections').click();
  await expect(firstWindow.getByTestId('connections-page')).toBeVisible();

  await app.electronApp.close();
  app = await launchTestApp(undefined, {
    userDataDir: app.userDataDir,
    settingsPath: app.settingsPath
  }, undefined, { workspace: false });

  await expect(app.window.getByRole('button', { name: 'Select workspace' })).toContainText('Client Delivery');
  await expect(app.window.getByTestId('connections-page')).toBeVisible();
});

test('disabled restoration and a missing saved workspace both fail safely to Getting Started', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;
  await win.evaluate(async () => {
    const workspace = await window.praxis.workspaces.create({ name: 'Recent Workspace', projectIds: [] });
    localStorage.setItem('praxis-active-workspace', workspace.id);
    localStorage.setItem('praxis-recent-workspaces', JSON.stringify([workspace.id, 'workspace-deleted']));
    await window.praxis.settings.set({ startup: { reopenLastWorkspace: false } });
  });
  await win.reload();

  await expect(win.getByTestId('getting-started')).toBeVisible();
  await expect(win.getByRole('heading', { name: 'Open a workspace' })).toBeVisible();
  await expect(win.getByRole('button', { name: /Recent Workspace/ })).toBeVisible();
  expect(await win.evaluate(() => JSON.parse(localStorage.getItem('praxis-recent-workspaces') ?? '[]'))).not.toContain('workspace-deleted');

  await win.evaluate(async () => {
    await window.praxis.settings.set({ startup: { reopenLastWorkspace: true } });
    localStorage.setItem('praxis-active-workspace', 'workspace-deleted');
  });
  await win.reload();
  await expect(win.getByTestId('getting-started')).toBeVisible();
});

test('Getting Started remains usable in a narrow reduced-motion window and light theme', { tag: '@theme' }, async () => {
  app = await launchTestApp({ appearance: { themeId: 'praxis-light', themeMode: 'light' } }, undefined, undefined, { workspace: false });
  const win = app.window;
  await win.setViewportSize({ width: 620, height: 720 });
  await win.emulateMedia({ reducedMotion: 'reduce' });

  await expect(win.locator('html')).toHaveAttribute('data-mode', 'light');
  await expect(win.getByTestId('getting-started')).toBeVisible();
  await expect(win.getByRole('textbox', { name: 'Workspace name' })).toBeVisible();
  await win.screenshot({ path: 'output/playwright/getting-started-light-narrow.png', fullPage: true });
});

test('recent workspaces follow actual opens, show five, and expose View all', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;
  const names = ['One', 'Two', 'Three', 'Four', 'Five', 'Six'];
  await win.evaluate(async workspaceNames => {
    const created = [];
    for (const name of workspaceNames) created.push(await window.praxis.workspaces.create({ name, projectIds: [] }));
    localStorage.setItem('praxis-active-workspace', created[0].id);
  }, names);
  await win.reload();

  for (const name of names) {
    await win.getByRole('button', { name: 'Select workspace' }).click();
    await win.getByRole('menuitem', { name, exact: true }).click();
  }
  await win.evaluate(() => window.praxis.settings.set({ startup: { reopenLastWorkspace: false } }));
  await win.reload();

  await expect(win.locator('.getting-started-recent')).toHaveCount(5);
  await expect(win.locator('.getting-started-recent strong')).toHaveText(['Six', 'Five', 'Four', 'Three', 'Two']);
  const openWorkspaceLayout = await win.locator('.getting-started').evaluate(element => ({
    overflowY: getComputedStyle(element).overflowY
  }));
  expect(openWorkspaceLayout.overflowY).toBe('hidden');
  await win.getByRole('button', { name: 'View all workspaces' }).click();
  await expect(win.locator('.getting-started-recent')).toHaveCount(6);
});
