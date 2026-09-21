// A per-session cost/token figure has existed for a while (the composer's
// spend-limit banner, `summariseSpend`), but nothing ever showed a total: the
// only place spend appeared was a warning once a limit was nearly hit. This
// drives the Settings → AI Provider spend report end to end — real cost from
// a real ACP session, real tokens from a real gateway session, grouped by
// provider/model and by connection, with the two kinds of session never
// blended into one invented number.

import * as path from 'node:path';
import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

const FIXTURE_PATH = path.join(__dirname, 'fixtures', 'fakeAcpAgent.mjs');
const MODEL = { id: 'mock/model', name: 'Mock Model', context_length: 100_000 };

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_OIDC_TOKEN: undefined
};

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

async function waitCompleted(win: TestApp['window'], issueKey: string): Promise<void> {
  await expect
    .poll(() => win.evaluate(k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state), issueKey), {
      timeout: 20000
    })
    .toBe('completed');
}

async function openAiProviderSettings(win: TestApp['window']): Promise<void> {
  await win.keyboard.press('ControlOrMeta+k');
  const palette = win.getByRole('dialog', { name: 'Go to' });
  await palette.getByRole('textbox').fill('ai provider');
  await palette.getByRole('option', { name: /AI Provider/ }).first().click();
  await expect(win.getByRole('dialog', { name: 'Settings' })).toBeVisible();
  await win.getByTestId('ai-tab-spend').click();
  await expect(win.getByTestId('ai-spend-report')).toBeVisible();
}

test('totals real ACP cost and real gateway tokens, never blended, grouped by provider and connection', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    models: [MODEL],
    usage: { prompt_tokens: 5000, completion_tokens: 1200 }
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  // One ACP session reporting a real cost (fakeAcpAgent's WITH_USAGE marker).
  await win.evaluate(
    p => window.praxis.settings.set({ ai: { providers: { 'claude-code-cli': { cliPath: p } } } }),
    FIXTURE_PATH
  );
  const acpSession = await win.evaluate(
    async () => window.praxis.ai.delegate({
      provider: 'claude-code-cli',
      goal: 'WITH_USAGE please',
      toolMode: 'read-only',
      task: { goal: 'WITH_USAGE please', maxSteps: 2, timeoutMs: 30000 }
    })
  );
  await waitCompleted(win, acpSession.issueKey);

  // One gateway session reporting real tokens, no cost — the provider this
  // app has no price table for.
  const gatewaySession = await win.evaluate(
    async ({ cwd, model }) => window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      model,
      goal: 'Summarise the repository layout.',
      workingDirectory: cwd,
      toolMode: 'read-only',
      task: { goal: 'Summarise the repository layout.', maxSteps: 2, timeoutMs: 30000 }
    }),
    { cwd: process.cwd(), model: MODEL.id }
  );
  await waitCompleted(win, gatewaySession.issueKey);

  await openAiProviderSettings(win);

  // Total cost: only the ACP session's $0.42 counts — the gateway session
  // contributed no cost, and nothing here invents one from its tokens.
  await expect(win.getByTestId('ai-spend-total-cost')).toContainText('0.42');

  const providerRows = win.getByTestId('ai-spend-provider-row');
  const claudeRow = providerRows.filter({ hasText: 'Claude Code' });
  await expect(claudeRow).toContainText('1 session');
  await expect(claudeRow).toContainText('0.42');
  await expect(claudeRow).not.toContainText('tokens');

  const gatewayRow = providerRows.filter({ hasText: 'Vercel AI Gateway' });
  await expect(gatewayRow).toContainText('1 session');
  await expect(gatewayRow).toContainText('6.2k tokens');
  // Loosely: Intl renders currency differently by locale ("$0.42" vs
  // "US$0.42"), so assert the absence of the currency symbol pattern instead
  // of a literal string — the point is no cost line at all on this row.
  await expect(gatewayRow).not.toContainText('$0.42');

  // Neither delegate call passed a connectionId (both are free-form New
  // Session runs), so both fall into the demo bucket together.
  const demoRow = win.getByTestId('ai-spend-connection-row').filter({ hasText: 'Demo' });
  await expect(demoRow).toContainText('2 sessions');

  await win.getByTestId('ai-spend-report').scrollIntoViewIfNeeded();
  await win.screenshot({ path: 'output/playwright/ai-spend-report.png' });
});

test('a range with no sessions shows the empty state, not an empty report', async () => {
  app = await launchTestApp();
  const win = app.window;
  await openAiProviderSettings(win);
  await expect(win.getByText('No sessions in this range.')).toBeVisible();
});
