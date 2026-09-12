import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { ProjectStore, WorkspaceStore, defaultProjectTickets, defaultProjectWorkflow, localToolDefinitionsForMode, type KeyValueStore, type ProjectType } from '@praxis/core';
import { ProjectManager } from '../src/main/projectManager';

let app: TestApp;

test.beforeEach(async () => { app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false }); });
test.afterEach(async () => { await closeTestApp(app); });

test('creates a folderless Product project through the full wizard and opens its board', async () => {
  const page = app.window;
  await expect(page.getByTestId('overview-page')).toBeVisible();
  await page.getByTestId('new-menu').click();
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('new-project-wizard')).toBeVisible();

  // A first project is three steps by default; Advanced setup restores all six,
  // which this test walks for full coverage.
  await expect(page.locator('.step-count')).toHaveText('Step 1 of 3');
  await expect(page).toHaveScreenshot('project-wizard-type.png');
  await page.getByRole('button', { name: /Product Development/ }).click();
  await page.getByTestId('wizard-advanced-toggle').check();
  await expect(page.locator('.step-count')).toHaveText('Step 1 of 6');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Project name').fill('Customer Portal');
  await page.getByRole('button', { name: /Keep in Praxis only/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  // The recommended brief for the type is included by default — a first-time
  // user gets a real brief to react to, not six empty slots to opt into.
  await expect(page.getByText('Start with the primary users closest to the problem and refine the audience with evidence.')).toBeVisible();
  await expect(page.locator('.brief-section-option.included')).toHaveCount(6);
  await expect(page.getByRole('button', { name: 'Deselect Target users' })).toHaveAttribute('aria-pressed', 'true');

  // A card can be deselected and reselected.
  await page.getByRole('button', { name: 'Deselect Target users' }).click();
  await expect(page.getByRole('button', { name: 'Select Target users' })).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('.brief-section-option.included')).toHaveCount(5);
  await page.getByRole('button', { name: 'Select Target users' }).click();
  await expect(page.getByRole('button', { name: 'Deselect Target users' })).toHaveAttribute('aria-pressed', 'true');

  // The customize editor opens, a starter fills the field, Done applies it.
  const customizeTargetUsers = page.getByRole('button', { name: 'Customize Target users' });
  await customizeTargetUsers.hover();
  await expect(customizeTargetUsers).toHaveCSS('width', '78px');
  await page.screenshot({ path: 'output/playwright/project-wizard-customize-hover.png', fullPage: true });
  await customizeTargetUsers.click();
  await expect(page.locator('.brief-section-layout')).toHaveClass(/editor-open/);
  expect(await page.locator('.brief-editor-reveal').evaluate(element => getComputedStyle(element).transitionDuration)).not.toBe('0s');
  await page.getByRole('button', { name: 'Use example' }).click();
  await expect(page.getByRole('textbox', { name: 'Target users', exact: true })).toHaveValue('Support leads at growing SaaS companies who manage 5–20 agents.');
  await page.screenshot({ path: 'output/playwright/project-wizard-brief-editor-open.png', fullPage: true });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.brief-section-layout')).not.toHaveClass(/editor-open/);
  await expect(page.getByRole('button', { name: 'Deselect Target users' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.brief-section-option.included .brief-section-selected')).toHaveCount(6);
  await page.screenshot({ path: 'output/playwright/project-wizard-guided-brief.png', fullPage: true });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.locator('.plan-illustration')).toHaveCount(0);
  await expect(page.locator('.plan-section-heading > span')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Recommended: Standard product development workflow' })).toBeVisible();
  await page.getByRole('button', { name: 'Simple: To do and Done' }).click();
  await expect(page.getByRole('button', { name: 'Simple: To do and Done' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Custom: Choose the stages' }).click();
  await expect(page.locator('.plan-custom-editor').first().getByLabel('Workflow stage 1')).toBeVisible();
  await page.getByRole('button', { name: 'Recommended: Standard product development workflow' }).click();
  await page.getByRole('button', { name: 'Custom: Edit starter tickets' }).click();
  await expect(page.locator('.ticket-edit')).toHaveCount(5);
  await page.screenshot({ path: 'output/playwright/project-wizard-guided-plan-custom.png', fullPage: true });
  await page.getByRole('button', { name: 'Recommended: Add suggested tickets' }).click();
  await page.screenshot({ path: 'output/playwright/project-wizard-guided-plan.png', fullPage: true });
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Project-board tools only')).toBeVisible();
  await expect(page.getByText('Session access', { exact: true })).toHaveCount(0);
  await expect(page.locator('.tool-access-illustration')).toHaveCount(0);
  await expect(page.locator('.access-choice.selected .access-choice-check')).toHaveText('✓');
  expect(await page.locator('.access-choice').evaluate(element => getComputedStyle(element).minHeight)).toBe('96px');
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('No AI session starts during project creation.')).toBeVisible();
  await expect(page.locator('.review-illustration, .review-project-card, .review-details-card')).toHaveCount(0);
  await expect(page.locator('.review-summary-list > div')).toHaveCount(4);
  await expect(page).toHaveScreenshot('project-wizard-review.png');
  await page.getByTestId('new-project-wizard').getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByTestId('project-home')).toContainText('Customer Portal');
  await expect(page.getByTestId('project-dashboard')).toBeVisible();
  await expect(page.getByTestId('project-dashboard')).not.toContainText('Boards');
  await expect(page.getByTestId('project-dashboard')).not.toContainText('Repository');
  await expect(page.getByTestId('project-dashboard')).toContainText('Work progress');
  await expect(page.getByTestId('project-dashboard')).toContainText('Recent activity');
  const projectTree = page.getByTestId('project-tree').filter({ hasText: 'Customer Portal' });
  await expect(page.getByTestId('nav-board')).toHaveCount(0);
  await expect(page.getByTestId('board-nav-item').filter({ hasText: 'Customer Portal Board' })).toHaveCount(0);
  await expect(projectTree.getByTestId('project-default-board-nav-item')).toContainText('Customer Portal Board');
  await expect(projectTree.getByText('Default', { exact: true })).toBeVisible();
  await expect(projectTree.getByText('Repository', { exact: true })).toBeVisible();
  const themedColors = await projectTree.evaluate(tree => ({
    accent: getComputedStyle(document.documentElement).getPropertyValue('--accent').trim(),
    projectIcon: getComputedStyle(tree.querySelector('.project-icon')!).color,
    boardIcon: getComputedStyle(tree.querySelector('.project-board-icon')!).color
  }));
  expect(themedColors.projectIcon).toBe('rgb(198, 67, 31)');
  expect(themedColors.accent).toBe('#c6431f');
  expect(themedColors.boardIcon).toBe('rgb(116, 105, 94)');
  // A freshly-created project lands with a Get Started strip: one lit action
  // and a small checklist, not four zero cards.
  const getStarted = page.getByTestId('project-getstarted');
  await expect(getStarted).toBeVisible();
  await expect(getStarted).toContainText('Project created');
  await expect(getStarted).toContainText('6/6 sections');
  await expect(getStarted.getByTestId('project-getstarted-start')).toBeVisible();
  // The created date is today's, so it is masked — an unmasked baseline here
  // goes red at midnight on a change that has nothing to do with the app.
  await expect(page).toHaveScreenshot('project-home.png', {
    mask: [page.getByTestId('project-created-date')],
    maxDiffPixels: 200
  });
  await getStarted.getByRole('button', { name: 'Dismiss' }).click();
  await expect(page.getByTestId('project-getstarted')).toHaveCount(0);
  const stored = await page.evaluate(() => window.praxis.projects.list());
  const created = stored.find(project => project.key === 'CUSTOMER');
  expect(created?.defaultAiToolMode).toBe('project-only');
  // The recommended brief ships whole; Target users was rewritten from the example.
  expect(created?.brief.users).toBe('Support leads at growing SaaS companies who manage 5–20 agents.');
  expect(created?.brief.problem).toBe('Validate the users’ current difficulty before choosing a solution.');
  expect(created?.brief.mvp).toBe('Deliver the smallest coherent release that can test the core value.');
  expect(Object.values(created?.brief ?? {}).filter(Boolean)).toHaveLength(6);
  expect(created?.workItems).toHaveLength(5);
  // FX-BE-046 — the workflow is data the user owns, not a value frozen at
  // creation. Every stage carries a category (FX-BE-043) and the last one is
  // what "done" means.
  expect(created?.workflowStages.map(stage => stage.category)).toEqual([
    'todo', 'todo', 'indeterminate', 'indeterminate', 'indeterminate', 'done'
  ]);
  const workflowPanel = page.getByTestId('project-workflow');
  await expect(workflowPanel).toBeVisible();
  await expect(workflowPanel.getByTestId('workflow-stage-0')).toContainText('Backlog');
  await expect(workflowPanel.getByTestId('workflow-stage-5')).toContainText('Done');

  // Rename a stage and add one, then save — the record must follow.
  await page.getByRole('button', { name: 'Edit project' }).click();
  await workflowPanel.getByRole('textbox', { name: 'Stage 2 name' }).fill('Shaping');
  await workflowPanel.getByTestId('workflow-add-stage').click();
  await page.getByRole('button', { name: 'Save' }).click();
  await expect(workflowPanel.getByTestId('workflow-stage-1')).toContainText('Shaping');

  const afterEdit = (await page.evaluate(() => window.praxis.projects.list()))
    .find(project => project.key === 'CUSTOMER');
  expect(afterEdit?.workflowStages.map(stage => stage.name)).toContain('Shaping');
  expect(afterEdit?.workflowStages).toHaveLength(7);
  // The stage that means done stays last however the list is edited.
  expect(afterEdit?.workflowStages[afterEdit.workflowStages.length - 1].category).toBe('done');

  // Project surfaces — including the detail panels — must inherit the active
  // application theme instead of painting an opaque default background over the
  // themed panes. The panels are borderless and carry no surface of their own.
  await page.locator('[data-testid="titlebar-settings"]').click();
  await page.locator('[data-testid="settings-nav-appearance-themes"]').click();
  await page.locator('[data-testid="theme-card-praxis-dark"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'praxis-dark');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'output/playwright/project-dashboard-praxis-dark.png', fullPage: true });
  const projectThemeStyles = await page.evaluate(() => {
    const dashboard = document.querySelector('[data-testid="project-dashboard"]');
    const projectHome = document.querySelector('[data-testid="project-home"]');
    const panel = projectHome?.querySelector('.project-panel');
    return {
      dashboardColor: dashboard ? getComputedStyle(dashboard).color : '',
      dashboardBackground: dashboard ? getComputedStyle(dashboard).backgroundColor : '',
      homeBackground: projectHome ? getComputedStyle(projectHome).backgroundColor : '',
      panelBackground: panel ? getComputedStyle(panel).backgroundColor : '',
      panelBorderWidth: panel ? getComputedStyle(panel).borderTopWidth : ''
    };
  });
  expect(projectThemeStyles.dashboardColor).not.toBe('');
  expect(projectThemeStyles.dashboardBackground).toMatch(/rgba?\(0, 0, 0, 0\)/);
  expect(projectThemeStyles.homeBackground).toMatch(/rgba?\(0, 0, 0, 0\)/);
  expect(projectThemeStyles.panelBackground).toMatch(/rgba?\(0, 0, 0, 0\)/);
  expect(projectThemeStyles.panelBorderWidth).toBe('0px');

  await projectTree.getByTestId('project-default-board-nav-item').click();
  await expect(page.getByTestId('issue-card')).toHaveCount(5);
  await page.getByTestId('mode-work').click();
  const workProject = page.getByTestId('work-project').filter({ hasText: 'Customer Portal' });
  await expect(workProject).toContainText('1 board');
  await expect(workProject.getByTestId('work-card')).toContainText('Customer Portal Board');
  await page.getByTestId('new-menu').click();
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('project-empty-state')).toContainText('Create a new project');
});

test('opens a focused Create from existing folder flow from the New menu', async () => {
  const page = app.window;
  const repoInspection = await page.evaluate(folder => window.praxis.projects.inspectFolder(folder), path.resolve(__dirname, '../../../..'));
  expect(repoInspection.planFiles?.length ?? 0).toBeGreaterThan(0);
  await page.getByTestId('new-menu').click();
  const triggerBox = await page.getByTestId('new-menu').boundingBox();
  const menuBox = await page.getByRole('menu').boundingBox();
  expect(triggerBox).not.toBeNull();
  expect(menuBox).not.toBeNull();
  expect(menuBox!.y).toBeGreaterThanOrEqual(triggerBox!.y + triggerBox!.height);
  expect(Math.abs(menuBox!.x - triggerBox!.x)).toBeLessThanOrEqual(1);
  const menuIsTopmost = await page.getByRole('menu').evaluate(menu => {
    const box = menu.getBoundingClientRect();
    const point = document.elementFromPoint(box.right - 4, box.top + 12);
    return point === menu || menu.contains(point);
  });
  expect(menuIsTopmost).toBe(true);
  await expect(page.getByTestId('new-project')).toContainText('Create New Project');
  await page.getByTestId('add-existing-project').click();
  await expect(page.getByRole('dialog', { name: 'Create from existing folder' })).toBeVisible();
  await expect(page.getByText('Choose the existing folder')).toBeVisible();
  await expect(page.getByText('Workspace detection will appear here')).toBeVisible();
  await expect(page).toHaveScreenshot('add-existing-project.png');
  await page.getByRole('button', { name: 'Close new project dialog' }).click();
  await expect(page.getByTestId('new-project-wizard')).not.toBeVisible();
});

test('a first project is three steps: type, name, review', async () => {
  const page = app.window;
  await expect(page.getByTestId('overview-page')).toBeVisible();
  await page.getByTestId('new-menu').click();
  await page.getByTestId('new-project').click();

  await expect(page.locator('.step-count')).toHaveText('Step 1 of 3');
  await page.getByRole('button', { name: /Product Development/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();

  await expect(page.locator('.step-count')).toHaveText('Step 2 of 3');
  await page.getByLabel('Project name').fill('Quick Start');
  await page.getByRole('button', { name: 'Continue' }).click();

  // Straight to review — the brief, plan and tool-access steps took defaults.
  await expect(page.locator('.step-count')).toHaveText('Step 3 of 3');
  await expect(page.getByRole('heading', { name: 'Review and create' })).toBeVisible();
  await expect(page.getByText('6 brief sections drafted')).toBeVisible();
  await expect(page.getByText('Praxis only — no local folder')).toBeVisible();
  await page.locator('.project-wizard-footer').getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByTestId('project-dashboard')).toContainText('Quick Start');
  const stored = await page.evaluate(() => window.praxis.projects.list());
  const created = stored.find(project => project.name === 'Quick Start');
  expect(Object.values(created?.brief ?? {}).filter(Boolean)).toHaveLength(6);
  expect(created?.workItems).toHaveLength(5);
  expect(created?.defaultAiToolMode).toBe('project-only');
});

test('retains an existing project.praxis.md and supports local board transitions and edits', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-project-existing-'));
  fs.writeFileSync(path.join(folder, 'project.praxis.md'), '# Existing\n');
  try {
    const result = await app.window.evaluate(async folderPath => {
      const workspaceId = (await window.praxis.workspaces.list())[0].id;
      const stages = [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }];
      const project = await window.praxis.projects.create({
        name: 'Existing Workspace', key: 'EXIST', type: 'software', purpose: 'Test', brief: {},
        startingPoint: 'existing-folder', folderPath, workflowStages: stages,
        starterTickets: [{ summary: 'First slice', description: '', issueType: 'Task', status: 'To do' }],
        defaultAiToolMode: 'full'
      }, workspaceId);
      const boards = await window.praxis.board.list({ projectKeys: ['EXIST'], types: [], searchText: '' });
      const board = boards.find(item => item.connectionId === `project:${project.id}`)!;
      const before = await window.praxis.board.get(board);
      await window.praxis.issue.update(before.issues[0].key, { summary: 'Edited slice' }, board.connectionId);
      const issue = await window.praxis.issue.get(before.issues[0].key, board.connectionId);
      const transition = issue?.transitions?.find(item => item.toStatus === 'Done')!;
      await window.praxis.issue.transition(issue!.key, transition.id, board.connectionId);
      return { project, issue: await window.praxis.issue.get(issue!.key, board.connectionId) };
    }, folder);
    expect(result.project.projectFileStatus).toBe('retained');
    expect(result.issue?.summary).toBe('Edited slice');
    expect(result.issue?.status).toBe('Done');
    expect(fs.readFileSync(path.join(folder, 'project.praxis.md'), 'utf8')).toBe('# Existing\n');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('uses a folder connection for an existing-folder project with plans', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-project-plans-'));
  const featureFolder = path.join(folder, 'docs', 'plans', 'features', 'feature-01-imported');
  fs.mkdirSync(featureFolder, { recursive: true });
  fs.writeFileSync(path.join(featureFolder, 'feature.md'), [
    '# Imported planning work', '', '**Status:** 🚧 In Progress', '**Type:** Feature', '',
    '## Description', '', 'This should appear on the project board.', ''
  ].join('\n'));
  try {
    const result = await app.window.evaluate(async folderPath => {
      const workspaceId = (await window.praxis.workspaces.list())[0].id;
      const project = await window.praxis.projects.create({
        name: 'Imported Plans', key: 'IMPORTED', type: 'software', purpose: '', brief: {},
        startingPoint: 'existing-folder', folderPath, storage: 'folder', workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
        starterTickets: [], defaultAiToolMode: 'read-only'
      }, workspaceId);
      const connection = (await window.praxis.connection.list()).find(
        item => item.settings.projectId === project.id
      );
      const boards = await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' });
      const board = boards.find(item => item.connectionId === connection?.id);
      return { project, connection, board, details: board ? await window.praxis.board.get(board) : undefined };
    }, folder);
    expect(result.connection?.mode).toBe('folder');
    expect(result.board?.name).toBe('Imported Plans');
    expect(result.details?.issues).toHaveLength(1);
    expect(result.details?.issues[0].summary).toBe('Imported planning work');
    await app.window.reload();
    const projectTree = app.window.getByTestId('project-tree').filter({ hasText: 'Imported Plans' });
    await expect(projectTree.getByTestId('project-default-board-nav-item')).toContainText('Imported Plans');
    await expect(app.window.locator('.sidebar').getByTestId('board-nav-item').filter({ hasText: 'Imported Plans' })).toHaveCount(0);
    await projectTree.getByTestId('project-default-board-nav-item').click();
    await expect(app.window.getByTestId('issue-card')).toContainText('Imported planning work');
    const importedPlan = projectTree.getByTestId('project-document-nav-item').filter({ hasText: 'Imported planning work' });
    await expect(importedPlan.getByTestId('project-document-status')).toHaveClass(/status-dot/);
    await expect(importedPlan.getByTestId('project-document-status')).toHaveAttribute('title', 'In Progress');
    await expect(importedPlan.getByTestId('project-document-status')).toHaveAttribute('aria-label', 'Status: In Progress');
    await expect(importedPlan.getByTestId('project-document-status')).toHaveCSS('background-color', 'rgb(210, 153, 34)');
    await app.window.screenshot({ path: 'output/playwright/project-imported-plans-board.png', fullPage: true });
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('reuses an existing project record for the same folder instead of duplicating it', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-project-reuse-'));
  try {
    const result = await app.window.evaluate(async folderPath => {
      const workspaceId = (await window.praxis.workspaces.list())[0].id;
      const stages = [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }];
      const original = await window.praxis.projects.create({
        name: 'Reusable Project', key: 'REUSE', type: 'software', purpose: '', brief: {},
        startingPoint: 'existing-folder', folderPath, workflowStages: stages,
        starterTickets: [], defaultAiToolMode: 'read-only'
      }, workspaceId);
      const reused = await window.praxis.projects.useExisting(original.id, workspaceId);
      const matches = (await window.praxis.projects.list()).filter(project => project.workspaceFolder === folderPath);
      return { original, reused, matchCount: matches.length };
    }, folder);
    expect(result.reused.id).toBe(result.original.id);
    expect(result.matchCount).toBe(1);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('rejects prohibited folderless types and new-folder collisions without changing the folder', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-project-collision-'));
  const collision = path.join(parent, 'already-there');
  fs.mkdirSync(collision);
  fs.writeFileSync(path.join(collision, 'keep.txt'), 'keep');
  try {
    const errors = await app.window.evaluate(async ({ parentPath }) => {
      const base = {
        name: 'Invalid', key: 'INVALID', type: 'software' as const, purpose: '', brief: {},
        workflowStages: [{ id: 'a', name: 'Backlog' }, { id: 'b', name: 'Done' }],
        starterTickets: [{ summary: 'Ticket', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'full' as const
      };
      const workspaceId = (await window.praxis.workspaces.list())[0].id;
      const capture = async (input: Parameters<typeof window.praxis.projects.create>[0]) => {
        try { await window.praxis.projects.create(input, workspaceId); return ''; }
        catch (error) { return error instanceof Error ? error.message : String(error); }
      };
      return {
        folderless: await capture({ ...base, startingPoint: 'app-storage' }),
        collision: await capture({ ...base, key: 'COLLIDE', startingPoint: 'new-folder', folderPath: parentPath, folderName: 'already-there' })
      };
    }, { parentPath: parent });
    expect(errors.folderless).toContain('require');
    expect(errors.collision).toContain('Existing Folder');
    expect(fs.readFileSync(path.join(collision, 'keep.txt'), 'utf8')).toBe('keep');
    expect(fs.existsSync(path.join(collision, 'project.praxis.md'))).toBe(false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('rolls back a newly-created folder and project.praxis.md when project persistence fails', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-project-rollback-'));
  const state: KeyValueStore = { get: () => undefined, update: async () => { throw new Error('simulated persistence failure'); } };
  const manager = new ProjectManager(new ProjectStore(state));
  try {
    await expect(manager.create({
      name: 'Rollback', key: 'ROLLBACK', type: 'software', purpose: '', brief: {},
      startingPoint: 'new-folder', folderPath: parent, folderName: 'new-project',
      workflowStages: defaultProjectWorkflow('software'), starterTickets: defaultProjectTickets('software'),
      defaultAiToolMode: 'full'
    })).rejects.toThrow('simulated persistence failure');
    expect(fs.existsSync(path.join(parent, 'new-project'))).toBe(false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('rolls back the project record and created artifacts when workspace persistence fails', async () => {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-workspace-rollback-'));
  let projectsValue: unknown;
  const projectState: KeyValueStore = {
    get: () => projectsValue,
    update: async (_key, value) => { projectsValue = value; }
  };
  let workspacesValue: unknown;
  let failWorkspaceUpdate = false;
  const workspaceState: KeyValueStore = {
    get: () => workspacesValue,
    update: async (_key, value) => {
      if (failWorkspaceUpdate) throw new Error('simulated workspace persistence failure');
      workspacesValue = value;
    }
  };
  const manager = new ProjectManager(new ProjectStore(projectState));
  const workspaces = new WorkspaceStore(workspaceState);
  const workspace = await workspaces.create({ name: 'Rollback workspace' }, 'test');
  failWorkspaceUpdate = true;
  try {
    await expect(manager.createInWorkspace({
      name: 'Rollback', key: 'ROLLBACK', type: 'software', purpose: '', brief: {},
      startingPoint: 'new-folder', folderPath: parent, folderName: 'new-project',
      workflowStages: defaultProjectWorkflow('software'), starterTickets: defaultProjectTickets('software'),
      defaultAiToolMode: 'full'
    }, workspace.id, workspaces, 'test')).rejects.toThrow('simulated workspace persistence failure');
    expect(manager.list()).toEqual([]);
    expect(fs.existsSync(path.join(parent, 'new-project'))).toBe(false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('ships deterministic workflows and five editable starters for every project type', () => {
  expect(localToolDefinitionsForMode('project-only')).toEqual([]);
  for (const type of ['software', 'product', 'research', 'experiment'] satisfies ProjectType[]) {
    const stages = defaultProjectWorkflow(type);
    const tickets = defaultProjectTickets(type);
    expect(stages.length).toBeGreaterThanOrEqual(5);
    expect(new Set(stages.map(stage => stage.name)).size).toBe(stages.length);
    expect(tickets).toHaveLength(5);
    expect(tickets.every(ticket => ticket.status === stages[0].name && ticket.summary.length > 0)).toBe(true);
  }
});

test('a folder-backed project board is served by its folder connection', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-project-folder-connection-'));
  const feature = path.join(folder, 'docs', 'plans', 'features', 'feature-01-source');
  fs.mkdirSync(feature, { recursive: true });
  fs.writeFileSync(path.join(feature, 'feature.md'), '# Folder source\n\n**Type:** Feature\n**Status:** Backlog\n');
  try {
    const result = await app.window.evaluate(async folderPath => {
      const workspaceId = (await window.praxis.workspaces.list())[0].id;
      const project = await window.praxis.projects.create({
        name: 'Folder Source', key: 'FSRC', type: 'software', purpose: '', brief: {},
        startingPoint: 'existing-folder', folderPath, storage: 'folder',
        workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
        starterTickets: [], defaultAiToolMode: 'read-only'
      }, workspaceId);
      const connection = (await window.praxis.connection.list()).find(item => item.settings.projectId === project.id);
      const board = (await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' }))
        .find(item => item.connectionId === connection?.id);
      return { project, connection, board };
    }, folder);

    expect(result.connection?.mode).toBe('folder');
    expect(result.connection?.settings.roots).toEqual([folder]);
    expect(result.board?.connectionId).toBe(result.connection?.id);
    expect(result.board?.id).toBe('folder-fsrc');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('attaches a folder later and enforces one-project ownership for linked boards', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-project-attach-'));
  try {
    const result = await app.window.evaluate(async folderPath => {
      const workspaceId = (await window.praxis.workspaces.list())[0].id;
      const create = (name: string, key: string) => window.praxis.projects.create({
        name, key, type: 'research', purpose: '', brief: {}, startingPoint: 'app-storage',
        workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'Research', description: '', issueType: 'Task', status: 'To do' }],
        defaultAiToolMode: 'project-only'
      }, workspaceId);
      const first = await create('First Research', 'FIRST');
      const second = await create('Second Research', 'SECOND');
      const appConnection = (await window.praxis.connection.list()).find(connection => connection.id === `project:${first.id}`);
      const appBoard = (await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' }))
        .find(board => board.connectionId === appConnection?.id);
      const attached = await window.praxis.projects.attachFolder(first.id, {
        startingPoint: 'existing-folder', folderPath, createProjectFile: true
      });
      const attachedConnection = (await window.praxis.connection.list()).find(connection => connection.id === `project:${first.id}`);
      const attachedBoard = (await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' }))
        .find(board => board.connectionId === attachedConnection?.id);
      const board = { connectionId: 'jira-main', boardId: '42', displayName: 'Delivery' };
      await window.praxis.projects.linkBoard(first.id, board);
      let duplicateError = '';
      try { await window.praxis.projects.linkBoard(second.id, board); }
      catch (error) { duplicateError = error instanceof Error ? error.message : String(error); }
      const unlinked = await window.praxis.projects.unlinkBoard(first.id, board.connectionId, board.boardId);
      return {
        attached,
        duplicateError,
        linkedCountAfterUnlink: unlinked.linkedBoards.length,
        appConnectionMode: appConnection?.mode,
        appBoardConnectionId: appBoard?.connectionId,
        attachedConnectionMode: attachedConnection?.mode,
        attachedBoardConnectionId: attachedBoard?.connectionId
      };
    }, folder);
    expect(result.attached.project.workspaceFolder).toBe(folder);
    expect(result.attached.project.defaultAiToolMode).toBe('read-only');
    expect(result.attached.project.folderInspection?.projectFileExists).toBe(true);
    expect(result.appConnectionMode).toBe('app');
    expect(result.appBoardConnectionId).toBe(`project:${result.attached.project.id}`);
    expect(result.attachedConnectionMode).toBe('app');
    expect(result.attachedBoardConnectionId).toBe(`project:${result.attached.project.id}`);
    expect(result.duplicateError).toContain('already linked');
    expect(result.linkedCountAfterUnlink).toBe(0);
    expect(fs.existsSync(path.join(folder, 'project.praxis.md'))).toBe(true);
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('nests unlinked boards under the sidebar "Boards" heading', async () => {
  const page = app.window;

  // The built-in demo boards belong to no project, so they render in the
  // standalone "Boards" section rather than inside a project tree.
  const boardsHeading = page.getByTestId('toggle-boards');
  await expect(boardsHeading).toBeVisible();
  await expect(boardsHeading).toHaveAttribute('aria-expanded', 'true');

  const boardTree = page.locator('.external-board-tree');
  const boardRow = boardTree.getByTestId('board-nav-item').first();
  await expect(boardRow).toBeVisible();

  // The row must be indented under the heading, not flush with the sidebar
  // edge — this was the "unlinked boards not nested" regression.
  const rowPaddingLeft = await boardRow.evaluate(el => parseFloat(getComputedStyle(el).paddingLeft));
  expect(rowPaddingLeft).toBeGreaterThanOrEqual(24);

  // The row's glyph should sit at (roughly) the same x as the heading label,
  // so the section reads as a tree with the boards as children of "Boards"
  // (glyph under parent label, row label indented one glyph further — the
  // same idiom as the project tree).
  const headingLabelX = await boardsHeading.locator('span', { hasText: 'Boards' }).first().evaluate(el => el.getBoundingClientRect().x);
  const rowIconX = await boardRow.locator('.tree-icon').evaluate(el => el.getBoundingClientRect().x);
  const rowLabelX = await boardRow.locator('.tree-label').evaluate(el => el.getBoundingClientRect().x);
  const sidebarX = await page.locator('.sidebar').evaluate(el => el.getBoundingClientRect().x);
  expect(rowIconX).toBeGreaterThan(sidebarX + 20);
  expect(rowLabelX).toBeGreaterThan(rowIconX);
  expect(Math.abs(rowIconX - headingLabelX)).toBeLessThanOrEqual(12);

  // Collapsing the heading hides its nested children.
  await boardsHeading.click();
  await expect(boardTree).toHaveCount(0);
});

test('shows a connected board only beneath its owning Praxis project', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-project-linked-board-'));
  const featureFolder = path.join(folder, 'features', 'feature-01-linked');
  fs.mkdirSync(featureFolder, { recursive: true });
  fs.writeFileSync(path.join(featureFolder, 'feature.md'), [
    '# Linked delivery', '', '**Status:** 🚧 In Progress', '**Type:** Feature', '',
    '## Description', '', 'Connected project work.', ''
  ].join('\n'));

  await closeTestApp(app);
  app = await launchTestApp({ connections: [{
    id: 'linked-live-folder', name: 'Linked delivery source', mode: 'folder',
    settings: { path: folder, projectKey: 'LINKED', projectName: 'Linked Delivery' }
  }] });

  try {
    await app.window.evaluate(async projectFolder => {
      const workspaceId = (await window.praxis.workspaces.list())[0].id;
      const project = await window.praxis.projects.create({
        name: 'Delivery Workspace', key: 'DELIVERY', type: 'software', purpose: 'Ship linked work', brief: {},
        startingPoint: 'existing-folder', folderPath: projectFolder, workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'Starter', description: '', issueType: 'Task', status: 'To do' }], defaultAiToolMode: 'read-only'
      }, workspaceId);
      const boards = await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' });
      const connected = boards.find(board => board.connectionId === 'linked-live-folder');
      if (!connected?.connectionId) throw new Error('Expected connected live-folder board.');
      await window.praxis.projects.linkBoard(project.id, {
        connectionId: connected.connectionId, boardId: connected.id, displayName: connected.name
      });
    }, folder);
    await app.window.reload();

    await expect(app.window.getByTestId('nav-board')).toHaveCount(0);
    await expect(app.window.locator('.external-board-tree').getByTestId('board-nav-item').filter({ hasText: 'Delivery Workspace' })).toHaveCount(0);
    const projectTree = app.window.getByTestId('project-tree').filter({ hasText: 'Delivery Workspace' });
    const linkedBoard = projectTree.getByTestId('project-linked-board-nav-item');
    await expect(linkedBoard).toContainText('Linked Delivery');
    await expect(linkedBoard).toContainText('Linked');
    await linkedBoard.click();
    await expect(app.window.getByTestId('issue-card')).toContainText('Linked delivery');

    await app.window.getByTestId('mode-work').click();
    const workProject = app.window.getByTestId('work-project').filter({ hasText: 'Delivery Workspace' });
    await expect(workProject).toContainText('2 boards');
    await expect(workProject.getByTestId('work-card')).toHaveCount(2);
    await expect(workProject).toContainText('Linked Delivery');

    // Unlinking from the sidebar must remove only this project's link, not
    // the shared folder connection itself — the same "Linked delivery source"
    // connection could be linked into another project too.
    await app.window.getByTestId('mode-classic').click();
    await linkedBoard.getByTestId('board-unlink-btn').click();
    await expect(projectTree.getByTestId('project-linked-board-nav-item')).toHaveCount(0);
    const stillConnected = await app.window.evaluate(async () =>
      (await window.praxis.connection.list()).some(connection => connection.id === 'linked-live-folder')
    );
    expect(stillConnected).toBe(true);
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

/**
 * Regression test for a real bug: a board linked from *another project's own*
 * connection could never be unlinked from the sidebar. `onDeleteBoard`'s
 * "this board belongs to a project, delete the project instead" guard fired
 * for any board whose connection carried a `projectId` — which every
 * cross-project link does by definition — so the click silently did nothing.
 * `onUnlinkBoard` (routed through `projects.unlinkBoard`) fixes it.
 */
test('unlinks a board that was cross-linked from another project\'s own connection', async () => {
  const result = await app.window.evaluate(async () => {
    const workspaceId = (await window.praxis.workspaces.list())[0].id;
    const create = (name: string, key: string) => window.praxis.projects.create({
      name, key, type: 'research', purpose: '', brief: {}, startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
      starterTickets: [{ summary: 'Research', description: '', issueType: 'Task', status: 'To do' }],
      defaultAiToolMode: 'project-only'
    }, workspaceId);
    const first = await create('First Research', 'FIRST');
    const second = await create('Second Research', 'SECOND');
    const secondConnection = (await window.praxis.connection.list()).find(c => c.settings.projectId === second.id);
    const secondBoard = (await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' }))
      .find(board => board.connectionId === secondConnection?.id);
    if (!secondBoard?.connectionId) throw new Error('Expected the second project to expose its own board.');
    await window.praxis.projects.linkBoard(first.id, {
      connectionId: secondBoard.connectionId, boardId: secondBoard.id, displayName: secondBoard.name
    });
    return { firstId: first.id, firstName: first.name, secondId: second.id };
  });
  await app.window.reload();

  const projectTree = app.window.getByTestId('project-tree').filter({ hasText: result.firstName });
  const linkedBoard = projectTree.getByTestId('project-linked-board-nav-item');
  await expect(linkedBoard).toContainText('Linked');
  await linkedBoard.getByTestId('board-unlink-btn').click();
  await expect(projectTree.getByTestId('project-linked-board-nav-item')).toHaveCount(0);

  const after = await app.window.evaluate(async ({ firstId, secondId }) => ({
    firstLinkedBoards: (await window.praxis.projects.get(firstId))?.linkedBoards.length,
    secondStillExists: Boolean(await window.praxis.projects.get(secondId))
  }), { firstId: result.firstId, secondId: result.secondId });
  expect(after.firstLinkedBoards).toBe(0);
  // Unlinking must not touch the second project or its own board at all.
  expect(after.secondStillExists).toBe(true);
});

test('an existing folder is three steps too, and confirms the detected identity', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-project-fastpath-'));
  fs.writeFileSync(path.join(folder, 'README.md'), '# Ledger Service\n');
  try {
    const page = app.window;
    // The picker has to be stubbed in the main process: `window.praxis` is a
    // contextBridge object, so assigning over it from the page is a no-op.
    await app.electronApp.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, folder);

    await page.getByTestId('new-menu').click();
    await page.getByTestId('add-existing-project').click();
    // The advanced toggle is offered here as well — someone pointing Praxis at
    // a repo they already have is the least likely person to want six screens.
    await expect(page.locator('.step-count')).toHaveText('Step 1 of 3');
    await page.getByRole('button', { name: 'Choose folder…' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();

    // Step 2 confirms what the folder supplied. It used to be skipped outright,
    // which left the project type — the thing that picks the brief, workflow and
    // starter tickets — never seen and silently defaulted.
    await expect(page.locator('.step-count')).toHaveText('Step 2 of 3');
    await expect(page.getByRole('heading', { name: 'Describe the project' })).toBeVisible();
    await expect(page.getByLabel('Project name')).toHaveValue(/.+/);
    await page.getByRole('button', { name: 'Continue' }).click();

    await expect(page.locator('.step-count')).toHaveText('Step 3 of 3');
    await page.locator('.project-wizard-footer').getByRole('button', { name: 'Add project' }).click();
    await expect(page.getByTestId('project-dashboard')).toBeVisible();
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('ticking advanced setup restores all six steps in existing-folder mode', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-project-advanced-'));
  fs.writeFileSync(path.join(folder, 'README.md'), '# Deep Setup\n');
  try {
    const page = app.window;
    await app.electronApp.evaluate(({ dialog }, chosen) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [chosen] });
    }, folder);
    await page.getByTestId('new-menu').click();
    await page.getByTestId('add-existing-project').click();

    await expect(page.locator('.step-count')).toHaveText('Step 1 of 3');
    await page.getByTestId('wizard-advanced-toggle').check();
    await expect(page.locator('.step-count')).toHaveText('Step 1 of 6');
    await page.getByRole('button', { name: 'Choose folder…' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await page.getByRole('button', { name: 'Continue' }).click();
    await expect(page.getByRole('heading', { name: 'Shape the brief' })).toBeVisible();
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});

test('the command palette can add a project from an existing folder', async () => {
  const page = app.window;
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('textbox', { name: 'Go to' }).fill('from folder');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Create from existing folder' })).toBeVisible();
});
