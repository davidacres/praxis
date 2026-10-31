import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
let repo: string | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
  if (repo) {
    fs.rmSync(repo, { recursive: true, force: true });
    repo = undefined;
  }
});

test('reviewing changes lives beside the diff and the composer has no mode tabs', async () => {
  repo = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-session-mode-'));
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl,
    VERCEL_OIDC_TOKEN: undefined
  });
  const win = app.window;

  const session = await win.evaluate(
    async ({ cwd }) => window.praxis.ai.delegate({
      goal: 'Draft the release notes.',
      workingDirectory: cwd,
      toolMode: 'read-only',
      task: { goal: 'Draft the release notes.', maxSteps: 2, timeoutMs: 30000 }
    }),
    { cwd: repo }
  );
  await expect
    .poll(() => win.evaluate(
      k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), session.issueKey
    ), { timeout: 20000 })
    .toBe('completed');

  await win.keyboard.press('ControlOrMeta+k');
  const palette = win.getByRole('dialog', { name: 'Go to' });
  await palette.getByRole('textbox').fill(session.issueKey);
  await palette.getByRole('option').filter({ hasText: 'Draft the release notes.' }).click();
  const composer = win.locator('.session-follow-up-composer');
  await expect(composer.getByRole('group', { name: 'Switch session mode' })).toHaveCount(0);
  await expect(composer.locator('[data-testid^="session-switch-mode-"]')).toHaveCount(0);
  const footer = win.locator('.session-composer-footer');
  const tools = footer.getByTestId('session-tool-mode');
  await expect(tools).toBeVisible();
  await expect(composer.getByTestId('session-tool-mode')).toHaveCount(0);
  expect(await tools.evaluate(element => element.previousElementSibling?.getAttribute('data-testid'))).toBe('session-permission-chip');
  await tools.click();
  await expect(tools).toHaveAttribute('aria-expanded', 'true');
  await tools.click();
  await footer.getByTestId('session-permission-chip').click();
  await expect(win.getByRole('listbox', { name: 'Permission mode' })).toBeVisible();
  await win.getByTestId('session-permission-option-manual').click();
  const review = win.getByTestId('session-review-changes');
  await expect(win.getByTestId('session-panel-changes').getByTestId('session-review-changes')).toBeVisible();
  await expect(review).toBeEnabled();
  const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await win.locator('.agent-details-composer-dock').screenshot({ path: path.join(artifacts, 'session-tools-next-to-permissions.png') });
  await win.locator('.session-review-action').screenshot({ path: path.join(artifacts, 'session-review-changes-action.png') });
  await review.click();
  await expect.poll(() => win.evaluate(k => window.praxis.ai.getSession(k).then(record => record?.mode), session.issueKey)).toBe('review');
  await expect.poll(() => win.evaluate(
    k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), session.issueKey
  ), { timeout: 20000 }).toBe('completed');

  // Polled: the switch issues the follow-up asynchronously, so the mock may not
  // hold the resumed turn yet at this point.
  await expect.poll(() => {
    const last = mock.requests.at(-1);
    if (!last) return false;
    const body = JSON.parse(last.body) as { messages: Array<{ role: string; content: string }> };
    const lastUserMessage = [...body.messages].reverse().find(message => message.role === 'user');
    return lastUserMessage?.content.includes('Review the current changes');
  }, { timeout: 20000 }).toBe(true);

  await win.screenshot({ path: 'output/playwright/session-mode-chip.png', fullPage: true });
});

test('ticket analysis remains an explicit action when the analysis gate is off', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp({ ai: { analysisPrompt: 'Assess this ticket read-only.', analysisGateEnabled: false } }, undefined,
    { AI_GATEWAY_API_KEY: 'e2e-gateway-key', AI_GATEWAY_URL: mock.baseUrl }, { openNewSession: false });
  const page = app.window;
  const project = await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    return window.praxis.projects.create({ name: 'Contextual analysis', key: 'CONTEXT', type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage',
      starterTickets: [{ summary: 'Clarify recovery behaviour', description: '', issueType: 'Task', status: 'Todo' }],
      workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], defaultAiToolMode: 'read-only' }, workspace.id);
  });
  await page.reload();
  await page.keyboard.press('ControlOrMeta+k');
  const palette = page.getByRole('dialog', { name: 'Go to' });
  await palette.getByRole('textbox').fill(project.name);
  await palette.getByRole('option').filter({ hasText: project.name }).filter({ hasText: 'Board' }).click();
  await page.getByTestId('issue-card').filter({ hasText: 'Clarify recovery behaviour' }).click();
  await expect(page.getByTestId('issue-analyze-ticket')).toBeVisible();
  await page.getByTestId('issue-analyze-ticket').click();
  await expect.poll(() => page.evaluate(async id => (await window.praxis.ai.listSessions()).find(session => session.projectId === id)?.taskDefinition.kind, project.id)).toBe('analysis');
});
