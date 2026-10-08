import { expect, test, type Locator, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp as launchApp, type TestApp } from './launchTestApp';

/**
 * FX-BF-108 — loops, findings routing and run parameters, end to end.
 *
 * The designer draws and edits a loop edge and it survives a save and reload
 * (the failure mode a field missing from `normalizeWorkflow` produces). A run of
 * Governed delivery whose review keeps reporting a high finding goes back to
 * Implement, shows which pass it is on, and — once its budget is spent — waits
 * for a person, whose answer is recorded. Improve until target asks for its goal
 * and target and shows the worst case before it starts.
 *
 * Stages are advanced through the same manual seam the other workflow specs use;
 * no model is called.
 */

test.slow();

const launchTestApp: typeof launchApp = (seed, reuse, env, options) => launchApp(seed, reuse, {
  AI_GATEWAY_API_KEY: 'e2e-manual-workflow', AI_GATEWAY_URL: 'http://127.0.0.1:1', VERCEL_OIDC_TOKEN: undefined, ...env
}, options);

let app: TestApp;

test.afterEach(async () => {
  await closeTestApp(app);
});

async function seedProject(page: Page, templates: string[]): Promise<string> {
  const projectId = await page.evaluate(async ids => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create(
      {
        name: 'Loop Project',
        key: 'LOOP',
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
    for (const id of ids) await window.praxis.workflows.instantiate(project.id, id);
    localStorage.setItem(`praxis-last-workspace-route:${localStorage.getItem('praxis-active-workspace')}`, JSON.stringify({ projectId: project.id, feature: 'workflows' }));
    return project.id;
  }, templates);
  await page.reload();
  return projectId;
}

const canvasOf = (page: Page) => page.getByRole('application', { name: 'Workflow canvas' });
const inspectorOf = (page: Page) => page.getByRole('region', { name: 'Stage inspector' });
const runPanel = (page: Page) => page.getByTestId('wf-run-panel');

async function pickChip(page: Page, scope: Locator, label: string, option: string | RegExp): Promise<void> {
  await scope.getByRole('button', { name: label, exact: true }).click();
  const list = page.getByRole('listbox', { name: `${label} options` });
  await list.getByRole('option', { name: option }).click();
  await expect(list).toBeHidden();
}

const HIGH = {
  findings: [{ fingerprint: 'fp-pager', severity: 'high', category: 'bug', message: 'Off by one in the pager', file: 'src/pager.ts', line: 12, suggestion: 'Start from page 0.' }],
  metrics: { issuesFound: 1 }
};

/** Advances stages of the newest run through the manual seam, in order. */
async function advance(page: Page, steps: Array<[string, 'succeeded' | 'failed', unknown?]>): Promise<void> {
  await page.evaluate(async list => {
    const project = (await window.praxis.projects.list())[0];
    const run = (await window.praxis.workflows.listRuns(project.id))[0];
    for (const [nodeId, outcome, findings] of list) {
      await window.praxis.workflows.advanceStage(run.runId, nodeId, outcome, findings ? { findings: findings as never } : undefined);
    }
  }, steps);
}

test('a loop edge is drawn distinctly, edited in the inspector, and survives save and reload', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seedProject(page, ['governed-delivery']);
  await page.getByTestId('project-workflow-nav-item').filter({ hasText: 'Governed delivery' }).first().click();

  const canvas = canvasOf(page);
  await expect(canvas.getByRole('button', { name: /^Review \(agent-task\)/ })).toBeVisible();
  // The way back is labelled on the edge itself.
  await expect(canvas.getByTestId('wf-edge-badge-e-review-fix')).toHaveText('↺ up to 2× on findings');
  await page.screenshot({ path: 'output/playwright/workflow-loops-designer.png' });

  await canvas.getByTestId('wf-edge-badge-e-review-fix').click();
  const inspector = inspectorOf(page);
  await expect(inspector.getByRole('heading', { name: 'Connection' })).toBeVisible();
  await expect(inspector.getByTestId('wf-edge-outcome')).toHaveAttribute('data-value', 'findings');
  await expect(inspector.getByTestId('wf-edge-loop-toggle')).toBeChecked();
  await expect(inspector.getByTestId('wf-edge-loop-iterations')).toHaveValue('2');
  await page.screenshot({ path: 'output/playwright/workflow-loops-edge-inspector.png' });
  await expect(inspector.getByRole('textbox', { name: 'Finding categories' })).toBeVisible();

  // An out-of-range budget is named on the connection, and blocks saving.
  await inspector.getByTestId('wf-edge-loop-iterations').fill('0');
  await expect(inspector.getByTestId('wf-edge-issues')).toContainText('needs a budget of 1 to 10 iterations');
  await expect(page.getByRole('button', { name: 'Save workflow' })).toBeDisabled();

  await inspector.getByTestId('wf-edge-loop-iterations').fill('3');
  await pickChip(page, inspector, 'Finding severity', /^Critical/);
  await inspector.getByTestId('wf-edge-keep-best').check();
  await expect(inspector.getByTestId('wf-edge-issues')).toHaveCount(0);
  await page.getByRole('button', { name: 'Save workflow' }).click();
  await expect(page.getByRole('button', { name: 'Saved' })).toBeVisible();

  await page.reload();
  await expect(canvasOf(page).getByTestId('wf-edge-badge-e-review-fix')).toHaveText('↺ up to 3× on findings');
  await canvasOf(page).getByTestId('wf-edge-badge-e-review-fix').click();
  const reopened = inspectorOf(page);
  await expect(reopened.getByTestId('wf-edge-loop-iterations')).toHaveValue('3');
  await expect(reopened.getByTestId('wf-edge-severity')).toHaveAttribute('data-value', 'critical');
  await expect(reopened.getByTestId('wf-edge-keep-best')).toBeChecked();

  // Independence is set on the reviewer and stays set.
  await canvasOf(page).getByRole('button', { name: /^Review \(agent-task\)/ }).click();
  await expect(inspectorOf(page).getByTestId('wf-node-independent-of')).toHaveAttribute('data-value', 'implement');
});

test('a back-edge is a cycle unless it carries a loop budget', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seedProject(page, []);
  const result = await page.evaluate(async () => {
    const project = (await window.praxis.projects.list())[0];
    const agent = { agentId: 'praxis-implementer', scope: 'global' as const, toolMode: 'full' as const };
    const definition = {
      schemaVersion: 1, id: 'back', name: 'Back', scope: 'project' as const, projectId: project.id, version: 1, entryNodeId: 'implement',
      createdAt: '2026-10-08T00:00:00.000Z', updatedAt: '2026-10-08T00:00:00.000Z',
      nodes: [
        { type: 'agent-task' as const, id: 'implement', name: 'Implement', x: 0, y: 0, inputs: [], agent, instructions: 'Build.', outputs: [{ id: 'diff', kind: 'diff' as const, required: true }], mutatesWorktree: true },
        { type: 'check' as const, id: 'test', name: 'Test', x: 0, y: 0, inputs: ['diff'], command: 'npm', args: ['test'], outputs: [] }
      ],
      edges: [{ id: 'e-test', from: 'implement', to: 'test', on: 'success' as const, required: true }]
    };
    const back = { id: 'e-back', from: 'test', to: 'implement', on: 'failure' as const, required: true };
    const plain = await window.praxis.workflows.validate(project.id, { ...definition, edges: [...definition.edges, back] });
    const bounded = await window.praxis.workflows.validate(project.id, { ...definition, edges: [...definition.edges, { ...back, loop: { maxIterations: 2 } }] });
    return { plain: plain.errors.map(error => error.message), bounded: bounded.errors.map(error => error.message) };
  });
  expect(result.plain.join(' ')).toMatch(/cycle.*mark the edge that returns as a loop edge/);
  expect(result.bounded).toEqual([]);
});

test('a review that keeps finding a high bug loops back, then waits for a decision that is recorded', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seedProject(page, ['governed-delivery']);

  await page.getByRole('button', { name: /^Start a run of / }).first().click();
  const dialog = page.getByTestId('wf-runstart-dialog');
  await dialog.getByLabel('Run task').fill('Fix the pager');
  // The worst case is shown before anything starts; this machine has measured nothing yet.
  await expect(dialog.getByTestId('wf-runstart-estimate-launches')).toContainText('at worst');
  await expect(dialog.getByTestId('wf-runstart-estimate-tokens')).toContainText('not estimable');
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(runPanel(page)).toBeVisible();

  const pass = (findings: unknown): Array<[string, 'succeeded' | 'failed', unknown?]> => [
    ['implement', 'succeeded'],
    ['test-contracts', 'succeeded'],
    ['review', 'succeeded', findings]
  ];
  await advance(page, [['plan', 'succeeded'], ...pass(HIGH)]);

  // Back to Implement: the pipeline says which pass this is, and the loop's history names the finding.
  await expect(runPanel(page).getByTestId('wf-vpipe-pass-implement')).toContainText('pass 2 of 3');
  const loops = runPanel(page).getByTestId('wf-loops');
  await expect(loops.getByTestId('wf-loop-e-review-fix')).toContainText('Review → Implement');
  await expect(loops.getByTestId('wf-loop-pass')).toHaveCount(1);
  await expect(loops.getByTestId('wf-loop-pass').first()).toContainText('Off by one in the pager');

  await advance(page, pass(HIGH));
  await advance(page, pass(HIGH));

  // Budget spent: a decision, in the run view and on the sidebar row.
  const decision = runPanel(page).getByTestId('wf-loop-decision');
  await expect(decision).toBeVisible();
  await expect(decision).toContainText('after 2 of 2 passes back to Implement');
  await expect(decision).toContainText('Off by one in the pager');
  await expect(page.getByTestId('project-workflow-run-row').first()).toHaveAttribute('data-run-status', 'needs-decision');
  await page.screenshot({ path: 'output/playwright/workflow-loops-decision.png' });

  // One more pass, then accept with a reason.
  await decision.getByTestId('wf-loop-grant').click();
  await expect(runPanel(page).getByTestId('wf-vpipe-pass-implement')).toContainText('pass 4 of 4');
  await advance(page, pass(HIGH));
  await expect(runPanel(page).getByTestId('wf-loop-decision')).toBeVisible();
  await runPanel(page).getByTestId('wf-loop-accept').click();
  const prompt = page.getByRole('dialog', { name: 'Accept this result?' });
  await prompt.getByRole('textbox').fill('Known issue, tracked separately');
  await prompt.getByRole('button', { name: 'OK', exact: true }).click();

  await expect(runPanel(page).getByTestId('wf-loop-decision')).toHaveCount(0);
  await expect(loops).toContainText('desktop-user allowed 1 more');
  await expect(loops).toContainText('desktop-user accepted the result: Known issue, tracked separately');
  await loops.scrollIntoViewIfNeeded();
  await page.screenshot({ path: 'output/playwright/workflow-loops-accepted.png' });

  // The review gate still holds on the high finding: accepting the loop does not sign off delivery.
  await advance(page, [['install', 'succeeded'], ['build', 'succeeded'], ['qa', 'succeeded'], ['security', 'succeeded', { findings: [], metrics: {} }]]);
  await page.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(runPanel(page).getByRole('alert').filter({ hasText: 'Blocked on review (failed)' })).toBeVisible();
  const status = await page.evaluate(async () => {
    const project = (await window.praxis.projects.list())[0];
    return (await window.praxis.workflows.listRuns(project.id))[0].status;
  });
  expect(status).not.toBe('succeeded');
});

test('improve until target asks for its goal and target and checks them before it starts', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const projectId = await seedProject(page, ['improve-until-target']);

  await page.getByRole('button', { name: /^Start a run of / }).first().click();
  const dialog = page.getByTestId('wf-runstart-dialog');
  await dialog.getByLabel('Run task').fill('Speed up the pager');
  const parameters = dialog.getByTestId('wf-runstart-parameters');
  await expect(parameters).toBeVisible();
  await expect(parameters).toContainText('Give a target or a rubric');
  await expect(dialog.getByTestId('wf-runstart-param-iterations')).toHaveValue('3');
  await page.screenshot({ path: 'output/playwright/workflow-loops-start-dialog.png' });

  // Without a goal the run refuses to start, saying why.
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(dialog.getByRole('alert').filter({ hasText: /Goal is required/ })).toBeVisible();

  await dialog.getByTestId('wf-runstart-param-goal').fill('Render the first page in under 100 ms');
  await dialog.getByTestId('wf-runstart-param-target').fill('85');
  // Raising the iteration count raises the ceiling shown.
  const before = await dialog.getByTestId('wf-runstart-estimate-launches').textContent();
  await dialog.getByTestId('wf-runstart-param-iterations').fill('6');
  await expect(dialog.getByTestId('wf-runstart-estimate-launches')).not.toHaveText(before ?? '');

  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(runPanel(page)).toBeVisible();
  const recorded = await page.evaluate(async id => (await window.praxis.workflows.listRuns(id))[0].parameters, projectId);
  expect(recorded).toEqual({ goal: 'Render the first page in under 100 ms', target: 85, iterations: 6 });
});

test('the loop views read in dark mode too', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await page.evaluate(() => window.praxis.settings.set({ appearance: { themeId: 'praxis-dark', themeMode: 'dark' } }));
  await seedProject(page, ['governed-delivery']);
  await expect(page.locator('html')).toHaveAttribute('data-mode', 'dark');
  await page.getByRole('button', { name: /^Start a run of / }).first().click();
  const dialog = page.getByTestId('wf-runstart-dialog');
  await dialog.getByLabel('Run task').fill('Fix the pager');
  await dialog.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(runPanel(page)).toBeVisible();
  for (let lap = 0; lap < 3; lap += 1) {
    await advance(page, [...(lap === 0 ? [['plan', 'succeeded'] as [string, 'succeeded']] : []), ['implement', 'succeeded'], ['test-contracts', 'succeeded'], ['review', 'succeeded', HIGH]]);
  }
  await expect(runPanel(page).getByTestId('wf-loop-decision')).toBeVisible();
  await page.screenshot({ path: 'output/playwright/workflow-loops-decision-dark.png' });
  await page.getByTestId('project-workflow-nav-item').filter({ hasText: 'Governed delivery' }).first().click();
  await expect(canvasOf(page).getByTestId('wf-edge-badge-e-review-fix')).toBeVisible();
  await page.screenshot({ path: 'output/playwright/workflow-loops-designer-dark.png' });
});
