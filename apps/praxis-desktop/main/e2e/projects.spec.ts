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

test('creates a folderless Product project through the six-step wizard and opens its board', async () => {
  const page = app.window;
  await expect(page.getByTestId('overview-page')).toBeVisible();
  await page.getByTestId('new-menu').click();
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('new-project-wizard')).toBeVisible();
  await expect(page).toHaveScreenshot('project-wizard-type.png');

  await page.getByRole('button', { name: /Product Development/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Project name').fill('Customer Portal');
  await page.getByRole('button', { name: /Keep in Praxis only/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('heading', { name: 'A useful brief is ready' })).toHaveCount(0);
  await expect(page.getByText('Start with the primary users closest to the problem and refine the audience with evidence.')).toBeVisible();
  await expect(page.locator('.brief-section-option.included')).toHaveCount(0);
  await expect(page.locator('.brief-section-number')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Select Target users' })).toHaveAttribute('aria-pressed', 'false');
  const customizeTargetUsers = page.getByRole('button', { name: 'Customize Target users' });
  await customizeTargetUsers.hover();
  await expect(customizeTargetUsers).toHaveCSS('width', '78px');
  await page.screenshot({ path: 'output/playwright/project-wizard-customize-hover.png', fullPage: true });
  await page.getByRole('button', { name: 'Select Target users' }).click();
  await expect(page.getByRole('button', { name: 'Deselect Target users' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Deselect Target users' }).click();
  await expect(page.getByRole('button', { name: 'Select Target users' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Customize Target users' }).click();
  await page.getByRole('button', { name: 'Use example' }).click();
  await expect(page.getByText('Customize the text here, then select its card to include it.')).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select Target users' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Select Target users' }).click();
  await expect(page.locator('.brief-editor-reveal')).toHaveCSS('opacity', '0');
  await page.getByRole('button', { name: 'Customize Target users' }).click();
  await expect(page.locator('.brief-section-layout')).toHaveClass(/editor-open/);
  expect(await page.locator('.brief-editor-reveal').evaluate(element => getComputedStyle(element).transitionDuration)).not.toBe('0s');
  await page.getByRole('button', { name: 'Use example' }).click();
  await expect(page.getByRole('textbox', { name: 'Target users', exact: true })).toHaveValue('Support leads at growing SaaS companies who manage 5–20 agents.');
  await page.locator('.brief-editor-panel').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Deselect Target users' })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Customize Target users' }).click();
  await page.getByRole('button', { name: 'Use example' }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Deselect Target users' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.brief-section-option.included')).toHaveCount(1);
  await page.getByRole('button', { name: 'Select Problem' }).click();
  await page.getByRole('button', { name: 'Customize Problem' }).click();
  await expect(page.getByRole('textbox', { name: 'Problem', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'Skip this section' }).click();
  await expect(page.getByText('Customize the text here, then select its card to include it.')).toBeVisible();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Select Problem' })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('button', { name: 'Select Problem' }).click();
  await page.getByRole('button', { name: 'Customize Problem' }).click();
  await expect(page.getByRole('textbox', { name: 'Problem', exact: true })).toBeFocused();
  await page.getByRole('button', { name: 'I’m not sure' }).click();
  await expect(page.getByRole('textbox', { name: 'Problem', exact: true })).toHaveValue('Not decided yet — confirm during the first planning pass.');
  await expect(page.locator('.brief-editor-reveal')).toHaveCSS('opacity', '1');
  await page.screenshot({ path: 'output/playwright/project-wizard-brief-editor-open.png', fullPage: true });
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.locator('.brief-section-layout')).not.toHaveClass(/editor-open/);
  await expect(page.locator('.brief-editor-reveal')).toHaveCSS('opacity', '0');
  await expect(page.getByRole('button', { name: 'Select Problem' })).toBeFocused();
  await page.getByRole('button', { name: 'Select MVP' }).click();
  await expect(page.getByRole('button', { name: 'Deselect MVP' })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.brief-section-option.included .brief-section-selected')).toHaveCount(3);
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
  expect(themedColors.boardIcon).toBe('rgb(205, 191, 174)');
  await expect(page).toHaveScreenshot('project-home.png');
  const stored = await page.evaluate(() => window.praxis.projects.list());
  const created = stored.find(project => project.key === 'CUSTOMER');
  expect(created?.defaultAiToolMode).toBe('project-only');
  expect(created?.brief.users).toBe('Support leads at growing SaaS companies who manage 5–20 agents.');
  expect(created?.brief.problem).toBe('Not decided yet — confirm during the first planning pass.');
  expect(created?.brief.mvp).toBe('Deliver the smallest coherent release that can test the core value.');
  expect(Object.values(created?.brief ?? {}).filter(Boolean)).toHaveLength(3);
  expect(created?.workItems).toHaveLength(5);

  // Project surfaces must inherit the active application theme instead of
  // painting an opaque default background over the themed panes.
  await page.locator('[data-testid="titlebar-themes"]').click();
  await page.locator('[data-testid="theme-card-humanist-light"]').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'humanist-light');
  await page.keyboard.press('Escape');
  await page.screenshot({ path: 'output/playwright/project-dashboard-humanist-light.png', fullPage: true });
  const projectThemeStyles = await page.evaluate(() => {
    const dashboard = document.querySelector('[data-testid="project-dashboard"]');
    const projectHome = document.querySelector('[data-testid="project-home"]');
    const panel = projectHome?.querySelector('.project-panel');
    return {
      dashboardColor: dashboard ? getComputedStyle(dashboard).color : '',
      dashboardBackground: dashboard ? getComputedStyle(dashboard).backgroundColor : '',
      homeBackground: projectHome ? getComputedStyle(projectHome).backgroundColor : '',
      panelBackground: panel ? getComputedStyle(panel).backgroundColor : ''
    };
  });
  expect(projectThemeStyles.dashboardColor).not.toBe('');
  expect(projectThemeStyles.dashboardBackground).toMatch(/rgba?\(0, 0, 0, 0\)/);
  expect(projectThemeStyles.homeBackground).toMatch(/rgba?\(0, 0, 0, 0\)/);
  expect(projectThemeStyles.panelBackground).not.toBe(projectThemeStyles.dashboardBackground);

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

test('retains an existing PROJECT.md and supports local board transitions and edits', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-project-existing-'));
  fs.writeFileSync(path.join(folder, 'PROJECT.md'), '# Existing\n');
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
    expect(fs.readFileSync(path.join(folder, 'PROJECT.md'), 'utf8')).toBe('# Existing\n');
  } finally { fs.rmSync(folder, { recursive: true, force: true }); }
});

test('imports detected plans as a read-only board for an existing-folder project', async () => {
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
        startingPoint: 'existing-folder', folderPath, workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
        starterTickets: [], defaultAiToolMode: 'read-only'
      }, workspaceId);
      const boards = await window.praxis.board.list({ projectKeys: [], types: [], searchText: '' });
      const board = boards.find(item => item.connectionId === project.linkedBoards[0]?.connectionId);
      return { project, board, details: board ? await window.praxis.board.get(board) : undefined };
    }, folder);
    expect(result.project.linkedBoards).toHaveLength(1);
    expect(result.project.linkedBoards[0].connectionId).toContain('project-plans-');
    expect(result.board?.name).toBe('Imported Plans (Live)');
    expect(result.details?.issues).toHaveLength(1);
    expect(result.details?.issues[0].summary).toBe('Imported planning work');
    await app.window.reload();
    const projectTree = app.window.getByTestId('project-tree').filter({ hasText: 'Imported Plans' });
    await expect(projectTree.getByTestId('project-linked-board-nav-item')).toContainText('Imported Plans (Live)');
    await expect(app.window.locator('.sidebar').getByTestId('board-nav-item').filter({ hasText: 'Imported Plans (Live)' })).toHaveCount(0);
    await projectTree.getByTestId('project-linked-board-nav-item').click();
    await expect(app.window.getByTestId('issue-card')).toContainText('Imported planning work');
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
    expect(fs.existsSync(path.join(collision, 'PROJECT.md'))).toBe(false);
  } finally { fs.rmSync(parent, { recursive: true, force: true }); }
});

test('rolls back a newly-created folder and PROJECT.md when project persistence fails', async () => {
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
      const attached = await window.praxis.projects.attachFolder(first.id, {
        startingPoint: 'existing-folder', folderPath, createProjectFile: true
      });
      const board = { connectionId: 'jira-main', boardId: '42', displayName: 'Delivery' };
      await window.praxis.projects.linkBoard(first.id, board);
      let duplicateError = '';
      try { await window.praxis.projects.linkBoard(second.id, board); }
      catch (error) { duplicateError = error instanceof Error ? error.message : String(error); }
      const unlinked = await window.praxis.projects.unlinkBoard(first.id, board.connectionId, board.boardId);
      return { attached, duplicateError, linkedCountAfterUnlink: unlinked.linkedBoards.length };
    }, folder);
    expect(result.attached.project.workspaceFolder).toBe(folder);
    expect(result.attached.project.defaultAiToolMode).toBe('read-only');
    expect(result.attached.project.folderInspection?.projectFileExists).toBe(true);
    expect(result.duplicateError).toContain('already linked');
    expect(result.linkedCountAfterUnlink).toBe(0);
    expect(fs.existsSync(path.join(folder, 'PROJECT.md'))).toBe(true);
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
    id: 'linked-live-folder', name: 'Linked delivery source', mode: 'livefolder',
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
    await expect(linkedBoard).toContainText('Linked Delivery (Live)');
    await expect(linkedBoard).toContainText('Linked');
    await linkedBoard.click();
    await expect(app.window.getByTestId('issue-card')).toContainText('Linked delivery');

    await app.window.getByTestId('mode-work').click();
    const workProject = app.window.getByTestId('work-project').filter({ hasText: 'Delivery Workspace' });
    await expect(workProject).toContainText('2 boards');
    await expect(workProject.getByTestId('work-card')).toHaveCount(2);
    await expect(workProject).toContainText('Linked Delivery (Live)');
  } finally {
    fs.rmSync(folder, { recursive: true, force: true });
  }
});
