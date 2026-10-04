import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test, type Locator, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

/**
 * FX-BE-021 / FX-BF-014 — the visual workflow designer.
 *
 * Navigation lives in the project sidebar: Workflows is a project-level group
 * for saved definitions, separate from the project's Automations group of run
 * rows. `+` on Workflows opens the New Workflow dialog. The stage/connection
 * inspector renders in the shell's right pane.
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

/** Open a chip picker by its label and choose an option (options are named by label, then description). */
async function pickChip(page: Page, scope: Locator, label: string, option: string | RegExp): Promise<void> {
  await scope.getByRole('button', { name: label, exact: true }).click();
  const list = page.getByRole('listbox', { name: `${label} options` });
  await list.getByRole('option', { name: option }).click();
  await expect(list).toBeHidden();
}

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

  const canvas = canvasOf(page);
  await canvas.getByRole('button', { name: /^Implement \(agent-task\)/ }).click();
  // A configured profile is now always visible in the Agent Hub palette;
  // clear the launch binding explicitly to make the stage unrunnable.
  await pickChip(page, inspectorOf(page), 'Launch binding', /^None/);

  const status = page.getByRole('status').filter({ hasText: /error/ });
  await expect(status).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save workflow' })).toBeDisabled();
  await expect(canvas.getByRole('button', { name: /^Implement \(agent-task\).*issue/ })).toBeVisible();
});

test('the canvas moves a stage with the keyboard and selects it', async () => {
  const page = app.window;
  await newWorkflow(page, 'Governed delivery');

  const canvas = canvasOf(page);
  await expect(canvas).toBeVisible();

  const qaCard = canvas.getByRole('button', { name: /^QA \(check\)/ });
  await qaCard.focus();
  const before = await qaCard.evaluate(el => (el as HTMLElement).style.left);
  await qaCard.press('Shift+ArrowRight');
  await qaCard.press('Shift+ArrowRight');
  await expect.poll(async () => qaCard.evaluate(el => (el as HTMLElement).style.left)).not.toBe(before);

  await canvas.getByRole('button', { name: /^Review \(agent-task\)/ }).click();
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

  const canvas = canvasOf(page);
  const toolbar = page.getByTestId('wf-designer-toolbar');

  // Open agents submenu and drag an agent to empty canvas
  await toolbar.getByTestId('wf-tool-agents').click();
  const reviewer = page.getByTestId('wf-tool-agent-code-reviewer');
  await expect(reviewer).toBeVisible();

  await reviewer.dragTo(canvas, { targetPosition: { x: 330, y: 180 } });
  const reviewerStage = canvas.getByRole('button', { name: /^Code Reviewer \(agent-task\).*agent Code Reviewer/ });
  await expect(reviewerStage).toBeVisible();
  await expect(reviewerStage).toHaveAttribute('aria-pressed', 'true');

  // Open skills submenu and click a skill to attach it to the selected stage
  await toolbar.getByTestId('wf-tool-skills').click();
  const audit = page.getByTestId('wf-tool-skill-code-audit');
  await expect(audit).toBeVisible();
  await audit.click();
  await expect(reviewerStage).toContainText('code-audit');
  await expect(inspectorOf(page).getByTestId('wf-node-skill-code-audit')).toBeVisible();
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
  const csharpDep = dialog.locator('.wf-dep-item').filter({ hasText: 'csharp-dotnet-code-reviewer' });
  await expect(csharpDep.getByText('Installs on selection')).toBeVisible();
  // The implementer is installed, but its built-in skills are not yet, so its row installs too.
  const implementerDep = dialog.locator('.wf-dep-item').filter({ hasText: 'praxis-implementer' });
  await expect(implementerDep.getByText('Installs on selection')).toBeVisible();
  await expect(implementerDep.getByText('Skills: verification-report, visual-verification')).toBeVisible();
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

  const pane = page.getByTestId('workflow-validation-pane');
  await expect(pane).toBeVisible();
  await expect(page.getByTestId('wf-validation-banner')).toContainText('Workflow is configured and valid');
  await expect(page.getByTestId('wf-val-category-connections')).toContainText('Valid');
  await expect(page.getByTestId('wf-val-category-flow')).toContainText('Valid');
  await expect(page.getByTestId('wf-val-category-configuration')).toContainText('Valid');
  await page.screenshot({ path: 'output/playwright/workflow-validation-pane.png' });

  // Test clear and revalidate buttons in pane
  const clearBtn = page.getByTestId('wf-val-clear-btn');
  await clearBtn.click();
  await expect(page.getByTestId('wf-val-cleared-state')).toBeVisible();

  const recheckBtn = page.getByTestId('wf-val-recheck-btn');
  await recheckBtn.click();
  await expect(page.getByTestId('wf-val-cleared-state')).toHaveCount(0);
  await expect(page.getByTestId('wf-validation-banner')).toContainText('Workflow is configured and valid');

  // Close pane via close button
  await page.getByTestId('wf-val-close-btn').click();
  await expect(pane).toBeHidden();

  // 2. Introduce an invalid configuration (clear launch binding / agent id)
  const canvas = canvasOf(page);
  await canvas.getByRole('button', { name: /^Implement \(agent-task\)/ }).click();
  await pickChip(page, inspectorOf(page), 'Launch binding', /^None/);

  // 3. The header's validation chip reports the error, and re-runs validation when clicked
  await expect(validateBtn).toContainText(/1 error|\d+ errors/);
  await validateBtn.click();

  await expect(pane).toBeVisible();
  await expect(page.getByTestId('wf-validation-banner')).toContainText('Workflow configuration requires attention');
  await expect(page.getByTestId('wf-val-category-configuration')).toContainText(/issue/);
  await page.screenshot({ path: 'output/playwright/workflow-validation-pane-errors.png' });

  // Check Go to stage functionality
  const gotoBtn = pane.getByRole('button', { name: 'Go to stage' }).first();
  await expect(gotoBtn).toBeVisible();
  await gotoBtn.click();
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

test('a stage can run on its own AI and model, chosen from the AIs that are set up', async () => {
  const page = app.window;
  // Only Codex (the fake ACP agent) is set up; the other local AIs are off, so the list is predictable.
  await page.evaluate(async cliPath => {
    await window.praxis.settings.set({
      ai: {
        providers: {
          'codex-cli': { cliPath },
          'claude-code-cli': { enabled: false },
          'copilot-cli': { enabled: false },
          'antigravity-cli': { enabled: false }
        }
      }
    });
  }, path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs'));
  await newWorkflow(page, 'Governed delivery');
  await canvasOf(page).getByRole('button', { name: /^Plan \(agent-task\), entry stage/ }).click();
  const inspector = inspectorOf(page);

  const ai = inspector.getByTestId('wf-node-ai');
  await expect(ai).toHaveAttribute('data-value', '');
  await expect(ai).toContainText('Run’s AI');
  await expect(inspector.getByTestId('wf-node-model')).toHaveCount(0);
  await ai.click();
  const aiList = page.getByRole('listbox', { name: 'AI options' });
  await expect(aiList.getByRole('option')).toHaveText([/^Run’s AI/, /^OpenAI Codex/]);
  await aiList.getByRole('option', { name: /^OpenAI Codex/ }).click();
  await expect(ai).toHaveAttribute('data-value', 'codex-cli');
  // A model that is not in the AI's list can still be typed into the picker's filter and used.
  await inspector.getByTestId('wf-node-model').click();
  const modelList = page.getByRole('listbox', { name: 'Model options' });
  await modelList.getByLabel('Filter Model').fill('gpt-5.6-luna');
  await modelList.getByRole('option', { name: 'Use “gpt-5.6-luna”' }).click();
  await expect(inspector.getByTestId('wf-node-model')).toHaveAttribute('data-value', 'gpt-5.6-luna');
  await page.mouse.move(0, 0);
  await page.screenshot({ path: 'output/playwright/workflow-stage-ai.png' });

  await page.getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();
  const saved = await page.evaluate(async () => {
    const project = (await window.praxis.projects.list())[0];
    return JSON.stringify(await window.praxis.workflows.catalog(project.id));
  });
  expect(saved).toContain('"providerId":"codex-cli"');
  expect(saved).toContain('"model":"gpt-5.6-luna"');
});

test('stage skills are added from the picker dialog and removed from their chip', async () => {
  const page = app.window;
  await newWorkflow(page, 'Governed delivery');
  await canvasOf(page).getByRole('button', { name: /^Plan \(agent-task\), entry stage/ }).click();
  const inspector = inspectorOf(page);
  await expect(inspector.getByRole('list', { name: 'Active skills' })).toHaveCount(0);

  await inspector.getByTestId('wf-node-add-skill').click();
  const picker = page.getByRole('dialog', { name: 'Stage skills' });
  await expect(picker).toBeVisible();
  // Each skill shows its description, and the search narrows by it too.
  await expect(picker.getByTestId('wf-skill-option-code-audit')).toContainText('Reviews a change for correctness');
  await picker.getByLabel('Search skills').fill('no such skill');
  await expect(picker.getByTestId('wf-skill-option-code-audit')).toHaveCount(0);
  await picker.getByLabel('Search skills').fill('correctness');
  await picker.getByTestId('wf-skill-option-code-audit').click();
  await expect(picker.getByTestId('wf-skill-option-code-audit').getByRole('checkbox')).toBeChecked();
  await picker.getByRole('button', { name: 'Done' }).click();
  await expect(picker).toBeHidden();

  const chip = inspector.getByTestId('wf-node-skill-code-audit');
  await expect(chip).toBeVisible();
  await expect(canvasOf(page).getByRole('button', { name: /^Plan \(agent-task\)/ })).toContainText('code-audit');
  await chip.getByRole('button', { name: 'Remove skill Code Audit' }).click();
  await expect(chip).toHaveCount(0);
});

test('a connection selected on the canvas is edited in the inspector, with no separate tab', async () => {
  const page = app.window;
  await newWorkflow(page, 'Quick change');
  const inspector = inspectorOf(page);
  await expect(inspector.getByRole('tab')).toHaveCount(0);

  await canvasOf(page).locator('[data-testid^="wf-canvas-edge-line-"]').first().click({ force: true });
  await expect(inspector.getByRole('heading', { name: 'Connection' })).toBeVisible();
  const outcome = inspector.getByTestId('wf-edge-outcome');
  await expect(outcome).toHaveAttribute('data-value', 'success');
  await outcome.click();
  await page.getByRole('option', { name: /^On failure/ }).click();
  await expect(outcome).toHaveAttribute('data-value', 'failure');

  // Escape closes a picker without leaving the connection, and Backspace inside the inspector never deletes it.
  const edgesBefore = await canvasOf(page).locator('[data-testid^="wf-canvas-edge-line-"]').count();
  await outcome.click();
  await page.keyboard.press('Backspace');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('listbox')).toHaveCount(0);
  expect(await canvasOf(page).locator('[data-testid^="wf-canvas-edge-line-"]').count()).toBe(edgesBefore);
});

test('floating toolbar provides stage tools, canvas tools, and deletion', async () => {
  const page = app.window;
  await newWorkflow(page, 'Quick change');

  const canvas = canvasOf(page);
  const toolbar = page.getByTestId('wf-designer-toolbar');
  await expect(toolbar).toBeVisible();

  // Arrow (Select) tool is the first tool and active by default
  const selectTool = page.getByTestId('wf-tool-select');
  await expect(selectTool).toBeVisible();
  await expect(selectTool).toHaveClass(/is-active/);
  await expect(selectTool).toHaveAttribute('title', /Select/);
  await expect(selectTool).toHaveAttribute('aria-label', 'Select');

  // Stage and library tool buttons exist and all have tooltips
  for (const toolId of [
    'wf-tool-select',
    'wf-tool-agent-task',
    'wf-tool-check',
    'wf-tool-approval',
    'wf-tool-deployment',
    'wf-tool-join',
    'wf-tool-agents',
    'wf-tool-skills',
    'wf-auto-arrange',
    'wf-tool-zoom-in',
    'wf-tool-zoom-out',
    'wf-tool-reset-view',
    'wf-delete-selected',
    'wf-tool-help'
  ]) {
    const btn = page.getByTestId(toolId);
    await expect(btn).toBeVisible();
    const title = await btn.getAttribute('title');
    expect(title).toBeTruthy();
    const ariaLabel = await btn.getAttribute('aria-label');
    expect(ariaLabel).toBeTruthy();
  }

  // Clicking check tool adds a check stage
  const initialNodes = await canvas.locator('[data-node-id]').count();
  await page.getByTestId('wf-tool-check').click();
  await expect(canvas.locator('[data-node-id]')).toHaveCount(initialNodes + 1);

  // The newly added check stage is selected, and delete button is enabled
  const deleteBtn = page.getByTestId('wf-delete-selected');
  await expect(deleteBtn).toBeEnabled();
  await deleteBtn.click();
  await expect(canvas.locator('[data-node-id]')).toHaveCount(initialNodes);

  // Dragging toolbar handle moves the toolbar
  const handle = toolbar.locator('.designer-toolbar-handle');
  const boxBefore = await toolbar.boundingBox();
  expect(boxBefore).not.toBeNull();
  if (boxBefore) {
    await handle.hover();
    await page.mouse.down();
    await page.mouse.move(boxBefore.x + 80, boxBefore.y + 80);
    await page.mouse.up();
    const boxAfter = await toolbar.boundingBox();
    expect(boxAfter).not.toBeNull();
    if (boxAfter) {
      expect(boxAfter.x).not.toBe(boxBefore.x);
    }
  }
});

test('clicking and dragging on the designer surface pans the canvas without changing zoom', async () => {
  const page = app.window;
  await newWorkflow(page, 'Quick change');

  const canvas = canvasOf(page);
  const world = canvas.locator('.wf-canvas-world');

  // Initial transform has scale(1)
  const initialTransform = await world.evaluate(el => (el as HTMLElement).style.transform);
  expect(initialTransform).toContain('scale(1)');

  // Click on empty canvas space and drag to pan
  const canvasBox = await canvas.boundingBox();
  expect(canvasBox).not.toBeNull();
  if (canvasBox) {
    const startX = canvasBox.x + 200;
    const startY = canvasBox.y + 350;
    await page.mouse.move(startX, startY);
    await page.mouse.down();
    await page.mouse.move(startX + 80, startY + 50);
    await page.mouse.up();

    const afterDragTransform = await world.evaluate(el => (el as HTMLElement).style.transform);
    // Transform translate should change, but scale(1) MUST remain unchanged (no zooming on drag!)
    expect(afterDragTransform).not.toBe(initialTransform);
    expect(afterDragTransform).toContain('scale(1)');
  }

  // Wheel scrolling also pans without zooming
  await canvas.hover();
  await page.mouse.wheel(0, 100);
  const afterWheelTransform = await world.evaluate(el => (el as HTMLElement).style.transform);
  expect(afterWheelTransform).toContain('scale(1)');
});

test('floating toolbar provides agent and skill submenus with scrolling list, icon, and text', async () => {
  const page = app.window;
  await newWorkflow(page, 'Quick change');

  const canvas = canvasOf(page);
  const toolbar = page.getByTestId('wf-designer-toolbar');
  await expect(toolbar).toBeVisible();

  // Agents button exists and has a vertical line indicator on the left side
  const agentsBtn = page.getByTestId('wf-tool-agents');
  await expect(agentsBtn).toBeVisible();
  await expect(agentsBtn).toHaveAttribute('title', /Agents/);
  await expect(agentsBtn).toHaveAttribute('aria-haspopup', 'true');
  const agentsLineIndicator = page.getByTestId('wf-tool-indicator-line-agents');
  await expect(agentsLineIndicator).toBeVisible();

  // Skills button exists and has a vertical line indicator on the left side
  const skillsBtn = page.getByTestId('wf-tool-skills');
  await expect(skillsBtn).toBeVisible();
  await expect(skillsBtn).toHaveAttribute('title', /Skills/);
  await expect(skillsBtn).toHaveAttribute('aria-haspopup', 'true');
  const skillsLineIndicator = page.getByTestId('wf-tool-indicator-line-skills');
  await expect(skillsLineIndicator).toBeVisible();

  // Submenus are closed initially
  await expect(page.getByTestId('wf-submenu-agents')).not.toBeVisible();
  await expect(page.getByTestId('wf-submenu-skills')).not.toBeVisible();

  // Click agents button to open agents submenu — opens to the right since toolbar is on the left
  await agentsBtn.click();
  const agentsSubmenu = page.getByTestId('wf-submenu-agents');
  await expect(agentsSubmenu).toBeVisible();
  await expect(agentsBtn).toHaveClass(/is-active/);
  await expect(agentsSubmenu).not.toHaveClass(/designer-submenu--left/);
  await page.waitForTimeout(200);
  await page.screenshot({ path: 'output/playwright/wf-agents-submenu.png' });

  // Scrolling mouse wheel over the submenu list does NOT pan the canvas
  const world = canvas.locator('.wf-canvas-world');
  const worldBeforeWheel = await world.evaluate(el => (el as HTMLElement).style.transform);
  await agentsSubmenu.locator('.designer-submenu-list').hover();
  await page.mouse.wheel(0, 40);
  const worldAfterWheel = await world.evaluate(el => (el as HTMLElement).style.transform);
  expect(worldAfterWheel).toBe(worldBeforeWheel);

  // Check header, count, and scrollable list
  await expect(agentsSubmenu.locator('.designer-submenu-header')).toContainText('Agents');
  const agentList = agentsSubmenu.locator('.designer-submenu-list');
  await expect(agentList).toBeVisible();
  const agentItems = agentsSubmenu.locator('.designer-submenu-item');
  const agentCount = await agentItems.count();
  expect(agentCount).toBeGreaterThan(0);

  // Each agent item has an icon and text
  const firstAgent = agentItems.first();
  await expect(firstAgent.locator('.designer-submenu-item-icon')).toBeVisible();
  await expect(firstAgent.locator('.designer-submenu-item-text')).toBeVisible();
  const agentName = await firstAgent.locator('.designer-submenu-item-text').innerText();
  expect(agentName.length).toBeGreaterThan(0);

  // Clicking an agent adds it to canvas and closes submenu
  const initialNodes = await canvas.locator('[data-node-id]').count();
  await firstAgent.click();
  await expect(canvas.locator('[data-node-id]')).toHaveCount(initialNodes + 1);
  await expect(agentsSubmenu).not.toBeVisible();

  // Open skills submenu
  await skillsBtn.click();
  const skillsSubmenu = page.getByTestId('wf-submenu-skills');
  await expect(skillsSubmenu).toBeVisible();
  await expect(skillsBtn).toHaveClass(/is-active/);
  await page.screenshot({ path: 'output/playwright/wf-skills-submenu.png' });

  // Check header, count, and scrollable list
  await expect(skillsSubmenu.locator('.designer-submenu-header')).toContainText('Skills');
  const skillItems = skillsSubmenu.locator('.designer-submenu-item');
  const skillCount = await skillItems.count();
  expect(skillCount).toBeGreaterThan(0);

  // Each skill item has an icon and text
  const firstSkill = skillItems.first();
  await expect(firstSkill.locator('.designer-submenu-item-icon')).toBeVisible();
  await expect(firstSkill.locator('.designer-submenu-item-text')).toBeVisible();
  const skillTitle = await firstSkill.locator('.designer-submenu-item-text').innerText();
  expect(skillTitle.length).toBeGreaterThan(0);

  // Clicking a skill attaches it to the selected agent stage and closes submenu
  await firstSkill.click();
  await expect(skillsSubmenu).not.toBeVisible();

  // Escape key closes open submenu
  await agentsBtn.click();
  await expect(page.getByTestId('wf-submenu-agents')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByTestId('wf-submenu-agents')).not.toBeVisible();

  // Dragging toolbar to the right side of the canvas where there is more space on the left:
  // Submenu should open to the left (designer-submenu--left)
  const handle = toolbar.locator('.designer-toolbar-handle');
  const canvasBox = await canvas.boundingBox();
  const toolbarBox = await toolbar.boundingBox();
  expect(canvasBox).not.toBeNull();
  expect(toolbarBox).not.toBeNull();
  if (canvasBox && toolbarBox) {
    const targetX = canvasBox.x + canvasBox.width - 80;
    await handle.hover();
    await page.mouse.down();
    await page.mouse.move(targetX, toolbarBox.y);
    await page.mouse.up();

    // Now open agents submenu on the right side
    await agentsBtn.click();
    const rightSideSubmenu = page.getByTestId('wf-submenu-agents');
    await expect(rightSideSubmenu).toBeVisible();
    await expect(rightSideSubmenu).toHaveClass(/designer-submenu--left/);
    await page.waitForTimeout(200);
    await page.screenshot({ path: 'output/playwright/wf-submenu-open-left.png' });
  }

  // With <= 10 items in fixture, search input is not rendered
  await expect(page.getByTestId('wf-submenu-agents-search')).not.toBeVisible();
});

test('submenu displays search box when items exceed 10, filters real-time, and clears on escape or button click', async () => {
  const page = app.window;
  // Seed extra agents so total agents > 10
  for (let i = 1; i <= 12; i++) {
    seedAgent(app.userDataDir, `extra-agent-${i}`, `Specialist Agent ${String.fromCharCode(64 + i)}`);
  }
  await page.evaluate(async () => window.praxis.agentRuntime.refresh());

  await newWorkflow(page, 'Quick change');
  const canvas = canvasOf(page);
  const toolbar = page.getByTestId('wf-designer-toolbar');
  const agentsBtn = toolbar.getByTestId('wf-tool-agents');

  // Open agents submenu
  await agentsBtn.click();
  const agentsSubmenu = page.getByTestId('wf-submenu-agents');
  await expect(agentsSubmenu).toBeVisible();

  // Search box is displayed because total agents > 10
  const searchInput = page.getByTestId('wf-submenu-agents-search');
  await expect(searchInput).toBeVisible();
  await expect(searchInput).toHaveAttribute('placeholder', 'Search agents…');

  const totalAgents = await agentsSubmenu.locator('.designer-submenu-item').count();
  expect(totalAgents).toBeGreaterThan(10);

  // Type filter query
  await searchInput.fill('Specialist Agent B');
  await expect(agentsSubmenu.locator('.designer-submenu-header')).toContainText(`1/${totalAgents}`);
  await expect(agentsSubmenu.locator('.designer-submenu-item')).toHaveCount(1);
  await expect(agentsSubmenu.locator('.designer-submenu-item-text')).toHaveText('Specialist Agent B');

  // Clear button is visible when query is present
  const clearBtn = agentsSubmenu.locator('.designer-submenu-search-clear');
  await expect(clearBtn).toBeVisible();

  // Visual screenshot of search in action
  await page.screenshot({ path: 'output/playwright/wf-submenu-search.png' });

  // Pressing Escape while query is present clears search text
  await searchInput.press('Escape');
  await expect(searchInput).toHaveValue('');
  await expect(agentsSubmenu.locator('.designer-submenu-item')).toHaveCount(totalAgents);

  // Test typing a query that matches nothing
  await searchInput.fill('nonexistent-query-xyz');
  await expect(agentsSubmenu.locator('.designer-submenu-empty')).toHaveText('No matching agents');
  await expect(agentsSubmenu.locator('.designer-submenu-item')).toHaveCount(0);

  // Clicking clear button clears query
  await clearBtn.click();
  await expect(searchInput).toHaveValue('');
  await expect(agentsSubmenu.locator('.designer-submenu-item')).toHaveCount(totalAgents);

  // Backspace/Delete inside search input does not delete any canvas elements
  const stagesCountBefore = await canvas.locator('[data-node-id]').count();
  await searchInput.focus();
  await searchInput.fill('Agent');
  await searchInput.press('Backspace');
  await searchInput.press('Delete');
  const stagesCountAfter = await canvas.locator('[data-node-id]').count();
  expect(stagesCountAfter).toBe(stagesCountBefore);

  // Clear search and press Escape to close submenu
  await clearBtn.click();
  await searchInput.press('Escape');
  await expect(agentsSubmenu).not.toBeVisible();
});
