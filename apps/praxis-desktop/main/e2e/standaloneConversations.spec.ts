import * as fs from 'node:fs';
import { openFromPalette } from './navigation';
import { openSession } from './sessionNavigation';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;
test.afterEach(async () => { if (app) await closeTestApp(app); app = undefined; });

test('detached-chat IPC refuses a window outside the trusted renderer', async () => {
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const untrustedPromise = app.electronApp.waitForEvent('window');
  await app.electronApp.evaluate(async ({ BrowserWindow }, preload) => {
    const untrusted = new BrowserWindow({ show: false, webPreferences: { preload, contextIsolation: true, nodeIntegration: false } });
    await untrusted.loadURL('data:text/html,<html><body>Untrusted IPC probe</body></html>');
  }, path.resolve(__dirname, '../out/preload/index.js'));
  const untrusted = await untrustedPromise;
  for (const url of [untrusted.url(), app.window.url()]) {
    await untrusted.goto(url);
    for (const operation of ['list', 'open', 'close'] as const) {
      await expect(untrusted.evaluate(async operation => {
        if (operation === 'list') return window.praxis.detachedChat.list();
        return window.praxis.detachedChat[operation]('SESSION-untrusted');
      }, operation)).rejects.toThrow('IPC sender is not a trusted application renderer.');
    }
  }
  expect(await app.window.evaluate(() => window.praxis.detachedChat.list())).toEqual([]);
});

test('standalone conversation persists and resumes across floating-window pop-in, close and app restart', async () => {
  test.setTimeout(60000);
  const fixture = path.resolve(__dirname, 'fixtures/fakeAcpAgent.mjs');
  app = await launchTestApp({ ai: { activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath: fixture } } } },
    undefined, undefined, { openNewSession: false });
  let win = app.window;
  await openFromPalette(win, 'New conversation');
  await expect(win.getByTestId('new-conversation-heading')).toHaveText('New conversation');
  await expect(win.getByTestId('new-session-board-select')).toHaveCount(0);
  await expect(win.getByTestId('new-session-ticket-select')).toHaveCount(0);
  await win.getByPlaceholder('Ask anything, brainstorm, or get something done…').fill('Standalone lifecycle proof');
  await win.getByTestId('new-session-submit').click();
  await expect.poll(() => win.evaluate(async () => (await window.praxis.ai.listSessions())[0]?.state)).toBe('completed');
  const record = await win.evaluate(async () => (await window.praxis.ai.listSessions())[0]);
  expect(record.projectId).toBeUndefined();
  expect(record.linkedIssueKey).toBeUndefined();
  expect(record.toolMode).toBe('project-only');
  const key = record.issueKey;
  await expect(win.getByTestId('session-chat-thread')).toContainText('Hello from the fake ACP agent');

  const floatingPromise = app.electronApp.waitForEvent('window');
  await win.getByTestId('session-pop-out').click();
  const floating = await floatingPromise;
  await expect(floating.getByTestId('session-chat-thread')).toContainText('Standalone lifecycle proof');
  await expect(win.getByTestId('conversation-detached-placeholder')).toBeVisible();
  await win.evaluate(key => window.praxis.detachedChat.open(key), key);
  expect(app.electronApp.windows()).toHaveLength(2);
  const security = await app.electronApp.evaluate(({ BrowserWindow }) => {
    const detached = BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('detachedSession='))!;
    const preferences = detached.webContents.getLastWebPreferences();
    return { alwaysOnTop: detached.isAlwaysOnTop(), contextIsolation: preferences.contextIsolation, nodeIntegration: preferences.nodeIntegration, sandbox: preferences.sandbox };
  });
  expect(security).toEqual({ alwaysOnTop: true, contextIsolation: true, nodeIntegration: false, sandbox: true });
  expect(await floating.evaluate(() => window.open('data:text/html,<h1>Unexpected window</h1>'))).toBeNull();
  expect(app.electronApp.windows()).toHaveLength(2);
  // A long-running follow-up retains its turn clock even as newer tool events arrive.
  await app.electronApp.evaluate(({ BrowserWindow }, record) => {
    const now = new Date().toISOString();
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('ai:sessionChanged', {
      ...record, state: 'executing', reasoningText: 'Checking the next step',
      events: [...record.events, { type: 'user_input_completed', timestamp: new Date(Date.now() - 65000).toISOString(), summary: 'Follow-up' },
        { type: 'tool_start', timestamp: now, summary: 'Running tool: inspect', data: { toolName: 'inspect' } }]
    });
  }, record);
  const composerClock = floating.getByTestId('session-composer-activity-timer');
  await expect(composerClock).toHaveText(/1m \d+s/);
  await expect(floating.getByTestId('session-activity-status')).toHaveCount(0);
  await expect(floating.getByTestId('session-thought-markdown')).toContainText('Checking the next step');
  await floating.locator('.session-follow-up-composer').screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/detached-composer-thinking.png') });
  await app.electronApp.evaluate(({ BrowserWindow }, record) => {
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('ai:sessionChanged', record);
  }, record);
  await floating.getByTestId('session-follow-up-input').fill('Continue in floating chat');
  await floating.getByTestId('session-follow-up-send').click();
  await expect.poll(() => win.evaluate(async key => {
    const session = await window.praxis.ai.getSession(key);
    return session?.state === 'completed' && session.events.filter(event => event.type === 'message').length >= 2;
  }, key)).toBe(true);
  const capture = path.resolve(__dirname, '../../../../.praxis/session-artifacts/standalone-floating-chat.png');
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  await floating.screenshot({ path: capture });
  await floating.getByTestId('session-pop-in').click();
  await expect.poll(() => floating.isClosed()).toBe(true);
  await expect(win.getByTestId('session-chat-thread')).toContainText('Continue in floating chat');

  const closePromise = app.electronApp.waitForEvent('window');
  await win.getByTestId('session-pop-out').click();
  const toClose = await closePromise;
  await app.electronApp.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows().find(window => window.webContents.getURL().includes('detachedSession='))!.close();
  });
  await expect.poll(() => toClose.isClosed()).toBe(true);
  await expect(win.getByTestId('conversation-detached-placeholder')).toHaveCount(0);

  const restartPromise = app.electronApp.waitForEvent('window');
  await win.getByTestId('session-pop-out').click();
  await restartPromise;
  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  app = await launchTestApp(undefined, profile, undefined, { openNewSession: false });
  win = app.window;
  expect(await win.evaluate(() => window.praxis.detachedChat.list())).toEqual([]);
  await openSession(win, key);
  await expect(win.getByTestId('session-chat-thread')).toContainText('Continue in floating chat');
  expect((await win.evaluate(key => window.praxis.ai.getSession(key), key))?.toolMode).toBe('project-only');
});
