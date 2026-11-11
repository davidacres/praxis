import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp;
test.afterEach(async () => { if (app) await closeTestApp(app); });

test('desktop notification preferences persist, live transitions deliver once, and clicks open the session', async () => {
  app = await launchTestApp({ notifications: { completed: true, failed: true, needsAttention: true, sound: false, suppressWhenViewing: true } }, undefined, { AI_GATEWAY_API_KEY: 'notification-test' });
  const win = app.window;
  await win.getByTestId('new-session-view').waitFor();
  // Keep native delivery deterministic and avoid changing the machine's notification permission.
  await app.electronApp.evaluate(({ Notification }) => {
    (globalThis as any).taskNotices = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { (globalThis as any).taskNotices.push(this); };
  });
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

  await app.electronApp.evaluate(({ app }) => {
    const modulePath = app.getAppPath() + '/out/main/aiInstance.js';
    const require = process.getBuiltinModule('module')!.createRequire(modulePath);
    const { getAiSessionManager } = require(modulePath);
    const manager = getAiSessionManager();
    manager.createAgentSession('SESSION-abcdef', 'notice-session', { goal: 'Notification verification', scope: 'Read only', definitionOfDone: 'Done' }, 'openai');
    manager.updateAgentState('SESSION-abcdef', 'executing');
    manager.updateAgentState('SESSION-abcdef', 'completed');
    manager.renameAgentSession('SESSION-abcdef', 'Notification verification');
  });
  expect(await app.electronApp.evaluate(() => (globalThis as any).taskNotices.map((n: any) => ({ title: n.title, silent: n.silent })))).toEqual([{ title: 'AI task completed', silent: false }]);
  await app.electronApp.evaluate(() => (globalThis as any).taskNotices[0].emit('click', {}));
  await expect(panel).not.toBeVisible();
  await expect(win.getByText('Notification verification', { exact: true }).first()).toBeVisible();
  await expect(win.getByTestId('session-follow-up-input')).toBeVisible();
  // Parallel test apps can steal OS focus; pin focus for the suppression assertion.
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    for (const win of BrowserWindow.getAllWindows()) win.isFocused = () => true;
  });

  await app.electronApp.evaluate(({ app }) => {
    const modulePath = app.getAppPath() + '/out/main/aiInstance.js';
    const require = process.getBuiltinModule('module')!.createRequire(modulePath);
    const { getAiSessionManager } = require(modulePath);
    const manager = getAiSessionManager();
    manager.updateAgentState('SESSION-abcdef', 'executing');
    manager.updateAgentState('SESSION-abcdef', 'completed');
  });
  // The relevant session is now visible in the focused window, so no second banner.
  expect(await app.electronApp.evaluate(() => (globalThis as any).taskNotices.length)).toBe(1);
  expect(JSON.parse(fs.readFileSync(app.settingsPath, 'utf8')).notifications.sound).toBe(true);
  await win.evaluate(() => window.praxis.settings.set({ notifications: { suppressWhenViewing: false, sound: false } }));
  await app.electronApp.evaluate(({ app }) => {
    const modulePath = app.getAppPath() + '/out/main/aiInstance.js';
    const require = process.getBuiltinModule('module')!.createRequire(modulePath);
    const manager = require(modulePath).getAiSessionManager();
    manager.updateAgentState('SESSION-abcdef', 'executing');
    manager.updateAgentState('SESSION-abcdef', 'awaiting_approval');
    manager.updateAgentState('SESSION-abcdef', 'executing');
    manager.updateAgentState('SESSION-abcdef', 'failed');
  });
  expect(await app.electronApp.evaluate(() => (globalThis as any).taskNotices.slice(1).map((n: any) => ({ title: n.title, silent: n.silent })))).toEqual([
    { title: 'AI task needs your attention', silent: true }, { title: 'AI task failed', silent: true }
  ]);
  // A notification for a popped-out chat should focus that chat window.
  const nextWindow = app.electronApp.waitForEvent('window');
  await win.evaluate(() => window.praxis.detachedChat.open('SESSION-abcdef'));
  const detached = await nextWindow;
  await detached.getByTestId('session-follow-up-input').waitFor();
  await win.bringToFront();
  await app.electronApp.evaluate(() => (globalThis as any).taskNotices.at(-1).emit('click', {}));
  await expect.poll(() => app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getFocusedWindow()?.webContents.getURL().includes('detachedSession=SESSION-abcdef'))).toBe(true);
});

test('workflow transitions notify once and clicking opens the run in its project', async () => {
  app = await launchTestApp({ notifications: { completed: true, needsAttention: true } }, undefined, { AI_GATEWAY_API_KEY: 'notification-test' });
  const win = app.window;
  await win.getByTestId('new-session-view').waitFor();
  const projectId = await win.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    return (await window.praxis.projects.create({ name: 'Notification project', key: 'NOTICE', type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage', workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [{ summary: 'Verify notifications', description: '', issueType: 'Task', status: 'Todo' }], defaultAiToolMode: 'read-only' }, workspace.id)).id;
  });
  await app.electronApp.evaluate(async ({ app, Notification }, projectId) => {
    const modulePath = app.getAppPath() + '/out/main/index.js';
    const require = process.getBuiltinModule('module')!.createRequire(modulePath);
    const { createWorkflowRun, WorkflowRunStore } = require('@praxis/core');
    const { getWorkflowBackingStore } = require('./workflowStoreInstance.js');
    const { getWorkflowOrchestrator } = require('./workflowOrchestratorInstance.js');
    const orchestrator = getWorkflowOrchestrator();
    (globalThis as any).taskNotices = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { (globalThis as any).taskNotices.push(this); };
    const now = new Date().toISOString();
    const definition = { schemaVersion: 1, id: 'notice-workflow', name: 'Notification workflow', version: 1, scope: 'project', projectId, createdAt: now, updatedAt: now, entryNodeId: 'approve', nodes: [{ type: 'approval', id: 'approve', name: 'Approve', x: 0, y: 0, inputs: [], prompt: 'Continue?', requiredGates: [], allowBypass: false }], edges: [] };
    const run = createWorkflowRun({ runId: 'notice-run', projectId, definition, at: now });
    await new WorkflowRunStore(getWorkflowBackingStore()).save(run);
    await orchestrator.updateRun(run.runId, (current: any) => current);
    await orchestrator.updateRun(run.runId, (current: any) => ({ ...current, status: 'awaiting-approval' }));
    await orchestrator.updateRun(run.runId, (current: any) => ({ ...current, status: 'succeeded', endedAt: now, nodes: { ...current.nodes, approve: { ...current.nodes.approve, outcome: 'succeeded' } } }));
    await orchestrator.updateRun(run.runId, (current: any) => current);
  }, projectId);
  expect(await app.electronApp.evaluate(() => (globalThis as any).taskNotices.map((n: any) => n.title))).toEqual(['Workflow needs your attention', 'Workflow completed']);
  await app.electronApp.evaluate(() => (globalThis as any).taskNotices[1].emit('click', {}));
  await expect.poll(() => win.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('praxis-last-workspace-route:')).map(key => JSON.parse(localStorage.getItem(key) || '{}')).find(route => route.workflowRunId === 'notice-run')?.projectId)).toBe(projectId);
});
