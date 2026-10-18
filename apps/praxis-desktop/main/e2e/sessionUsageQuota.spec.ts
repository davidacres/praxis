import * as fs from 'node:fs';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * The composer's usage panel renders the selected provider's account windows
 * in a compact strip and keeps every provider visible across speaker changes.
 */

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
});

async function openDraftComposer(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    await window.praxis.projects.create({
      name: 'Usage project',
      key: 'USAGE',
      type: 'product',
      purpose: '',
      brief: {},
      startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do' }, { id: 'done', name: 'Done' }],
      starterTickets: [{ summary: 'Usage ticket', description: '', issueType: 'Task', status: 'To do' }],
      defaultAiToolMode: 'read-only'
    }, workspace.id);
  });
  await page.reload();
  await page.getByTestId('project-session-new').first().click();
}

// The earlier renderer fails the zero-cost guard: account usage and zero credits must remain visible.
test('composer usage panel draws provider quota windows as bars with a collapsed meter', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'usage-quota-e2e-key', AI_GATEWAY_URL: mock.baseUrl
  });
  const page = app.window;
  const resetsAt = new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString();
  await app.electronApp.evaluate(({ ipcMain }, reset) => {
    ipcMain.removeHandler('aiUsage:providerSnapshots');
    ipcMain.handle('aiUsage:providerSnapshots', (_event, providers: string[]) => ({ snapshots: providers.map(provider => ({
      provider,
      checkedAt: new Date().toISOString(),
      windows: [
        { period: 'hour', windowDurationMinutes: 300, label: '5-hour window', usedPercent: 82, resetsAt: reset },
        { period: 'week', label: 'Weekly', usedPercent: 41 },
        { period: 'day', label: 'Daily consumption', usedCost: 0, currency: 'USD' }
      ],
      credits: { remaining: 0, currency: 'USD' }
    })), checkedAt: new Date().toISOString() }));
  }, resetsAt);
  await openDraftComposer(page);

  const draft = page.getByTestId('new-session-view');
  const summary = draft.getByTestId('session-usage-summary');
  // The collapsed strip shows every quota window, not just the worst one.
  await expect(summary.getByTestId('session-usage-meter-hour')).toContainText('5h');
  await expect(summary.getByTestId('session-usage-meter-hour')).toContainText('82%');
  await expect(summary.getByTestId('session-usage-meter-hour')).toHaveClass(/is-warn/);
  await expect(summary.getByTestId('session-usage-meter-week')).toContainText('Wk');
  await expect(summary.getByTestId('session-usage-meter-week')).toContainText('41%');
  await expect(summary.getByTestId('session-usage-meter-week')).not.toHaveClass(/is-warn/);
  await expect(summary.getByTestId('session-usage-meter-day')).toContainText('0.00 USD');
  await expect(summary.getByTestId('session-usage-meter-day').getByRole('progressbar')).toHaveCount(0);

  await summary.locator(':scope > summary').click();
  const quotas = draft.getByTestId('session-usage-provider-vercel-gateway');
  await expect(quotas).toBeVisible();
  await expect(quotas.locator('svg, img').first()).toBeVisible();
  await expect(quotas.getByTestId('session-usage-meter-hour')).toContainText('82%');
  await expect(quotas.getByTestId('session-usage-meter-hour')).toContainText('↻');
  await expect(quotas.getByRole('progressbar')).toHaveCount(2);
  await expect(quotas.locator('.composer-usage-credit')).toContainText('0.00 USD');
  await expect(quotas.locator('.composer-usage-provider-tokens')).toHaveText('Not reported');
  await expect(summary.locator('.session-usage-grid')).toHaveCount(0);

  const shot = path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'composer-usage-quota.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await draft.locator('.session-usage-wrapper').screenshot({ path: shot });
});

// The collapsed strip must still say something when a provider reports no account limits.
test('collapsed usage names providers that report no limits instead of going blank', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'usage-unreported-e2e-key', AI_GATEWAY_URL: mock.baseUrl
  });
  const page = app.window;
  await app.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('aiUsage:providerSnapshots');
    ipcMain.handle('aiUsage:providerSnapshots', (_event, providers: string[]) => ({ snapshots: providers.map(provider => ({
      provider,
      checkedAt: new Date().toISOString(),
      windows: [],
      unavailableReason: 'Provider did not return usage.'
    })), checkedAt: new Date().toISOString() }));
  });
  await openDraftComposer(page);

  const summary = page.getByTestId('new-session-view').getByTestId('session-usage-summary');
  const unreported = summary.locator('.composer-usage-unreported').first();
  await expect(unreported).toHaveText('Limits not reported');
  await expect(unreported).toHaveAttribute('title', /Provider did not return usage\./);
  const shot = path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'composer-usage-unreported.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await summary.screenshot({ path: shot });
});

// Proven with the IPC model filter removed: 333 provider tokens fail the expected 111.
test('draft usage follows the selected model and keeps unfiltered dashboard totals', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', models: [{ id: 'mock/first' }, { id: 'mock/second' }] });
  const os = await import('node:os');
  const userDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-usage-model-'));
  const timestamp = new Date().toISOString();
  fs.writeFileSync(path.join(userDataDir, 'ai-usage-log.json'), JSON.stringify({ 'praxis.aiUsageLog.v1': [
    { id: 'first', timestamp, source: 'session', provider: 'vercel-gateway', model: 'mock/first', totalTokens: 111, cost: { amount: 1, currency: 'USD' } },
    { id: 'second', timestamp, source: 'session', provider: 'vercel-gateway', model: 'mock/second', totalTokens: 222, cost: { amount: 2, currency: 'USD' } },
    { id: 'other-provider', timestamp, source: 'session', provider: 'openai', model: 'mock/second', totalTokens: 999 }
  ] }));
  app = await launchTestApp({ ai: { activeProvider: 'vercel-gateway', defaultModel: 'mock/first' } },
    { userDataDir, settingsPath: path.join(userDataDir, 'settings.json') },
    { AI_GATEWAY_API_KEY: 'usage-model-test', AI_GATEWAY_URL: mock.baseUrl });
  const page = app.window;
  await page.getByTestId('conversations-new-btn').click();
  const summary = page.getByTestId('new-session-view').getByTestId('session-usage-summary');
  await summary.locator(':scope > summary').click();
  await expect(summary.getByTestId('session-usage-current')).toContainText('mock/first');
  await expect(summary.getByTestId('session-usage-provider-vercel-gateway').locator('.composer-usage-provider-tokens')).toHaveText('Not reported');
  expect(await page.evaluate(async () => (await window.praxis.aiUsage.series('hour', 1, 'vercel-gateway', 'mock/first'))[0].totalTokens)).toBe(111);
  await page.getByTestId('new-session-model-chip').click();
  await page.getByTestId('new-session-model-option-mock/second').click();
  await expect(summary.locator(':scope > summary')).toContainText('mock/second');
  // Opening the picker dismisses the usage details.
  await expect(summary).not.toHaveAttribute('open', '');
  await summary.locator(':scope > summary').click();
  await expect(summary.getByTestId('session-usage-current')).toContainText('mock/second');
  await expect(summary.getByTestId('session-usage-provider-vercel-gateway').locator('.composer-usage-provider-tokens')).toHaveText('Not reported');
  expect(await page.evaluate(async () => (await window.praxis.aiUsage.series('hour', 1, 'vercel-gateway', 'mock/second'))[0].totalTokens)).toBe(222);
  expect(await page.evaluate(async () => (await window.praxis.aiUsage.series('hour', 1))[0].totalTokens)).toBe(1332);
  await summary.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/composer-current-model-usage.png') });
});

// The earlier renderer build fails the guard against repeating the collapsed figures when expanded.
test('session usage follows the active conversation speaker and its runtime tokens', async () => {
  const fixture = path.resolve(__dirname, 'fixtures/fakeAcpAgent.mjs');
  app = await launchTestApp({ ai: { activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath: fixture } } } });
  const page = app.window;
  await page.getByTestId('conversations-new-btn').click();
  await page.getByPlaceholder('Ask anything, brainstorm, or get something done…').fill('Current speaker usage');
  await page.getByTestId('new-session-submit').click();
  await expect.poll(() => page.evaluate(async () => (await window.praxis.ai.listSessions())[0]?.state)).toBe('completed');
  const record = await page.evaluate(async () => (await window.praxis.ai.listSessions())[0]);
  try {
    const publish = async (speakerId: string) => {
      await app!.electronApp.evaluate(({ BrowserWindow, ipcMain }, { record, speakerId }) => {
        const startedAt = new Date().toISOString();
        const updated = {
          ...record, provider: 'claude-code-cli', model: 'host-model', tokenUsage: { totalTokens: 399 }, cost: { amount: 4, currency: 'USD' },
          runtimeEpochs: [
            { id: 'host', provider: 'claude-code-cli', model: 'host-model', startedAt, reason: 'started', tokenUsage: { totalTokens: 111 } },
            { id: 'earlier', provider: 'claude-code-cli', model: 'earlier-model', startedAt, reason: 'handover', tokenUsage: { totalTokens: 55 } },
            { id: 'host-again', provider: 'claude-code-cli', model: 'host-model', startedAt, reason: 'conversation_turn', tokenUsage: { totalTokens: 11 } },
            { id: 'guest', provider: 'codex-cli', model: 'guest-model', startedAt, reason: 'conversation_turn', tokenUsage: { totalTokens: 222 } }
          ],
          conversation: { state: 'running', mode: 'consult', currentSpeakerId: speakerId, toolOwnerId: 'host', originalToolMode: 'read-only', turnsUsed: 1, turnCap: 4,
            participants: [
              { id: 'host', provider: 'claude-code-cli', model: 'host-model', role: 'host', displayLabel: 'Host' },
              { id: 'guest', provider: 'codex-cli', model: 'guest-model', role: 'guest', displayLabel: 'Guest' }
            ] }
        };
        ipcMain.removeHandler('ai:listSessions');
        ipcMain.handle('ai:listSessions', () => [updated]);
        ipcMain.removeHandler('ai:getSession');
        ipcMain.handle('ai:getSession', () => updated);
        ipcMain.removeHandler('aiUsage:providerSnapshots');
        ipcMain.handle('aiUsage:providerSnapshots', async (_event, providers: string[]) => {
          await new Promise(resolve => setTimeout(resolve, 500));
          return { snapshots: providers.map(provider => ({ provider, fetchedAt: new Date().toISOString(), windows: [
            { period: 'hour', windowDurationMinutes: 300, usedPercent: provider === 'codex-cli' ? 18 : 32, resetsAt: new Date(Date.now() + 7200000).toISOString() },
            { period: 'week', usedPercent: provider === 'codex-cli' ? 44 : 61, resetsAt: new Date(Date.now() + 172800000).toISOString() }
          ] })), checkedAt: new Date().toISOString() };
        });
        ipcMain.removeHandler('aiUsage:listEvents');
        ipcMain.handle('aiUsage:listEvents', () => [
          { sessionId: record.sessionId, provider: 'claude-code-cli', model: 'host-model', cost: { amount: 1.5, currency: 'USD' } },
          { sessionId: record.sessionId, provider: 'claude-code-cli', model: 'earlier-model', cost: { amount: 0.5, currency: 'USD' } },
          { sessionId: record.sessionId, provider: 'codex-cli', model: 'guest-model', cost: { amount: 2, currency: 'USD' } }
        ]);
        for (const window of BrowserWindow.getAllWindows()) window.webContents.send('ai:sessionChanged', updated);
      }, { record, speakerId });
    };
    const summary = page.getByTestId('sessions-view').getByTestId('session-usage-summary');
    await publish('guest');
    const bar = summary.locator(':scope > summary');
    await expect(summary.getByTestId('session-usage-current')).toHaveText('guest-model');
    await expect(bar.getByTestId('session-usage-tokens-claude-code-cli')).toHaveText('177 tok');
    await expect(bar.getByTestId('session-usage-tokens-codex-cli')).toHaveText('222 tok');
    await expect(bar.getByTestId('session-usage-meter-hour')).toHaveCount(2);
    expect(await bar.locator('.composer-usage-provider-icons > span').evaluateAll(elements => elements.map(item => item.getAttribute('title')))).toEqual(['Claude Code', 'OpenAI Codex']);
    expect(await bar.locator('.composer-usage-limit').evaluateAll(elements => elements.map(item => [item.getAttribute('data-provider'), item.getAttribute('data-period')]))).toEqual([
      ['claude-code-cli', 'hour'], ['codex-cli', 'hour'], ['claude-code-cli', 'week'], ['codex-cli', 'week']
    ]);
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(48);
    await summary.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/usage-single-line.png') });
    await bar.focus();
    await page.keyboard.press('Enter');
    await expect(summary.getByTestId('session-usage-expanded')).toBeVisible();
    await expect(summary.locator('.composer-usage-expanded-current')).toContainText('222 tok');
    await expect(summary.getByTestId('session-usage-provider-claude-code-cli')).toContainText('177 tok');
    await expect(summary.getByTestId('session-usage-provider-codex-cli')).toContainText('222 tok');
    await expect(summary.locator('.composer-usage-history > summary')).toContainText('399 tok');
    await expect(bar.getByTestId('session-usage-inline')).toHaveCount(0);
    expect((await summary.boundingBox())!.height).toBeLessThanOrEqual(190);
    await summary.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/usage-compact-expanded.png') });
    await summary.locator('.composer-usage-history > summary').click();
    await expect(summary.locator('.composer-usage-model-row')).toHaveCount(3);
    for (const name of await summary.locator('.composer-usage-model-name > span').all()) await expect(name).toBeVisible();
    await expect(summary.locator('.composer-usage-model-row').filter({ hasText: 'host-model' })).toContainText('122 tok');
    await expect(summary.locator('.composer-usage-model-row').filter({ hasText: 'earlier-model' })).toContainText('55 tok');
    await publish('host');
    await expect(summary.getByTestId('session-usage-current')).toHaveText('host-model');
    await expect(summary.locator('.composer-usage-expanded-current')).toContainText('122 tok');
    await expect(summary.getByTestId('session-usage-provider-codex-cli')).toBeVisible();
    await expect(summary.locator('.composer-usage-expanded-current')).toContainText('$1.50');
    await summary.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/usage-expanded.png') });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'praxis-dark'));
    await summary.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/usage-expanded-dark.png') });
    await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'praxis-light'));
    await summary.evaluate(element => { element.style.width = '380px'; element.style.maxWidth = '100%'; });
    expect(await summary.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
    await summary.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/usage-narrow.png') });
    await page.keyboard.press('Escape');
    await expect(summary).not.toHaveAttribute('open', '');
    await bar.focus();
    await page.keyboard.press('Space');
    await expect(summary.getByTestId('session-usage-expanded')).toBeVisible();
    await page.getByTestId('sessions-view').getByTestId('session-chat-thread').click({ position: { x: 10, y: 10 } });
    await expect(summary).not.toHaveAttribute('open', '');
  } finally {
    await app.electronApp.evaluate(({ ipcMain }, record) => {
      ipcMain.removeHandler('ai:listSessions');
      ipcMain.handle('ai:listSessions', () => [record]);
    }, record);
  }
});

// Proven by breaking runtime summing (100 instead of 300) and restoring the incorrect partial flag.
test('usage attribution preserves missing tokens, currencies and legacy session totals', async () => {
  const { sessionUsageData } = await import('../../renderer/src/ai/sessionUsageData');
  type Record = import('@praxis/core').AgentSessionRecord;
  const record = {
    sessionId: 'mixed', provider: 'claude-code-cli', model: 'current', tokenUsage: { totalTokens: 500 },
    runtimeEpochs: [
      { provider: 'claude-code-cli', model: 'current', tokenUsage: { totalTokens: 100 } },
      { provider: 'claude-code-cli', model: 'current', tokenUsage: { totalTokens: 200 } },
      { provider: 'codex-cli', model: 'other' }
    ], cost: { amount: 3, currency: 'USD' }
  } as Record;
  const data = sessionUsageData([record], 'codex-cli', 'other', [
    { sessionId: 'mixed', provider: 'claude-code-cli', model: 'current', cost: { amount: 1, currency: 'USD' } },
    { sessionId: 'mixed', provider: 'claude-code-cli', model: 'current', cost: { amount: 2, currency: 'EUR' } },
    { sessionId: 'another-session', provider: 'codex-cli', model: 'other', cost: { amount: 999, currency: 'USD' } }
  ] as import('@praxis/core').AiUsageEvent[]);
  expect(data.current?.tokens).toBeUndefined();
  expect(data.current?.costs).toEqual([]);
  expect(data.models[0].tokens).toBe(300);
  expect(data.models[0].costs).toEqual([{ amount: 1, currency: 'USD' }, { amount: 2, currency: 'EUR' }]);
  expect(data.total.tokens).toBe(500);
  const legacyRecord = { sessionId: 'legacy', provider: 'claude-code-cli', model: 'current', tokenUsage: { totalTokens: 150 }, runtimeEpochs: [{ provider: 'claude-code-cli', model: 'current' }] } as Record;
  const legacy = sessionUsageData([legacyRecord], 'claude-code-cli', 'current', []);
  expect(legacy.current?.tokens).toBe(150);
  expect(legacy.providers).toHaveLength(1);
  const upcoming = sessionUsageData([legacyRecord], 'claude-code-cli', 'not-yet-used', []);
  expect(upcoming.current?.tokens).toBeUndefined();
  expect(upcoming.providers[0]).toMatchObject({ tokens: 150, partial: false });
  const partial = sessionUsageData([{ ...record, runtimeEpochs: [...record.runtimeEpochs!, { provider: 'claude-code-cli', model: 'current' }] } as Record], 'claude-code-cli', 'current', []);
  expect(partial.current).toMatchObject({ tokens: 300, partial: true });
});
