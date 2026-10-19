import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { openSession } from './sessionNavigation';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * A turn that queried the code intelligence index wears a badge in its
 * telemetry bar, counting those calls. Another server's tool with the same
 * short name (`mcp__github__search_code`) must not count. The no-badge case —
 * a turn with only local tools — is asserted in aiThoughtGrouping.spec.ts.
 */

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined
} as const;

const ACP_FIXTURE_PATH = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');

const FINAL_REPLY = 'buildSystemPrompt is called from both agent hosts.';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
  if (mock) await mock.close();
  mock = undefined;
});

test('a turn that used code intelligence shows a lowercase badge without a count', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    usage: { prompt_tokens: 900, completion_tokens: 200 },
    roundTrips: [
      { content: '', toolCalls: [{ name: 'mcp__code_intelligence__search_code', arguments: { query: 'session prompt' } }] },
      { content: '', toolCalls: [{ name: 'mcp__code_intelligence__find_symbol', arguments: { name: 'buildSystemPrompt' } }] },
      { content: '', toolCalls: [{ name: 'mcp.code_intelligence.search_code', arguments: { query: 'who calls this?' } }] },
      { content: '', toolCalls: [{ name: 'mcp__code_intelligence__get_callers', arguments: { symbolId: 'sym' } }] },
      { content: '', toolCalls: [{ name: 'mcp__github__search_code', arguments: { query: 'buildSystemPrompt' } }] },
      { content: '', toolCalls: [{ name: 'read_file', arguments: { path: 'a.ts' } }] }
    ],
    reply: FINAL_REPLY
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-code-intel-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  await win.evaluate(async () => window.praxis.ai.delegate({
    provider: 'vercel-gateway',
    permissionMode: 'auto',
    task: { goal: 'What calls the session prompt builder?' }
  }));

  await openSession(win);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 20000 });

  const card = win.locator('[data-testid="session-chat-assistant"]', { hasText: FINAL_REPLY });
  await expect(card).toHaveCount(1);
  const badge = card.getByTestId('session-chat-code-intel-badge');
  await expect(badge).toHaveCount(1);
  // The badge is a simple usage indicator; counts are omitted. The dot-separated
  // MCP name emitted by some hosts is still included in recognition.
  await expect(badge).toHaveText('code intel');
  await expect(badge).toHaveAttribute('title', /search_code, find_symbol, get_callers/);

  const capture = path.resolve(__dirname, '../../.praxis/session-artifacts/chat-code-intel-badge.png');
  fs.mkdirSync(path.dirname(capture), { recursive: true });
  await card.screenshot({ path: capture });
});

test('an ACP MCP call reported completed first still shows the code intelligence badge', async () => {
  app = await launchTestApp();
  const win = app.window;
  const goal = 'CODE_INTEL_COMPLETED_FIRST';
  await win.evaluate(async ({ fixturePath, taskGoal }) => {
    await window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: fixturePath } } } });
    await window.praxis.ai.delegate({
      provider: 'claude-code-cli',
      goal: taskGoal,
      toolMode: 'read-only',
      task: { goal: taskGoal, maxSteps: 4, timeoutMs: 30000 }
    });
  }, { fixturePath: ACP_FIXTURE_PATH, taskGoal: goal });

  await openSession(win, goal);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 20000 });

  const card = win.locator('[data-testid="session-chat-assistant"]', { hasText: 'Hello from the fake ACP agent.' });
  const badge = card.getByTestId('session-chat-code-intel-badge');
  await expect(badge).toHaveCount(1);
  await expect(badge).toHaveText('code intel');
  await expect(badge).toHaveAttribute('title', /search_code/);
});
