import * as fs from 'node:fs';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { openSession } from './sessionNavigation';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * Visual verification for the unified reasoning widget (`renderer/src/ui/ThoughtBlock.tsx`).
 *
 * The chat pane used to render the same reasoning string with five different
 * widgets, two labels ("Thought"/"Thoughts") and two default-open behaviours,
 * so identical content looked different depending on surface — and a live turn
 * visibly collapsed and moved a DOM level deeper the instant it settled.
 * See `docs/research/model-reasoning-response-shapes.md` §5/§F2 and its §8.
 *
 * These tests drive the real renderer against the in-process gateway mock, so
 * the screenshots are the shipped UI rather than a fixture. Reasoning is
 * streamed as OpenAI-compatible `delta.reasoning_content`, which is exactly the
 * field `core/src/ai/gateway/wire.ts` reads to yield `thought_delta`.
 *
 * Evidence lands in `.praxis/session-artifacts/thought-display/`.
 */

const ARTIFACTS = path.resolve(__dirname, '../../.praxis/session-artifacts/thought-display');

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined
} as const;

/** Reasoning streamed in pieces, so a live turn can be caught mid-accumulation. */
const REASONING = [
  'First I need to find which component renders the session summary. ',
  'The summary pane is fed by SessionInspector, so I should read that next. ',
  'That confirms the caption is built once per turn, not per round trip.'
];

/** The three fragments above, joined exactly as the stream concatenates them. */
const REASONING_TEXT = REASONING.join('');

const REPLY = 'Here is the reasoning-display verification summary.';

let app: TestApp | undefined;
let mock: MockGatewayServer | undefined;

test.beforeAll(() => {
  fs.mkdirSync(ARTIFACTS, { recursive: true });
});

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

interface DelegateInput {
  provider: string;
  permissionMode: string;
  model?: string;
  reasoningEffort?: 'off' | 'low' | 'medium' | 'high';
  task: { goal: string };
}

/** Delegate a free-form session and return its key, typing only what we send. */
async function delegate(
  win: TestApp['window'],
  input: DelegateInput
): Promise<string> {
  return win.evaluate(
    async payload => {
      const w = window as unknown as {
        praxis: { ai: { delegate: (input: unknown) => Promise<{ issueKey?: string }> } };
      };
      const result = await w.praxis.ai.delegate(payload);
      if (!result.issueKey) throw new Error('delegate returned no issueKey');
      return result.issueKey;
    },
    { ...input, permissionMode: 'auto' }
  );
}

/**
 * Wait until the live turn's thought block is on screen.
 *
 * Waits on the widget rather than a session state: `holdCompletion` parks the
 * first request, so the turn is still `planning` when its reasoning arrives,
 * and `isTurnActive` (SessionsPage.tsx) treats planning as a live turn. Pinning
 * to `executing` would therefore never match.
 */
async function waitForLiveThought(win: TestApp['window']): Promise<void> {
  await expect(win.locator('[data-testid="session-thought-disclosure"]')).toBeVisible({
    timeout: 25000
  });
}

/**
 * One turn that streams reasoning, captured open while live and collapsed once
 * settled. The two shots must show the same widget with the same label — that
 * is the regression guard for the streaming/settled jolt.
 */
test('reasoning streams open and settles into the same widget', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    reasoning: REASONING,
    reply: REPLY,
    // `completion_tokens_details.reasoning_tokens` is the OpenAI-compatible
    // spelling `gateway/wire.ts` reads, so the telemetry tooltip can show how
    // many of the output tokens were internal reasoning.
    usage: { prompt_tokens: 900, completion_tokens: 210, completion_tokens_details: { reasoning_tokens: 84 } },
    // Hold `[DONE]` so the live turn is observable rather than flashing past.
    holdCompletion: true
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-thought-display-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  const issueKey = await delegate(win, {
    provider: 'vercel-gateway',
    permissionMode: 'auto',
    task: { goal: 'Verify the unified reasoning display.' }
  });

  await openSession(win, issueKey);
  await waitForLiveThought(win);

  // The live turn shows reasoning in the streaming widget, open by default.
  const liveBlock = win.locator('[data-testid="session-thought-disclosure"]');
  await expect(liveBlock).toHaveAttribute('open', '');
  await expect(liveBlock.locator('[data-testid="session-thought-summary"]')).toContainText('Thought');
  const liveMarkdown = win.locator('[data-testid="session-thought-markdown"]');
  await expect(liveMarkdown.first()).toContainText(REASONING[0]);

  // Evidence: reasoning mid-stream, block open, label "Thought".
  await win.locator('[data-testid="session-chat-thread"]').screenshot({
    path: path.join(ARTIFACTS, '01-streaming-open.png')
  });
  await liveBlock.screenshot({ path: path.join(ARTIFACTS, '02-streaming-block.png') });

  // Prove every streamed piece accumulated rather than being replaced.
  await expect(liveMarkdown.first()).toContainText(REASONING_TEXT);

  mock.releaseCompletion();
  await expect(win.getByTestId('session-state-badge')).toHaveText('Completed', { timeout: 20000 });

  // Settled: same widget, same label, now collapsed — no DOM-level move, no
  // relabelling to "Thoughts".
  const settledBlock = win.locator('[data-testid="session-thought-disclosure"]');
  await expect(settledBlock).toHaveCount(1);
  await expect(settledBlock).not.toHaveAttribute('open', '');
  await expect(settledBlock.locator('[data-testid="session-thought-summary"]')).toContainText('Thought');
  await expect(settledBlock.locator('[data-testid="session-thought-summary"]')).not.toContainText('Thoughts');
  // No stray "Thoughts" widget anywhere in the thread.
  await expect(win.locator('[data-testid="session-chat-thread"]')).not.toContainText('Thoughts');

  await win.locator('[data-testid="session-chat-thread"]').screenshot({
    path: path.join(ARTIFACTS, '03-settled-collapsed.png')
  });

  // Expanding the settled block reveals the reasoning behind one nested
  // expander, identical in structure to the streaming content above.
  await settledBlock.locator('[data-testid="session-thought-summary"]').click();
  await expect(settledBlock.locator('[data-testid="session-thought-reasoning"]')).toBeVisible();
  await settledBlock.locator('[data-testid="session-thought-reasoning"] summary').click();
  const settledMarkdown = settledBlock.locator('[data-testid="session-thought-markdown"]');
  await expect(settledMarkdown.first()).toContainText(REASONING_TEXT);
  await win.locator('[data-testid="session-chat-thread"]').screenshot({
    path: path.join(ARTIFACTS, '04-settled-expanded.png')
  });
  await settledBlock.screenshot({ path: path.join(ARTIFACTS, '05-settled-reasoning.png') });

  // The reasoning-token count parsed from the usage chunk reaches the
  // telemetry tooltip — the only evidence of thinking for a route whose text
  // never arrives, and exactly what used to be dropped.
  await expect(win.locator('.session-chat-telemetry-bar [title*="reasoning"]')).toHaveCount(1);

  // The transcript still carries the reply, and the reasoning never leaked
  // into it as body text.
  await expect(win.locator('[data-testid="session-chat-assistant"]').first()).toContainText(REPLY);
});

/**
 * GPT-6 over OpenAI's own HTTP API keeps reasoning items opaque: no text ever
 * arrives. That is a normal outcome, not a failure, so the live block says why
 * instead of rendering a blank — the first-class empty state from §7.
 */
test('a route that cannot return reasoning says so instead of blanking', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    reply: REPLY,
    holdCompletion: true
  });
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;

  // Point `openai` at the mock exactly as the Settings UI does.
  await win.evaluate(async baseUrl => {
    const w = window as unknown as {
      praxis: {
        settings: { set: (patch: { ai: { providers: Record<string, { baseUrl: string }> } }) => Promise<unknown> };
        ai: { setProviderApiKey: (provider: string, value: string) => Promise<unknown> };
      };
    };
    await w.praxis.settings.set({ ai: { providers: { openai: { baseUrl } } } });
    await w.praxis.ai.setProviderApiKey('openai', 'e2e-opaque-key');
  }, mock.baseUrl);

  const issueKey = await delegate(win, {
    provider: 'openai',
    permissionMode: 'auto',
    model: 'gpt-6-luna',
    task: { goal: 'Verify the opaque-reasoning empty state.' }
  });

  await openSession(win, issueKey);
  await waitForLiveThought(win);

  // The host stamped the record `opaque` because provider=openai and the id is
  // an OpenAI reasoning family — neither is inferable from the model name
  // alone, since `codex-cli` would return text for this same id.
  await expect
    .poll(
      async () =>
        win.evaluate(async key => {
          const w = window as unknown as {
            praxis: {
              ai: {
                listSessions: () => Promise<Array<{ issueKey: string; reasoningAvailability?: string }>>;
              };
            };
          };
          return (await w.praxis.ai.listSessions()).find(s => s.issueKey === key)?.reasoningAvailability;
        }, issueKey),
      { timeout: 15000 }
    )
    .toBe('opaque');

  const empty = win.locator('[data-testid="session-thought-none"]');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('doesn’t return reasoning text');

  await win.locator('[data-testid="session-chat-thread"]').screenshot({
    path: path.join(ARTIFACTS, '06-empty-opaque.png')
  });

  mock.releaseCompletion();
  await expect(win.getByTestId('session-state-badge')).toHaveText('Completed', { timeout: 20000 });

  // Settled history stays uncluttered: an empty block is a live-turn affordance
  // only, so it does not persist as a permanent "nothing here" row.
  await expect(win.locator('[data-testid="session-thought-none"]')).toHaveCount(0);
  await win.locator('[data-testid="session-chat-thread"]').screenshot({
    path: path.join(ARTIFACTS, '07-empty-opaque-settled.png')
  });
});

/**
 * `reasoningEffort: 'off'` is an explicit opt-out, distinct from a route that
 * cannot deliver. The copy must say reasoning was not requested, so the user
 * is not told their model is broken when they turned it off themselves.
 */
test('a turn with reasoning turned off says it was not requested', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    reply: REPLY,
    holdCompletion: true
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-off-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  const issueKey = await delegate(win, {
    provider: 'vercel-gateway',
    permissionMode: 'auto',
    reasoningEffort: 'off',
    task: { goal: 'Verify the not-requested empty state.' }
  });

  await openSession(win, issueKey);
  await waitForLiveThought(win);

  const empty = win.locator('[data-testid="session-thought-none"]');
  await expect(empty).toBeVisible();
  await expect(empty).toContainText('wasn’t requested');
  // Wording must not be the route-based one — the two cases are not conflated.
  await expect(empty).not.toContainText('doesn’t return reasoning text');

  await win.locator('[data-testid="session-chat-thread"]').screenshot({
    path: path.join(ARTIFACTS, '08-empty-not-requested.png')
  });

  // Nothing asked for reasoning, so no reasoning parameter went on the wire.
  const body = JSON.parse(mock.requests[0]!.body) as { reasoning_effort?: string };
  expect(body.reasoning_effort).toBeUndefined();

  mock.releaseCompletion();
  await expect(win.getByTestId('session-state-badge')).toHaveText('Completed', { timeout: 20000 });
});
