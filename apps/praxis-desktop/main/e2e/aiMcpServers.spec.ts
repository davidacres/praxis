import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { chooseOption } from './chipSelect';
import { openSession } from './sessionNavigation';

/**
 * MCP servers the user adds for their agents (Settings → AI Provider → Tools).
 * CLI agents receive them at session start — covered in aiCliAgentHost.spec.ts
 * — and API providers get their tools bridged in, covered here, along with the
 * settings UI that manages the list.
 */

// A tiny stdio MCP server in core: `echo`, `fail` and `whoami` tools.
const ECHO_SERVER = path.resolve(__dirname, '..', '..', '..', '..', 'packages', 'core', 'src', 'ai', 'mcp', 'fixtures', 'echoServer.mjs');

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined
} as const;

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
});

const echoServer = (requireApproval: boolean) => ({
  id: 'echo-1',
  name: 'Echo Tools',
  enabled: true,
  transport: 'stdio' as const,
  command: process.execPath,
  args: [ECHO_SERVER],
  requireApproval
});

async function startGatewaySession(
  requireApproval: boolean,
  toolMode: 'full' | 'read-only' = 'full'
): Promise<TestApp['window']> {
  mock = await startMockGatewayServer({
    mode: 'complete',
    roundTrips: [{ content: 'Let me try the echo tool', toolCalls: [{ name: 'mcp__echo_tools__echo', arguments: { text: 'hello' } }] }],
    reply: 'The echo tool answered.'
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-mcp-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  await win.evaluate(async server => {
    await window.praxis.settings.set({ ai: { mcpServers: [server] } });
  }, echoServer(requireApproval));
  await win.evaluate(async toolMode => window.praxis.ai.delegate({
    provider: 'vercel-gateway',
    toolMode,
    permissionMode: 'manual',
    task: { goal: 'Use the echo tool.' }
  }), toolMode);
  await openSession(win);
  return win;
}

test('an API-provider session can call a tool from a user-added server', async () => {
  const win = await startGatewaySession(false);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 30000 });

  // The model was offered the tool, under the server's namespace…
  expect(mock!.requests[0].body).toContain('mcp__echo_tools__echo');
  // …and what the server answered went back to it on the next round trip.
  expect(mock!.requests[1].body).toContain('echo:hello');
});

test('a server that requires approval asks before each call, and a denial never reaches it', async () => {
  const win = await startGatewaySession(true);
  const card = win.locator('[data-testid="session-permission-card"]');
  await expect(card).toBeVisible({ timeout: 30000 });
  await expect(win.locator('[data-testid="session-permission-summary"]')).toContainText('Echo Tools › echo');
  await win.locator('[data-testid="session-permission-deny"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 30000 });
  expect(mock!.requests[1].body).toContain('Permission denied');
  expect(mock!.requests[1].body).not.toContain('echo:hello');
});

test('a read-only session is never given user-added servers', async () => {
  mock = await startMockGatewayServer({ mode: 'complete', reply: 'Nothing to call.' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-mcp-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  await win.evaluate(async server => {
    await window.praxis.settings.set({ ai: { mcpServers: [server] } });
  }, echoServer(false));
  await win.evaluate(async () => window.praxis.ai.delegate({
    provider: 'vercel-gateway',
    toolMode: 'read-only',
    task: { goal: 'Just read.' }
  }));
  await openSession(win);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 30000 });
  expect(mock.requests[0].body).not.toContain('mcp__echo_tools__');
});

test('servers are added, tested, switched off and removed from Settings', async () => {
  app = await launchTestApp();
  const win = app.window;
  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-ai').click();
  await win.getByTestId('ai-provider-list').waitFor();
  await win.getByRole('tablist', { name: 'AI provider settings' }).getByRole('tab', { name: 'Tools' }).click();

  await win.getByTestId('mcp-add-server').click();
  // An empty form says what is missing and cannot be saved.
  await expect(win.getByTestId('mcp-server-problem')).toContainText('Enter a name');
  await expect(win.getByTestId('mcp-server-save')).toBeDisabled();

  await win.getByTestId('mcp-server-name').fill('Echo Tools');
  await chooseOption(win.getByTestId('mcp-server-transport'), 'stdio');
  await win.getByTestId('mcp-server-command').fill(process.execPath);
  await win.getByTestId('mcp-server-args').fill(ECHO_SERVER);

  await win.getByTestId('mcp-server-test').click();
  await expect(win.getByTestId('mcp-server-test-result')).toContainText('Connected to echo-fixture');
  await expect(win.getByTestId('mcp-server-test-result')).toContainText('3 tools');

  await win.getByTestId('mcp-server-save').click();
  const row = win.locator('[data-testid^="mcp-server-row-"]');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('Echo Tools');
  await expect(row).toContainText('Local');

  const saved = await win.evaluate(async () => (await window.praxis.settings.get()).ai.mcpServers);
  expect(saved).toMatchObject([{ name: 'Echo Tools', transport: 'stdio', enabled: true, requireApproval: true, args: [ECHO_SERVER] }]);

  // A bad server reports why, instead of failing silently.
  await win.getByTestId('mcp-add-server').click();
  await win.getByTestId('mcp-server-name').fill('Nowhere');
  await win.getByTestId('mcp-server-url').fill('http://127.0.0.1:9/mcp');
  await win.getByTestId('mcp-server-test').click();
  await expect(win.getByTestId('mcp-server-test-result')).toContainText('Could not connect', { timeout: 30000 });
  {
    const dir = path.resolve(__dirname, '..', '..', 'renderer', '.praxis', 'session-artifacts');
    fs.mkdirSync(dir, { recursive: true });
    await win.getByTestId('mcp-servers').screenshot({ path: path.join(dir, 'mcp-servers-form.png') });
  }
  await win.getByTestId('mcp-server-cancel').click();

  const artifacts = path.resolve(__dirname, '..', '..', 'renderer', '.praxis', 'session-artifacts');
  fs.mkdirSync(artifacts, { recursive: true });
  await win.getByTestId('mcp-servers').screenshot({ path: path.join(artifacts, 'mcp-servers-settings.png') });

  await row.locator('[data-testid^="mcp-server-toggle-"]').click();
  await expect.poll(async () => win.evaluate(async () => (await window.praxis.settings.get()).ai.mcpServers?.[0].enabled)).toBe(false);

  await row.locator('[data-testid^="mcp-server-remove-"]').click();
  await win.getByRole('dialog').last().getByRole('button', { name: 'Remove', exact: true }).click();
  await expect(win.locator('[data-testid^="mcp-server-row-"]')).toHaveCount(0);
  expect(await win.evaluate(async () => (await window.praxis.settings.get()).ai.mcpServers)).toBeUndefined();
});
