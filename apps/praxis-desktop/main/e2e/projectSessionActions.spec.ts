import * as path from 'node:path';
import { openProject } from './navigation';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

test.slow();

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
});

test('General and Ticket project sessions expose rename, archive, and delete actions', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'project-session-actions-e2e-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const page = app.window;

  const projectId = await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Session actions project',
      key: 'ACTIONS',
      type: 'product',
      purpose: '',
      brief: {},
      startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
      starterTickets: [{ summary: 'Session actions ticket', description: '', issueType: 'Task', status: 'To do' }],
      defaultAiToolMode: 'read-only'
    }, workspace.id);
    await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      projectId: project.id,
      task: { goal: 'General sidebar action session' }
    });
    await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      projectId: project.id,
      issueKey: 'APP-101',
      task: { goal: 'Ticket sidebar action session' }
    });
    await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      task: { goal: 'Standalone sidebar action session' }
    });
    return project.id;
  });

  await expect.poll(() => page.evaluate(async id => {
    const sessions = await window.praxis.ai.listSessions();
    return sessions.filter(session => session.projectId === id).length;
  }, projectId), { timeout: 30000 }).toBe(2);
  await page.reload();
  await openProject(page, 'Session actions project');
  await expect(page.getByTestId('sidebar-project-select')).toContainText('Session actions project');

  const sessions = await page.evaluate(() => window.praxis.ai.listSessions());
  const keyFor = (goal: string) => sessions.find(session => session.taskDefinition.goal === goal)!.issueKey;
  const generalKey = keyFor('General sidebar action session');
  const ticketKey = keyFor('Ticket sidebar action session');
  const standaloneKey = keyFor('Standalone sidebar action session');
  const list = page.getByTestId('easymode-sessions-list');
  const card = (key: string) => list.getByTestId(`easymode-session-card-${key}`);

  // The project's feed holds its own sessions only; the standalone chat lives under General conversations.
  await expect(card(generalKey)).toBeVisible();
  await expect(card(ticketKey)).toBeVisible();
  await expect(card(standaloneKey)).toHaveCount(0);
  for (const key of [generalKey, ticketKey]) {
    await card(key).hover();
    await expect(page.getByTestId(`easymode-session-rename-${key}`)).toBeVisible();
    await expect(page.getByTestId(`easymode-session-archive-${key}`)).toBeVisible();
    await expect(page.getByTestId(`easymode-session-delete-${key}`)).toBeVisible();
  }
  await page.screenshot({ path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'project-session-actions.png') });

  await card(generalKey).hover();
  await page.getByTestId(`easymode-session-rename-${generalKey}`).click();
  const titleInput = page.getByTestId(`easymode-session-title-input-${generalKey}`);
  await titleInput.fill('Renamed general session');
  await titleInput.press('Enter');
  await expect(card(generalKey)).toContainText('Renamed general session');

  await card(ticketKey).hover();
  await page.getByTestId(`easymode-session-archive-${ticketKey}`).click();
  await expect(card(ticketKey)).toHaveCount(0);

  await card(generalKey).hover();
  await page.getByTestId(`easymode-session-delete-${generalKey}`).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Delete this session?');
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  await dialog.screenshot({ path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'session-delete-dialog.png') });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(card(generalKey)).toHaveCount(0);
});
