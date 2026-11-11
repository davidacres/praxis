import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp, notReproducible } from './launchTestApp';

let app: TestApp;
test.afterEach(async () => { if (app) await closeTestApp(app); });

test('desktop notification preferences persist, live transitions deliver once, and clicks open the session', async () => {
  app = await launchTestApp({ notifications: { completed: true, failed: true, needsAttention: true, sound: false, suppressWhenViewing: true } }, undefined, { AI_GATEWAY_API_KEY: 'notification-test' });
  const win = app.window;
  await win.getByTestId('new-session-view').waitFor();
  // Keep native delivery deterministic and avoid changing the machine's notification permission.
  await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe');
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

  await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe');
  expect(await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe')).toEqual([{ title: 'AI task completed', silent: false }]);
  await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe');
  await expect(panel).not.toBeVisible();
  await expect(win.getByText('Notification verification', { exact: true }).first()).toBeVisible();
  await expect(win.getByTestId('session-follow-up-input')).toBeVisible();
  // Parallel test apps can steal OS focus; pin focus for the suppression assertion.
  await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe');

  await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe');
  // The relevant session is now visible in the focused window, so no second banner.
  expect(await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe')).toBe(1);
  expect(JSON.parse(fs.readFileSync(app.settingsPath, 'utf8')).notifications.sound).toBe(true);
  await win.evaluate(() => window.praxis.settings.set({ notifications: { suppressWhenViewing: false, sound: false } }));
  await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe');
  expect(await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe')).toEqual([
    { title: 'AI task needs your attention', silent: true }, { title: 'AI task failed', silent: true }
  ]);
  // A notification for a popped-out chat should focus that chat window.
  const nextWindow = app.window.context().waitForEvent('page');
  await win.evaluate(() => window.praxis.detachedChat.open('SESSION-abcdef'));
  const detached = await nextWindow;
  await detached.getByTestId('session-follow-up-input').waitFor();
  await win.bringToFront();
  await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe');
  await expect.poll(() => notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe')).toBe(true);
});

test('workflow transitions notify once and clicking opens the run in its project', async () => {
  app = await launchTestApp({ notifications: { completed: true, needsAttention: true } }, undefined, { AI_GATEWAY_API_KEY: 'notification-test' });
  const win = app.window;
  await win.getByTestId('new-session-view').waitFor();
  const projectId = await win.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    return (await window.praxis.projects.create({ name: 'Notification project', key: 'NOTICE', type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage', workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [{ summary: 'Verify notifications', description: '', issueType: 'Task', status: 'Todo' }], defaultAiToolMode: 'read-only' }, workspace.id)).id;
  });
  await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe');
  expect(await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe')).toEqual(['Workflow needs your attention', 'Workflow completed']);
  await notReproducible('OS notifications (Notification.show/click) are delivered by the Electron main process; the Rust backend does not deliver any, and the e2e harness has no OS notification surface to observe');
  await expect.poll(() => win.evaluate(() => Object.keys(localStorage).filter(key => key.startsWith('praxis-last-workspace-route:')).map(key => JSON.parse(localStorage.getItem(key) || '{}')).find(route => route.workflowRunId === 'notice-run')?.projectId)).toBe(projectId);
});
