import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

test('first launch offers one folder-first workspace entry flow', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;

  const initialSize = await app.electronApp.evaluate(({ BrowserWindow }) =>
    BrowserWindow.getAllWindows()[0]?.getSize()
  );
  expect(initialSize).toEqual([1664, 936]);

  await expect(win.getByTestId('getting-started')).toBeVisible();
  await expect(win.getByRole('heading', { name: 'Open a workspace' })).toBeVisible();
  await expect(win.getByTestId('main-content-pane')).toHaveCount(0);
  await expect(win.getByRole('button', { name: /Open Folder/ })).toBeVisible();
  await expect(win.getByRole('button', { name: /New Workspace/ })).toBeVisible();
  await expect(win.getByRole('button', { name: 'Open Workspace File' })).toBeVisible();
  await win.screenshot({ path: 'output/playwright/getting-started-dark.png', fullPage: true });

  await win.getByRole('button', { name: /New Workspace/ }).click();
  await expect(win.getByRole('heading', { name: 'Give your work a home' })).toBeVisible();
  await expect(win.getByRole('textbox', { name: 'Workspace name' })).toBeEditable();
  await expect(win.getByRole('textbox')).toHaveCount(1);
});

test('opening an existing folder creates a portable workspace and file-only project', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-open-folder-'));
  fs.writeFileSync(path.join(folder, 'README.md'), '# Existing folder\n');
  fs.mkdirSync(path.join(folder, 'docs', 'plans', 'features', 'fx-test'), { recursive: true });
  fs.writeFileSync(path.join(folder, 'docs', 'plans', 'features', 'fx-test', 'feature.md'), '# Test feature\n\n**Type:** Feature\n**Status:** Proposed\n');
  try {
    await app.electronApp.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, folder);

    await expect(win.getByRole('button', { name: /Open Folder/ })).toBeVisible();
    await win.screenshot({ path: 'output/playwright/getting-started-open-folder.png', fullPage: true });
    await win.getByRole('button', { name: /Open Folder/ }).click();
    await expect(win.getByTestId('project-home')).toContainText('praxis-open-folder-');
    await expect(win.getByText('File structure', { exact: true })).toBeVisible();
    await win.screenshot({ path: 'output/playwright/open-existing-folder.png', fullPage: true });

    const state = await win.evaluate(async () => {
      const workspace = (await window.praxis.workspaces.list()).find(item => item.name.startsWith('praxis-open-folder-'));
      const project = (await window.praxis.projects.list()).find(item => item.workspaceFolder?.includes('praxis-open-folder-'));
      return { workspace, project };
    });
    const expectedWorkspacePath = path.join(folder, `${path.basename(folder).toLowerCase()}.workspace.praxis.json`);
    expect(state.workspace?.storagePath).toBe(expectedWorkspacePath);
    expect(state.project?.planningMode).toBe('files');
    expect(state.project?.workspaceFolder).toBe(folder);
    expect(fs.existsSync(path.join(folder, 'project.praxis.md'))).toBe(true);
    expect(fs.existsSync(state.workspace!.storagePath!)).toBe(true);
    await win.getByTestId('project-add-board').click();
    await expect(win.getByTestId('planning-source-detected-plans')).toBeVisible();
    await win.getByTestId('project-planning-source-dialog').screenshot({ path: 'output/playwright/planning-source-detected.png' });
    await win.getByTestId('planning-source-detected-plans').click();
    await expect(win.getByTestId('project-default-board-nav-item')).toBeVisible();
    const plannedProject = await win.evaluate(async projectId => window.praxis.projects.get(projectId), state.project!.id);
    expect(plannedProject?.planningMode).toBe('board');
    expect(plannedProject?.storage).toBe('folder');

    const reopened = await win.evaluate(folderPath => window.praxis.workspaces.openFolder(folderPath), folder);
    expect(reopened?.id).toBe(state.workspace?.id);
    const document = JSON.parse(fs.readFileSync(state.workspace!.storagePath!, 'utf8')) as { workspace: { projectIds: string[] } };
    expect(document.workspace.projectIds).toEqual([state.project!.id]);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('workspace setup can be skipped to the empty Praxis shell', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;

  await expect(win.getByRole('heading', { name: 'Open a workspace' })).toBeVisible();
  await win.getByRole('button', { name: 'Continue without opening' }).click();
  await expect(win.getByTestId('getting-started')).toHaveCount(0);
  await expect(win.getByTestId('main-content-pane')).toBeVisible();

  // Skipping means "get out of my way", not "leave me stranded". Without an
  // active workspace the shell cannot create a project at all: the wizard
  // bounces straight back to Getting Started and the New menu's import entry is
  // disabled. So a skip still lands on a usable workspace.
  expect(await win.evaluate(() => window.praxis.workspaces.list().then(list => list.length))).toBe(1);
  await win.getByTestId('new-menu').click();
  await win.getByTestId('new-project').click();
  await expect(win.getByTestId('add-project-options')).toBeVisible();
  await expect(win.getByTestId('getting-started')).toHaveCount(0);
});

test('workspace setup offers project handoff and cancelling the wizard opens the empty shell', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;

  await win.getByRole('button', { name: /New Workspace/ }).click();
  await win.getByRole('textbox', { name: 'Workspace name' }).fill('Client Delivery');
  await win.getByRole('button', { name: 'Create Workspace' }).click();
  await expect(win.getByTestId('workspace-created-actions')).toBeVisible();
  await expect(win.getByRole('button', { name: /Add Project/ })).toBeVisible();

  await win.getByRole('button', { name: /Add Project/ }).click();
  await expect(win.getByTestId('add-project-options')).toBeVisible();
  await expect(win.getByTestId('add-project-open-folder')).toBeVisible();
  await expect(win.getByTestId('add-project-new-folder')).toBeVisible();
  await expect(win.getByTestId('add-project-no-folder')).toBeVisible();
  await win.screenshot({ path: 'output/playwright/add-project-options.png', fullPage: true });
  await win.getByTestId('add-project-new-folder').click();
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

test('workspace Add Project opens a folder without a board and adds planning later', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-quick-start-'));
  fs.writeFileSync(path.join(folder, 'README.md'), '# Notes\n');
  fs.mkdirSync(path.join(folder, 'docs'));
  try {
    await app.electronApp.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, folder);

    await win.getByRole('button', { name: /New Workspace/ }).click();
    await win.getByRole('textbox', { name: 'Workspace name' }).fill('File Workspace');
    await win.getByRole('button', { name: 'Create Workspace' }).click();
    await expect(win.getByTestId('workspace-created-actions')).toBeVisible();
    await win.getByRole('button', { name: /Add Project/ }).click();
    await win.getByTestId('add-project-open-folder').click();
    await win.getByRole('button', { name: 'Choose folder…' }).click();
    await win.getByRole('button', { name: 'Continue' }).click();
    await win.getByRole('button', { name: 'Continue' }).click();
    await win.getByRole('button', { name: 'Add project' }).click();

    await expect(win.getByTestId('project-home')).toContainText('praxis-quick-start-');
    await expect(win.getByText('File structure', { exact: true })).toBeVisible();
    const state = await win.evaluate(async () => {
      const project = (await window.praxis.projects.list()).at(-1);
      const connections = await window.praxis.connection.list();
      return {
        project,
        ownedConnection: project ? connections.some(connection => connection.settings.projectId === project.id) : false
      };
    });
    expect(state.project?.planningMode).toBe('files');
    expect(state.project?.workspaceFolder).toBe(folder);
    expect(state.project?.linkedBoards).toEqual([]);
    expect(state.ownedConnection).toBe(false);
    expect(fs.existsSync(path.join(folder, 'project.praxis.md'))).toBe(true);
    await expect(win.getByTestId('project-tree').getByText('Boards')).toHaveCount(0);
    await expect(win.getByTestId('toggle-boards')).toHaveCount(0);
    await win.screenshot({ path: 'output/playwright/quick-start-file-only.png', fullPage: true });

    await win.getByTestId('project-add-board').click();
    await expect(win.getByTestId('project-planning-source-dialog')).toBeVisible();
    await win.getByTestId('project-planning-source-dialog').scrollIntoViewIfNeeded();
    await win.getByTestId('project-planning-source-dialog').screenshot({ path: 'output/playwright/planning-source-options.png' });
    await win.getByTestId('planning-source-local-board').click();
    await expect(win.getByTestId('project-default-board-nav-item')).toBeVisible();
    await win.screenshot({ path: 'output/playwright/quick-start-with-board.png', fullPage: true });
    const boardState = await win.evaluate(async () => {
      const project = (await window.praxis.projects.list()).at(-1);
      const connections = await window.praxis.connection.list();
      return {
        planningMode: project?.planningMode,
        ownedConnection: project ? connections.some(connection => connection.settings.projectId === project.id) : false
      };
    });
    expect(boardState.planningMode).toBe('board');
    expect(boardState.ownedConnection).toBe(true);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('advanced project setup remains available without forcing a board', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { workspace: false });
  const win = app.window;

  await expect(win.getByRole('heading', { name: 'Open a workspace' })).toBeVisible();
  await win.getByRole('button', { name: /New Workspace/ }).click();
  await expect(win.getByRole('heading', { name: 'Give your work a home' })).toBeVisible();
  await win.screenshot({ path: 'output/playwright/full-onboarding-01-workspace.png', fullPage: true });
  await win.getByRole('textbox', { name: 'Workspace name' }).fill('Product Studio');
  await win.getByRole('button', { name: 'Create Workspace' }).click();

  await expect(win.getByTestId('workspace-created-actions')).toBeVisible();
  await win.screenshot({ path: 'output/playwright/full-onboarding-02-workspace-ready.png', fullPage: true });
  await win.getByRole('button', { name: /Add Project/ }).click();
  await win.getByTestId('add-project-no-folder').click();

  await expect(win.getByRole('heading', { name: 'Choose a project type' })).toBeVisible();
  await expect(win.locator('.project-choice')).toHaveCount(4);
  await expect(win.locator('.project-choice').last()).toHaveCSS('opacity', '1');
  await win.screenshot({ path: 'output/playwright/full-onboarding-03-project-type.png', fullPage: true });
  await win.getByRole('button', { name: /Product Development/ }).click();
  // Advanced setup keeps brief and tool access available; planning is deferred.
  await win.getByTestId('wizard-advanced-toggle').check();
  await win.getByRole('button', { name: 'Continue' }).click();

  await expect(win.getByRole('heading', { name: 'Name and locate your project' })).toBeVisible();
  await win.getByRole('textbox', { name: 'Project name', exact: true }).fill('Customer Hub');
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

  await expect(win.getByRole('heading', { name: 'Choose tool access' })).toBeVisible();
  await expect(win.getByText('Project tools only')).toBeVisible();
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
  await expect(win.getByText('File structure', { exact: true })).toBeVisible();
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
  await expect(win.getByRole('heading', { name: 'Open a workspace' })).toBeVisible();
  await expect(win.getByRole('button', { name: /Open Folder/ })).toBeVisible();
  await expect(win.getByRole('button', { name: /New Workspace/ })).toBeVisible();
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
