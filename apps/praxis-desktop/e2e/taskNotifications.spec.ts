import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp;
test.afterEach(async () => { if (app) await closeTestApp(app); });

const SESSION = 'SESSION-abcdef';
/** The session manager's record after a state change; `applySession` publishes it as the manager does. */
const sessionIn = (state: string) => ({
  issueKey: SESSION, sessionId: 'notice-session', provider: 'openai', toolMode: 'read-only', mode: 'chat', state,
  title: 'Notification verification',
  taskDefinition: { goal: 'Notification verification', scope: 'Read only', definitionOfDone: 'Done' },
  events: [], eventsLoaded: true, eventCount: 0, stepCount: 0, startedAt: new Date().toISOString()
});
const shown = async () => (await app.notifications()).shown.map(({ title, silent }) => ({ title, silent }));

test('desktop notification preferences persist, live transitions deliver once, and clicks open the session', async () => {
  app = await launchTestApp({ notifications: { completed: true, failed: true, needsAttention: true, sound: false, suppressWhenViewing: true } }, undefined, { AI_GATEWAY_API_KEY: 'notification-test' });
  const win = app.window;
  await win.getByTestId('new-session-view').waitFor();
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-ai').click();
  await win.getByTestId('ai-tab-behaviour').click();
  const panel = win.getByRole('region', { name: 'Desktop notifications', exact: true });
  await expect(panel).toBeVisible();
  await panel.getByRole('switch', { name: 'Notification sound', exact: true }).click();
  await expect.poll(() => win.evaluate(async () => (await window.praxis.settings.get()).notifications.sound)).toBe(true);
  const artifact = path.resolve('..', '.praxis/session-artifacts/task-notification-settings.png');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  await panel.screenshot({ path: artifact, animations: 'disabled' });

  for (const state of ['not_started', 'executing', 'completed']) await app.applySession(sessionIn(state));
  // A rename publishes the record again with the same state: not a new transition.
  await app.applySession(sessionIn('completed'));
  await expect.poll(shown).toEqual([{ title: 'AI task completed', silent: false }]);
  await app.clickNotification(0);
  await expect(panel).not.toBeVisible();
  await expect(win.getByText('Notification verification', { exact: true }).first()).toBeVisible();
  await expect(win.getByTestId('session-follow-up-input')).toBeVisible();
  // The window now shows the session and counts as focused; let it report what it is showing.
  await app.setWindowFocused(true);
  await win.waitForTimeout(500);

  for (const state of ['executing', 'completed']) await app.applySession(sessionIn(state));
  // The relevant session is now visible in the focused window, so no second banner.
  expect(await shown()).toHaveLength(1);
  expect(JSON.parse(fs.readFileSync(app.settingsPath, 'utf8')).notifications.sound).toBe(true);
  await win.evaluate(() => window.praxis.settings.set({ notifications: { suppressWhenViewing: false, sound: false } }));
  for (const state of ['executing', 'awaiting_approval', 'executing', 'failed']) await app.applySession(sessionIn(state));
  expect((await shown()).slice(1)).toEqual([
    { title: 'AI task needs your attention', silent: true }, { title: 'AI task failed', silent: true }
  ]);
  // A notification for a popped-out chat should focus that chat window.
  const nextWindow = app.window.context().waitForEvent('page');
  await win.evaluate(key => window.praxis.detachedChat.open(key), SESSION);
  const detached = await nextWindow;
  await detached.getByTestId('session-follow-up-input').waitFor();
  await win.bringToFront();
  await app.clickNotification(2);
  await expect.poll(async () => (await app.notifications()).opened.at(-1)?.window).toBe(`detached:${SESSION}`);
});

test('workflow transitions notify once and clicking opens the run in its project', async () => {
  app = await launchTestApp({ notifications: { completed: true, needsAttention: true } }, undefined, { AI_GATEWAY_API_KEY: 'notification-test' });
  const win = app.window;
  await win.getByTestId('new-session-view').waitFor();
  const projectId = await win.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    return (await window.praxis.projects.create({ name: 'Notification project', key: 'NOTICE', type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage', workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [{ summary: 'Verify notifications', description: '', issueType: 'Task', status: 'Todo' }], defaultAiToolMode: 'read-only' }, workspace.id)).id;
  });
  // A real run: it stops at the approval node (needs attention), then approving completes it.
  const runId = await win.evaluate(async projectId => {
    const now = new Date().toISOString();
    await window.praxis.workflows.save(projectId, { schemaVersion: 1, id: 'notice-workflow', name: 'Notification workflow', version: 1, scope: 'project', projectId, createdAt: now, updatedAt: now, entryNodeId: 'approve', nodes: [{ type: 'approval', id: 'approve', name: 'Approve', x: 0, y: 0, inputs: [], prompt: 'Continue?', requiredGates: [], allowBypass: false }], edges: [] } as never);
    const run = await window.praxis.workflows.startRun(projectId, 'notice-workflow', 'Notification verification');
    // A run that reaches an approval node with nothing before it is not saved again; the next save announces it.
    await window.praxis.workflows.renameRun(run.runId, 'Notification run');
    return run.runId;
  }, projectId);
  await expect.poll(async () => (await shown()).map(notice => notice.title)).toEqual(['Workflow needs your attention']);
  await win.evaluate(id => window.praxis.workflows.approveRun(id, 'tester', undefined, 'approve'), runId);
  await expect.poll(async () => (await shown()).map(notice => notice.title)).toEqual(['Workflow needs your attention', 'Workflow completed']);
  await app.clickNotification(1);
  await expect.poll(() => win.evaluate(id => Object.keys(localStorage).filter(key => key.startsWith('praxis-last-workspace-route:')).map(key => JSON.parse(localStorage.getItem(key) || '{}')).find(route => route.workflowRunId === id)?.projectId, runId)).toBe(projectId);
});
