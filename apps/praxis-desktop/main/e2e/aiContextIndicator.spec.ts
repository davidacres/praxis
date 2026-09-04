// The context indicator, driven end to end through the real stack: a mock
// gateway reports usage the way a provider does (a final chunk with no
// `choices`), and publishes a `context_length` on `/v1/models`. Everything
// between — the wire parser, the loop's usage event, the session manager, the
// inspector — is the shipping code.
//
// The point of the feature is that a user finds out *before* a turn is rejected
// for being too large, so these assert what they are actually shown.

import { expect, test } from '@playwright/test';
import { closeTestApp, launchTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_OIDC_TOKEN: undefined
};

/** A model with a small window, so a plausible prompt size crosses a threshold. */
const MODEL = { id: 'mock/model', name: 'Mock Model', context_length: 100_000 };

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

async function runSession(promptTokens: number): Promise<TestApp['window']> {
  mock = await startMockGatewayServer({
    mode: 'complete',
    models: [MODEL],
    usage: { prompt_tokens: promptTokens, completion_tokens: 400 }
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  const session = await win.evaluate(
    async ({ cwd, model }) => window.praxis.ai.delegate({
      goal: 'Summarise the repository layout.',
      model,
      workingDirectory: cwd,
      toolMode: 'read-only',
      task: { goal: 'Summarise the repository layout.', maxSteps: 2, timeoutMs: 30000 }
    }),
    { cwd: process.cwd(), model: MODEL.id }
  );

  await expect
    .poll(() => win.evaluate(
      k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.state),
      session.issueKey
    ), { timeout: 20000 })
    .toBe('completed');

  // The context limit is fetched from /v1/models in the background.
  await expect
    .poll(() => win.evaluate(
      k => window.praxis.ai.listSessions().then(l => l.find(s => s.issueKey === k)?.contextLimit),
      session.issueKey
    ), { timeout: 10000 })
    .toBe(MODEL.context_length);

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.locator('[data-testid="session-list-row"]').first().click();
  return win;
}

test('a comfortable context says nothing at all', async () => {
  // 20% full. A mostly-empty window is not news, and a bar that is always on
  // screen is a bar nobody reads.
  const win = await runSession(20_000);

  await expect(win.getByTestId('session-tokens')).toBeVisible();
  await expect(win.getByTestId('session-context')).toHaveCount(0);
});

test('the runtime facts sit on the composer as chips, not tucked in a side panel', async () => {
  // A quiet context — the point here is what the composer shows regardless of
  // context pressure: what started this session, read back where you type.
  const win = await runSession(20_000);

  const chips = win.locator('.composer-controls');
  await expect(chips.getByTestId('session-provider')).toContainText('Vercel AI Gateway');
  await expect(chips.getByTestId('session-model')).toContainText(MODEL.id);
  await expect(chips.getByTestId('session-tool-mode')).toContainText('Read only');
  await expect(chips.getByTestId('session-working-directory')).toBeVisible();
  await win.screenshot({ path: 'output/playwright/composer-runtime-chips.png', fullPage: true });
});

test('a filling context warns, and says what is causing it', async () => {
  const win = await runSession(72_000);

  const context = win.getByTestId('session-context');
  await expect(context).toBeVisible();
  await expect(context.getByTestId('session-context-figure')).toHaveText('72% of 100k context used');
  await expect(context).toContainText('filling the model’s window');
  // The bar is a real progressbar, so screen readers get the number too.
  await expect(context.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '72');

  // Not smaller than the rest of the composer it sits above. The paragraph
  // shipped at 11px once already — below the chat message body (12px) and
  // AGENTS.md's own reading floor — because --text-xs is a label size, and a
  // full sentence someone has to read is not a label.
  const sizes = await win.evaluate(() => ({
    heading: getComputedStyle(document.querySelector('.composer-context-heading')!).fontSize,
    paragraph: getComputedStyle(document.querySelector('.composer-context-banner p')!).fontSize,
    chip: getComputedStyle(document.querySelector('.session-runtime-chip')!).fontSize,
    chatMessage: getComputedStyle(document.querySelector('.session-chat-message')!).fontSize
  }));
  expect(sizes.heading).toBe(sizes.chip);
  expect(sizes.paragraph).toBe(sizes.chatMessage);

  await win.screenshot({ path: 'output/playwright/context-indicator-warn.png', fullPage: true });
});

test('a nearly-full context escalates and tells the user what to do', async () => {
  const win = await runSession(92_000);

  const context = win.getByTestId('session-context');
  await expect(context.getByTestId('session-context-figure')).toHaveText('92% of 100k context used');
  // Not just a redder bar — the advice changes to the action that resolves it.
  await expect(context).toContainText('may not fit');
  await expect(context).toContainText('Start a fresh session');

  // Critical is visually distinct, and specifically uses the danger tone rather
  // than the warning one — so the escalation is visible, not just wordier.
  const colours = await context.evaluate(element => {
    const probe = (value: string) => {
      const span = document.createElement('span');
      span.style.color = value;
      document.body.appendChild(span);
      const resolved = getComputedStyle(span).color;
      span.remove();
      return resolved;
    };
    const root = getComputedStyle(document.documentElement);
    return {
      figure: getComputedStyle(element.querySelector('[data-testid="session-context-figure"]')!).color,
      fill: getComputedStyle(element.querySelector('.session-context-bar > span')!).backgroundColor,
      danger: probe(root.getPropertyValue('--danger').trim()),
      warning: probe(root.getPropertyValue('--warning').trim())
    };
  });
  expect(colours.figure).toBe(colours.danger);
  expect(colours.fill).toBe(colours.danger);
  expect(colours.figure).not.toBe(colours.warning);

  await win.screenshot({ path: 'output/playwright/context-indicator-critical.png', fullPage: true });
});
