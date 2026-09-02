import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
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
  await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();

  // The built-in template is offered in the library.
  const templateCard = page.getByRole('listitem').filter({ hasText: 'Governed delivery' }).first();
  await expect(templateCard).toBeVisible();
  await expect(page.getByRole('main')).toHaveScreenshot('workflow-designer-library.png');
  await templateCard.getByRole('button', { name: 'Use template' }).click();

  // The graph loads with its stages as labelled buttons.
  await expect(page.getByRole('button', { name: /^Plan \(agent-task\), entry stage/ })).toBeVisible();
  await expect(page.getByRole('button', { name: /^Approve \(approval\)/ })).toBeVisible();
  await expect(page.getByRole('main')).toHaveScreenshot('workflow-designer-open.png');

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

  // Blank the implement stage's agent id — that is a node-level error. With no
  // agents discovered in the test profile the picker falls back to a text field.
  await page.getByRole('button', { name: /^Implement \(agent-task\)/ }).click();
  await page.getByLabel('Agent', { exact: true }).fill('');

  const status = page.getByRole('status').filter({ hasText: /error/ });
  await expect(status).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save workflow' })).toBeDisabled();

  // The offending stage carries a visible issue badge.
  await expect(page.getByRole('button', { name: /^Implement \(agent-task\).*issue/ })).toBeVisible();
});

test('the canvas moves a stage with the keyboard and toggles to the list view', async () => {
  const page = app.window;

  await page.getByTestId('project-workflows-nav-item').click();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Governed delivery' })
    .first()
    .getByRole('button', { name: 'Use template' })
    .click();

  // The designer opens on the canvas; the QA stage card is focusable.
  const canvas = page.getByRole('application', { name: 'Workflow canvas' });
  await expect(canvas).toBeVisible();
  const qaCard = canvas.getByRole('button', { name: /^QA \(check\)/ });
  await qaCard.focus();

  const before = await qaCard.evaluate(el => (el as HTMLElement).style.left);
  await qaCard.press('Shift+ArrowRight');
  await qaCard.press('Shift+ArrowRight');
  await expect
    .poll(async () => qaCard.evaluate(el => (el as HTMLElement).style.left))
    .not.toBe(before);

  // Switching to the list view still shows every stage and hides the canvas.
  await page.getByRole('button', { name: 'List', exact: true }).click();
  await expect(canvas).toBeHidden();
  await expect(page.getByRole('button', { name: /^QA \(check\)/ })).toBeVisible();
});

test('a folder-backed project commits its workflow to .praxis/workflows and reloads it', async () => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-wf-folder-'));
  const page = app.window;

  const created = await page.evaluate(async projectFolder => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Folder Delivery',
        key: 'FDLV',
        type: 'software',
        purpose: '',
        brief: {},
        startingPoint: 'existing-folder',
        folderPath: projectFolder,
        workflowStages: [
          { id: 'backlog', name: 'Backlog' },
          { id: 'done', name: 'Done' }
        ],
        starterTickets: [{ summary: 'First', description: '', issueType: 'Task', status: 'Backlog' }],
        defaultAiToolMode: 'read-only'
      },
      workspace.id
    );
    localStorage.setItem('praxis-last-workspace-route', JSON.stringify({ projectId: project.id, feature: 'workflows' }));
    return { id: project.id, workspaceFolder: project.workspaceFolder };
  }, folder);
  const projectId = created.id;
  const projectFolder = created.workspaceFolder as string;
  expect(projectFolder.endsWith(path.basename(folder))).toBe(true);
  await page.reload();

  await expect(page.getByRole('heading', { name: 'Workflows' })).toBeVisible();
  await page
    .getByRole('listitem')
    .filter({ hasText: 'Governed delivery' })
    .first()
    .getByRole('button', { name: 'Use template' })
    .click();

  // Instantiating only drafts it; an explicit Save writes the file.
  await page.getByRole('button', { name: /^Plan \(agent-task\), entry stage/ }).click();
  await page.getByLabel('Name').fill('Plan the delivery');
  await page.getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

  // The definition is now a real file in the project's repo.
  const committed = path.join(projectFolder, '.praxis', 'workflows', `governed-delivery-${projectId}.json`);
  expect(fs.existsSync(committed)).toBe(true);
  const onDisk = JSON.parse(fs.readFileSync(committed, 'utf8'));
  expect(onDisk.scope).toBe('project');
  expect(onDisk.projectId).toBe(projectId);

  // An out-of-band edit to the file is picked up on reload.
  fs.writeFileSync(committed, JSON.stringify({ ...onDisk, name: 'Edited on disk' }, null, 2));
  await page.getByRole('button', { name: 'Close' }).click();
  await expect(page.getByRole('button', { name: /Edited on disk/ })).toBeVisible();

  fs.rmSync(folder, { recursive: true, force: true });
});
