import { openSession } from './sessionNavigation';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { buildGadgetFenceMessage } from '@praxis/core';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * A single agent turn that calls several tools, narrating between each call —
 * the shape that used to render as one chat card per model round trip. Proves
 * the transcript now shows one assistant card per turn, that the narration
 * between tool calls lands in the thought block rather than the transcript, and
 * that the thought block counts and lists every call.
 */

const NO_GATEWAY_ENV = {
  AI_GATEWAY_API_KEY: undefined,
  VERCEL_OIDC_TOKEN: undefined,
  FROSTY_VERCEL_API_KEY: undefined,
  AI_GATEWAY_URL: undefined,
  VERCEL_AI_GATEWAY_URL: undefined,
  FROSTY_VERCEL_URL: undefined
} as const;

/** One unpunctuated, first-person, single-clause narration per tool call. */
const NARRATION = [
  'Let me check the sessions header',
  'SessionInspector is the details pane',
  'Now let me see what feeds it',
  'Finally let me confirm the styles'
];

const FINAL_REPLY = 'Here is the summary you asked for, with the findings in order.';

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

test('a turn that narrates between tool calls renders as one assistant card', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    usage: { prompt_tokens: 1200, completion_tokens: 300 },
    roundTrips: NARRATION.map(content => ({
      content,
      toolCalls: [{ name: 'read_file', arguments: { path: 'a.ts' } }]
    })),
    reply: FINAL_REPLY
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-thought-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  const session = await win.evaluate(async () => window.praxis.ai.delegate({
    provider: 'vercel-gateway',
    permissionMode: 'auto',
    task: { goal: 'Review the details pane summary.' }
  }));

  await openSession(win);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 20000 });

  // The agent really did take four tool round trips.
  await expect.poll(() => mock!.requests.length).toBeGreaterThanOrEqual(NARRATION.length + 1);

  const cards = win.locator('[data-testid="session-chat-assistant"]');
  // One card for the whole turn — this is the regression guard. Before the
  // grouping, each narration plus the final reply rendered separately.
  await expect(cards).toHaveCount(1);

  const card = cards.first();
  await expect(card).toContainText(FINAL_REPLY);
  // Narration belongs to the thought block, not the transcript.
    const thought = card.locator('[data-testid="session-thought-disclosure"]');
  await expect(thought).toHaveCount(1);
  await expect(thought).not.toHaveAttribute('open', '');

  // The caption counts calls, not distinct tool names: four `read_file` calls
  // are four calls.
  await expect(thought.locator('[data-testid="session-thought-summary"]')).toContainText('4 tool calls');

  await thought.locator('summary').click();
  const toolRows = thought.locator('[data-testid="session-thought-tools"] li');
  await expect(toolRows).toHaveCount(4);
  await expect(toolRows.first()).toContainText('read_file');
  for (const line of NARRATION) await expect(thought).toContainText(line);

  // The caption already carries duration and tool calls, so the telemetry bar
  // does not repeat them.
  await expect(card.locator('.session-chat-telemetry-bar')).not.toContainText('tool call');

  // Exactly one telemetry bar for the turn, not one per round trip.
  await expect(card.locator('.session-chat-telemetry-bar')).toHaveCount(1);
  await expect(card.locator('.session-chat-telemetry-bar')).toContainText('tok');

  // The details pane names an untitled session once, not twice: the title is
  // just the goal's first line, so printing both repeated the same words.
  await expect(win.locator('[data-testid="session-purpose-title"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-purpose-goal"]')).toHaveCount(1);
  await expect(win.locator('[data-testid="session-purpose-goal"]')).toContainText('Review the details pane summary.');

  // Evidence, kept alongside the other session artifacts.
  const artifactDir = path.join(__dirname, '..', '..', 'renderer', '.praxis', 'session-artifacts');
  fs.mkdirSync(artifactDir, { recursive: true });
  await card.screenshot({
    path: path.join(artifactDir, 'turn-merged-single-card.png')
  });
  await win.locator('[data-testid="session-panel-summary"]').screenshot({
    path: path.join(artifactDir, 'turn-inspector-summary.png')
  });
  await win.locator('[data-testid="session-chat-thread"]').screenshot({
    path: path.join(artifactDir, 'turn-merged-thread.png')
  });

  // A brief field holding a whole reply stops at a few lines and expands on
  // request, rather than stretching the Summary tab.
  const longProgress = Array.from({ length: 12 }, (_, i) => `Finding ${i + 1}: the details pane repeated itself.`).join('\n');
  await win.locator('[data-testid="session-brief-edit"]').click();
  await win.locator('textarea[data-testid="session-brief-progress"]').fill(longProgress);
  await win.locator('[data-testid="session-brief-save"]').click();
  const progress = win.locator('p[data-testid="session-brief-progress"]');
  await expect(progress).toHaveClass(/is-clamped/);
  const clampedHeight = (await progress.boundingBox())!.height;
  await win.getByRole('button', { name: 'Show more' }).click();
  await expect(progress).not.toHaveClass(/is-clamped/);
  expect((await progress.boundingBox())!.height).toBeGreaterThan(clampedHeight * 1.5);
  await win.getByRole('button', { name: 'Show less' }).click();
  await expect(progress).toHaveClass(/is-clamped/);

  await win.evaluate(key => window.praxis.ai.abort(key), session.issueKey).catch(() => undefined);
});

// A 1x1 PNG, so the file is a real image rather than text with a .png name.
const TINY_PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

test('an image read by a tool reaches the model on the next round trip', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    roundTrips: [{ content: 'Let me look at the screenshot', toolCalls: [{ name: 'read_image', arguments: { path: 'shot.png' } }] }],
    reply: 'I can see a single pixel.'
  });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-readimage-'));
  fs.writeFileSync(path.join(workDir, 'shot.png'), Buffer.from(TINY_PNG_BASE64, 'base64'));
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-image-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  await win.evaluate(async workingDirectory => window.praxis.ai.delegate({
    provider: 'vercel-gateway',
    toolMode: 'full',
    permissionMode: 'auto',
    workingDirectory,
    task: { goal: 'Look at shot.png.' }
  }), workDir);

  await openSession(win);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 20000 });
  await expect.poll(() => mock!.requests.length).toBeGreaterThanOrEqual(2);

  // The first request has no image; the follow-up after the tool ran must.
  expect(mock.requests[0].body).not.toContain('image_url');
  const followUp = mock.requests[1].body;
  expect(followUp).toContain('image_url');
  expect(followUp).toContain('data:image/png;base64,');
  fs.rmSync(workDir, { recursive: true, force: true });
});

// Each model call is billed once, so a turn's tokens are the sum of its calls —
// never that sum added up again per card. The card, the session total and (when
// the provider reports it) the wire figures must all agree.
for (const reportsUsage of [true, false]) {
  test(`a multi-round-trip turn counts tokens once (provider ${reportsUsage ? 'reports' : 'omits'} usage)`, async () => {
    mock = await startMockGatewayServer({
      mode: 'complete',
      ...(reportsUsage ? { usage: { prompt_tokens: 1200, completion_tokens: 300 } } : {}),
      roundTrips: NARRATION.slice(0, 3).map(content => ({
        content,
        toolCalls: [{ name: 'read_file', arguments: { path: 'a.ts' } }]
      })),
      reply: FINAL_REPLY
    });
    app = await launchTestApp(undefined, undefined, {
      ...NO_GATEWAY_ENV,
      AI_GATEWAY_API_KEY: 'e2e-token-key',
      AI_GATEWAY_URL: mock.baseUrl
    });
    const win = app.window;
    await win.evaluate(async () => window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      permissionMode: 'auto',
      task: { goal: 'Review the details pane summary.' }
    }));
    await openSession(win);
    await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 20000 });

    const session = await win.evaluate(async () => {
      const [record] = await window.praxis.ai.listSessions();
      return { total: record.tokenUsage?.totalTokens, perMessage: record.events.filter(e => e.type === 'message').map(e => e.tokenUsage?.totalTokens) };
    });
    // Running totals only ever grow, and the last one is the session's total.
    expect(session.perMessage).toEqual([...session.perMessage].sort((a, b) => (a ?? 0) - (b ?? 0)));
    expect(session.perMessage[session.perMessage.length - 1]).toBe(session.total);
    if (reportsUsage) expect(session.total).toBe(mock.requests.length * 1500);

    const chip = win.locator('[data-testid="session-chat-assistant"] .session-telemetry-chip', { hasText: 'tok' });
    await expect(chip).toHaveText(`${session.total!.toLocaleString()} tok`);
  });
}

// A gadget rides on the message that carried it. A turn that used tools has
// several messages merged into one card, and the reply — where the agent puts
// its gadgets — is the last of them, so the card has to show gadgets from every
// message in the run, not only the first.
test('a gadget in the final reply of a multi-round-trip turn still renders', async () => {
  const reply = buildGadgetFenceMessage([{
    type: 'gadget' as const,
    blockId: 'artifact-block',
    gadget: {
      version: 1,
      kind: 'artifact',
      gadgetId: 'turn-evidence',
      payload: {
        title: 'Evidence',
        artifacts: [{ name: 'shot.png', path: 'shot.png', mediaType: 'image/png', description: 'A screenshot' }]
      },
      actions: []
    }
  }], 'Here is the evidence.');
  mock = await startMockGatewayServer({
    mode: 'complete',
    roundTrips: NARRATION.slice(0, 2).map(content => ({ content, toolCalls: [{ name: 'read_file', arguments: { path: 'a.ts' } }] })),
    reply
  });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-gadget-turn-'));
  fs.writeFileSync(path.join(workDir, 'shot.png'), Buffer.from(TINY_PNG_BASE64, 'base64'));
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gadget-turn-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  await win.evaluate(async workingDirectory => window.praxis.ai.delegate({
    provider: 'vercel-gateway',
    toolMode: 'full',
    permissionMode: 'auto',
    workingDirectory,
    task: { goal: 'Show me the evidence.' }
  }), workDir);
  await openSession(win);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 30000 });

  // It really was a merged turn: one card, with the narration folded away.
  await expect(win.locator('[data-testid="session-chat-assistant"]')).toHaveCount(1);
  const gadget = win.locator('[data-testid="gadget-artifact"]');
  await expect(gadget).toHaveCount(1);
  await expect(gadget.locator('img.markdown-image-preview')).toHaveAttribute('src', /^data:image\/png;base64,/);
  fs.rmSync(workDir, { recursive: true, force: true });
});
