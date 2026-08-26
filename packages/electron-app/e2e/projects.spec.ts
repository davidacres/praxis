import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { ProjectStore, defaultProjectTickets, defaultProjectWorkflow, localToolDefinitionsForMode, type KeyValueStore, type ProjectType } from '@ticket-manager/core';
import { ProjectManager } from '../src/main/projectManager';

let app: TestApp;

test.beforeEach(async () => { app = await launchTestApp(); });
test.afterEach(async () => { await closeTestApp(app); });

test('creates a folderless Product project through the six-step wizard and opens its board', async () => {
  const page = app.window;
  await expect(page.getByTestId('project-empty-state')).toBeVisible();
  await expect(page).toHaveScreenshot('project-empty-state.png');
  await page.getByTestId('new-menu').click();
  await page.getByTestId('new-project').click();
  await expect(page.getByTestId('new-project-wizard')).toBeVisible();
  await expect(page).toHaveScreenshot('project-wizard-type.png');

  await page.getByRole('button', { name: /Product Development/ }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Project name').fill('Customer Portal');
  await page.getByRole('button', { name: 'App storage' }).click();
  await page.getByLabel('Purpose').fill('Give customers a simple self-service experience.');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByLabel('Target users').fill('Existing customers');
  await page.getByRole('button', { name: 'Continue' }).click();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('Project-board tools only')).toBeVisible();
  await page.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByText('No AI starts automatically')).toBeVisible();
  await expect(page).toHaveScreenshot('project-wizard-review.png');
  await page.getByRole('button', { name: 'Create project' }).click();

  await expect(page.getByTestId('project-home')).toContainText('Customer Portal');
  await expect(page).toHaveScreenshot('project-home.png');
  const stored = await page.evaluate(() => window.ticketManager.projects.list());
  expect(stored).toHaveLength(1);
  expect(stored[0].defaultAiToolMode).toBe('project-only');
  expect(stored[0].workItems).toHaveLength(5);

  await page.getByRole('button', { name: 'Open default board' }).click();
  await expect(page.getByTestId('issue-card')).toHaveCount(5);
  await page.getByTestId('new-menu').click();
  await page.getByTestId('new-session').click();
  await expect(page.getByTestId('project-empty-state')).toContainText('Create a new project');
});

test('opens a focused Add Existing Project flow from the New menu', async () => {
  const page = app.window;
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
  await expect(page.getByRole('dialog', { name: 'Add existing project' })).toBeVisible();
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
      const stages = [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }];
      const project = await window.ticketManager.projects.create({
        name: 'Existing Workspace', key: 'EXIST', type: 'software', purpose: 'Test', brief: {},
        startingPoint: 'existing-folder', folderPath, workflowStages: stages,
        starterTickets: [{ summary: 'First slice', description: '', issueType: 'Task', status: 'To do' }],
        defaultAiToolMode: 'full'
      });
      const boards = await window.ticketManager.board.list({ projectKeys: ['EXIST'], types: [], searchText: '' });
      const board = boards.find(item => item.connectionId === `project:${project.id}`)!;
      const before = await window.ticketManager.board.get(board);
      await window.ticketManager.issue.update(before.issues[0].key, { summary: 'Edited slice' }, board.connectionId);
      const issue = await window.ticketManager.issue.get(before.issues[0].key, board.connectionId);
      const transition = issue?.transitions?.find(item => item.toStatus === 'Done')!;
      await window.ticketManager.issue.transition(issue!.key, transition.id, board.connectionId);
      return { project, issue: await window.ticketManager.issue.get(issue!.key, board.connectionId) };
    }, folder);
    expect(result.project.projectFileStatus).toBe('retained');
    expect(result.issue?.summary).toBe('Edited slice');
    expect(result.issue?.status).toBe('Done');
    expect(fs.readFileSync(path.join(folder, 'PROJECT.md'), 'utf8')).toBe('# Existing\n');
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
      const capture = async (input: Parameters<typeof window.ticketManager.projects.create>[0]) => {
        try { await window.ticketManager.projects.create(input); return ''; }
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
      const create = (name: string, key: string) => window.ticketManager.projects.create({
        name, key, type: 'research', purpose: '', brief: {}, startingPoint: 'app-storage',
        workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: 'Research', description: '', issueType: 'Task', status: 'To do' }],
        defaultAiToolMode: 'project-only'
      });
      const first = await create('First Research', 'FIRST');
      const second = await create('Second Research', 'SECOND');
      const attached = await window.ticketManager.projects.attachFolder(first.id, {
        startingPoint: 'existing-folder', folderPath, createProjectFile: true
      });
      const board = { connectionId: 'jira-main', boardId: '42', displayName: 'Delivery' };
      await window.ticketManager.projects.linkBoard(first.id, board);
      let duplicateError = '';
      try { await window.ticketManager.projects.linkBoard(second.id, board); }
      catch (error) { duplicateError = error instanceof Error ? error.message : String(error); }
      const unlinked = await window.ticketManager.projects.unlinkBoard(first.id, board.connectionId, board.boardId);
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
