import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BE-021 / FX-BF-014 — the visual workflow designer.
 *
 * Navigation moved to the sidebar: the Workflows row expands to the project's
 * saved workflows plus a Runs child; `+` opens the New Workflow dialog. The
 * stage/connection inspector renders in the shell's right pane.
 */

test.slow();

let app: TestApp;

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
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
    localStorage.setItem('praxis-last-workspace-route', JSON.stringify({ projectId: project.id, feature: 'workflows' }));
  });
  await app.window.reload();
});

test.afterEach(async () => {
  await closeTestApp(app);
});

/** Create a project workflow from a template via the sidebar `+` and its dialog. */
async function newWorkflow(page: Page, template: string, project = 'Delivery Project'): Promise<void> {
  await page.getByRole('button', { name: `New workflow in ${project}` }).click();
  const dialog = page.getByRole('dialog', { name: 'New workflow' });
  await dialog.getByRole('listitem').filter({ hasText: template }).getByRole('button', { name: 'Use' }).click();
  await expect(dialog).toBeHidden();
}

const canvasOf = (page: Page) => page.getByRole('application', { name: 'Workflow canvas' });
const inspectorOf = (page: Page) => page.getByRole('region', { name: 'Stage inspector' });

test('creates a workflow from a template, edits a stage in the right pane, and persists it', async () => {
  const page = app.window;

  // The empty state offers a starting point; the dialog lists the templates.
  await expect(page.getByRole('main').getByRole('button', { name: 'New workflow' })).toBeVisible();
  await newWorkflow(page, 'Governed delivery');

  const canvas = canvasOf(page);
  await expect(canvas.getByRole('button', { name: /^Plan \(agent-task\), entry stage/ })).toBeVisible();
  await expect(canvas.getByRole('button', { name: /^Approve \(approval\)/ })).toBeVisible();
  await expect(page.getByRole('main')).toHaveScreenshot('workflow-designer-open.png');
  await expect(inspectorOf(page)).toHaveScreenshot('workflow-designer-inspector.png');

  // Edit the Plan stage name through the right-pane inspector.
  await canvas.getByRole('button', { name: /^Plan \(agent-task\), entry stage/ }).click();
  const nameField = page.getByLabel('Name');
  await expect(nameField).toHaveValue('Plan');
  await nameField.fill('Plan the work');

  const saveButton = page.getByRole('button', { name: 'Save workflow' });
  await expect(saveButton).toBeEnabled();
  await saveButton.click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

  // The durable route reopens the same workflow after a reload; the rename stuck.
  await page.reload();
  await expect(
    canvasOf(page).getByRole('button', { name: /^Plan the work \(agent-task\), entry stage/ })
  ).toBeVisible();
});

test('blocks save while the graph is invalid and announces the errors', async () => {
  const page = app.window;
  await newWorkflow(page, 'Quick change');

  const rail = page.getByRole('navigation', { name: 'Workflow stages' });
  await rail.getByRole('button', { name: /^Implement \(agent-task\)/ }).click();
  await page.getByLabel('Agent', { exact: true }).fill('');

  const status = page.getByRole('status').filter({ hasText: /error/ });
  await expect(status).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save workflow' })).toBeDisabled();
  await expect(rail.getByRole('button', { name: /^Implement \(agent-task\).*issue/ })).toBeVisible();
});

test('the canvas moves a stage with the keyboard and stays in sync with the rail', async () => {
  const page = app.window;
  await newWorkflow(page, 'Governed delivery');

  const rail = page.getByRole('navigation', { name: 'Workflow stages' });
  const canvas = canvasOf(page);
  await expect(rail).toBeVisible();
  await expect(canvas).toBeVisible();

  const qaCard = canvas.getByRole('button', { name: /^QA \(check\)/ });
  await qaCard.focus();
  const before = await qaCard.evaluate(el => (el as HTMLElement).style.left);
  await qaCard.press('Shift+ArrowRight');
  await qaCard.press('Shift+ArrowRight');
  await expect.poll(async () => qaCard.evaluate(el => (el as HTMLElement).style.left)).not.toBe(before);

  await rail.getByRole('button', { name: /^Review \(agent-task\)/ }).click();
  await expect(canvas.getByRole('button', { name: /^Review \(agent-task\)/ })).toHaveAttribute('aria-pressed', 'true');
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
  await page.reload();

  await newWorkflow(page, 'Governed delivery', 'Folder Delivery');
  await canvasOf(page).getByRole('button', { name: /^Plan \(agent-task\), entry stage/ }).click();
  await page.getByLabel('Name').fill('Plan the delivery');
  await page.getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

  const committed = path.join(projectFolder, '.praxis', 'workflows', `governed-delivery-${projectId}.json`);
  expect(fs.existsSync(committed)).toBe(true);
  const onDisk = JSON.parse(fs.readFileSync(committed, 'utf8'));
  expect(onDisk.scope).toBe('project');
  expect(onDisk.projectId).toBe(projectId);

  // An out-of-band edit to the file is picked up on reload.
  fs.writeFileSync(committed, JSON.stringify({ ...onDisk, name: 'Edited on disk' }, null, 2));
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Edited on disk', level: 1 })).toBeVisible();

  fs.rmSync(folder, { recursive: true, force: true });
});
