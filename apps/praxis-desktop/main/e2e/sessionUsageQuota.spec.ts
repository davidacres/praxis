import * as fs from 'node:fs';
import { openFromPalette, openProject } from './navigation';
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
  await openProject(page, 'Usage project');
  await page.getByTestId('easymode-new-session').click();
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
  // The collapsed strip shows every quota window, not just the worst one, as one chart per
  // provider: the 5-hour bar above the weekly one, named in the tooltip rather than the strip.
  const chart = summary.getByTestId('session-usage-chart');
  await expect(chart).toHaveCount(1);
  await expect(chart).toHaveAttribute('title', /5-hour window: 82% used · resets in \d+h[^\n]*\nWeekly: 41% used/);
  await expect(summary.getByTestId('session-usage-inline')).not.toContainText(/\b(5h|Wk)\b/);
  await expect(summary.getByTestId('session-usage-meter-hour')).toHaveText('82%');
  await expect(summary.getByTestId('session-usage-meter-hour')).toHaveClass(/is-warn/);
  await expect(summary.getByTestId('session-usage-meter-week')).toHaveText('41%');
  const [hourBar, weekBar] = await Promise.all(['hour', 'week'].map(period =>
    summary.getByTestId(`session-usage-meter-${period}`).getByRole('progressbar').boundingBox()));
  expect(hourBar!.y + hourBar!.height).toBeLessThanOrEqual(weekBar!.y);
  expect(Math.abs(hourBar!.x - weekBar!.x)).toBeLessThan(1);
  const collapsedShot = (name: string) => path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', name);
  fs.mkdirSync(path.dirname(collapsedShot('x')), { recursive: true });
  await summary.screenshot({ path: collapsedShot('composer-usage-chart.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'praxis-dark'));
  await summary.screenshot({ path: collapsedShot('composer-usage-chart-dark.png') });
  await page.evaluate(() => document.documentElement.setAttribute('data-theme', 'praxis-light'));
  await expect(summary.getByTestId('session-usage-meter-week')).not.toHaveClass(/is-warn/);
  // The strip carries only the 5h and weekly rows; daily spend is in the expanded panel.
  await expect(summary.getByTestId('session-usage-meter-day')).toHaveCount(0);
  await expect(summary.getByTestId('session-usage-tokens-vercel-gateway')).toHaveText('0 tok');
  await expect(summary.getByTestId('session-usage-tokens-vercel-gateway')).toHaveAttribute('title', /No tokens used in this session yet/);
  await expect(chart.locator('.composer-usage-chart-row')).toHaveCount(2);

  await summary.locator(':scope > summary').click();
  const quotas = draft.getByTestId('session-usage-provider-vercel-gateway');
  await expect(quotas).toBeVisible();
  await expect(quotas.locator('svg, img').first()).toBeVisible();
  await expect(quotas.getByTestId('session-usage-meter-hour')).toContainText('82%');
  await expect(quotas.getByTestId('session-usage-meter-hour')).toContainText('↻');
  await expect(quotas.getByRole('progressbar')).toHaveCount(2);
  await expect(quotas.getByTestId('session-usage-meter-day')).toContainText('0.00 USD');
  // A window with no reset time simply shows none, rather than "Reset not reported".
  await expect(quotas.getByTestId('session-usage-meter-week')).not.toContainText('↻');
  await expect(summary).not.toContainText(/not reported/i);
  await expect(quotas.locator('.composer-usage-credit')).toContainText('0.00 USD');
  // Nothing has run yet: the session has used 0 tokens, which is not the same as unreported.
  await expect(quotas.locator('.composer-usage-provider-tokens')).toHaveText('0 tok');
  await expect(summary.locator('.composer-usage-expanded-current strong')).toHaveText('0 tok');
  await expect(summary.locator('.session-usage-grid')).toHaveCount(0);

  const shot = path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', 'composer-usage-quota.png');
  fs.mkdirSync(path.dirname(shot), { recursive: true });
  await draft.locator('.session-usage-wrapper').screenshot({ path: shot });
});

// A window the provider does not report keeps its row as a grey bar, so every provider shows the same two rows.
for (const { name, windows, reported } of [
  { name: 'no limits at all', windows: [], reported: { hour: false, week: false } },
  { name: 'weekly only', windows: [{ period: 'week', label: 'Weekly', usedPercent: 41 }], reported: { hour: false, week: true } }
]) {
  test(`collapsed usage shows grey bars for unreported windows (${name})`, async () => {
    mock = await startMockGatewayServer({ mode: 'complete' });
    app = await launchTestApp(undefined, undefined, {
      AI_GATEWAY_API_KEY: 'usage-unreported-e2e-key', AI_GATEWAY_URL: mock.baseUrl
    });
    const page = app.window;
    await app.electronApp.evaluate(({ ipcMain }, windows) => {
      ipcMain.removeHandler('aiUsage:providerSnapshots');
      ipcMain.handle('aiUsage:providerSnapshots', (_event, providers: string[]) => ({ snapshots: providers.map(provider => ({
        provider,
        checkedAt: new Date().toISOString(),
        windows,
        ...(windows.length ? {} : { unavailableReason: 'Provider did not return usage.' })
      })), checkedAt: new Date().toISOString() }));
    }, windows);
    await openDraftComposer(page);

    const summary = page.getByTestId('new-session-view').getByTestId('session-usage-summary');
    const chart = summary.getByTestId('session-usage-group-vercel-gateway').getByTestId('session-usage-chart');
    await expect(chart.locator('.composer-usage-chart-row')).toHaveCount(2);
    for (const period of ['hour', 'week'] as const) {
      const row = chart.getByTestId(`session-usage-meter-${period}`);
      await expect(row).toHaveAttribute('data-reported', String(reported[period]));
      if (reported[period]) await expect(row).toHaveText('41%');
      else {
        await expect(row).toHaveClass(/is-unreported/);
        await expect(row.getByRole('progressbar')).toHaveCount(0);
        // A full grey bar, not something that reads as an empty 0% track.
        const [grey, empty] = await row.locator('.composer-usage-limit-track').evaluate(element => {
          const probe = document.createElement('span');
          probe.className = 'composer-usage-limit-track';
          element.closest('.composer-usage-chart')!.appendChild(probe);
          const colours = [getComputedStyle(element).backgroundColor, getComputedStyle(probe).backgroundColor];
          probe.remove();
          return colours;
        });
        expect(grey).not.toBe(empty);
      }
    }
    await expect(chart).toHaveAttribute('title', windows.length ? /5-hour window: not available\nWeekly: 41% used/ : /not available[\s\S]*Provider did not return usage\./);
    // "Not reported" never appears, collapsed or expanded: unknown figures read as a dash.
    await expect(summary).not.toContainText(/not reported/i);
    await summary.locator(':scope > summary').click();
    await expect(summary.getByTestId('session-usage-expanded')).toBeVisible();
    await expect(summary).not.toContainText(/not reported/i);
    if (!windows.length) await expect(summary.getByTestId('session-usage-provider-vercel-gateway').locator('.composer-usage-unreported')).toHaveText('–');
    await summary.locator(':scope > summary').click();
    const shot = path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', `composer-usage-unreported-${windows.length ? 'partial' : 'none'}.png`);
    fs.mkdirSync(path.dirname(shot), { recursive: true });
    await summary.screenshot({ path: shot });
  });
}

// While limits load, both rows sweep instead of sitting empty; real values replace them.
test('collapsed usage animates both bars while account limits load', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'usage-loading-e2e-key', AI_GATEWAY_URL: mock.baseUrl
  });
  const page = app.window;
  await app.electronApp.evaluate(({ ipcMain }) => {
    const held = globalThis as unknown as { releaseUsage?: () => void };
    const released = new Promise<void>(resolve => { held.releaseUsage = resolve; });
    ipcMain.removeHandler('aiUsage:providerSnapshots');
    ipcMain.handle('aiUsage:providerSnapshots', async (_event, providers: string[]) => {
      await released;
      return { snapshots: providers.map(provider => ({ provider, checkedAt: new Date().toISOString(),
        windows: [{ period: 'hour', windowDurationMinutes: 300, usedPercent: 27 }, { period: 'week', usedPercent: 54 }] })), checkedAt: new Date().toISOString() };
    });
  });
  await openDraftComposer(page);

  const summary = page.getByTestId('new-session-view').getByTestId('session-usage-summary');
  const chart = summary.getByTestId('session-usage-group-vercel-gateway').getByTestId('session-usage-chart');
  await expect(chart).toHaveAttribute('aria-busy', 'true');
  await expect(chart.locator('.composer-usage-chart-row.is-loading')).toHaveCount(2);
  const segments = chart.locator('.composer-usage-limit-track > span');
  await expect(segments).toHaveCount(2);
  // Both rows run the sweep, the weekly one a beat behind, and no percentage is shown yet.
  expect(await segments.evaluateAll(elements => elements.map(element => {
    const style = getComputedStyle(element);
    return [style.animationName, style.animationDirection, style.animationIterationCount, style.animationDelay];
  }))).toEqual([['composer-usage-sweep', 'alternate', 'infinite', '0s'], ['composer-usage-sweep', 'alternate', 'infinite', '0.15s']]);
  await expect(chart.locator('strong:visible')).toHaveCount(0);
  // Measure once the panel's entrance animation (a scaleY on the wrapper) has settled,
  // or the "loading" size is a mid-animation frame rather than the chart's own size.
  await chart.evaluate(element => Promise.all(element.closest('.session-usage-wrapper')!.getAnimations().map(animation => animation.finished)));
  const loadingBox = (await chart.boundingBox())!;
  const xs = async () => (await segments.first().boundingBox())!.x;
  const first = await xs();
  await expect.poll(xs).not.toBe(first);
  const shot = (name: string) => path.resolve(__dirname, '..', '..', '.praxis', 'session-artifacts', name);
  fs.mkdirSync(path.dirname(shot('x')), { recursive: true });
  await summary.screenshot({ path: shot('composer-usage-loading.png') });

  // Reduced motion: a still, faint bar.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  expect(await segments.first().evaluate(element => getComputedStyle(element).animationName)).toBe('none');
  await page.emulateMedia({ reducedMotion: 'no-preference' });

  // Sample the 5h row every frame while the data lands: bar and label grow together from 0 to 27.
  const sampling = page.evaluate(() => new Promise<Array<[number, number]>>(resolve => {
    const samples: Array<[number, number]> = [];
    const started = performance.now();
    const tick = () => {
      const row = document.querySelector('[data-testid="session-usage-group-vercel-gateway"] [data-testid="session-usage-meter-hour"][data-reported="true"]');
      const fill = row?.querySelector<HTMLElement>('.composer-usage-limit-track > span');
      if (row && fill) samples.push([parseFloat(fill.style.width), parseInt(row.querySelector('strong')!.textContent!, 10)]);
      if (performance.now() - started < 2500 && !(samples.length && samples[samples.length - 1][0] === 27)) requestAnimationFrame(tick);
      else resolve(samples);
    };
    requestAnimationFrame(tick);
  }));
  await app.electronApp.evaluate(() => (globalThis as unknown as { releaseUsage: () => void }).releaseUsage());
  const samples = await sampling;
  expect(samples.length).toBeGreaterThan(5);
  expect(samples[0][0]).toBeLessThan(10);
  expect(samples.some(([width]) => width > 5 && width < 22)).toBe(true);
  expect(samples.at(-1)).toEqual([27, 27]);
  for (let index = 1; index < samples.length; index++) expect(samples[index][0]).toBeGreaterThanOrEqual(samples[index - 1][0]);
  for (const [width, label] of samples) expect(Math.abs(width - label)).toBeLessThanOrEqual(1);
  await expect(chart).not.toHaveAttribute('aria-busy', 'true');
  await expect(chart.getByTestId('session-usage-meter-hour')).toHaveText('27%');
  // The chart keeps its size when the figures land, so the strip does not jump.
  const loadedBox = (await chart.boundingBox())!;
  expect(Math.abs(loadedBox.height - loadingBox.height)).toBeLessThan(0.5);
  expect(Math.abs(loadedBox.width - loadingBox.width)).toBeLessThan(0.5);
  // The accessible value is the real figure from the start, not the animated one.
  await expect(chart.getByTestId('session-usage-meter-hour').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '27');
  await expect(chart.getByTestId('session-usage-meter-week')).toHaveText('54%');
  await expect(chart.locator('.is-loading')).toHaveCount(0);
});

// With reduced motion the figures appear at their value, without counting up.
test('collapsed usage skips the count-up under reduced motion', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'usage-reduced-e2e-key', AI_GATEWAY_URL: mock.baseUrl
  });
  const page = app.window;
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await app.electronApp.evaluate(({ ipcMain }) => {
    ipcMain.removeHandler('aiUsage:providerSnapshots');
    ipcMain.handle('aiUsage:providerSnapshots', async (_event, providers: string[]) => {
      await new Promise(resolve => setTimeout(resolve, 800));
      return { snapshots: providers.map(provider => ({ provider, checkedAt: new Date().toISOString(),
        windows: [{ period: 'hour', windowDurationMinutes: 300, usedPercent: 27 }, { period: 'week', usedPercent: 54 }] })), checkedAt: new Date().toISOString() };
    });
  });
  await openDraftComposer(page);
  const row = page.getByTestId('new-session-view').getByTestId('session-usage-group-vercel-gateway').locator('[data-testid="session-usage-meter-week"][data-reported="true"]');
  await row.waitFor();
  // The first frame it exists, it already shows the real value.
  expect(await row.evaluate(element => [parseFloat(element.querySelector<HTMLElement>('.composer-usage-limit-track > span')!.style.width), element.querySelector('strong')!.textContent])).toEqual([54, '54%']);
});

// Once a session has run, missing token figures mean the provider did not report them, not zero.
test('a session that ran without token reports shows a dash, never Not reported', async () => {
  const fixture = path.resolve(__dirname, 'fixtures/fakeAcpAgent.mjs');
  app = await launchTestApp({ ai: { activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath: fixture } } } });
  const page = app.window;
  await openFromPalette(page, 'New conversation');
  await page.getByPlaceholder('Ask anything, brainstorm, or get something done…').fill('Unreported tokens');
  await page.getByTestId('new-session-submit').click();
  await expect.poll(() => page.evaluate(async () => (await window.praxis.ai.listSessions())[0]?.state)).toBe('completed');
  const record = await page.evaluate(async () => (await window.praxis.ai.listSessions())[0]);
  await app.electronApp.evaluate(({ BrowserWindow, ipcMain }, record) => {
    const updated = { ...record, tokenUsage: undefined, runtimeEpochs: [{ id: 'run', provider: 'claude-code-cli', model: record.model, startedAt: new Date().toISOString(), reason: 'started' }] };
    ipcMain.removeHandler('ai:listSessions'); ipcMain.handle('ai:listSessions', () => [updated]);
    ipcMain.removeHandler('ai:getSession'); ipcMain.handle('ai:getSession', () => updated);
    for (const window of BrowserWindow.getAllWindows()) window.webContents.send('ai:sessionChanged', updated);
  }, record);
  const tokens = page.getByTestId('sessions-view').getByTestId('session-usage-tokens-claude-code-cli');
  await expect(tokens).toHaveText('–');
  await expect(tokens).toHaveAttribute('title', /Token count not available from this provider/);
  const summary = page.getByTestId('sessions-view').getByTestId('session-usage-summary');
  await expect(summary).not.toContainText(/not reported/i);
  await summary.locator(':scope > summary').click();
  await expect(summary.getByTestId('session-usage-expanded')).toBeVisible();
  await expect(summary).not.toContainText(/not reported/i);
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
  await openFromPalette(page, 'New conversation');
  const summary = page.getByTestId('new-session-view').getByTestId('session-usage-summary');
  await summary.locator(':scope > summary').click();
  await expect(summary.getByTestId('session-usage-current')).toContainText('mock/first');
  await expect(summary.getByTestId('session-usage-provider-vercel-gateway').locator('.composer-usage-provider-tokens')).toHaveText('0 tok');
  expect(await page.evaluate(async () => (await window.praxis.aiUsage.series('hour', 1, 'vercel-gateway', 'mock/first'))[0].totalTokens)).toBe(111);
  await page.getByTestId('new-session-model-chip').click();
  await page.getByTestId('new-session-model-option-mock/second').click();
  await expect(summary.locator(':scope > summary')).toContainText('mock/second');
  // Opening the picker dismisses the usage details.
  await expect(summary).not.toHaveAttribute('open', '');
  await summary.locator(':scope > summary').click();
  await expect(summary.getByTestId('session-usage-current')).toContainText('mock/second');
  await expect(summary.getByTestId('session-usage-provider-vercel-gateway').locator('.composer-usage-provider-tokens')).toHaveText('0 tok');
  expect(await page.evaluate(async () => (await window.praxis.aiUsage.series('hour', 1, 'vercel-gateway', 'mock/second'))[0].totalTokens)).toBe(222);
  expect(await page.evaluate(async () => (await window.praxis.aiUsage.series('hour', 1))[0].totalTokens)).toBe(1332);
  await summary.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/composer-current-model-usage.png') });
});

// The earlier renderer build fails the guard against repeating the collapsed figures when expanded.
test('session usage follows the active conversation speaker and its runtime tokens', async () => {
  const fixture = path.resolve(__dirname, 'fixtures/fakeAcpAgent.mjs');
  app = await launchTestApp({ ai: { activeProvider: 'claude-code-cli', providers: { 'claude-code-cli': { cliPath: fixture } } } });
  const page = app.window;
  await openFromPalette(page, 'New conversation');
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
    // One group per provider, each holding its own icon, tokens and chart, 5h row before weekly.
    expect(await bar.locator('.composer-usage-provider-group .composer-usage-group-logo').evaluateAll(elements => elements.map(item => item.getAttribute('title')))).toEqual(['Claude Code', 'OpenAI Codex']);
    await expect(bar.getByTestId('session-usage-chart')).toHaveCount(2);
    for (const provider of ['claude-code-cli', 'codex-cli']) {
      const group = bar.getByTestId(`session-usage-group-${provider}`);
      await expect(group.getByTestId(`session-usage-tokens-${provider}`)).toHaveCount(1);
      await expect(group.getByTestId('session-usage-chart')).toHaveAttribute('data-provider', provider);
    }
    expect(await bar.locator('.composer-usage-limit').evaluateAll(elements => elements.map(item => [item.getAttribute('data-provider'), item.getAttribute('data-period')]))).toEqual([
      ['claude-code-cli', 'hour'], ['claude-code-cli', 'week'], ['codex-cli', 'hour'], ['codex-cli', 'week']
    ]);
    expect((await bar.boundingBox())!.height).toBeLessThanOrEqual(48);
    await summary.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/usage-single-line.png') });
    // Narrow: the strip may wrap, but only between providers, never inside one group.
    await summary.evaluate(element => { element.style.width = '300px'; });
    // Each provider's icon and chart share a line: their vertical centres agree.
    const offsets = await bar.locator('.composer-usage-provider-group').evaluateAll(groups => groups.map(group => {
      const centre = (element: Element | null) => { const box = element!.getBoundingClientRect(); return box.top + box.height / 2; };
      return Math.abs(centre(group.querySelector('.composer-usage-group-logo')) - centre(group.querySelector('.composer-usage-chart')));
    }));
    expect(offsets).toHaveLength(2);
    for (const offset of offsets) expect(offset).toBeLessThan(4);
    await summary.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/usage-groups-narrow.png') });
    await summary.evaluate(element => { element.style.width = ''; });
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

  // Shaped like a real session: Codex hit its limit at once, Antigravity got a handover but never
  // replied, then Claude did the work. Runs that never replied used nothing, so they read 0, not unreported.
  const at = (minute: number) => new Date(Date.UTC(2026, 9, 18, 23, minute)).toISOString();
  const handedOver = {
    sessionId: 'handed-over', provider: 'claude-code-cli', model: 'opus', tokenUsage: { totalTokens: 900 },
    runtimeEpochs: [
      { provider: 'codex-cli', model: 'gpt', startedAt: at(31), endedAt: at(32), reason: 'started' },
      { provider: 'antigravity-cli', model: 'gemini', startedAt: at(32), endedAt: at(35), reason: 'provider_handover' },
      { provider: 'claude-code-cli', model: 'opus', startedAt: at(35), reason: 'provider_handover', tokenUsage: { totalTokens: 900 } }
    ],
    events: [
      { type: 'user_input_completed', timestamp: at(31), summary: 'Question' },
      { type: 'error', timestamp: at(31), summary: 'Provider limit reached' },
      { type: 'message', timestamp: at(31), summary: 'limit', detail: "You've hit your usage limit. Try again at 1:59 AM." },
      { type: 'user_input_completed', timestamp: at(33), summary: 'Question again' },
      { type: 'message', timestamp: at(36), summary: 'answer', detail: 'Here is the answer.' }
    ]
  } as unknown as Record;
  const handover = sessionUsageData([handedOver], 'claude-code-cli', 'opus', []);
  expect(handover.providers.map(item => [item.provider, item.tokens, item.partial])).toEqual([
    ['codex-cli', 0, false], ['antigravity-cli', 0, false], ['claude-code-cli', 900, false]
  ]);
  // A run that did reply but sent no figures is still unreported.
  const repliedEvents = [...(handedOver.events ?? []), { type: 'message', timestamp: at(33), summary: 'reply', detail: 'An Antigravity answer.' }];
  const replied = sessionUsageData([{ ...handedOver, events: repliedEvents } as Record], 'claude-code-cli', 'opus', []);
  expect(replied.providers.find(item => item.provider === 'antigravity-cli')?.tokens).toBeUndefined();
  // Without the event log we cannot tell, so nothing is assumed.
  const unloaded = sessionUsageData([{ ...handedOver, events: [], eventsLoaded: false } as unknown as Record], 'claude-code-cli', 'opus', []);
  expect(unloaded.providers.find(item => item.provider === 'codex-cli')?.tokens).toBeUndefined();
});
