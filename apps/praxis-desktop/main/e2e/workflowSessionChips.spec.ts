import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
});

async function seedProjectSession(page: Page): Promise<string> {
  return page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Workflow chat project',
      key: 'WFCHAT',
      type: 'product',
      purpose: '',
      brief: {},
      startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
      starterTickets: [{ summary: 'Workflow chat ticket', description: '', issueType: 'Task', status: 'To do' }],
      defaultAiToolMode: 'read-only'
    }, workspace.id);
    await window.praxis.workflows.instantiate(project.id, 'quick-change');
    const session = await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      projectId: project.id,
      toolMode: 'read-only',
      task: { goal: 'Keep this project conversation available.' }
    });
    return session.issueKey;
  });
}

test('an existing project session selects and starts governed workflows from one chat chip', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'workflow-chip-e2e-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const page = app.window;
  const sessionKey = await seedProjectSession(page);
  const artifacts = path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });

  // Reload so the shell refreshes project workflow readiness, then open the
  // existing session rather than starting through New Session.
  await page.reload();
  await page.getByTestId('nav-sessions').click();
  await page.getByTestId('session-list-row').filter({ hasText: 'Keep this project conversation available.' }).click();

  // Before a workflow owns the session, the ordinary session runtime controls
  // remain available for changing provider/model.
  await expect(page.getByTestId('session-provider')).toBeEnabled();
  await expect(page.getByTestId('session-model')).toBeEnabled();

  const add = page.getByTestId('session-workflow-add');
  await expect(add).toBeEnabled();
  await add.click();
  await expect(page.getByTestId('session-workflow-menu')).toBeVisible();
  const startOptions = page.getByTestId('session-workflow-menu').locator('[aria-label="Start workflow"]');
  await expect(startOptions.getByRole('button', { name: /Quick change/ })).toHaveCount(1);
  await startOptions.getByRole('button', { name: /Quick change/ }).click();

  await expect.poll(async () => page.evaluate(async key => {
    const session = (await window.praxis.ai.listSessions()).find(candidate => candidate.issueKey === key);
    return session?.workflowRunIds?.length ?? 0;
  }, sessionKey)).toBe(1);
  await expect(page.getByTestId('session-workflow-add')).toContainText('Quick change');
  await expect(page.getByTestId('session-workflow-runtime')).toContainText('Workflow managed');
  await expect(page.getByTestId('session-provider')).toBeVisible();
  await expect(page.getByTestId('session-model')).toBeVisible();
  await expect.poll(async () => page.getByTestId('session-provider').evaluate(element => element.tagName)).toBe('SPAN');
  await expect.poll(async () => page.getByTestId('session-model').evaluate(element => element.tagName)).toBe('SPAN');
  await page.getByTestId('session-workflow-runtime').click();
  const runtime = page.getByTestId('session-workflow-runtime-popover');
  await expect(runtime).toBeVisible();
  await expect(runtime).toContainText('Quick change');
  await expect(runtime).toContainText('Active stage');
  await page.screenshot({ path: path.join(artifacts, 'session-workflow-runtime.png'), fullPage: true });
  await page.keyboard.press('Escape');
  await expect(runtime).toBeHidden();

  // Adding again preserves the first durable run; selecting its chip changes
  // only the active context, not either run's immutable history.
  await add.click();
  await page.getByTestId('session-workflow-menu').locator('[aria-label="Start workflow"]').getByRole('button', { name: /Quick change/ }).click();
  await expect.poll(async () => page.evaluate(async key => {
    const session = (await window.praxis.ai.listSessions()).find(candidate => candidate.issueKey === key);
    return session?.workflowRunIds ?? [];
  }, sessionKey)).toHaveLength(2);
  const ids = await page.evaluate(async key => {
    const session = (await window.praxis.ai.listSessions()).find(candidate => candidate.issueKey === key);
    return session?.workflowRunIds ?? [];
  }, sessionKey);
  await add.click();
  await page.screenshot({ path: path.join(artifacts, 'session-workflow-selector.png'), fullPage: true });
  await page.getByTestId(`session-workflow-chip-${ids[0]}`).click();
  await expect.poll(async () => page.evaluate(async key => {
    const session = (await window.praxis.ai.listSessions()).find(candidate => candidate.issueKey === key);
    return session?.workflowRunId;
  }, sessionKey)).toBe(ids[0]);

  await page.screenshot({ path: path.join(artifacts, 'session-workflow-chips.png'), fullPage: true });

  // Removing the inactive run detaches it without disturbing the active one.
  await add.click();
  await expect(page.getByTestId('session-workflow-menu')).toBeVisible();
  await page.getByTestId(`session-workflow-remove-${ids[1]}`).click();
  await expect.poll(async () => page.evaluate(async key => {
    const session = (await window.praxis.ai.listSessions()).find(candidate => candidate.issueKey === key);
    return session?.workflowRunIds ?? [];
  }, sessionKey)).toEqual([ids[0]]);
  await expect.poll(async () => page.evaluate(async key => {
    const session = (await window.praxis.ai.listSessions()).find(candidate => candidate.issueKey === key);
    return session?.workflowRunId;
  }, sessionKey)).toBe(ids[0]);

  // Removing the last remaining run clears the session's workflow context
  // entirely, and the composer chip falls back to its unselected label.
  await page.getByTestId(`session-workflow-remove-${ids[0]}`).click();
  await expect.poll(async () => page.evaluate(async key => {
    const session = (await window.praxis.ai.listSessions()).find(candidate => candidate.issueKey === key);
    return session?.workflowRunIds ?? [];
  }, sessionKey)).toEqual([]);
  await expect.poll(async () => page.evaluate(async key => {
    const session = (await window.praxis.ai.listSessions()).find(candidate => candidate.issueKey === key);
    return session?.workflowRunId;
  }, sessionKey)).toBeUndefined();
  await expect(page.getByTestId('session-workflow-add')).toContainText('Workflow');
  await expect(page.getByTestId('session-workflow-runtime')).toHaveCount(0);
  await expect(page.getByTestId('session-provider')).toBeVisible();
  await expect(page.getByTestId('session-model')).toBeVisible();
  await expect(page.getByTestId('session-provider')).toBeEnabled();
  await expect(page.getByTestId('session-model')).toBeEnabled();
});
