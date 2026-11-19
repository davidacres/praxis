import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * A new chat session starts with the user's default agent (Praxis Default out of the box): its
 * working method reaches the model, and the skills it lists are attached. The agent is a choice,
 * not a lock: the composer's Agent chip changes it for one session, Settings changes the default,
 * and analysis or review sessions never start with one.
 */

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.beforeEach(async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl,
    VERCEL_OIDC_TOKEN: undefined
  });
  await app.window.waitForSelector('[data-testid="new-session-view"]');
});

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  app = undefined;
  mock = undefined;
});

async function lastSession(win: TestApp['window']): Promise<{ state: string; profileId?: string; activeSkills?: string[] } | undefined> {
  return win.evaluate(async () => {
    const sessions = await window.praxis.ai.listSessions();
    const latest = sessions[0];
    return latest ? { state: latest.state, profileId: latest.profileId, activeSkills: latest.activeSkills } : undefined;
  });
}

test('a chat session starts with Praxis Default, sends its brief to the model, and attaches its skills', async () => {
  const win = app!.window;
  const chip = win.getByTestId('new-session-agent');
  await expect(chip).toContainText('Praxis Default');

  await win.locator('[data-testid="new-session-view"] textarea').fill('Say hello');
  await win.getByTestId('new-session-submit').click();

  await expect.poll(async () => (await lastSession(win))?.state, { timeout: 20000 }).toBe('completed');
  const session = await lastSession(win);
  expect(session?.profileId).toBe('praxis-default');
  expect(session?.activeSkills).toEqual(expect.arrayContaining(['verification-report', 'visual-verification']));

  const sent = mock!.requests.map(request => request.body).join('\n');
  expect(sent).toContain('Praxis agent profile: Praxis Default');
  expect(sent).toContain('at most 3 rounds');
});

test('choosing No agent in the composer starts a bare session', async () => {
  const win = app!.window;
  await win.getByTestId('new-session-agent').click();
  await win.getByRole('option', { name: /No agent/ }).click();
  await expect(win.getByTestId('new-session-agent')).toContainText('No agent');

  await win.locator('[data-testid="new-session-view"] textarea').fill('Say hello without an agent');
  await win.getByTestId('new-session-submit').click();

  await expect.poll(async () => (await lastSession(win))?.state, { timeout: 20000 }).toBe('completed');
  const session = await lastSession(win);
  expect(session?.profileId).toBeUndefined();
  expect(mock!.requests.map(request => request.body).join('\n')).not.toContain('Praxis agent profile');
});

test('analysis sessions never start with an agent, and the Settings default can be cleared', async () => {
  const win = app!.window;
  await expect(win.getByTestId('new-session-agent')).toContainText('Praxis Default');
  await win.getByTestId('new-session-mode-analysis').click();
  await expect(win.getByTestId('new-session-agent')).toContainText('No agent');
  await win.getByTestId('new-session-mode-chat').click();
  await expect(win.getByTestId('new-session-agent')).toContainText('Praxis Default');

  await win.evaluate(() => window.praxis.settings.set({ ai: { defaultAgentId: '' } }));
  await expect(win.getByTestId('new-session-agent')).toContainText('No agent');

  // An agent that is not installed falls back to none instead of failing the launch.
  await win.evaluate(() => window.praxis.settings.set({ ai: { defaultAgentId: 'praxis-no-such-agent' } }));
  await expect(win.getByTestId('new-session-agent')).toContainText('No agent');
});

test('Settings lists the agents and persists the chosen default', async () => {
  const win = app!.window;
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-ai').click();
  await win.getByTestId('ai-provider-list').waitFor();
  await win.getByRole('tablist', { name: 'AI provider settings' }).getByRole('tab', { name: 'Behaviour' }).click();
  const picker = win.getByTestId('settings-default-agent');
  await expect(picker).toContainText('Praxis Default');
  await picker.click();
  await expect(win.getByRole('option', { name: /Praxis Fixer/ })).toBeVisible();
  await win.getByRole('option', { name: /Praxis Fixer/ }).click();
  await expect.poll(() => win.evaluate(async () => (await window.praxis.settings.get()).ai.defaultAgentId)).toBe('praxis-fixer');
});

test('a session with a built-in agent is still refused up front when its provider is turned off', async () => {
  const win = app!.window;
  const provider = await win.evaluate(async () => (await window.praxis.settings.get()).ai.activeProvider);
  await win.evaluate(async id => { await window.praxis.settings.set({ ai: { providers: { [id]: { enabled: false } } } }); }, provider);
  const refusal = await win.evaluate(async id => {
    try {
      await window.praxis.ai.delegate({
        goal: 'Say hello',
        provider: id,
        toolMode: 'read-only',
        agentId: 'praxis-default',
        profileId: 'praxis-default',
        hostId: 'praxis-default',
        task: { goal: 'Say hello', maxSteps: 2, timeoutMs: 30000 }
      } as never);
      return 'started';
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  }, provider);
  // Proven against the old launcher, which skipped this check for any binding and started the session.
  expect(refusal).toMatch(/turned off/);
});
