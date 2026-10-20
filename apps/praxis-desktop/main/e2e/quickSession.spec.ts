import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { chooseOption } from './chipSelect';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * The title-bar quick-session button (FX-QUICK): one click opens the composer
 * already scoped to the current project with the quick-change workflow
 * pre-selected and the goal focused — "ready to go", no pickers to visit.
 */

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
});

async function seedProject(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Quick session project',
      key: 'QUICK',
      type: 'product',
      purpose: '',
      brief: {},
      startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
      starterTickets: [{ summary: 'Quick session ticket', description: '', issueType: 'Task', status: 'To do' }],
      defaultAiToolMode: 'read-only'
    }, workspace.id);
    await window.praxis.workflows.instantiate(project.id, 'quick-change');
    return project.id;
  });
}

async function seedProjects(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    for (const [name, key] of [['First project', 'FIRST'], ['Target project', 'TARGET']] as const) {
      await window.praxis.projects.create({
        name,
        key,
        type: 'product',
        purpose: '',
        brief: {},
        startingPoint: 'app-storage',
        workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
        starterTickets: [{ summary: `${name} ticket`, description: '', issueType: 'Task', status: 'To do' }],
        defaultAiToolMode: 'read-only'
      }, workspace.id);
    }
  });
}

test('the title-bar quick session opens the composer scoped to the current project with quick-change ready', async ({ page: _page }) => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'quick-session-e2e-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const page = app.window;

  await seedProject(page);
  // Reload so the shell picks up the seeded project and its workflow readiness.
  await page.reload();
  await page.getByTestId(`project-nav-item`).first().waitFor({ state: 'visible' });

  await expect(page.getByTestId('quick-session')).toBeVisible();
  await page.getByTestId('quick-session').click();

  // Scoped to the current project, not a board.
  await expect(page.getByTestId('new-session-view')).toBeVisible();
  await expect(page.getByTestId('new-session-scope-heading')).toContainText('Quick session project');

  // Quick-change is pre-selected on the workflow chip.
  await expect(page.getByTestId('new-session-workflow-chip')).toContainText('Quick change');

  // The goal textarea is focused — ready to type.
  await expect(page.locator('.composer-input')).toBeFocused();

  // Starting the session runs it under the quick-change workflow.
  await page.locator('.composer-input').fill('Ship a tiny copy fix.');
  await page.getByTestId('new-session-submit').click();
  await expect(page.getByTestId('session-console')).toBeVisible();
  await expect.poll(async () => page.evaluate(async () => {
    const sessions = await window.praxis.ai.listSessions();
    return sessions.find(session => session.taskDefinition.goal.includes('Ship a tiny copy fix'))?.workflowRunIds?.length ?? 0;
  })).toBe(1);

  await page.screenshot({
    path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'quick-session-started.png'),
    fullPage: true
  });
});

test('a project session action scopes the composer to that project', async ({ page: _page }) => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'project-picker-e2e-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const page = app.window;

  await seedProjects(page);
  await page.reload();
  // Classic mode shows one project at a time; the title chip's project picker switches between them.
  await expect(page.getByTestId('project-tree')).toHaveCount(1);
  const picker = page.getByTestId('titlebar-project-select');
  await picker.click();
  const menu = page.locator('.titlebar-context-project-menu');
  await expect(menu.getByRole('menuitem')).toHaveCount(2);
  await menu.getByRole('menuitem', { name: 'Target project' }).click();
  await expect(picker).toContainText('Target project');
  await expect(page.getByTestId('project-tree')).toHaveCount(1);
  await expect(page.getByTestId('project-tree')).toContainText('Target project');
  await expect(page.getByTestId('board-nav-item').filter({ hasText: 'First project Board' })).toHaveCount(0);

  // Global navigation must retain the chosen project instead of reverting
  // to the workspace's first/default project.
  await page.getByTestId('nav-overview').click();
  await expect(picker).toContainText('Target project');
  await expect(page.getByTestId('project-tree')).toHaveCount(1);
  await expect(page.getByTestId('project-tree')).toContainText('Target project');
  await picker.click();
  await page.screenshot({
    path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'classic-project-picker.png'),
    fullPage: true
  });
  await menu.getByRole('menuitem', { name: 'First project' }).click();
  await expect(page.getByTestId('project-tree')).toContainText('First project');
  await expect(page.getByTestId('project-tree')).toHaveCount(1);
  await picker.click();
  await menu.getByRole('menuitem', { name: 'Target project' }).click();
  await page.reload();
  await expect(picker).toContainText('Target project');
  await expect(page.getByTestId('project-tree')).toHaveCount(1);

  await page.getByTestId('project-tree').getByTestId('project-session-new').click();

  await expect(page.getByTestId('new-session-scope-heading')).toContainText('Target project');
  await page.screenshot({
    path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'project-session-scope.png'),
    fullPage: true
  });

  await page.locator('.composer-input').fill('Keep the target project selected.');
  await page.getByTestId('new-session-submit').click();
  await expect(page.getByTestId('session-console')).toBeVisible();
  await expect(picker).toContainText('Target project');
  await expect(page.getByTestId('project-tree')).toHaveCount(1);
  await expect(page.getByTestId('project-tree').getByTestId('project-session-nav-item')).toHaveCount(1);
  await page.reload();
  await expect(picker).toContainText('Target project');
  await expect(page.getByTestId('project-tree')).toHaveCount(1);
  await picker.click();
  await page.screenshot({
    path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'classic-project-session.png'),
    fullPage: true
  });
});

test('draft and existing sessions share the composer frame and input layout', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'composer-frame-e2e-key', AI_GATEWAY_URL: mock.baseUrl
  });
  const page = app.window;
  await seedProject(page);
  await page.reload();
  await page.getByTestId('project-session-new').first().click();
  const draft = page.getByTestId('new-session-view');
  const card = draft.locator('.session-follow-up-composer');
  // A draft has used nothing yet: 0 tok, never "Not reported".
  await expect(draft.getByTestId('session-usage-summary')).toContainText('0 tok');
  await expect(draft.getByTestId('session-usage-summary')).not.toContainText(/not reported/i);
  await draft.getByTestId('session-usage-summary').locator(':scope > summary').click();
  await expect(draft.locator('.composer-usage-expanded')).toContainText('No usage recorded for this session yet');
  await draft.getByTestId('session-usage-summary').locator(':scope > summary').click();
  await expect(draft.locator('.composer-usage-expanded')).toBeHidden();
  await expect(draft.getByTestId('new-session-context-indicator')).toBeVisible();
  await expect(card.locator('.session-mode-panel')).toBeVisible();
  await expect(card.locator('.composer-controls .session-mode-toggle')).toHaveCount(0);
  await expect(draft.getByTestId('new-session-tool-mode')).toBeVisible();
  await chooseOption(draft.getByTestId('new-session-tool-mode'), 'read-only');
  await page.evaluate(() => window.praxis.settings.set({ ai: { spendLimit: 25 } }));
  await expect(draft.getByTestId('new-session-tool-mode')).toHaveAttribute('data-value', 'read-only');
  const input = card.locator('textarea');
  await expect(input).toHaveAttribute('rows', '1');
  await input.fill('Compare composer frames.');
  const inputStyle = await input.evaluate(element => {
    const style = getComputedStyle(element);
    return [style.fontSize, style.lineHeight, style.paddingTop, style.maxHeight];
  });
  const artifacts = path.resolve(__dirname, '../../../../.praxis/session-artifacts');
  await page.screenshot({ path: path.join(artifacts, 'composer-draft-matched.png'), fullPage: true });
  await draft.getByTestId('new-session-submit').click();
  await expect(page.getByTestId('session-console')).toBeVisible();
  await expect(page.getByTestId('session-follow-up-input')).toBeEnabled();
  const active = page.getByTestId('session-follow-up-input');
  expect(await active.evaluate(element => {
    const style = getComputedStyle(element);
    return [style.fontSize, style.lineHeight, style.paddingTop, style.maxHeight];
  })).toEqual(inputStyle);
  await expect(page.getByTestId('session-mode-panel')).toBeVisible();
  await page.screenshot({ path: path.join(artifacts, 'composer-existing-matched.png'), fullPage: true });
});
