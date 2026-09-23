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

function seedAgent(userDataDir: string, id: string, name: string): void {
  const dir = path.join(userDataDir, 'agents', id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'agent.json'),
    JSON.stringify({ schemaVersion: 1, id, name, type: 'acp', entry: { command: 'node', args: ['agent.js'] } }, null, 2)
  );
  fs.writeFileSync(
    path.join(dir, 'AGENT.md'),
    `---\nid: ${id}\nname: ${name}\ndescription: Reviews implementation changes against repository standards.\nskills: code-audit\n---\nReview the supplied change and return structured findings.`
  );
}

function seedSkill(userDataDir: string, name: string): void {
  const dir = path.join(userDataDir, 'skills', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, 'SKILL.md'),
    `---\nname: ${name}\ndescription: Reviews a change for correctness, risk, and repository conventions.\ntriggers: review, audit\n---\nInspect the supplied change and report blocking findings separately from suggestions.`
  );
}

test.beforeEach(async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  seedAgent(app.userDataDir, 'code-reviewer', 'Code Reviewer');
  seedSkill(app.userDataDir, 'code-audit');
  await app.window.evaluate(async () => window.praxis.agentRuntime.refresh());
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
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
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
  await dialog.getByRole('listitem').filter({ hasText: template }).click();
  await dialog.getByRole('button', { name: /^Use/ }).click();
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
  // A configured profile is now always visible in the Agent Hub palette;
  // clear the launch binding explicitly to make the stage unrunnable.
  const bindingControl = inspectorOf(page).getByLabel('Launch binding');
  if (await bindingControl.evaluate(el => el.tagName.toLowerCase() === 'select')) await bindingControl.selectOption('');
  else await bindingControl.fill('');

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

test('auto arrange lays out workflow stages in dependency order without overlap', async () => {
  const page = app.window;
  await newWorkflow(page, 'Governed delivery');

  const canvas = canvasOf(page);
  const arrange = page.getByTestId('wf-auto-arrange');
  await expect(arrange).toBeEnabled();
  await arrange.click();

  const layout = await canvas.locator('[data-node-id]').evaluateAll(elements =>
    elements.map(element => {
      const rect = element.getBoundingClientRect();
      return {
        id: element.getAttribute('data-node-id'),
        left: rect.left,
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom
      };
    })
  );
  expect(layout.length).toBeGreaterThan(1);
  for (let i = 0; i < layout.length; i += 1) {
    for (let j = i + 1; j < layout.length; j += 1) {
      const a = layout[i];
      const b = layout[j];
      expect(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top).toBe(true);
    }
  }

  const left = async (name: string) =>
    Number(await canvas.getByRole('button', { name: new RegExp(`^${name} \\(`) }).evaluate(element => (element as HTMLElement).style.left.replace('px', '')));
  expect(await left('Plan')).toBeLessThan(await left('Implement'));
  expect(await left('Implement')).toBeLessThan(await left('QA'));
  expect(await left('QA')).toBeLessThan(await left('Approve'));

  // Every card is measured after the action, rather than trusting the DOM's
  // paint order; the persisted coordinate update is what drives this layout.
  expect(layout.every(node => node.id)).toBe(true);
});

test('nudging a stage past the canvas edge clamps its position instead of losing it off-screen', async () => {
  const page = app.window;
  await newWorkflow(page, 'Governed delivery');

  const canvas = canvasOf(page);
  const qaCard = canvas.getByRole('button', { name: /^QA \(check\)/ });
  await qaCard.focus();

  // Far more nudges than the stage can possibly have room for (20px each), so the test keeps holding
  // however the template lays the stage out — it is the clamp being tested, not the distance.
  for (let i = 0; i < 80; i += 1) await qaCard.press('Shift+ArrowLeft');
  for (let i = 0; i < 40; i += 1) await qaCard.press('Shift+ArrowUp');

  await expect.poll(async () => qaCard.evaluate(el => (el as HTMLElement).style.left)).toBe('0px');
  await expect.poll(async () => qaCard.evaluate(el => (el as HTMLElement).style.top)).toBe('0px');
  await expect(qaCard).toBeVisible();
});

test('builds an agent handoff stage from the palette and attaches a specialist skill', async () => {
  const page = app.window;
  await newWorkflow(page, 'Quick change');

  const palette = page.getByLabel('Workflow stages').getByLabel('Build with agents and skills');
  const canvas = canvasOf(page);
  const reviewer = palette.getByTestId('wf-palette-agent-code-reviewer');
  const audit = palette.getByTestId('wf-palette-skill-code-audit');

  await expect(reviewer).toBeVisible();
  await expect(audit).toBeVisible();

  // Dragging an agent to empty canvas creates a runnable specialist stage.
  await reviewer.dragTo(canvas, { targetPosition: { x: 330, y: 180 } });
  const reviewerStage = canvas.getByRole('button', { name: /^Code Reviewer \(agent-task\).*agent Code Reviewer/ });
  await expect(reviewerStage).toBeVisible();
  await expect(reviewerStage).toHaveAttribute('aria-pressed', 'true');

  // Dropping a skill on that stage binds the specialist guidance and pins its version.
  await audit.dragTo(reviewerStage);
  await expect(reviewerStage).toContainText('code-audit');
  await expect(inspectorOf(page).getByLabel('Code Audit')).toBeChecked();
  await expect(page.getByRole('main')).toHaveScreenshot('workflow-designer-composition.png');
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
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
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

test('instantiating Full SDLC (.NET) identifies and installs missing agent dependencies automatically', async () => {
  const page = app.window;

  await page.getByRole('button', { name: 'New workflow in Delivery Project' }).click();
  const dialog = page.getByRole('dialog', { name: 'New workflow' });
  await expect(dialog).toBeVisible();

  // Select Full SDLC (.NET)
  const dotnetItem = dialog.getByRole('listitem').filter({ hasText: 'Full SDLC (.NET)' });
  await dotnetItem.click();

  // Check dependency identification
  await expect(dialog.getByText('csharp-dotnet-code-reviewer', { exact: true })).toBeVisible();
  await expect(dialog.getByText('Installs on selection')).toBeVisible();
  await expect(dialog.getByText(/Missing agent dependencies will be installed automatically/)).toBeVisible();

  // Click Use
  await dialog.getByRole('button', { name: 'Use "Full SDLC (.NET)"' }).click();
  await expect(dialog).toBeHidden();

  // Workflow is loaded in designer
  await expect(canvasOf(page)).toBeVisible();
  await expect(canvasOf(page).getByRole('button', { name: /^Approve \(approval\)/ })).toBeVisible();
});

test('validates workflow connections, flow, and configuration via validate workflow button', async () => {
  const page = app.window;
  await newWorkflow(page, 'Quick change');

  // 1. Valid workflow check
  const validateBtn = page.getByTestId('wf-validate-btn');
  await expect(validateBtn).toBeVisible();
  await validateBtn.click();

  const dialog = page.getByTestId('workflow-validation-dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('wf-validation-banner')).toContainText('Workflow is configured and valid');
  await expect(page.getByTestId('wf-val-category-connections')).toContainText('Valid');
  await expect(page.getByTestId('wf-val-category-flow')).toContainText('Valid');
  await expect(page.getByTestId('wf-val-category-configuration')).toContainText('Valid');

  // Close dialog via Done button
  await page.getByTestId('wf-val-done-btn').click();
  await expect(dialog).toBeHidden();

  // 2. Introduce an invalid configuration (clear launch binding / agent id)
  const rail = page.getByRole('navigation', { name: 'Workflow stages' });
  await rail.getByRole('button', { name: /^Implement \(agent-task\)/ }).click();
  const bindingControl = inspectorOf(page).getByLabel('Launch binding');
  if (await bindingControl.evaluate(el => el.tagName.toLowerCase() === 'select')) await bindingControl.selectOption('');
  else await bindingControl.fill('');

  // 3. Re-run validation via the rail validate button
  const railValidateBtn = page.getByTestId('wf-rail-validate-btn');
  await expect(railValidateBtn).toBeVisible();
  await railValidateBtn.click();

  await expect(dialog).toBeVisible();
  await expect(page.getByTestId('wf-validation-banner')).toContainText('Workflow configuration requires attention');
  await expect(page.getByTestId('wf-val-category-configuration')).toContainText(/issue/);

  // Check Go to stage functionality
  const gotoBtn = dialog.getByRole('button', { name: 'Go to stage' }).first();
  await expect(gotoBtn).toBeVisible();
  await gotoBtn.click();
  await expect(dialog).toBeHidden();
  await expect(canvasOf(page).getByRole('button', { name: /^Implement \(agent-task\)/ })).toHaveAttribute('aria-pressed', 'true');
});

test('clicking a connection on the canvas selects it and deletes it', async () => {
  const page = app.window;
  await newWorkflow(page, 'Quick change');

  const canvas = canvasOf(page);
  const edgeLine = canvas.locator('[data-testid^="wf-canvas-edge-line-"]').first();
  await expect(edgeLine).toBeAttached();

  // Click on the connection curve to select it and reveal the delete button
  await edgeLine.click({ force: true });

  const deleteBtn = canvas.locator('[data-testid^="wf-edge-delete-"]').first();
  await expect(deleteBtn).toBeVisible();

  // Clicking delete removes the connection
  const edgeCountBefore = await canvas.locator('[data-testid^="wf-canvas-edge-line-"]').count();
  await deleteBtn.click();

  await expect.poll(async () => canvas.locator('[data-testid^="wf-canvas-edge-line-"]').count()).toBe(edgeCountBefore - 1);
});

test('selecting a connection and pressing Delete key removes it', async () => {
  const page = app.window;
  await newWorkflow(page, 'Quick change');

  const canvas = canvasOf(page);
  const edgeLine = canvas.locator('[data-testid^="wf-canvas-edge-line-"]').first();
  await expect(edgeLine).toBeAttached();

  await edgeLine.click({ force: true });
  await expect(canvas.locator('[data-testid^="wf-edge-delete-"]').first()).toBeVisible();

  const edgeCountBefore = await canvas.locator('[data-testid^="wf-canvas-edge-line-"]').count();
  await page.keyboard.press('Delete');

  await expect.poll(async () => canvas.locator('[data-testid^="wf-canvas-edge-line-"]').count()).toBe(edgeCountBefore - 1);
});

test('clicking delete on an agent task removes it from the canvas', async () => {
  const page = app.window;
  await newWorkflow(page, 'Quick change');

  const canvas = canvasOf(page);
  const stage = canvas.getByRole('button', { name: /^Implement \(agent-task\)/ });
  await expect(stage).toBeVisible();

  const deleteBtn = stage.locator('[data-testid^="wf-node-delete-"]');
  await deleteBtn.click();

  await expect(stage).toBeHidden();
});

test('selecting an agent task and pressing Delete key removes it', async () => {
  const page = app.window;
  await newWorkflow(page, 'Quick change');

  const canvas = canvasOf(page);
  const stage = canvas.getByRole('button', { name: /^Implement \(agent-task\)/ });
  await expect(stage).toBeVisible();

  await stage.click();
  await expect(stage).toHaveAttribute('aria-pressed', 'true');

  await page.keyboard.press('Delete');
  await expect(stage).toBeHidden();
});
