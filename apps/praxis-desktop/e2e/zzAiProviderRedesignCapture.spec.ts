import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, type Page } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockAnthropicServer, type MockAnthropicServer } from './mockAnthropicServer';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { startMockOpenAiCompatibleServer, type MockOpenAiCompatibleServer } from './mockOpenAiCompatibleServer';

// Throwaway: renders the implemented AI Providers screens in the states the mockups show, for a side-by-side review.
const out = path.join(__dirname, '..', '..', '.praxis', 'session-artifacts', 'ai-provider-redesign', 'implemented');
let app: TestApp | undefined;
let anthropic: MockAnthropicServer | undefined;
let gateway: MockGatewayServer | undefined;
let chatOnly: MockOpenAiCompatibleServer | undefined;
let lmStudio: MockOpenAiCompatibleServer | undefined;
let fixtureDir: string | undefined;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  for (const server of [anthropic, gateway, chatOnly, lmStudio]) if (server) await server.close();
  if (fixtureDir) fs.rmSync(fixtureDir, { recursive: true, force: true });
  app = undefined;
});

async function shot(win: Page, name: string) {
  fs.mkdirSync(out, { recursive: true });
  await win.waitForTimeout(500);
  await win.screenshot({ path: path.join(out, `${name}.png`) });
}

test.skip('capture implemented AI provider screens', async () => {
  test.setTimeout(180000);
  anthropic = await startMockAnthropicServer({ mode: 'complete', models: [
    { id: 'claude-opus-5', display_name: 'Claude Opus 5' },
    { id: 'claude-sonnet-5', display_name: 'Claude Sonnet 5' },
    { id: 'claude-haiku-5', display_name: 'Claude Haiku 5' }
  ] });
  gateway = await startMockGatewayServer({ mode: 'complete', models: [
    { id: 'anthropic/claude-opus-5', name: 'Claude Opus 5', context_length: 1000000 },
    { id: 'anthropic/claude-sonnet-5', name: 'Claude Sonnet 5', context_length: 1000000 },
    { id: 'anthropic/claude-haiku-5', name: 'Claude Haiku 5', context_length: 200000 },
    { id: 'openai/gpt-5.6', name: 'GPT-5.6', context_length: 400000 },
    { id: 'openai/gpt-5.6-mini', name: 'GPT-5.6 mini', context_length: 400000 },
    { id: 'google/gemini-3-pro', name: 'Gemini 3 Pro', context_length: 1000000 },
    { id: 'xai/grok-5', name: 'Grok 5', context_length: 256000 }
  ] });
  chatOnly = await startMockOpenAiCompatibleServer({ tools: false, models: ['qwen3:14b', 'llama3.3:70b'] });
  lmStudio = await startMockOpenAiCompatibleServer({ models: ['qwen3-coder-30b', 'gemma-3-27b', 'mistral-small'] });
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-aip-capture-'));
  const fixture = path.join(fixtureDir, 'claude-agent-acp');
  fs.writeFileSync(fixture, '#!/bin/sh\nprintf "0.9.2\\n"\n', { mode: 0o755 });
  const cursorFixture = path.join(fixtureDir, 'agent');
  fs.writeFileSync(cursorFixture, '#!/bin/sh\nprintf "1.4.0\\n"\n', { mode: 0o755 });

  app = await launchTestApp({
    ai: {
      activeProvider: 'anthropic',
      agentName: 'Praxis Agent',
      analysisPrompt: 'You are a senior engineer assessing implementation readiness. For the issue below, list missing acceptance criteria, risky assumptions, affected areas and a rough size. Ask at most three questions.',
      modelTiers: {
        anthropic: { fast: 'claude-haiku-5', standard: 'claude-sonnet-5', strong: 'claude-opus-5' },
        'vercel-gateway': { standard: 'anthropic/claude-sonnet-5' }
      },
      providers: {
        anthropic: { baseUrl: anthropic.baseUrl, defaultModel: 'claude-sonnet-5' },
        openai: { added: true, baseUrl: 'http://127.0.0.1:9' },
        'claude-code-cli': { cliPath: fixture },
        'codex-cli': { added: true, cliPath: '/nonexistent/codex-acp' },
        'cursor-cli': { cliPath: cursorFixture, enabled: false }
      },
      customProviders: [{
        id: 'custom:ollama', label: 'Ollama', presetId: 'ollama', protocol: 'openai-chat', baseUrl: chatOnly.baseUrl, apiPath: '/v1', auth: { kind: 'none' },
        capabilities: { models: true, chat: true, streaming: true, streamUsage: true, tools: false, model: 'qwen3:14b', probedAt: new Date().toISOString() }
      }],
      browserTools: { enabled: true, allowedHosts: ['docs.github.com', 'developer.mozilla.org', 'playwright.dev'] },
      mcpServers: [
        { id: 'github', name: 'github', enabled: true, transport: 'stdio', command: 'npx', args: ['-y', '@modelcontextprotocol/server-github'], env: { GITHUB_TOKEN: 'x' }, requireApproval: true },
        { id: 'linear', name: 'linear', enabled: true, transport: 'http', url: 'https://mcp.linear.app/mcp', requireApproval: true },
        { id: 'playwright', name: 'playwright', enabled: false, transport: 'stdio', command: 'npx', args: ['@playwright/mcp@latest', '--headless'], requireApproval: true }
      ]
    }
  }, undefined, {
    AI_GATEWAY_API_KEY: 'gateway-e2e-key',
    AI_GATEWAY_URL: gateway.baseUrl,
    PRAXIS_LOCAL_RUNTIME_ORIGINS: JSON.stringify({ 'lm-studio': lmStudio.baseUrl })
  });
  const win = app.window;
  await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  await win.waitForSelector('[data-testid="new-session-view"]');
  await win.evaluate(async () => { await window.praxis.ai.setProviderApiKey('anthropic', 'e2e-anthropic-key'); });
  await win.reload();
  await win.waitForSelector('[data-testid="new-session-view"]');

  await win.getByTestId('titlebar-settings').click();
  await win.getByTestId('settings-nav-ai').click();
  await win.getByTestId('ai-provider-list').waitFor();
  await win.waitForTimeout(1500);
  await shot(win, '01-providers');

  await win.getByTestId('ai-provider-row-openai').locator('.ai-provider-head').click();
  await shot(win, '02b-connect-api-start');

  await win.getByTestId('ai-provider-row-claude-code-cli').locator('.ai-provider-head').click();
  await win.waitForTimeout(1500);
  await shot(win, '03-local-agent');

  await win.getByTestId('ai-provider-row-codex-cli').locator('.ai-provider-head').click();
  await shot(win, '04-local-agent-missing');

  await win.getByTestId('ai-add-provider').click();
  await win.waitForTimeout(1500);
  await shot(win, '05-add-provider');

  await win.getByTestId('add-provider-detected-lm-studio').click();
  await win.getByTestId('custom-endpoint-probe').waitFor({ timeout: 15000 }).catch(() => undefined);
  await shot(win, '06-custom-endpoint');
  await win.getByTestId('add-provider-dialog').getByRole('button', { name: 'Close' }).click();

  await win.getByTestId('ai-provider-row-custom:ollama').locator('.ai-provider-head').click();
  await shot(win, '06b-chat-only-endpoint');
  await win.getByTestId('ai-provider-edit-custom:ollama').click();
  await win.getByTestId('custom-endpoint-test').click();
  await win.getByTestId('custom-endpoint-probe').waitFor({ timeout: 15000 }).catch(() => undefined);
  await shot(win, '06c-endpoint-chat-only-test');
  await win.getByTestId('add-provider-dialog').getByRole('button', { name: 'Close' }).click();

  await win.getByTestId('ai-provider-row-vercel-gateway').locator('.ai-provider-head').click();
  await win.getByTestId('ai-manage-models-btn').click();
  await win.getByTestId('model-manager-list').waitFor({ timeout: 10000 }).catch(() => undefined);
  await win.getByTestId('model-manager-checkbox-xai/grok-5').click().catch(() => undefined);
  await shot(win, '07-models');
  await win.getByTestId('model-manager-back').click();

  await win.getByTestId('ai-tab-routing').click();
  await win.waitForTimeout(800);
  await shot(win, '08-routing');
  await win.getByTestId('ai-tab-behaviour').click();
  await shot(win, '09-behaviour');
  await win.getByTestId('ai-tab-tools').click();
  await shot(win, '10-tools');

  await win.getByTestId('ai-tab-providers').click();
  await win.getByTestId('ai-provider-row-anthropic').locator('.ai-provider-head').click();
  await win.getByTestId('ai-provider-remove-anthropic').click();
  await shot(win, '11-remove');
});

test('capture implemented first-run wizard', async () => {
  fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-aip-wizard-'));
  const fixture = path.join(fixtureDir, 'claude-agent-acp');
  fs.writeFileSync(fixture, '#!/bin/sh\nprintf "0.9.2\\n"\n', { mode: 0o755 });
  const missing = (name: string) => ({ cliPath: `/nonexistent/${name}` });
  app = await launchTestApp({
    ai: { providers: { 'claude-code-cli': missing('claude'), 'codex-cli': missing('codex'), 'copilot-cli': missing('copilot'), 'antigravity-cli': missing('agy'), 'cursor-cli': missing('agent') } }
  }, undefined, { AI_GATEWAY_API_KEY: undefined, VERCEL_OIDC_TOKEN: undefined, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, { workspace: false, aiOnboarding: true });
  const win = app.window;
  await win.getByTestId('ai-setup-wizard').waitFor({ timeout: 20000 });
  await app.electronApp.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]!.setContentSize(1440, 900));
  await win.waitForTimeout(1500);
  await win.getByTestId('ai-setup-choice-anthropic').click().catch(() => undefined);
  await shot(win, '12-setup-wizard');
});
