import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;
test.afterEach(async () => { if (app) await closeTestApp(app); app = undefined; if (mock) await mock.close(); mock = undefined; });

async function seedInterrupted(keyAvailable = true, provider = 'vercel-gateway', goalPrefix = '') {
  mock = await startMockGatewayServer({ mode: 'complete' });
  const env = { AI_GATEWAY_API_KEY: keyAvailable ? 'recovery-test-key' : undefined, AI_GATEWAY_URL: mock.baseUrl,
    VERCEL_OIDC_TOKEN: undefined, FROSTY_VERCEL_API_KEY: undefined };
  const settings = provider === 'claude-code-cli' ? { ai: { activeProvider: provider, providers: { [provider]: { cliPath: path.join(__dirname, 'fixtures/fakeAcpAgent.mjs') } } } } : undefined;
  app = await launchTestApp(settings, undefined, env, { openNewSession: false });
  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  const records = Object.fromEntries(['one', 'two', 'done'].map(name => {
    const issueKey = `SESSION-${name}`;
    return [issueKey, { issueKey, sessionId: issueKey, title: `Recovery ${name}`, provider,
      state: name === 'done' ? 'completed' : 'executing', startedAt: new Date().toISOString(),
      model: 'openai/gpt-4o-mini', workingDirectory: profile.userDataDir, toolMode: 'read-only', stepCount: 0,
      taskDefinition: { kind: 'general', goal: `${goalPrefix}Recovery ${name}`, scope: '', definitionOfDone: '' }, events: [] }];
  }));
  fs.writeFileSync(path.join(profile.userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': records }));
  app = await launchTestApp(undefined, profile, env, { openNewSession: false });
  return { profile, env, page: app.window, dialog: app.window.getByTestId('session-recovery-dialog') };
}

test('startup waits for approval, resumes only selected sessions, and logs provider and time', async () => {
  const { page, dialog } = await seedInterrupted();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('checkbox')).toHaveCount(2);
  await expect(dialog.getByRole('button', { name: 'Resume selected (0)' })).toBeDisabled();
  expect(mock!.requests).toHaveLength(0);
  const artifact = path.resolve(__dirname, '../../../../.praxis/session-artifacts/session-startup-recovery.png');
  fs.mkdirSync(path.dirname(artifact), { recursive: true });
  await page.screenshot({ path: artifact });
  await dialog.getByRole('button', { name: 'Select all', exact: true }).click();
  await expect(dialog.getByRole('button', { name: 'Resume selected (2)' })).toBeEnabled();
  await dialog.getByRole('checkbox').nth(1).uncheck();
  await dialog.getByRole('button', { name: 'Resume selected (1)' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => mock!.requests.length).toBe(1);
  const sessions = await page.evaluate(() => window.praxis.ai.listSessions());
  expect(sessions.find(record => record.issueKey === 'SESSION-two')?.state).toBe('aborted');
  const logs = await page.evaluate(() => window.praxis.log.getRecent());
  expect(logs.some(line => /\[ApiAgent\] Starting follow-up turn provider=vercel-gateway session=SESSION-one.*at=/.test(line))).toBe(true);
  expect(logs.some(line => line.includes('Resuming interrupted session'))).toBe(true);
  expect(logs.some(line => line.includes('[VercelAgent]'))).toBe(false);
});

test('Leave stopped persists across restart without launching requests', async () => {
  const { profile, env, dialog } = await seedInterrupted();
  await expect(dialog).toBeVisible();
  await dialog.getByRole('button', { name: 'Leave stopped' }).click();
  await expect(dialog).toHaveCount(0);
  await app!.electronApp.close();
  app = await launchTestApp(undefined, profile, env, { openNewSession: false });
  await expect(app.window.getByTestId('session-recovery-dialog')).toHaveCount(0);
  expect(mock!.requests).toHaveLength(0);
});

test('Select all resumes both, and a stale recovery request is rejected', async () => {
  const { page, dialog } = await seedInterrupted();
  await dialog.getByRole('button', { name: 'Select all', exact: true }).click();
  await dialog.getByRole('button', { name: 'Resume selected (2)' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => mock!.requests.length).toBe(2);
  const result = await page.evaluate(() => window.praxis.ai.resumeInterruptedSession('SESSION-one').then(() => 'unexpected', error => error.message));
  expect(result).toContain('no longer awaiting startup recovery');
});

test('unconfigured providers show a recovery error and remain stopped', async () => {
  const { dialog } = await seedInterrupted(false);
  await dialog.getByRole('checkbox').first().check();
  await dialog.getByRole('button', { name: 'Resume selected (1)' }).click();
  await expect(dialog.getByRole('alert')).toContainText('API key');
  await expect(dialog).toBeVisible();
  expect(mock!.requests).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Leave stopped' }).click();
});

test('keyboard focus stays in recovery, and Escape leaves sessions stopped', async () => {
  const { page, dialog } = await seedInterrupted();
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Select all', exact: true })).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(dialog.getByRole('button', { name: 'Leave stopped' })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(dialog.getByRole('button', { name: 'Select all', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  expect(mock!.requests).toHaveLength(0);
});


test('interrupted CLI sessions also wait for selection and resume through ACP', async () => {
  const { page, dialog } = await seedInterrupted(false, 'claude-code-cli');
  await expect(dialog).toContainText('Claude Code');
  await dialog.getByRole('checkbox').first().check();
  await dialog.getByRole('button', { name: 'Resume selected (1)' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await page.evaluate(() => window.praxis.ai.listSessions())).find(record => record.issueKey === 'SESSION-one')?.responseText).toContain('Hello from the fake ACP agent');
  expect(mock!.requests).toHaveLength(0);
});


test('teardown drains an ACP task even when the session list already reports completion', async () => {
  const { page, dialog } = await seedInterrupted(false, 'claude-code-cli', 'HANG_UNTIL_CANCELLED ');
  await dialog.getByRole('checkbox').first().check();
  await dialog.getByRole('button', { name: 'Resume selected (1)' }).click();
  await expect(dialog).toHaveCount(0);
  await expect.poll(async () => (await page.evaluate(() => window.praxis.ai.listSessions()))
    .find(record => record.issueKey === 'SESSION-one')?.responseText).toContain('Hello from the fake ACP agent');

  const sessions = await page.evaluate(() => window.praxis.ai.listSessions());
  expect(sessions.find(record => record.issueKey === 'SESSION-one')?.state).toBe('executing');
  // Hold a real ACP subprocess open, but expose the terminal snapshot teardown
  // can see while shutdown is still pending. The real abort IPC and native
  // close guard remain in place: skipping this record would hang Electron.close.
  await app!.electronApp.evaluate(({ ipcMain }, records) => {
    ipcMain.removeHandler('ai:listSessions');
    ipcMain.handle('ai:listSessions', () => records.map(record =>
      record.issueKey === 'SESSION-one' ? { ...record, state: 'completed' } : record));
  }, sessions);
  const userDataDir = app!.userDataDir;
  await closeTestApp(app!);
  app = undefined;
  expect(fs.existsSync(userDataDir)).toBe(false);
});
