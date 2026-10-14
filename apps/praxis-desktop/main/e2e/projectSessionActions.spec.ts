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
  await expect(page.getByTestId('project-nav-item')).toContainText('Session actions project');

  const general = page.getByTestId('project-session-nav-item').filter({ hasText: 'General sidebar action session' });
  const ticket = page.getByTestId('project-session-nav-item').filter({ hasText: 'Ticket sidebar action session' });
  await expect(ticket.locator('.session-nav-card-meta')).toContainText('APP-101');
  for (const row of [general, ticket]) {
    await expect(row).toBeVisible();
    await expect(row.locator('.tree-icon')).toHaveAttribute('title', /session/);
    await expect(row.locator('.session-nav-card-title-row')).toBeVisible();
    await expect(row.locator('.session-nav-card-status')).toBeVisible();
    await expect(row.getByTestId('project-session-agent-summary')).toBeVisible();
    await expect(row.locator('.session-nav-card-meta')).not.toBeEmpty();
    // A two-line ledger row (title + meta), not a single-line tree row.
    expect(await row.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(40);
    await expect(row.locator('.session-nav-actions')).toHaveCSS('opacity', '0');
    await row.hover();
    await expect(row.locator('.session-nav-actions')).toHaveCSS('opacity', '1');
    await expect(row.getByTestId('session-rename-btn')).toBeVisible();
    await expect(row.getByTestId('session-archive-btn')).toBeVisible();
    await expect(row.getByTestId('session-delete-btn')).toBeVisible();
  }

  // E6 ledger geometry: a session row's icon and title sit on the same two columns as the project's
  // other ledger rows (here its Workflows › Policies row) — not one tree level deeper. Selected, it is
  // marked by one straight accent line on a square left edge, not a bar bent round a rounded corner.
  const projectTree = page.getByTestId('project-tree').filter({ hasText: 'Session actions project' });
  const columns = (row: typeof general, icon: string, label: string) => row.evaluate((el, [i, l]) => ({
    icon: Math.round((el.querySelector(i) as HTMLElement).getBoundingClientRect().left),
    label: Math.round((el.querySelector(l) as HTMLElement).getBoundingClientRect().left)
  }), [icon, label] as const);
  const policiesColumns = await columns(projectTree.locator('.project-workflow-child').first(), '.tree-icon', '.tree-label');
  expect(await columns(general, '.tree-icon', '.tree-label'), 'session row shares the ledger columns').toEqual(policiesColumns);
  await general.click();
  await expect(general).toHaveClass(/is-selected/);
  const edge = await general.evaluate(el => {
    const style = getComputedStyle(el);
    return { topLeft: style.borderTopLeftRadius, bottomLeft: style.borderBottomLeftRadius, shadow: style.boxShadow };
  });
  expect(edge.topLeft, 'selected row has a square left edge').toBe('0px');
  expect(edge.bottomLeft, 'selected row has a square left edge').toBe('0px');
  expect(edge.shadow, 'selected row carries a straight 2px accent line on its left edge').toMatch(/2px 0px 0px 0px inset/);

  const standalone = page.getByTestId('session-list-row').filter({ hasText: 'Standalone sidebar action session' });
  await expect(standalone).toBeVisible();
  await expect(standalone.locator('.session-nav-card-title-row')).toBeVisible();
  await expect(standalone.locator('.session-nav-card-status')).toBeVisible();
  await expect(standalone.locator('.session-nav-card-meta')).toContainText(/Vercel|Model not reported/);
  expect(await standalone.evaluate(element => element.getBoundingClientRect().height)).toBeGreaterThanOrEqual(40);

  await page.mouse.move(900, 120);
  await page.waitForTimeout(180);
  await page.locator('nav.sidebar').screenshot({
    path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'project-session-actions.png'),
  });
  await general.screenshot({
    path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'project-session-action-row.png')
  });

  await standalone.hover();
  await page.waitForTimeout(180);
  await standalone.screenshot({
    path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'real-classic-standalone-row-hover.png')
  });
  await general.hover();
  await page.waitForTimeout(180);
  await page.locator('nav.sidebar').screenshot({
    path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'real-classic-session-hover.png'),
  });
  await general.screenshot({
    path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'real-classic-session-row-hover.png')
  });
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
  await expect(dialog.getByRole('button', { name: 'Close' })).toBeVisible();
  await expect(dialog.locator('.modal-footer')).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Cancel', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Archive', exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Delete', exact: true })).toBeVisible();
  await dialog.screenshot({ path: path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'session-delete-dialog.png') });
  await dialog.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(page.getByTestId('project-session-nav-item')).toHaveCount(0);
});
