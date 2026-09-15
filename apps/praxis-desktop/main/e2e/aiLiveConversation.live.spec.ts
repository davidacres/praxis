/**
 * Real-provider proof for FX-BE-122. This is intentionally excluded from the
 * normal desktop suite: it spends two signed-in CLI agents.
 *
 *   PRAXIS_LIVE_AGENT=1 npx playwright test --project=live-agent e2e/aiLiveConversation.live.spec.ts
 */
import { spawnSync } from 'node:child_process';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';

const HOST_PROVIDER = 'claude-code-cli';
const HOST_COMMAND = process.env.PRAXIS_LIVE_AGENT_CMD ?? 'claude-agent-acp';
const GUEST_PROVIDER = process.env.PRAXIS_LIVE_CONVERSATION_TO ?? 'codex-cli';
const GUEST_COMMAND = process.env.PRAXIS_LIVE_CONVERSATION_CMD ?? 'codex-acp';
const TURN_MS = 240000;

let app: TestApp | undefined;

function commandAvailable(command: string): boolean {
  const probe = process.platform === 'win32' ? ['where', command] : ['which', command];
  return Boolean(command) && spawnSync(probe[0], probe.slice(1), { encoding: 'utf8' }).status === 0;
}

async function sessionByKey(win: Page, key: string) {
  return win.evaluate(issueKey => window.praxis.ai.listSessions().then(records =>
    records.find(record => record.issueKey === issueKey)
  ), key);
}

async function waitFor(win: Page, key: string, predicate: (record: NonNullable<Awaited<ReturnType<typeof sessionByKey>>>) => boolean) {
  for (let attempt = 0; attempt < TURN_MS / 1000; attempt += 1) {
    const record = await sessionByKey(win, key);
    if (record && predicate(record)) return record;
    if (record?.state === 'failed' || record?.state === 'aborted') return record;
    await win.waitForTimeout(1000);
  }
  return sessionByKey(win, key);
}

test.beforeAll(() => {
  test.skip(process.env.PRAXIS_LIVE_AGENT !== '1', 'Set PRAXIS_LIVE_AGENT=1 to spend real model calls.');
});

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

test('two real CLI agents visibly alternate in a capped read-only consult', async () => {
  test.skip(!commandAvailable(HOST_COMMAND), `Host CLI not on PATH: ${HOST_COMMAND}`);
  test.skip(!commandAvailable(GUEST_COMMAND), `Guest CLI not on PATH: ${GUEST_COMMAND}`);

  app = await launchTestApp();
  const win = app.window;
  await win.evaluate(({ hostProvider, hostCommand, guestProvider, guestCommand }) => window.praxis.settings.set({
    ai: { providers: { [hostProvider]: { cliPath: hostCommand }, [guestProvider]: { cliPath: guestCommand } } }
  }), { hostProvider: HOST_PROVIDER, hostCommand: HOST_COMMAND, guestProvider: GUEST_PROVIDER, guestCommand: GUEST_COMMAND });

  const session = await win.evaluate(({ provider, timeoutMs }) => window.praxis.ai.delegate({
    provider,
    toolMode: 'read-only',
    goal: 'In one concise sentence, propose a safe way to verify a small code change. Do not use tools.',
    task: { maxSteps: 3, timeoutMs }
  }), { provider: HOST_PROVIDER, timeoutMs: TURN_MS });
  const first = await waitFor(win, session.issueKey, record => record.state === 'completed');
  expect(first?.state).toBe('completed');

  await win.evaluate(({ issueKey, provider }) => window.praxis.ai.startConversation(issueKey, {
    provider, mode: 'consult', turnCap: 2
  }), { issueKey: session.issueKey, provider: GUEST_PROVIDER });
  const capped = await waitFor(win, session.issueKey, record => record.conversation?.state === 'capped');
  expect(capped?.conversation?.turnsUsed).toBe(2);
  const speakers = new Set((capped?.events ?? [])
    .filter(event => event.type === 'message' && event.speaker)
    .map(event => event.speaker?.participantId));
  expect(speakers).toEqual(new Set(['host', 'guest']));
  expect((capped?.events ?? []).filter(event => event.type === 'user_input_completed')).toHaveLength(0);

  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('Claude Code');
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('Codex');
});
