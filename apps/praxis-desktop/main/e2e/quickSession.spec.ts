import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
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
