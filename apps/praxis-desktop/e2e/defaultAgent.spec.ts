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

type SessionRow = { issueKey: string; state: string; profileId?: string; activeSkills?: string[] };

async function sessionRow(win: TestApp['window'], key: string): Promise<SessionRow | undefined> {
  return win.evaluate(
    async k => (await window.praxis.ai.listSessions()).find(session => session.issueKey === k) as never,
    key
  );
}

async function waitCompleted(win: TestApp['window'], key: string): Promise<void> {
  await expect.poll(async () => (await sessionRow(win, key))?.state, { timeout: 20000 }).toBe('completed');
}

/** The bodies of the model requests made since `from`, so a test reads only the turn it just ran. */
function bodiesSince(from: number): string {
  return mock!.requests.slice(from).map(request => request.body).join('\n');
}

async function startSession(win: TestApp['window'], agent?: string): Promise<string> {
  const session = await win.evaluate(async id => window.praxis.ai.delegate({
    goal: 'Plan the release.',
    toolMode: 'read-only',
    ...(id ? { agentId: id, profileId: id, hostId: id, skillNames: ['verification-report'] } : {}),
    task: { goal: 'Plan the release.', maxSteps: 2, timeoutMs: 30000 }
  } as never), agent ?? null);
  await waitCompleted(win, session.issueKey);
  return session.issueKey;
}

test('a session keeps its agent on every turn, and a follow-up can change, clear or set it', async () => {
  const win = app!.window;
  const key = await startSession(win, 'praxis-default');
  const send = async (message: string, agent?: { profileId: string; skillNames?: string[] }) => {
    const from = mock!.requests.length;
    await win.evaluate(
      async ({ k, m, a }) => { await window.praxis.ai.continueSession(k, m, undefined, a ? { agent: a } : undefined); },
      { k: key, m: message, a: agent ?? null }
    );
    await expect.poll(() => mock!.requests.length, { timeout: 20000 }).toBeGreaterThan(from);
    await waitCompleted(win, key);
    return bodiesSince(from);
  };

  // The brief is part of the stored goal, so it is on the second turn too, without being resent.
  expect(await send('And the changelog?')).toContain('Praxis agent profile: Praxis Default');

  // Switching replaces it: the new agent is present and the old one is gone, not stacked.
  const switched = await send('Now fix the failing build.', { profileId: 'praxis-fixer', skillNames: ['verification-report'] });
  expect(switched).toContain('Praxis agent profile: Praxis Fixer');
  expect(switched).not.toContain('Praxis agent profile: Praxis Default');
  expect(switched).toContain('Plan the release.');
  expect(await sessionRow(win, key)).toMatchObject({ profileId: 'praxis-fixer', activeSkills: ['verification-report'] });

  // Clearing leaves the bare goal.
  const cleared = await send('Just answer plainly.', { profileId: '' });
  expect(cleared).not.toContain('Praxis agent profile');
  expect(cleared).toContain('Plan the release.');
  expect((await sessionRow(win, key))?.profileId).toBeUndefined();

  // A session that never had an agent can be given one, and keeps its own goal.
  const set = await send('Back to the baseline.', { profileId: 'praxis-default', skillNames: [] });
  expect(set).toContain('Praxis agent profile: Praxis Default');
  expect(set).toContain('Plan the release.');
});

test('the follow-up composer shows the session\'s agent, or No agent, and sends a change with the next message', async () => {
  const win = app!.window;
  const legacy = await startSession(win);
  const bound = await startSession(win, 'praxis-default');

  const open = async (key: string) => {
    await win.keyboard.press('ControlOrMeta+k');
    const palette = win.getByRole('dialog', { name: 'Go to' });
    await palette.getByRole('textbox').fill(key);
    await palette.getByRole('option').first().click();
    await expect(win.locator('.session-follow-up-composer')).toBeVisible();
  };

  // A session started without an agent simply has none set.
  await open(legacy);
  await expect(win.getByTestId('session-agent-chip')).toContainText('No agent');

  await open(bound);
  await expect(win.getByTestId('session-agent-chip')).toContainText('Praxis Default');
  await win.getByTestId('session-agent-chip').click();
  await win.getByRole('option', { name: /Praxis Fixer/ }).click();
  await expect(win.getByTestId('session-agent-chip')).toContainText('Praxis Fixer');
  // Picking is not applying: nothing changes until a message is sent.
  expect((await sessionRow(win, bound))?.profileId).toBe('praxis-default');

  const from = mock!.requests.length;
  await win.locator('[data-testid="session-follow-up-input"]').fill('Fix the failing build.');
  await win.locator('[data-testid="session-follow-up-send"]').click();
  await expect.poll(async () => (await sessionRow(win, bound))?.profileId, { timeout: 20000 }).toBe('praxis-fixer');
  await waitCompleted(win, bound);
  expect(bodiesSince(from)).toContain('Praxis agent profile: Praxis Fixer');
  await expect(win.getByTestId('session-agent-chip')).toContainText('Praxis Fixer');
});

test('the chat shows what you typed, not the agent brief that rides along with it', async () => {
  const win = app!.window;
  await win.locator('[data-testid="new-session-view"] textarea').fill('Summarise the release notes');
  await win.getByTestId('new-session-submit').click();
  await expect.poll(async () => (await lastSession(win))?.state, { timeout: 20000 }).toBe('completed');
  const session = await win.evaluate(async () => (await window.praxis.ai.listSessions())[0]!.issueKey);
  await win.keyboard.press('ControlOrMeta+k');
  const palette = win.getByRole('dialog', { name: 'Go to' });
  await palette.getByRole('textbox').fill(session);
  await palette.getByRole('option').first().click();
  const thread = win.getByTestId('session-chat-thread');
  await expect(thread).toContainText('Summarise the release notes');
  // Proven against the raw goal, which rendered the whole brief (and its skill text) as your message.
  await expect(thread).not.toContainText('Praxis agent profile');
  await expect(thread).not.toContainText('at most 3 rounds');
});
