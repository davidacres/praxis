import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { openSession } from './sessionNavigation';
import { chooseOption, chipOptionValues } from './chipSelect';

// Real IPC and handover, isolated profiles and two separate mock providers.
// Never dismiss the error: recovery must clear the active warning itself.
// Proven red before the fix: both healthy-provider examples retained the
// original banner and incorrectly labelled OpenAI as out of budget while executing.
let app: TestApp | undefined;
const servers: MockGatewayServer[] = [];

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  await Promise.all(servers.splice(0).map(server => server.close()));
});

async function givenLimitedProvider(errorBody: string, replacementFails = false, setup?: (app: TestApp) => Promise<void>) {
  const original = await startMockGatewayServer({ mode: 'error', errorStatus: 429, errorBody, holdCompletion: true });
  servers.push(original);
  const replacement = await startMockGatewayServer({
    mode: replacementFails ? 'error' : 'complete',
    errorStatus: 429,
    errorBody: JSON.stringify({ error: { message: 'OpenAI insufficient quota: credits exhausted' } }),
    reply: 'Replacement provider continued the existing session.',
    models: [{ id: 'mock/model' }, { id: 'mock/other' }],
    holdCompletion: true
  });
  servers.push(replacement);
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'e2e-original-limit-key',
    AI_GATEWAY_URL: original.baseUrl,
    VERCEL_OIDC_TOKEN: undefined,
    FROSTY_VERCEL_API_KEY: undefined,
    VERCEL_AI_GATEWAY_URL: undefined,
    FROSTY_VERCEL_URL: undefined
  });
  const win = app.window;
  await win.evaluate(async baseUrl => {
    await window.praxis.settings.set({ ai: { providers: { openai: { baseUrl, enabled: true } } } });
    await window.praxis.ai.setProviderApiKey('openai', 'e2e-replacement-key');
  }, replacement.baseUrl);
  const session = await win.evaluate(() => window.praxis.ai.delegate({
    provider: 'vercel-gateway', task: { goal: 'Continue this work after a provider limit.' }
  }));
  if (setup) await setup(app);
  await openSession(win, session.issueKey);
  await expect(win.getByTestId('session-state-badge')).toHaveText('Failed', { timeout: 15000 });
  await expect(win.getByTestId('session-error-banner')).toContainText('Provider Limit');
  await expect(win.getByTestId('session-limit-switch')).toContainText('Vercel AI Gateway reached its usage limit.');
  return { win, session, original, replacement };
}

async function thenRecoveredComposer(win: TestApp['window'], idle = true) {
  // Soft assertions expose both regressions and allow completion/reopen checks
  // to run even when the in-flight recovery UI is broken.
  await expect.soft(win.getByTestId('session-error-banner')).toHaveCount(0, { timeout: 1000 });
  await expect.soft(win.getByTestId('session-limit-switch')).toHaveCount(0, { timeout: 1000 });
  // Ordinary single-agent execution collapses the composer controls.
  if (idle) {
    await expect.soft(win.getByTestId('session-provider')).toContainText('OpenAI', { timeout: 1000 });
    await expect.soft(win.getByTestId('session-follow-up-input')).toBeVisible({ timeout: 1000 });
  }
}

async function captureRecovery(win: TestApp['window'], name: string) {
  const screenshot = path.resolve(__dirname, `../../.praxis/session-artifacts/${name}.png`);
  fs.mkdirSync(path.dirname(screenshot), { recursive: true });
  await win.screenshot({ path: screenshot });
}

for (const failure of [
  { name: 'credits exhausted', message: 'Insufficient balance or no resource package. Please recharge.' },
  { name: 'budget exhausted', message: 'Provider spending budget exceeded' }
]) {
  test(`Given ${failure.name}, When switching provider, Then stale warnings clear through continuation and reopen`, async () => {
    const { win, session, original, replacement } = await givenLimitedProvider(
      JSON.stringify({ error: { code: '1113', message: failure.message } })
    );
    const originalRequests = original.requests.length;

    // WHEN the user accepts the actual composer recovery action.
    await win.getByTestId('session-limit-switch-go').click();
    await expect.poll(() => replacement.requests.length).toBeGreaterThan(0);
    await expect.poll(() => win.evaluate(async key => {
      const record = (await window.praxis.ai.listSessions()).find(item => item.issueKey === key);
      return { provider: record?.provider, state: record?.state };
    }, session.issueKey)).toEqual({ provider: 'openai', state: 'executing' });

    // THEN the old failure must not be relabelled as an OpenAI failure while running.
    if (failure.name === 'credits exhausted') await captureRecovery(win, 'provider-limit-fixed-running');
    await thenRecoveredComposer(win, false);
    replacement.releaseCompletion();
    await expect(win.getByTestId('session-state-badge')).toHaveText('Completed', { timeout: 15000 });
    await thenRecoveredComposer(win);
    await expect(win.getByTestId('session-chat-thread')).toContainText('Replacement provider continued');

    const recovered = await win.evaluate(async key =>
      (await window.praxis.ai.listSessions()).find(item => item.issueKey === key), session.issueKey);
    expect(recovered?.lastError).toBeFalsy();
    expect(recovered?.providerLimitReached).toBeFalsy();
    // Keep historical failure evidence without presenting it as an active error.
    expect(recovered?.events.some(event => event.type === 'error')).toBe(true);
    expect(recovered?.runtimeEpochs?.some(epoch => epoch.provider === 'vercel-gateway')).toBe(true);
    expect(recovered?.runtimeEpochs?.at(-1)?.provider).toBe('openai');
    expect(original.requests).toHaveLength(originalRequests);

    // AND a normal follow-up uses the replacement, without returning to recovery UI.
    const requestsBeforeFollowUp = replacement.requests.length;
    await win.getByTestId('session-follow-up-input').fill('Continue with the next step.');
    await win.getByTestId('session-follow-up-send').click();
    await expect.poll(() => replacement.requests.length).toBeGreaterThan(requestsBeforeFollowUp);
    await expect(win.getByTestId('session-state-badge')).toHaveText('Completed', { timeout: 15000 });
    await thenRecoveredComposer(win);
    expect(original.requests).toHaveLength(originalRequests);

    // AND reopening from persisted session data must not resurrect the old limit.
    await win.reload();
    await openSession(win, session.issueKey);
    await thenRecoveredComposer(win);
    if (failure.name === 'credits exhausted') {
      await captureRecovery(win, 'provider-limit-recovered');
    }
  });
}

test('Given an exhausted provider, When the replacement also exhausts credits, Then its new failure remains actionable', async () => {
  const { win, replacement } = await givenLimitedProvider(
    JSON.stringify({ error: { message: 'Insufficient balance: credits exhausted' } }), true
  );
  await win.getByTestId('session-limit-switch-go').click();
  await expect.poll(() => replacement.requests.length).toBeGreaterThan(0);
  await expect.poll(() => win.evaluate(async () => {
    const record = (await window.praxis.ai.listSessions())[0];
    return { provider: record?.provider, state: record?.state, error: record?.lastError };
  })).toMatchObject({ provider: 'openai', state: 'failed', error: expect.stringContaining('OpenAI insufficient quota') });
  await expect(win.getByTestId('session-error-banner')).toContainText('Provider Limit');
  await expect(win.getByTestId('session-limit-switch')).toContainText('OpenAI reached its usage limit.');
  await expect(win.getByTestId('session-limit-switch-go')).toBeEnabled();
});

const QUOTA_ERROR = JSON.stringify({ error: { message: 'Insufficient balance: credits exhausted' } });

test('Given model chips, When choosing a non-default model, Then only Switch sends the exact draft pair once', async () => {
  const { win, session, replacement } = await givenLimitedProvider(QUOTA_ERROR);
  await expect(win.getByTestId('session-limit-switch-go')).toBeEnabled();
  await chooseOption(win.getByTestId('session-limit-model'), 'mock/other');
  expect(replacement.requests).toHaveLength(0);
  expect(await win.evaluate(async key => (await window.praxis.ai.listSessions()).find(record => record.issueKey === key)?.provider, session.issueKey)).toBe('vercel-gateway');
  await win.getByTestId('session-limit-switch-go').dblclick();
  await expect.poll(() => replacement.requests.length).toBe(1);
  expect(JSON.parse(replacement.requests[0].body).model).toBe('mock/other');
  await expect(win.getByTestId('session-limit-switch')).toHaveCount(0);
  replacement.releaseCompletion();
  await expect(win.getByTestId('session-state-badge')).toHaveText('Completed');
});

test('Given a topped-up original provider and changed draft model, When Retry is selected, Then the original runtime retries and stale warnings clear', async () => {
  const { win, original, replacement } = await givenLimitedProvider(QUOTA_ERROR);
  await chooseOption(win.getByTestId('session-limit-model'), 'mock/other');
  const first = JSON.parse(original.requests[0].body);
  original.setMode('complete');
  await win.getByTestId('session-limit-actions').click();
  await expect(win.getByTestId('session-limit-retry')).toContainText('Retry with Vercel AI Gateway');
  await win.getByTestId('session-limit-retry').click();
  await expect.poll(() => original.requests.length).toBe(2);
  expect(JSON.parse(original.requests[1].body).model).toBe(first.model);
  expect(replacement.requests).toHaveLength(0);
  await expect(win.getByTestId('session-limit-switch')).toHaveCount(0);
  await expect(win.getByTestId('session-error-banner')).toHaveCount(0);
  original.releaseCompletion();
  await expect(win.getByTestId('session-state-badge')).toHaveText('Completed');
});

test('Given a recovery menu, When it is dismissed or Stop is selected, Then selection alone changes nothing and Stop keeps history', async () => {
  const { win, original, replacement } = await givenLimitedProvider(QUOTA_ERROR);
  const actions = win.getByTestId('session-limit-actions');
  await actions.focus();
  await actions.press('ArrowDown');
  await expect(win.getByTestId('session-limit-action-menu')).toBeVisible();
  await win.keyboard.press('Escape');
  await expect(actions).toBeFocused();
  await expect(win.getByTestId('session-limit-action-menu')).toHaveCount(0);
  await expect(win.getByTestId('session-limit-switch')).toBeVisible();
  await actions.click();
  await win.getByTestId('session-limit-stop').click();
  await expect(win.getByTestId('session-limit-switch')).toHaveCount(0);
  await expect(win.getByTestId('session-follow-up-input')).toBeVisible();
  expect(original.requests).toHaveLength(1);
  expect(replacement.requests).toHaveLength(0);
  expect(await win.evaluate(async () => (await window.praxis.ai.listSessions())[0].events.some(event => event.type === 'error'))).toBe(true);
});

test('Given six providers, When recovery appears in wide and narrow panes, Then only two chips and a split action remain inline', async () => {
  const { win } = await givenLimitedProvider(QUOTA_ERROR, false, async app => {
    await app.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:listProviderStatuses');
      ipcMain.handle('ai:listProviderStatuses', () => ['vercel-gateway', 'openai', 'anthropic', 'gemini', 'z-ai', 'codex-cli'].map(provider => ({ provider, configured: true, enabled: true, capabilities: { tools: true } })));
    });
  });
  const recovery = win.getByTestId('session-limit-switch');
  await expect(recovery.locator('.chip-select')).toHaveCount(2);
  expect(await chipOptionValues(win.getByTestId('session-limit-provider'))).toHaveLength(5);
  await win.getByTestId('session-limit-actions').click();
  await expect(win.getByTestId('session-limit-action-menu').getByRole('menuitem')).toHaveCount(3);
  await captureRecovery(win, 'provider-recovery-chips-wide');
  await win.keyboard.press('Escape');
  await win.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await win.getByRole('button', { name: 'Toggle secondary sidebar', exact: true }).click();
  await app!.electronApp.evaluate(({ BrowserWindow }) => {
    const window = BrowserWindow.getAllWindows()[0];
    window.setMinimumSize(480, 600);
    window.setSize(540, 820);
  });
  await expect.poll(() => recovery.evaluate(element => element.getBoundingClientRect().width)).toBeLessThan(540);
  await expect.poll(() => recovery.evaluate(element => element.scrollWidth <= element.clientWidth)).toBe(true);
  await win.getByTestId('session-limit-actions').click();
  await expect.poll(() => win.getByTestId('session-limit-action-menu').evaluate(element => {
    const rect = element.getBoundingClientRect();
    return rect.left >= 0 && rect.right <= window.innerWidth && element.scrollWidth <= element.clientWidth;
  })).toBe(true);
  await captureRecovery(win, 'provider-recovery-chips-narrow');
});

test('Given a configured default absent from the catalog, When choosing its provider, Then that default is pinned and sent', async () => {
  const { win, replacement } = await givenLimitedProvider(QUOTA_ERROR, false, async app => {
    await app.window.evaluate(() => window.praxis.settings.set({ ai: { providers: { openai: { defaultModel: 'mock/configured-default' } } } }));
  });
  await expect(win.getByTestId('session-limit-model')).toContainText('Default · mock/configured-default');
  await win.getByTestId('session-limit-switch-go').click();
  await expect.poll(() => replacement.requests.length).toBe(1);
  expect(JSON.parse(replacement.requests[0].body).model).toBe('mock/configured-default');
  replacement.releaseCompletion();
  await expect(win.getByTestId('session-state-badge')).toHaveText('Completed');
});

test('Given failing model discovery, When reloading models, Then Switch stays blocked until a valid model is loaded', async () => {
  const { win, replacement } = await givenLimitedProvider(QUOTA_ERROR, false, async app => {
    await app.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:listApiModelOptions');
      ipcMain.handle('ai:listApiModelOptions', (_event, provider, refresh) => {
        if (provider === 'openai' && !refresh) throw new Error('Mock catalog unavailable');
        return { currentValue: 'mock/model', options: [{ value: 'mock/model', name: 'mock/model' }] };
      });
    });
  });
  await expect(win.getByTestId('session-limit-switch')).toContainText('Mock catalog unavailable');
  await expect(win.getByTestId('session-limit-switch-go')).toBeDisabled();
  expect(replacement.requests).toHaveLength(0);
  await win.getByTestId('session-limit-model-reload').click();
  await expect(win.getByTestId('session-limit-switch-go')).toBeEnabled();
  await expect(win.getByTestId('session-limit-model')).toContainText('mock/model');
});

test('Given slow model discovery for one provider, When changing provider again, Then the late catalog cannot overwrite the new selection', async () => {
  const { win } = await givenLimitedProvider(QUOTA_ERROR, false, async app => {
    await app.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:listProviderStatuses');
      ipcMain.handle('ai:listProviderStatuses', () => ['openai', 'anthropic', 'gemini'].map(provider => ({ provider, configured: true, enabled: true })));
      ipcMain.removeHandler('ai:listApiModelOptions');
      ipcMain.handle('ai:listApiModelOptions', async (_event, provider) => {
        if (provider === 'anthropic') await new Promise(resolve => setTimeout(resolve, 1200));
        return { currentValue: `mock/${provider}`, options: [{ value: `mock/${provider}`, name: `mock/${provider}` }] };
      });
    });
  });
  await expect(win.getByTestId('session-limit-switch-go')).toBeEnabled();
  await chooseOption(win.getByTestId('session-limit-provider'), 'anthropic');
  await expect(win.getByTestId('session-limit-switch-go')).toBeDisabled();
  await chooseOption(win.getByTestId('session-limit-provider'), 'gemini');
  await expect(win.getByTestId('session-limit-model')).toHaveAttribute('data-value', 'mock/gemini');
  // Wait for the earlier IPC response to settle, then check it did not replace Gemini.
  await app!.electronApp.evaluate(async () => { await new Promise(resolve => setTimeout(resolve, 1400)); });
  await expect(win.getByTestId('session-limit-model')).toHaveAttribute('data-value', 'mock/gemini');
});

test('Given a runtime without a model catalog, When it is selected, Then provider-default fallback is explicit', async () => {
  const { win } = await givenLimitedProvider(QUOTA_ERROR, false, async app => {
    await app.electronApp.evaluate(({ ipcMain }) => {
      ipcMain.removeHandler('ai:listProviderStatuses');
      ipcMain.handle('ai:listProviderStatuses', () => [{ provider: 'codex-cli', configured: true, enabled: true }]);
      ipcMain.removeHandler('ai:listCliModelOptions');
      ipcMain.handle('ai:listCliModelOptions', () => undefined);
    });
  });
  await expect(win.getByTestId('session-limit-model')).toContainText('Provider default — model not exposed');
  await expect(win.getByTestId('session-limit-switch-go')).toBeEnabled();
});
