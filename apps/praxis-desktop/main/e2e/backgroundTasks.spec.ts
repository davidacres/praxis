import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { openSession } from './sessionNavigation';

let app: TestApp;
let mock: MockGatewayServer | undefined;
test.afterEach(async () => { if (app) await closeTestApp(app); await mock?.close(); mock = undefined; });
const agent = path.join(__dirname, 'fixtures/backgroundAcpAgent.mjs');

async function start(goal: string) {
  app = await launchTestApp({ notifications: { completed: true, failed: true, needsAttention: true, suppressWhenViewing: false } }, undefined, { BACKGROUND_DELAY_MS: '6500' });
  await app.window.getByTestId('new-session-view').waitFor();
  await app.electronApp.evaluate(({ Notification }) => {
    (globalThis as any).backgroundNotices = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { (globalThis as any).backgroundNotices.push(this.title); };
  });
  await app.window.evaluate(cliPath => window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath } } } }), agent);
  return app.window.evaluate(goal => window.praxis.ai.delegate({ provider: 'claude-code-cli', goal, workingDirectory: undefined, toolMode: 'project-only', task: { goal, timeoutMs: 30000 } }), goal);
}
const record = (key: string) => app.window.evaluate(key => window.praxis.ai.getSession(key), key);

test('background completion arrives after the turn, updates the session, and notifies once', async () => {
  const session = await start('Run checks in the background');
  await expect.poll(async () => (await record(session.issueKey))?.state).toBe('completed');
  expect((await record(session.issueKey))?.backgroundTasks?.[0].state).toBe('running');
  await openSession(app.window, session.issueKey);
  await expect(app.window.getByTestId('session-state-badge')).toHaveText('Background running');
  const artifact = path.resolve('..', '.praxis/session-artifacts/background-tasks-session.png');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  await app.window.screenshot({ path: artifact, animations: 'disabled' });
  expect(await app.electronApp.evaluate(() => (globalThis as any).backgroundNotices)).toEqual([]);
  // A follow-up gets its own foreground runtime without shutting the observer down.
  await app.window.evaluate(key => window.praxis.ai.continueSession(key, 'FOLLOW_UP_ONLY'), session.issueKey);
  await expect.poll(async () => (await record(session.issueKey))?.backgroundTasks?.[0].state, { timeout: 15000 }).toBe('completed');
  await expect(app.window.getByTestId('session-state-badge')).toHaveText('Completed');
  expect(await app.electronApp.evaluate(() => (globalThis as any).backgroundNotices.filter((title: string) => title === 'Background task completed'))).toHaveLength(1);
  expect((await record(session.issueKey))?.backgroundTasks).toHaveLength(1);
  expect((await record(session.issueKey))?.backgroundTasks?.some(task => task.id.includes('historical'))).toBe(false);
  // Persisted terminal state survives reopening the renderer.
  await app.window.reload();
  await openSession(app.window, session.issueKey);
  expect((await record(session.issueKey))?.backgroundTasks?.[0].state).toBe('completed');
});

async function assertBackgroundOutcome(scenario: { goal: string; state: string; notice: string }) {
    const session = await start(scenario.goal);
    await expect.poll(async () => (await record(session.issueKey))?.state).toBe('completed');
    await openSession(app.window, session.issueKey);
    await expect.poll(async () => (await record(session.issueKey))?.backgroundTasks?.[0].state, { timeout: 15000 }).toBe(scenario.state);
    if (scenario.state === 'unknown') await expect(app.window.getByTestId('session-state-badge')).toHaveText('Background status unknown');
    if (scenario.state === 'failed') await expect(app.window.getByTestId('session-state-badge')).toHaveText('Background failed');
    if (scenario.goal === 'AIR_SUBAGENT') {
      expect((await record(session.issueKey))?.events.filter(event => event.type === 'message').map(event => event.detail).join(' ')).not.toContain('Child review complete');
    }
    expect(await app.electronApp.evaluate(() => (globalThis as any).backgroundNotices)).toEqual([scenario.notice]);
}

test('background failure is reported after the foreground reply', () => assertBackgroundOutcome({ goal: 'BACKGROUND_FAIL', state: 'failed', notice: 'Background task failed' }));

test('a lost background connection becomes unknown rather than completed', () => assertBackgroundOutcome({ goal: 'DROP_CONNECTION', state: 'unknown', notice: 'Background task status unknown' }));

test('native subagent completion is distinct from successful spawn', () => assertBackgroundOutcome({ goal: 'NATIVE_SUBAGENT', state: 'completed', notice: 'Background task completed' }));

test('AIR child completion and its result reach the owning session separately from the parent transcript', () => assertBackgroundOutcome({ goal: 'AIR_SUBAGENT', state: 'completed', notice: 'Background task completed' }));


test('a direct API agent shell process reports its exit after the AI reply without inventing success', async () => {
  test.skip(process.platform === 'win32', 'Process-group observation is supported on macOS and Linux.');
  mock = await startMockGatewayServer({ mode: 'complete', toolCall: { name: 'run_shell', arguments: { command: '(sleep 4; exit 7) &' } }, reply: 'The process is running in the background.' });
  app = await launchTestApp({ notifications: { completed: true, suppressWhenViewing: false } }, undefined, { AI_GATEWAY_API_KEY: 'background-test', AI_GATEWAY_URL: mock.baseUrl, VERCEL_OIDC_TOKEN: undefined });
  await app.window.getByTestId('new-session-view').waitFor();
  await app.electronApp.evaluate(({ Notification }) => {
    (globalThis as any).backgroundNotices = [];
    Notification.isSupported = () => true;
    Notification.prototype.show = function () { (globalThis as any).backgroundNotices.push(this.title); };
  });
  const session = await app.window.evaluate(cwd => window.praxis.ai.delegate({ provider: 'vercel-gateway', workingDirectory: cwd, toolMode: 'full', permissionMode: 'bypass', task: { goal: 'Launch a background process', maxSteps: 3 } }), app.userDataDir);
  await expect.poll(async () => (await record(session.issueKey))?.state, { timeout: 15000 }).toBe('completed');
  await openSession(app.window, session.issueKey);
  await expect.poll(async () => (await record(session.issueKey))?.backgroundTasks?.[0].state, { timeout: 15000 }).toBe('exited');
  const notices = await app.electronApp.evaluate(() => (globalThis as any).backgroundNotices as string[]);
  expect(notices.filter(title => title === 'Background process exited')).toHaveLength(1);
  expect(notices).not.toContain('Background task completed');
});
