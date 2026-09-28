import * as path from 'node:path';
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
    return project.id;
  });

  await expect.poll(() => page.evaluate(async id => {
    const sessions = await window.praxis.ai.listSessions();
    return sessions.filter(session => session.projectId === id).length;
  }, projectId), { timeout: 30000 }).toBe(2);
  await page.reload();
  await expect(page.getByTestId('project-nav-item')).toContainText('Session actions project');

  const general = page.getByTestId('project-session-nav-item').filter({ hasText: 'General sidebar action session' });
  const ticket = page.getByTestId('project-session-nav-item').filter({ hasText: 'Ticket sidebar action session' });
  for (const row of [general, ticket]) {
    await expect(row).toBeVisible();
    await expect(row.locator('.tree-icon')).toHaveAttribute('title', /session/);
    await expect(row.getByTestId('project-session-agent-summary')).toBeVisible();
    await expect(row.locator('.session-nav-actions')).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(row.locator('.session-nav-actions')).toHaveCSS('opacity', '1');
    await expect(row.getByTestId('session-rename-btn')).toBeVisible();
    await expect(row.getByTestId('session-archive-btn')).toBeVisible();
    await expect(row.getByTestId('session-delete-btn')).toBeVisible();
  }

  await page.mouse.move(900, 120);
  await page.waitForTimeout(180);
  await page.locator('nav.sidebar').screenshot({
    path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'project-session-actions.png'),
  });
  await general.screenshot({
    path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'project-session-action-row.png')
  });

  await general.hover();
  await general.getByTestId('session-rename-btn').click();
  const titleInput = page.getByTestId('session-title-input');
  await titleInput.fill('Renamed general session');
  await titleInput.press('Enter');
  await expect(page.getByTestId('project-session-nav-item').filter({ hasText: 'Renamed general session' })).toBeVisible();

  await ticket.hover();
  await ticket.getByTestId('session-archive-btn').click();
  await expect(ticket).toHaveCount(0);

  const renamedGeneral = page.getByTestId('project-session-nav-item').filter({ hasText: 'Renamed general session' });
  await renamedGeneral.hover();
  await renamedGeneral.getByTestId('session-delete-btn').click();
  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText('Delete this session?');
  await dialog.getByRole('button', { name: 'Delete session' }).click();
  await expect(page.getByTestId('project-session-nav-item')).toHaveCount(0);
});
