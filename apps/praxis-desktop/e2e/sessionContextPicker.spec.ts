import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, dismissSplash } from './launchTestApp';
import { startMockGatewayServer } from './mockGatewayServer';

test('composer plus adds real folder, session and ticket context to a follow-up', async () => {
  test.setTimeout(60000);
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-context-'));
  const folder = path.join(userDataDir, 'working-folder'); fs.mkdirSync(folder);
  const otherFolder = path.join(userDataDir, 'other-folder'); fs.mkdirSync(otherFolder);
  const at = new Date().toISOString();
  const record = (key: string, title: string, response: string) => ({ issueKey: key, sessionId: key, title, provider: 'vercel-gateway', model: 'mock/model', toolMode: 'full',
    state: 'completed', startedAt: at, completedAt: at, stepCount: 1, taskDefinition: { goal: title },
    events: [{ timestamp: at, type: 'message', summary: response }], responseText: response });
  fs.writeFileSync(path.join(userDataDir, 'ai-sessions.json'), JSON.stringify({ 'praxis.agentSessions': {
    'SESSION-context-main': record('SESSION-context-main', 'Context recipient', 'Ready for the next request.'),
    'SESSION-context-reference': record('SESSION-context-reference', 'Prior architecture decision', 'Unique decision: keep the recovery journal append-only.')
  } }));
  const mock = await startMockGatewayServer({ mode: 'complete', models: [{ id: 'mock/model' }] });
  const app = await launchTestApp(undefined, { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') }, { AI_GATEWAY_API_KEY: 'context-fixture-key', AI_GATEWAY_URL: mock.baseUrl, VERCEL_OIDC_TOKEN: undefined }, { openNewSession: false });
  const page = app.window;
  try {
    await page.evaluate(async () => {
      const workspace = (await window.praxis.workspaces.list())[0];
      await window.praxis.projects.create({ name: 'Context project', key: 'CTX', type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage',
        starterTickets: [{ summary: 'Recovery acceptance criteria', description: 'Unique ticket evidence: recover interrupted sessions without replaying completed actions.', issueType: 'Task', status: 'Todo' }],
        workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], defaultAiToolMode: 'read-only' }, workspace.id);
    });
    await app.electronApp.evaluate(({ ipcMain }, paths) => {
      let call = 0;
      ipcMain.removeHandler('dialog:pickFolder'); ipcMain.handle('dialog:pickFolder', () => paths[Math.min(call++, paths.length - 1)]);
    }, [folder, otherFolder, folder]);
    await page.reload(); await dismissSplash(page);
    await page.keyboard.press('ControlOrMeta+k');
    const palette = page.getByRole('dialog', { name: 'Go to' });
    await palette.getByRole('textbox').fill('SESSION-context-main');
    await palette.getByRole('option').filter({ hasText: 'Context recipient' }).click();
    const plus = page.getByTestId('session-add-context');
    const menu = page.getByRole('dialog', { name: 'Add context', exact: true });
    await expect(page.getByTestId('session-mode-panel')).toHaveCount(0);
    await expect(page.getByTestId('session-attach-folder')).toHaveCount(0);
    await plus.click();
    await expect(menu).toBeVisible();
    const artifacts = path.resolve(__dirname, '../../.praxis/session-artifacts'); fs.mkdirSync(artifacts, { recursive: true });
    await menu.screenshot({ path: path.join(artifacts, 'composer-context-menu.png') });
    await page.getByTestId('context-folder').click();
    await expect(page.getByTestId('session-context-references')).toContainText('working-folder');
    await plus.click(); await page.getByTestId('context-folder').click();
    await expect(page.getByTestId('session-context-references')).toContainText('other-folder');
    await page.getByRole('button', { name: 'Detach working folder' }).click();
    await expect(page.getByRole('button', { name: 'Detach working folder' })).toHaveCount(0);
    await plus.click(); await page.getByTestId('context-folder').click();
    await expect(page.getByTestId('session-context-references')).toContainText('working-folder');
    await plus.click(); await page.getByTestId('context-session').click();
    await menu.getByRole('textbox', { name: 'Find session context' }).fill('architecture');
    await menu.getByRole('button', { name: 'Prior architecture decision', exact: true }).click();
    await expect(page.getByTestId('session-context-reference')).toHaveCount(1);
    await page.getByRole('button', { name: 'Remove context Prior architecture decision' }).click();
    await expect(page.getByTestId('session-context-reference')).toHaveCount(0);
    await plus.click(); await page.getByTestId('context-session').click();
    await menu.getByRole('button', { name: 'Prior architecture decision', exact: true }).click();
    await plus.click(); await page.getByTestId('context-ticket').click();
    await menu.getByRole('textbox', { name: 'Find ticket context' }).fill('Recovery');
    await menu.getByRole('button', { name: /CTX-.*Recovery acceptance criteria/ }).click();
    await expect(page.getByTestId('session-context-reference')).toHaveCount(2);
    const input = page.getByTestId('session-follow-up-input');
    await input.fill('Use these references to explain the recovery plan.');
    const inputBounds = (await input.boundingBox())!; const plusBounds = (await plus.boundingBox())!;
    expect(plusBounds.x + plusBounds.width).toBeLessThan(inputBounds.x + 43);
    // The plus button shares the input's first line: both centres on one axis
    const firstLineCentre = await input.evaluate(element => {
      const styles = getComputedStyle(element);
      return element.getBoundingClientRect().top + parseFloat(styles.paddingTop) + parseFloat(styles.lineHeight) / 2;
    });
    expect(Math.abs(plusBounds.y + plusBounds.height / 2 - firstLineCentre)).toBeLessThan(2);
    // All three composer rows share one fixed height so each band is identical
    const rowHeights = await page.evaluate(() => {
      const refs = document.querySelector('.session-context-references');
      const shell = document.querySelector('.composer-input-shell.has-leading');
      const controls = document.querySelector('.session-chat-composer .composer-controls');
      return [refs, shell, controls].map(el => el ? el.getBoundingClientRect().height : -1);
    });
    expect(rowHeights[0]).toBeGreaterThan(0);
    expect(Math.abs(rowHeights[0] - rowHeights[1])).toBeLessThan(2);
    expect(Math.abs(rowHeights[1] - rowHeights[2])).toBeLessThan(2);
    await page.locator('.agent-details-composer-dock').screenshot({ path: path.join(artifacts, 'composer-attached-context.png') });
    await page.getByTestId('session-follow-up-send').click();
    await expect.poll(() => ({
      session: mock.requests.some(request => request.body.includes('Unique decision: keep the recovery journal')),
      ticket: mock.requests.some(request => request.body.includes('Unique ticket evidence: recover interrupted sessions')),
      prompt: mock.requests.some(request => request.body.includes('Use these references')),
    })).toMatchObject({ session: true, ticket: true, prompt: true });
    await expect(page.getByTestId('session-context-reference')).toHaveCount(0);
    const updated = await page.evaluate(() => window.praxis.ai.getSession('SESSION-context-main'));
    expect(updated?.workingDirectory).toBe(folder);
    await expect(page.getByTestId('session-chat-thread')).toContainText('Context: Prior architecture decision');
    await expect(page.getByTestId('session-chat-thread')).not.toContainText('<selected_context>');
    await page.locator('.agent-details-composer-dock').screenshot({ path: path.join(artifacts, 'composer-context-sent.png') });
  } finally { await closeTestApp(app); await mock.close(); }
});
