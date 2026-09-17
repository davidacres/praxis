import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';

/**
 * Phase E — AI sessions UI. Exercises the renderer against the real IPC
 * surface with a mock gateway (no live API key):
 *
 * 1. The New Session composer delegates a free-form goal, lands on the
 *    Sessions view, and the console streams the session's events live until
 *    the mock completes it.
 * 2. The issue detail header opens the extension-style task setup, starts a
 *    ticket-bound session, opens its console, and can abort it.
 * 3. Without any API key, the composer surfaces the provider-not-configured
 *    error instead of failing silently.
 */

/** Env that guarantees "no key anywhere" unless a test sets one explicitly. */
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

test('closing Praxis warns before interrupting an active AI session', async () => {
  mock = await startMockGatewayServer({ mode: 'hang' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  const session = await win.evaluate(async () => window.praxis.ai.delegate({
    provider: 'vercel-gateway',
    task: { goal: 'Keep this session running while the close guard is tested.' }
  }));

  await expect.poll(() => mock!.requests.length).toBeGreaterThan(0);

  try {
    // This exercises the same native BrowserWindow close path used by the
    // caption controls and macOS traffic lights.
    await win.evaluate(async () => window.praxis.window.close());
    const closeDialog = win.getByRole('dialog', { name: 'AI sessions still running' });
    await expect(closeDialog).toBeVisible();
    await expect(closeDialog).toContainText('Closing Praxis will stop 1 active AI session');
    await closeDialog.getByRole('button', { name: 'Keep Praxis open' }).click();
    await expect(closeDialog).toHaveCount(0);
  } finally {
    // Leave no live stream behind if an assertion fails; the close guard is
    // deliberately meant to block the normal Electron teardown too.
    await win.evaluate(issueKey => window.praxis.ai.abort(issueKey), session.issueKey).catch(() => undefined);
  }

  await expect.poll(() => win.evaluate(
    issueKey => window.praxis.ai.listSessions().then(sessions => sessions.find(s => s.issueKey === issueKey)?.state),
    session.issueKey
  )).toBe('aborted');
});

test('composer selects a board and open ticket, names the session, and streams to completion', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  // The app opens on the New Session composer.
  const composer = win.locator('[data-testid="new-session-view"]');
  await composer.waitFor();
  const boardSelect = win.locator('[data-testid="new-session-board-select"]');
  const ticketSelect = win.locator('[data-testid="new-session-ticket-select"]');
  await boardSelect.click();
  await expect(win.locator('[data-testid="new-session-board-option"]')).toHaveCount(3);
  await win.locator('[data-testid="new-session-board-option"]', { hasText: 'Operations Board' }).click();
  await expect(ticketSelect).toBeEnabled();
  await expect(ticketSelect).toContainText(/OPS-/);
  await ticketSelect.click();
  const ticketOptions = win.locator('[data-testid="new-session-ticket-option"]');
  const openTicketKeys = await ticketOptions.locator('strong').allTextContents();
  expect(openTicketKeys.length).toBeGreaterThan(0);
  expect(openTicketKeys.every(key => key.startsWith('OPS-'))).toBe(true);
  await ticketOptions.first().click();

  // The session name defaults to the ticket id and can be edited in place
  // before the ticket-bound session starts.
  const selectedTicket = (await ticketSelect.locator('span').textContent())?.trim() ?? '';
  await expect(win.locator('[data-testid="new-session-title"]')).toHaveText(selectedTicket);
  await win.locator('[data-testid="new-session-title-edit"]').click();
  await win.locator('[data-testid="new-session-title-input"]').fill('Operations follow-up');
  await win.locator('[data-testid="new-session-title-input"]').press('Enter');
  await composer.locator('textarea').fill('Refactor the demo board store');
  const toolMode = win.locator('[data-testid="new-session-tool-mode"]');
  await expect(toolMode).toContainText('Full tools');
  await toolMode.click();
  await expect(toolMode).toContainText('Read only');
  await win.locator('[data-testid="new-session-submit"]').click();

  // Lands on the Sessions view with the new session selected.
  await win.locator('[data-testid="sessions-view"]').waitFor();
  const row = win.locator('[data-testid="session-list-row"]').first();
  await row.waitFor();
  await expect(row).toContainText('Operations follow-up');
  await expect(row).toContainText(selectedTicket);

  // The agent runs to completion against the mock; the badge and console follow.
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', {
    timeout: 15000
  });
  await expect(win.locator('[data-testid="session-tool-mode"]')).toContainText('Read only');
  await win.screenshot({ path: 'output/playwright/sessions-shell.png', fullPage: true });
  const firstRequest = JSON.parse(mock.requests[0].body) as {
    tools: Array<{ function: { name: string } }>;
  };
  const toolNames = firstRequest.tools.map(tool => tool.function.name);
  expect(toolNames).toEqual(expect.arrayContaining([
    'read_file',
    'list_dir',
    'tracker_get_ticket',
    'tracker_list_transitions'
  ]));
  expect(toolNames).not.toEqual(expect.arrayContaining([
    'write_file',
    'run_shell',
    'tracker_update_ticket',
    'tracker_add_comment',
    'tracker_transition_ticket'
  ]));
  await expect(win.locator('.session-follow-up-composer')).toBeVisible();
  await expect(win.locator('[data-testid="session-follow-up-input"]')).toHaveClass(/composer-input/);
  await expect(win.locator('[data-testid="session-follow-up-send"]')).toHaveClass(/composer-send/);
  await win.getByLabel('Toggle panel').click();
  const terminal = win.getByTestId('integrated-terminal');
  await terminal.locator('.xterm-screen').click();
  await win.keyboard.type("printf 'SESSION_TERMINAL_CONTEXT\\n'");
  await win.keyboard.press('Enter');
  await expect.poll(async () => win.evaluate(async () => {
    const sessions = await window.praxis.terminal.list();
    return sessions.length ? (await window.praxis.terminal.getContext(sessions[0].id)).output : '';
  })).toContain('SESSION_TERMINAL_CONTEXT');
  await win.getByLabel('Close panel').click();
  await expect(win.getByTestId('attach-terminal-context')).toBeVisible();
  await win.getByTestId('attach-terminal-context').click();
  await expect(win.getByTestId('terminal-context-attachment')).toBeVisible();
  await win.locator('[data-testid="session-follow-up-input"]').fill('Please explain the result in more detail.');
  await win.locator('[data-testid="session-follow-up-send"]').click();
  await expect.poll(() => mock!.requests.length, { timeout: 15000 }).toBe(2);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', {
    timeout: 15000
  });
  await expect(win.locator('[data-testid="session-chat-user"]').last()).toContainText(
    'Please explain the result in more detail.'
  );
  await expect(win.locator('[data-testid="session-chat-assistant"]').last()).toContainText(
    'Mock gateway reply'
  );
  const transcriptOrder = await win.locator('.session-chat-message').evaluateAll(nodes =>
    nodes.map(node => ({
      role: node.classList.contains('is-assistant') ? 'assistant' : 'user',
      text: node.textContent?.trim() ?? ''
    }))
  );
  expect(transcriptOrder.map(item => item.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
  expect(transcriptOrder[0].text).toContain('Refactor the demo board store');
  expect(transcriptOrder[1].text).toContain('Mock gateway reply');
  expect(transcriptOrder[2].text).toContain('Please explain the result in more detail.');
  expect(transcriptOrder[3].text).toContain('Mock gateway reply');
  expect(mock.requests[1].body).toContain('Please explain the result in more detail.');
  expect(mock.requests[1].body).toContain('SESSION_TERMINAL_CONTEXT');
  expect(mock.requests[1].body).toContain('<terminal_context');
  expect(mock.requests[1].body).toContain('tracker_get_ticket');
  expect(mock.requests[1].body).not.toContain('tracker_update_ticket');
  expect(JSON.parse(mock.requests[1].body).model).toBe(JSON.parse(mock.requests[0].body).model);
  await win.locator('[data-testid="session-tab-activity"]').click();
  // Provider lifecycle/reasoning/completion events remain persisted, but the
  // default Activity digest has nothing actionable to show for this turn.
  await expect(win.locator('[data-testid="session-event-row"]')).toHaveCount(0);
  // Completed is terminal — no abort button.
  await expect(win.locator('[data-testid="session-abort-btn"]')).toHaveCount(0);

  // A row can be renamed in place; the custom title is used by both the list
  // and console header and survives a renderer reload.
  await row.locator('[data-testid="session-rename-btn"]').click();
  const titleInput = row.locator('[data-testid="session-title-input"]');
  await titleInput.fill('Demo store refactor session');
  await titleInput.press('Enter');
  await expect(row.locator('[data-testid="session-title"]')).toHaveText('Demo store refactor session');
  await expect(win.locator('[data-testid="session-console-title"]')).toContainText('Demo store refactor session');
  await win.reload();
  await win.locator('[data-testid="nav-sessions"]').click();
  const persistedRow = win.locator('[data-testid="session-list-row"]', {
    hasText: 'Demo store refactor session'
  });
  await persistedRow.waitFor();
  await persistedRow.click();
  await expect(win.locator('[data-testid="session-provider"]')).toBeEnabled();
  await expect(win.locator('[data-testid="session-model"]')).toBeEnabled();
  await win.locator('[data-testid="session-model"]').click();
  const persistedModelMenu = win.locator('[data-testid="session-model-menu"]');
  await expect(persistedModelMenu).toBeVisible();
  await expect.poll(() => persistedModelMenu.evaluate(element => getComputedStyle(element).position)).toBe('fixed');
  await expect(persistedModelMenu.locator('[data-testid^="session-model-option-"]')).not.toHaveCount(0);
  await win.keyboard.press('Escape');
  await win.locator('[data-testid="session-provider"]').click();
  const persistedProviderMenu = win.locator('[data-testid="session-provider-menu"]');
  await expect(persistedProviderMenu).toBeVisible();
  await expect.poll(() => persistedProviderMenu.evaluate(element => getComputedStyle(element).position)).toBe('fixed');
  await expect(persistedProviderMenu.locator('[data-testid^="session-provider-option-"]')).not.toHaveCount(0);
  await win.keyboard.press('Escape');
  const persistedTranscriptOrder = await win.locator('.session-chat-message').evaluateAll(nodes =>
    nodes.map(node => node.classList.contains('is-assistant') ? 'assistant' : 'user')
  );
  expect(persistedTranscriptOrder).toEqual(['user', 'assistant', 'user', 'assistant']);

  // Delete removes the persisted conversation and leaves the Sessions empty state.
  await persistedRow.locator('[data-testid="session-delete-btn"]').click();
  await expect(win.locator('[data-testid="session-list-row"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="sessions-empty"]')).toBeVisible();
});

test('issue detail starts a prompted ticket session and opens its console', async () => {
  mock = await startMockGatewayServer({ mode: 'hang' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  // Open a demo issue in the aux detail pane.
  await win.locator('[data-testid="nav-overview"]').click();
  await win.locator('.overview-board-card', { hasText: 'Platform Overview' }).click();
  await win.locator('[data-testid="issue-card"]', { hasText: 'APP-100' }).click();
  await win.locator('[data-testid="issue-primary-ai-btn"]').click();
  const dialog = win.locator('[data-testid="issue-session-dialog"]');
  await dialog.waitFor();
  await expect(dialog).toContainText(/APP-\d+ — /);
  await expect(win.locator('[data-testid="issue-ai-provider"]')).toHaveValue('vercel-gateway');
  await expect(win.locator('[data-testid="issue-ai-runtime-model"]')).toHaveValue('mock/model');
  await expect(win.locator('[data-testid="issue-session-goal"]')).not.toHaveValue('');
  await win.locator('[data-testid="issue-session-goal"]').fill('Deliver the ticket from its saved details');
  await win.locator('[data-testid="issue-session-scope"]').fill('Ticket implementation and focused tests');
  await win.locator('[data-testid="issue-session-done"]').fill('Implementation complete and tests passing');

  await win.locator('[data-testid="issue-session-start"]').click();
  await expect.poll(() => mock?.requests.length ?? 0).toBeGreaterThan(0);
  const request = JSON.parse(mock?.requests[0]?.body ?? '{}') as {
    model?: string;
    messages?: Array<{ role?: string; content?: string }>;
    tools?: Array<{ function: { name: string } }>;
  };
  expect(request.model).toBe('mock/model');
  const systemPrompt = request.messages?.find(message => message.role === 'system')?.content ?? '';
  expect(systemPrompt).toContain('**Goal:** Deliver the ticket from its saved details');
  expect(systemPrompt).toContain('**Scope:** Ticket implementation and focused tests');
  expect(systemPrompt).toContain('**Definition of Done:** Implementation complete and tests passing');
  expect(systemPrompt).toContain('- Key: APP-100');
  const fullToolNames = request.tools?.map(tool => tool.function.name) ?? [];
  expect(fullToolNames).toEqual(expect.arrayContaining([
    'write_file',
    'run_shell',
    'tracker_get_ticket',
    'tracker_update_ticket',
    'tracker_add_comment',
    'tracker_transition_ticket'
  ]));

  // Starting succeeds into the ticket-bound Sessions console instead of
  // leaving the user in the detail pane with no visible response.
  await expect(win.locator('[data-testid="sessions-view"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-console-title"]')).toContainText('Deliver the ticket');
  await win.locator('[data-testid="session-abort-btn"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Aborted');

  // Reopening the ticket does not silently overwrite the stored session: the
  // setup identifies it and offers a direct route back to the existing console.
  await win.locator('[data-testid="nav-overview"]').click();
  await win.locator('.overview-board-card', { hasText: 'Platform Overview' }).click();
  await win.locator('[data-testid="issue-card"]', { hasText: 'APP-100' }).click();
  const primaryAi = win.locator('[data-testid="issue-primary-ai-btn"]');
  await expect(primaryAi).toHaveAttribute('data-ai-mode', 'session');
  await primaryAi.click();
  await expect(win.locator('[data-testid="sessions-view"]')).toBeVisible();

  await win.locator('[data-testid="nav-overview"]').click();
  await win.locator('.overview-board-card', { hasText: 'Platform Overview' }).click();
  await win.locator('[data-testid="issue-card"]', { hasText: 'APP-100' }).click();
  await win.locator('[data-testid="issue-ai-restart-btn"]').click();
  await expect(win.locator('[data-testid="issue-session-existing-warning"]')).toContainText('aborted session');
  await expect(win.locator('[data-testid="issue-session-goal"]')).toHaveValue(
    'Deliver the ticket from its saved details'
  );
  await win.getByRole('button', { name: 'View existing' }).click();
  await expect(win.locator('[data-testid="sessions-view"]')).toBeVisible();
});

test('API session executes a tracker tool and shows the call and result inline', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    toolCall: { name: 'tracker_get_ticket', arguments: { issueKey: 'APP-101' } },
    reply: 'I inspected APP-101 through the tracker tool.'
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  await win.evaluate(async () => {
    await window.praxis.ai.delegate({
      issueKey: 'APP-101',
      provider: 'vercel-gateway',
      task: { goal: 'Inspect this ticket using the tracker.' }
    });
  });
  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', {
    timeout: 15000
  });
  await expect.poll(() => mock!.requests.length).toBe(2);
  // Tool diagnostics are represented by the grouped completion gadget in the
  // Activity log, not by a raw transcript row.
  const toolCards = win.locator('[data-testid="session-chat-tool"]');
  await expect(toolCards).toHaveCount(0);
  await win.locator('[data-testid="session-tab-activity"]').click();
  await expect(win.locator('[data-testid="tool-completion-gadget"]')).toBeVisible();
  await expect(win.locator('[data-testid="tool-completion-gadget"]')).toContainText('tracker_get_ticket');
  await expect(win.locator('[data-testid="session-chat-assistant"]').last()).toContainText(
    'I inspected APP-101 through the tracker tool.'
  );
  expect(mock.requests[1].body).toContain('Implement dependency-injected backend router');
});

test('composer surfaces the provider-not-configured error when no API key exists', async () => {
  app = await launchTestApp(undefined, undefined, { ...NO_GATEWAY_ENV });
  const win = app.window;

  const composer = win.locator('[data-testid="new-session-view"]');
  await composer.waitFor();
  await composer.locator('textarea').fill('Try without a key');
  await win.locator('[data-testid="new-session-submit"]').click();

  await expect(win.locator('[data-testid="new-session-error"]')).toContainText(
    'No Vercel AI Gateway API key configured'
  );
  // Still on the composer — no navigation happened.
  await expect(win.locator('[data-testid="sessions-view"]')).toHaveCount(0);
});

test('a write_file tool call renders a red/green diff after the write is approved', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    toolCall: {
      name: 'write_file',
      arguments: { path: 'notes.md', content: 'first line\nsecond line added by the agent\n' }
    },
    reply: 'Updated notes.md.'
  });
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-writefile-'));
  fs.writeFileSync(path.join(workDir, 'notes.md'), 'first line\n', 'utf8');
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  await win.evaluate(async workingDirectory => {
    await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      toolMode: 'full',
      workingDirectory,
      task: { goal: 'Add a second line to notes.md.' }
    });
  }, workDir);
  await win.locator('[data-testid="nav-sessions"]').click();

  // The write needs approval before it applies.
  await win.locator('[data-testid="session-permission-allow-once"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });

  // The grouped completion gadget is visible after the session restarts;
  // individual tool output remains behind the single selected-run detail view.
  await win.locator('[data-testid="session-tab-activity"]').click();
  const gadget = win.locator('[data-testid="tool-completion-gadget"]');
  await expect(gadget).toBeVisible();
  await gadget.locator('[data-testid="tool-completion-item"]').first().click();
  const diff = gadget.locator('[data-testid="session-tool-diff"]');
  await expect(diff).toBeVisible();
  await expect(diff.locator('.diff-add')).toContainText('second line added by the agent');
  expect(fs.readFileSync(path.join(workDir, 'notes.md'), 'utf8')).toContain('second line added by the agent');

  fs.rmSync(workDir, { recursive: true, force: true });
});

test('the inspector is tabbed state, not a second copy of the conversation', async () => {
  const reply = 'Here is a table:\n\n| Story | State |\n| --- | --- |\n| FX-BE-097 | Done |';
  mock = await startMockGatewayServer({ mode: 'complete', reply });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-inspector-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  await win.evaluate(async () => {
    await window.praxis.ai.delegate({ provider: 'vercel-gateway', task: { goal: 'Summarise the plan.' } });
  });
  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  // The reply is in the transcript, once.
  await expect(win.locator('[data-testid="session-chat-assistant"]').last()).toContainText('FX-BE-097');

  // The rail answers "what is this session and what can I do to it" — it must
  // not echo the reply. A "Last message" block here once rendered the whole
  // assistant message as Markdown, which made the rail a second transcript.
  //
  // Proven against the real regression: re-adding a `session-last-message`
  // block that renders the latest message event makes this line fail with
  // `Received string: "…Summary…Here is a table:…FX-BE-097…"`.
  const inspector = win.locator('[data-testid="session-inspector"]');
  await expect(inspector).not.toContainText('FX-BE-097');
  await expect(win.locator('[data-testid="session-last-message"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-purpose-goal"]')).toContainText('Summarise the plan.');
  await expect(win.locator('[data-testid="session-handover-brief"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-brief-progress"]')).toContainText('Here is a table');
  await expect(win.locator('[data-testid="session-summary-idle"]')).toHaveCount(0);

  // Three tabs, with real tab semantics.
  const tabs = inspector.getByRole('tab');
  await expect(tabs).toHaveCount(3);
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');

  await win.locator('[data-testid="session-tab-changes"]').click();
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false');
  await expect(tabs.nth(2)).toHaveAttribute('aria-selected', 'true');
  // This session's folder is a scratch dir, not a repo — the tab explains that
  // instead of going blank.
  await expect(win.locator('[data-testid="session-panel-changes"]')).not.toBeEmpty();

  await win.locator('[data-testid="session-tab-activity"]').click();
  await expect(win.locator('[data-testid="session-panel-activity"]')).not.toBeEmpty();
});

test('the agent\'s reply uses the pane it has; yours stays a reply beside it', async () => {
  // Long enough that it cannot fit on one line at any pane width. `fit-content`
  // is deliberately kept, so a bubble only fills the pane when its content
  // would otherwise overflow — a short reply still shrinks, and asserting on
  // one would measure the sentence rather than the rule.
  const reply = [
    'A paragraph long enough that the measure is what decides where it wraps, rather',
    'than the length of the sentence, so the assistant bubble has to take whatever',
    'width the pane offers it, and keeps taking it as the window grows wider still,',
    'well past the point where a single line could ever hold the whole of it.'
  ].join(' ');
  mock = await startMockGatewayServer({ mode: 'complete', reply });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-width-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  await app.electronApp.evaluate(async ({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1920, height: 1080 });
  });

  await win.evaluate(async () => {
    await window.praxis.ai.delegate({ provider: 'vercel-gateway', task: { goal: 'Say something long.' } });
  });
  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });

  const assistant = win.locator('[data-testid="session-chat-assistant"]').last();
  // The class, not the testid: the opening goal bubble carries no testid —
  // `session-chat-user` is only set on later user events.
  const user = win.locator('.session-chat-message.is-user').first();
  const assistantBox = await assistant.boundingBox();
  const userBox = await user.boundingBox();
  const paneBox = await win.locator('[data-testid="session-chat-thread"]').boundingBox();

  // Gadgets render inside this element, so its width is also every table's and
  // diff's width. It used to stop at 760px however wide the window was.
  //
  // Proven against the real regression: restoring the `max-width: min(760px,
  // 84%)` ceiling on `.session-chat-message.is-assistant` fails the next line
  // with `Expected: > 760 / Received: 760`.
  expect(assistantBox!.width).toBeGreaterThan(760);
  expect(assistantBox!.width).toBeGreaterThan(paneBox!.width * 0.9);

  // Yours stays a narrow, right-aligned reply — that asymmetry is what says who
  // spoke without reading a label.
  expect(userBox!.width).toBeLessThan(paneBox!.width * 0.6);
  expect(userBox!.x).toBeGreaterThan(assistantBox!.x);
});

test('change model and handover stay unreachable while a turn is running', async () => {
  mock = await startMockGatewayServer({ mode: 'hang' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-handover-busy-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  await win.evaluate(async () => {
    await window.praxis.ai.delegate({ provider: 'vercel-gateway', task: { goal: 'Keep running.' } });
  });
  await win.locator('[data-testid="nav-sessions"]').click();
  // The collapsed composer (a single-agent turn running, no conversation to
  // queue a directed message into) hides the model/provider chips entirely
  // now, rather than showing them disabled — see `followUpCollapsed` in
  // SessionsPage.tsx. Still the same guarantee this test exists to prove:
  // you cannot reach model/provider changes while a turn is running.
  await expect(win.locator('[data-testid="session-activity-status"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-model"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-provider"]')).toHaveCount(0);
  await win.evaluate(async () => {
    const sessions = await window.praxis.ai.listSessions();
    if (sessions[0]) await window.praxis.ai.abort(sessions[0].issueKey);
  });
});

test('a completed session can edit its brief, change model, and hand over', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    models: [{ id: 'mock/model' }, { id: 'mock/other' }]
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-handover-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  await win.evaluate(async ({ baseUrl }) => {
    await window.praxis.settings.set({ ai: { providers: { openai: { baseUrl } } } });
    await window.praxis.ai.setProviderApiKey('openai', 'e2e-openai-handover-key');
  }, { baseUrl: mock.baseUrl });
  await win.evaluate(async () => {
    await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      task: { goal: 'Ship the living brief.', scope: 'Session inspector', definitionOfDone: 'Handover works' }
    });
  });
  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  await expect(win.locator('[data-testid="session-purpose-goal"]')).toContainText('Ship the living brief.');
  await expect(win.locator('[data-testid="session-purpose-scope"]')).toContainText('Session inspector');
  await expect.poll(async () => win.locator('[data-testid="session-brief-progress"]').textContent(), {
    timeout: 15000
  }).toContain('Mock gateway reply');

  await win.locator('[data-testid="session-brief-edit"]').click();
  await win.locator('[data-testid="session-brief-notes"]').fill('Keep the worktree.');
  await win.locator('[data-testid="session-brief-save"]').click();
  await expect(win.locator('[data-testid="session-brief-notes"]')).toHaveText('Keep the worktree.');

  await win.locator('[data-testid="session-model"]').click();
  const modelMenu = win.locator('[data-testid="session-model-menu"]');
  await expect(modelMenu).toBeVisible();
  await expect(modelMenu.locator('[data-testid="session-model-refresh"]')).toBeVisible();
  await expect(modelMenu.locator('[data-testid="session-model-option-mock/other"]')).toBeVisible({ timeout: 15000 });
  const modelRequestsBeforeRefresh = mock.modelsRequestCount;
  await modelMenu.locator('[data-testid="session-model-refresh"]').click();
  await expect.poll(() => mock.modelsRequestCount).toBe(modelRequestsBeforeRefresh + 1);
  await expect(modelMenu.locator('[data-testid="session-model-option-mock/other"]')).toBeVisible();
  await modelMenu.locator('[data-testid="session-model-option-mock/other"]').click();
  await expect(modelMenu).toHaveCount(0);
  await expect(win.locator('[data-testid="session-model"]')).toContainText('mock/other');
  await expect(win.locator('[data-testid="session-runtime-epoch"]')).toHaveCount(2);

  await win.locator('[data-testid="session-provider"]').click();
  const providerMenu = win.locator('[data-testid="session-provider-menu"]');
  await expect(providerMenu).toBeVisible();
  const unavailableProvider = providerMenu.locator('[data-testid="session-provider-option-anthropic"]');
  await expect(unavailableProvider).toBeDisabled();
  await expect(unavailableProvider).toHaveAttribute('tabindex', '-1');
  await unavailableProvider.dispatchEvent('click');
  await expect(providerMenu).toBeVisible();
  await expect(providerMenu.locator('[data-testid="session-handover-confirmation"]')).toHaveCount(0);
  await providerMenu.locator('[data-testid="session-provider-option-openai"]').click();
  const handoverConfirmation = providerMenu.locator('[data-testid="session-handover-confirmation"]');
  await expect(handoverConfirmation).toContainText('Hand over to OpenAI?');
  await expect(handoverConfirmation).toContainText('continues the current session');
  await expect(handoverConfirmation.locator('[data-testid="session-handover-yes"]')).toBeVisible();
  await expect(handoverConfirmation.locator('[data-testid="session-handover-no"]')).toBeVisible();
  await expect(handoverConfirmation.locator('[data-testid="session-handover-always"]')).toBeVisible();
  await handoverConfirmation.locator('[data-testid="session-handover-no"]').click();
  await expect(providerMenu.locator('[data-testid="session-handover-confirmation"]')).toHaveCount(0);
  await providerMenu.locator('[data-testid="session-provider-option-openai"]').click();
  await providerMenu.locator('[data-testid="session-handover-always"]').click();
  await expect(providerMenu).toHaveCount(0);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  await expect(win.locator('[data-testid="session-provider"]')).toContainText('OpenAI');
  await expect(win.locator('[data-testid="session-model"]')).toContainText('mock/model');
  await expect(win.locator('[data-testid="session-chat-user"]').last()).toContainText('taking over this Praxis session');
  await expect(win.locator('[data-testid="session-brief-notes"]')).toHaveText('Keep the worktree.');
  await expect(win.locator('[data-testid="session-runtime-epoch"]')).toHaveCount(3);
  await expect.poll(() => win.evaluate(() => localStorage.getItem('praxis-ai-handover-confirmation'))).toBe('always');
});

test('an opt-in conversation alternates attributed AI turns and stops at its cap', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    models: [{ id: 'mock/model' }, { id: 'mock/other' }]
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-conversation-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  const session = await win.evaluate(async () => window.praxis.ai.delegate({
    provider: 'vercel-gateway', task: { goal: 'Compare the two approaches.' }
  }));
  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  const hostModel = await win.evaluate(key => window.praxis.ai.listSessions().then(records =>
    records.find(record => record.issueKey === key)?.model
  ), session.issueKey);

  await win.locator('[data-testid="session-provider"]').click();
  await win.locator('[data-testid="session-provider-add-vercel-gateway"]').click();
  const dialog = win.locator('[data-testid="session-conversation-dialog"]');
  await expect(dialog).toBeVisible();
  await dialog.locator('[data-testid="session-conversation-provider"]').selectOption('vercel-gateway');
  await dialog.locator('[data-testid="session-conversation-model"]').selectOption('mock/other');
  await dialog.locator('[data-testid="session-conversation-turn-cap"]').fill('2');
  await dialog.locator('[data-testid="session-conversation-confirm"]').click();

  await expect.poll(async () => win.evaluate(key => window.praxis.ai.listSessions().then(records => {
    const conversation = records.find(record => record.issueKey === key)?.conversation;
    return conversation ? `${conversation.state}:${conversation.turnsUsed}` : '';
  }), session.issueKey), { timeout: 15000 }).toBe('capped:2');
  await expect(win.locator('[data-testid="session-chat-user"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-chat-assistant"]')).toHaveCount(3);
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('Vercel AI Gateway · mock/other');
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText(`Vercel AI Gateway · ${hostModel}`);
  await expect(win.locator('[data-testid="session-provider"]')).toBeVisible();
});

test('a human can direct a message to either participant during an AI conversation', async () => {
  mock = await startMockGatewayServer({
    mode: 'complete',
    responseDelayMs: 2000,
    models: [{ id: 'mock/model' }, { id: 'mock/other' }]
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-directed-conversation-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  const session = await win.evaluate(async () => window.praxis.ai.delegate({
    provider: 'vercel-gateway', task: { goal: 'Review this implementation together.' }
  }));
  await win.locator('[data-testid="nav-sessions"]').click();
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  await win.locator('[data-testid="session-provider"]').click();
  await win.locator('[data-testid="session-provider-add-vercel-gateway"]').click();
  const dialog = win.locator('[data-testid="session-conversation-dialog"]');
  await dialog.locator('[data-testid="session-conversation-provider"]').selectOption('vercel-gateway');
  await dialog.locator('[data-testid="session-conversation-model"]').selectOption('mock/other');
  await dialog.locator('[data-testid="session-conversation-turn-cap"]').fill('3');
  await dialog.locator('[data-testid="session-conversation-confirm"]').click();

  const target = win.locator('[data-testid="session-conversation-target"]');
  await expect(target).toBeVisible();
  await target.locator('select').selectOption('host');
  await win.locator('[data-testid="session-follow-up-input"]').fill('Please review the other AI response for missing risks.');
  await win.locator('[data-testid="session-conversation-send"]').click();
  const directedMessage = win.locator('[data-testid="session-chat-user"]').last();
  await expect(directedMessage).toContainText('Please review the other AI response', { timeout: 1000 });
  await expect(directedMessage).toHaveAttribute('data-pending', 'true');
  await expect(target.locator('select')).toHaveValue('host');
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('Vercel AI Gateway · mock/other');
  const hostModel = await win.evaluate(key => window.praxis.ai.listSessions().then(records =>
    records.find(record => record.issueKey === key)?.conversation?.participants.find(participant => participant.id === 'host')?.model
  ), session.issueKey);
  if (hostModel) await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText(`Vercel AI Gateway · ${hostModel}`);
  await expect(win.locator('[data-testid="session-chat-assistant"].session-chat-participant-host')).not.toHaveCount(0);
  await expect(win.locator('[data-testid="session-chat-assistant"].session-chat-participant-guest')).not.toHaveCount(0);
  await expect(win.locator('[data-testid="session-chat-assistant"] .session-chat-author svg')).not.toHaveCount(0);
  await expect.poll(async () => win.evaluate(key => window.praxis.ai.listSessions().then(records => {
    const conversation = records.find(record => record.issueKey === key)?.conversation;
    return conversation ? `${conversation.state}:${conversation.turnsUsed}` : '';
  }), session.issueKey), { timeout: 20000 }).toBe('capped:3');
  await expect(win.locator('[data-testid="session-chat-user"]').last()).not.toHaveAttribute('data-pending', 'true');
  const directedTurn = await win.locator('.session-chat-message').evaluateAll(nodes => nodes.map(node => ({
    role: node.classList.contains('is-assistant') ? 'assistant' : 'user',
    text: node.textContent ?? '',
    participant: [...node.classList].find(name => name.startsWith('session-chat-participant-'))
  })));
  const directedIndex = directedTurn.findIndex(item => item.text.includes('Please review the other AI response'));
  expect(directedIndex).toBeGreaterThan(-1);
  expect(directedTurn[directedIndex + 1]).toMatchObject({
    role: 'assistant',
    participant: 'session-chat-participant-host'
  });
});

test('focus mode presents sessions as tabs and keeps them available while starting a new session', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-focus-tabs-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  const sessionKeys = await win.evaluate(async () => {
    const first = await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      task: { goal: 'First focus-mode conversation.' }
    });
    await window.praxis.ai.renameSession(first.issueKey, 'First focus chat');
    const second = await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      task: { goal: 'Second focus-mode conversation.' }
    });
    await window.praxis.ai.renameSession(second.issueKey, 'Second focus chat');
    return [first.issueKey, second.issueKey];
  });

  await expect.poll(async () => win.evaluate(keys => window.praxis.ai.listSessions().then(records =>
    keys.map(key => records.find(record => record.issueKey === key)?.state)
  ), sessionKeys), { timeout: 15000 }).toEqual(['completed', 'completed']);

  await win.locator('[data-testid="nav-sessions"]').click();
  await win.getByRole('button', { name: 'Toggle sidebar' }).click();
  await win.getByRole('button', { name: 'Toggle secondary sidebar' }).click();

  const tabs = win.locator('[data-testid="session-focus-tabs"]');
  await expect(tabs).toBeVisible();
  const focusHeader = tabs.locator('..');
  await expect.poll(async () => focusHeader.evaluate(node => ({
    header: node.getBoundingClientRect().height,
    tabs: node.querySelector<HTMLElement>('[data-testid="session-focus-tabs"]')?.getBoundingClientRect().height ?? 0
  }))).toEqual({ header: 31, tabs: 30 });
  await expect(win.locator('[data-testid="session-focus-tab"]')).toHaveCount(2);
  await expect(win.locator('[data-testid="session-console-title"]')).toHaveText('Second focus chat');

  const activeTab = win.locator('[data-testid="session-focus-tab"][aria-selected="true"]');
  await activeTab.focus();
  await activeTab.press('ArrowRight');
  await expect(win.locator('[data-testid="session-console-title"]')).toHaveText('First focus chat');
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('First focus-mode conversation.');

  await win.locator('[data-testid="session-focus-new"]').click();
  await expect(win.locator('[data-testid="new-session-view"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-focus-tabs"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-focus-new"]')).toHaveClass(/active/);

  await win.locator('[data-testid="session-focus-tab"]', { hasText: 'Second focus chat' }).click();
  await expect(win.locator('[data-testid="session-console-title"]')).toHaveText('Second focus chat');
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('Second focus-mode conversation.');
});
