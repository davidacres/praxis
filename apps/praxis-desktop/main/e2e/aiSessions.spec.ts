import { openSession } from './sessionNavigation';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockGatewayServer, type MockGatewayServer } from './mockGatewayServer';
import { chooseOption } from './chipSelect';

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
const ticketProjectFolders: string[] = [];

/** Ticket fixtures need a project owner, just like real tickets. */
async function seedTicketProject(win: TestApp['window'], toolMode: 'project-only' | 'full', boardPicker = false) {
  const folderPath = toolMode === 'full' || boardPicker ? fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-ticket-project-')) : undefined;
  if (folderPath) ticketProjectFolders.push(folderPath);
  if (boardPicker && folderPath) {
    fs.writeFileSync(path.join(folderPath, 'board.praxis.json'), JSON.stringify({ projectKey: 'OPS', projectName: 'Operations Board' }));
    const featureDir = path.join(folderPath, 'features', 'feature-01-operations');
    fs.mkdirSync(featureDir, { recursive: true });
    fs.writeFileSync(path.join(featureDir, 'task-01-01-follow-up.md'), '# Operations follow-up\n\n**Status:** Proposed\n**Type:** Task\n\n## Description\n\nRefactor the board store.\n');
  }
  const project = await win.evaluate(async ({ defaultAiToolMode, folderPath, boardPicker }) => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Demo ticket project', key: 'DEMO', type: 'product', purpose: '', brief: {},
      startingPoint: folderPath ? 'existing-folder' : 'app-storage', folderPath, planningMode: 'files',
      workflowStages: [
        { id: 'todo', name: 'To do', category: 'todo' },
        { id: 'done', name: 'Done', category: 'done' }
      ],
      starterTickets: [], defaultAiToolMode
    }, workspace.id);
    // Multiple projects keep the workspace composer unscoped so this test
    // exercises its board/ticket picker rather than the single-project shortcut.
    if (boardPicker) await window.praxis.projects.create({
      name: 'Other project', key: 'OTHER', type: 'product', purpose: '', brief: {},
      startingPoint: 'app-storage', planningMode: 'files',
      workflowStages: [
        { id: 'todo', name: 'To do', category: 'todo' },
        { id: 'done', name: 'Done', category: 'done' }
      ],
      starterTickets: [], defaultAiToolMode: 'project-only'
    }, workspace.id);
    if (boardPicker) await window.praxis.workspaces.update(workspace.id, { defaultProjectId: '' });
    if (boardPicker) await window.praxis.connection.add({
      id: 'ticket-project', name: 'Ticket tracker', mode: 'folder',
      settings: { roots: [folderPath], projectId: project.id, projectKey: 'OPS', projectName: 'Operations Board' }
    });
    for (const connection of await window.praxis.connection.list()) {
      if (connection.mode === 'demo') {
        await window.praxis.connection.update({
          ...connection, settings: { ...connection.settings, projectId: project.id }
        });
      }
    }
    return project;
  }, { defaultAiToolMode: toolMode, folderPath, boardPicker });
  return project;
}

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
  if (mock) {
    await mock.close();
    mock = undefined;
  }
  for (const folderPath of ticketProjectFolders.splice(0)) {
    fs.rmSync(folderPath, { recursive: true, force: true });
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
  mock = await startMockGatewayServer({ mode: 'complete', responseDelayMs: 1500 });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  }, { demoMode: false });
  const win = app.window;

  // The app opens on the New Session composer.
  const ticketProject = await seedTicketProject(win, 'full', true);
  await win.reload();
  const rendererErrors: Error[] = [];
  win.on('pageerror', error => rendererErrors.push(error));
  const composer = win.locator('[data-testid="new-session-view"]');
  await composer.waitFor();
  const boardSelect = win.locator('[data-testid="new-session-board-select"]');
  const ticketSelect = win.locator('[data-testid="new-session-ticket-select"]');
  await boardSelect.click();
  await expect(win.locator('[data-testid="new-session-board-option"]')).toHaveCount(1);
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
  await expect(win.locator('[data-testid="new-session-tool-mode"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="new-session-folder"]')).toHaveCount(0);
  await win.locator('[data-testid="new-session-submit"]').click();

  // Lands on the Sessions view with the new session selected.
  await win.locator('[data-testid="sessions-view"]').waitFor();
  await expect.poll(() => win.evaluate(async () => (await window.praxis.ai.listSessions())[0]?.projectId))
    .toBe(ticketProject.id);
  await expect(win.getByTestId('nav-sessions')).toHaveCount(0);
  const activityOrbit = win.locator('[data-testid="session-composer-activity-orbit"]');
  await expect(activityOrbit).toBeVisible();
  await expect(activityOrbit).toHaveAttribute('data-activity-duration', '7000');
  const capsules = activityOrbit.locator('[data-activity-capsule="true"]');
  await expect(capsules).toHaveCount(1);
  const capsuleStyle = await capsules.first().evaluate(element => ({
    animationName: getComputedStyle(element).animationName,
    animationDuration: getComputedStyle(element).animationDuration,
    gradient: element.querySelector('rect')?.getAttribute('fill'),
    rect: element.querySelector('rect')?.getAttribute('width')
  }));
  expect(capsuleStyle.animationName).toContain('session-composer-activity-pulse');
  expect(capsuleStyle.animationDuration).toContain('3.5s');
  expect(capsuleStyle.gradient).toContain('session-composer-activity-gradient');
  expect(capsuleStyle.rect).toBe('32');
  const activityGuide = activityOrbit.locator('[data-activity-guide="true"]');
  await expect(activityGuide).toHaveAttribute('d', /A 10 10/);
  const firstCapsule = capsules.first();
  const composerBox = await win.locator('.session-follow-up-composer').boundingBox();
  const orbitBox = await activityOrbit.boundingBox();
  const firstTransform = await firstCapsule.getAttribute('transform');
  await win.waitForTimeout(450);
  const secondTransform = await firstCapsule.getAttribute('transform');
  expect(composerBox).not.toBeNull();
  expect(orbitBox).not.toBeNull();
  expect(Math.abs((orbitBox?.x ?? 0) - (composerBox?.x ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((orbitBox?.y ?? 0) - (composerBox?.y ?? 0))).toBeLessThanOrEqual(1);
  expect(Math.abs((orbitBox?.width ?? 0) - (composerBox?.width ?? 0))).toBeLessThanOrEqual(2);
  expect(Math.abs((orbitBox?.height ?? 0) - (composerBox?.height ?? 0))).toBeLessThanOrEqual(2);
  expect(firstTransform).not.toBe(secondTransform);
  await win.locator('.session-follow-up-composer').screenshot({
    path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'session-composer-activity-orbit.png')
  });
  await expect(win.getByTestId('session-console-title')).toContainText('Operations follow-up');
  await expect(win.getByTestId('session-console-title')).toContainText(selectedTicket);

  // The agent runs to completion against the mock; the badge and console follow.
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', {
    timeout: 15000
  });
  await expect(win.locator('[data-testid="session-tool-mode"]')).toContainText('Full tools');
  await win.screenshot({ path: 'output/playwright/sessions-shell.png', fullPage: true });
  const firstRequest = JSON.parse(mock.requests[0].body) as {
    tools: Array<{ function: { name: string } }>;
  };
  const toolNames = firstRequest.tools.map(tool => tool.function.name);
  expect(toolNames).toEqual(expect.arrayContaining([
    'read_file',
    'list_dir',
    'tracker_get_ticket',
    'tracker_list_transitions',
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
  expect(JSON.parse(mock.requests[1].body).model).toBe(JSON.parse(mock.requests[0].body).model);
  await win.locator('[data-testid="session-tab-activity"]').click();
  // Provider lifecycle/reasoning/completion events remain persisted, but the
  // default Activity digest has nothing actionable to show for this turn.
  await expect(win.locator('[data-testid="session-event-row"]')).toHaveCount(0);
  // Completed is terminal — no abort button.
  await expect(win.locator('[data-testid="session-abort-btn"]')).toHaveCount(0);

  const row = win.getByTestId('project-session-nav-item').first();
  await expect(row).toBeVisible();
  await expect(row).toContainText('Operations follow-up');
  await expect(win.getByTestId('project-tree').filter({ hasText: ticketProject.name })).toContainText('Operations follow-up');
  await expect(win.getByTestId('session-list-row')).toHaveCount(0);
  await win.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/praxis-sidebar-ticket-project.png') });
  await row.hover();
  await row.getByTestId('session-rename-btn').click();
  const titleInput = row.getByTestId('session-title-input');
  await titleInput.fill('Demo store refactor session');
  await titleInput.press('Enter');
  await expect(row.getByTestId('session-title')).toHaveText('Demo store refactor session');
  await expect(win.getByTestId('session-console-title')).toContainText('Demo store refactor session');
  await win.reload();
  await openSession(win, 'Demo store refactor session');
  const persistedRow = win.getByTestId('project-session-nav-item').filter({ hasText: 'Demo store refactor session' });
  await persistedRow.hover();
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

  // Delete asks first, in an app-styled dialog with a third "Archive instead" escape hatch,
  // then removes the persisted conversation and leaves the Sessions empty state.
  await persistedRow.hover();
  await persistedRow.locator('[data-testid="session-delete-btn"]').click();
  const deleteDialog = win.getByRole('dialog');
  await expect(deleteDialog).toContainText('Delete this session?');
  await expect(deleteDialog.getByTestId('app-dialog-tertiary')).toHaveText('Archive instead');
  await deleteDialog.getByRole('button', { name: 'Delete session' }).click();
  await expect(win.locator('[data-testid="session-list-row"]')).toHaveCount(0);
  await expect(win.getByTestId('project-session-nav-item')).toHaveCount(0);
  await win.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/session-deleted.png') });
  await expect(win.locator('[data-testid="sessions-empty"]')).toBeVisible();
  expect(rendererErrors).toEqual([]);
});

test('issue detail starts a prompted ticket session and opens its console', async () => {
  mock = await startMockGatewayServer({ mode: 'hang' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  const ticketProject = await seedTicketProject(win, 'full');
  await win.reload();

  // Open a demo issue in the aux detail pane.
  await win.locator('[data-testid="nav-overview"]').click();
  await win.locator('.overview-board-card', { hasText: 'Platform Overview' }).click();
  await win.locator('[data-testid="issue-card"]', { hasText: 'APP-100' }).click();
  await win.locator('[data-testid="issue-primary-ai-btn"]').click();
  const dialog = win.locator('[data-testid="issue-session-dialog"]');
  await dialog.waitFor();
  await expect(dialog).toContainText(/APP-\d+ — /);
  await expect(win.locator('[data-testid="issue-ai-provider"]')).toHaveAttribute('data-value', 'vercel-gateway');
  await expect(win.locator('[data-testid="issue-ai-runtime-model"]')).toHaveAttribute('data-value', 'mock/model');
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
  await expect.poll(() => win.evaluate(async () => (await window.praxis.ai.listSessions())[0]?.projectId))
    .toBe(ticketProject.id);
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
  await openSession(win);
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
  await openSession(win);

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
  await openSession(win);
  await expect(win.getByTestId('nav-sessions')).toHaveCount(0);
  await expect(win.getByTestId('session-list-row')).toHaveCount(1);
  await expect(win.getByTestId('project-session-nav-item')).toHaveCount(0);
  await win.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/praxis-sidebar-conversation.png') });
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

  // Four tabs, with real tab semantics — Summary/Activity/Changes for the
  // selected session, plus the Sessions browser that keeps archived sessions
  // reachable.
  const tabs = inspector.getByRole('tab');
  await expect(tabs).toHaveCount(4);
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
  await openSession(win);
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
  await openSession(win);
  // The collapsed composer (a single-agent turn running, no conversation to
  // queue a directed message into) hides the model/provider chips entirely
  // now, rather than showing them disabled — see `followUpCollapsed` in
  // SessionsPage.tsx. Still the same guarantee this test exists to prove:
  // you cannot reach model/provider changes while a turn is running.
  // The turn is running (Abort is offered); the thinking indicator itself is
  // hidden once response text starts streaming.
  await expect(win.locator('[data-testid="session-abort-btn"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-model"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-provider"]')).toHaveCount(0);
  await win.evaluate(async () => {
    const sessions = await window.praxis.ai.listSessions();
    if (sessions[0]) await window.praxis.ai.abort(sessions[0].issueKey);
  });
});

test('the session composer model picker honours the curated enabled models', async () => {
  // Regression: the composer's per-session Model picker read the provider catalog
  // directly and ignored Settings -> AI Provider -> Models curation, unlike New
  // Session, which filtered through applyEnabledModelCuration.
  mock = await startMockGatewayServer({
    mode: 'complete',
    models: [{ id: 'mock/model' }, { id: 'mock/other' }, { id: 'mock/third' }]
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-curation-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  await win.evaluate(async ({ baseUrl }) => {
    await window.praxis.settings.set({ ai: { providers: { openai: { baseUrl } } } });
    await window.praxis.ai.setProviderApiKey('openai', 'e2e-openai-curation-key');
  }, { baseUrl: mock.baseUrl });
  await win.evaluate(async () => {
    await window.praxis.ai.delegate({
      provider: 'openai',
      task: { goal: 'Curation reach.', scope: 'Composer picker', definitionOfDone: 'Curated subset shown' }
    });
  });
  await openSession(win);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });

  const optionIds = async (menu: import('playwright').Locator) =>
    menu.locator('[data-testid^="session-model-option-"]').evaluateAll(nodes =>
      nodes.map(node => node.getAttribute('data-testid')!.replace('session-model-option-', '')));

  // Uncurated: the whole provider catalog is offered.
  await win.locator('[data-testid="session-model"]').click();
  const uncurated = win.locator('[data-testid="session-model-menu"]');
  await expect(uncurated).toBeVisible();
  // `mock/model` renders as the pinned Default row and the session's own model
  // (absent from the catalog) as the Current row; both are expected extras.
  await expect.poll(() => optionIds(uncurated), { timeout: 15000 }).toEqual(
    expect.arrayContaining(['default', 'current', 'mock/other', 'mock/third'])
  );

  // Curate down to a single model, then reopen: only that one may remain.
  await win.keyboard.press('Escape');
  await win.evaluate(async () => {
    await window.praxis.settings.set({
      ai: { providers: { openai: { enabledModelIds: ['mock/other'] } } }
    });
  });
  await win.locator('[data-testid="session-model"]').click();
  const curated = win.locator('[data-testid="session-model-menu"]');
  await expect(curated).toBeVisible();
  // Curation to one model: every other catalog model is gone from the menu, and
  // the survivor shows as the Default row (its own row is suppressed in favour of
  // it). The session's out-of-catalog model stays selectable as Current, so
  // curation can never strand an in-flight conversation.
  await expect.poll(() => optionIds(curated), { timeout: 15000 })
    .toEqual(expect.arrayContaining(['default', 'current']));
  const curatedIds = await optionIds(curated);
  expect(curatedIds).not.toContain('mock/third');
  await expect(curated.locator('[data-testid="session-model-option-default"]')).toContainText('mock/other');
  await expect(curated.locator('[data-testid="session-model-option-current"]')).toContainText('gpt-4o-mini');
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
  await openSession(win);
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
  const defaultModelOption = modelMenu.locator('[data-testid="session-model-option-default"]');
  await expect(defaultModelOption).toBeVisible();
  await expect(defaultModelOption).toContainText('mock/model');
  await expect(modelMenu.locator('[data-testid="session-model-option-mock/model"]')).toHaveCount(0);
  await modelMenu.screenshot({ path: path.resolve(process.cwd(), '../.praxis/session-artifacts/existing-session-default-model.png') });
  const modelRequestsBeforeRefresh = mock.modelsRequestCount;
  await modelMenu.locator('[data-testid="session-model-refresh"]').click();
  await expect.poll(() => mock.modelsRequestCount).toBe(modelRequestsBeforeRefresh + 1);
  await expect(modelMenu.locator('[data-testid="session-model-option-mock/other"]')).toBeVisible();
  await modelMenu.locator('[data-testid="session-model-option-mock/other"]').click();
  await expect(modelMenu).toHaveCount(0);
  await expect(win.locator('[data-testid="session-model"]')).toContainText('mock/other');
  await expect(win.locator('[data-testid="session-runtime-epoch"]')).toHaveCount(2);
  await win.evaluate(async () => {
    await window.praxis.settings.set({ ai: { defaultModel: 'mock/configured-default' } });
  });
  await win.locator('[data-testid="session-model"]').click();
  const resetModelMenu = win.locator('[data-testid="session-model-menu"]');
  await expect(resetModelMenu.locator('[data-testid="session-model-option-default"]')).toContainText('mock/configured-default');
  await expect(resetModelMenu.locator('[data-testid="session-model-option-default"]')).toHaveAttribute('aria-selected', 'false');
  await resetModelMenu.locator('[data-testid="session-model-option-default"]').click();
  await expect(win.locator('[data-testid="session-model"]')).toContainText('mock/configured-default');

  await win.locator('[data-testid="session-provider"]').click();
  const providerMenu = win.locator('[data-testid="session-provider-menu"]');
  await expect(providerMenu).toBeVisible();
  // Anthropic has no key configured in this test, so it doesn't appear in
  // the list at all — not present-but-disabled, per its dead-click history.
  await expect(providerMenu.locator('[data-testid="session-provider-option-anthropic"]')).toHaveCount(0);
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
  await expect(win.locator('[data-testid="session-runtime-epoch"]')).toHaveCount(4);
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
  await openSession(win);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  const hostModel = await win.evaluate(key => window.praxis.ai.listSessions().then(records =>
    records.find(record => record.issueKey === key)?.model
  ), session.issueKey);

  await win.locator('[data-testid="session-provider"]').click();
  await win.locator('[data-testid="session-provider-add-vercel-gateway"]').click();
  const dialog = win.locator('[data-testid="session-conversation-dialog"]');
  await expect(dialog).toBeVisible();
  await chooseOption(dialog.locator('[data-testid="session-conversation-provider"]'), 'vercel-gateway');
  await chooseOption(dialog.locator('[data-testid="session-conversation-model"]'), 'mock/other');
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
  await openSession(win);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  await win.locator('[data-testid="session-provider"]').click();
  await win.locator('[data-testid="session-provider-add-vercel-gateway"]').click();
  const dialog = win.locator('[data-testid="session-conversation-dialog"]');
  await chooseOption(dialog.locator('[data-testid="session-conversation-provider"]'), 'vercel-gateway');
  await chooseOption(dialog.locator('[data-testid="session-conversation-model"]'), 'mock/other');
  await dialog.locator('[data-testid="session-conversation-turn-cap"]').fill('3');
  await dialog.locator('[data-testid="session-conversation-confirm"]').click();

  const target = win.locator('[data-testid="session-conversation-target"]');
  await expect(target).toBeVisible();
  await chooseOption(target, 'host');
  await win.locator('[data-testid="session-follow-up-input"]').fill('Please review the other AI response for missing risks.');
  await win.locator('[data-testid="session-conversation-send"]').click();
  const directedMessage = win.locator('[data-testid="session-chat-user"]').last();
  await expect(directedMessage).toContainText('Please review the other AI response', { timeout: 1000 });
  await expect(directedMessage).toHaveAttribute('data-pending', 'true');
  await expect(target).toHaveAttribute('data-value', 'host');
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

test('an image pasted during a conversation rides with the directed message', async () => {
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4z8DAAMQACf4B/4PiLjgAAAAASUVORK5CYII=';
  mock = await startMockGatewayServer({
    mode: 'complete',
    responseDelayMs: 3000,
    models: [{ id: 'mock/model' }, { id: 'mock/other' }]
  });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-conversation-image-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;
  const session = await win.evaluate(async () => window.praxis.ai.delegate({
    provider: 'vercel-gateway', task: { goal: 'Review this design together.' }
  }));
  await openSession(win);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
  await win.locator('[data-testid="session-provider"]').click();
  await win.locator('[data-testid="session-provider-add-vercel-gateway"]').click();
  const dialog = win.locator('[data-testid="session-conversation-dialog"]');
  await chooseOption(dialog.locator('[data-testid="session-conversation-provider"]'), 'vercel-gateway');
  await chooseOption(dialog.locator('[data-testid="session-conversation-model"]'), 'mock/other');
  await dialog.locator('[data-testid="session-conversation-turn-cap"]').fill('2');
  await dialog.locator('[data-testid="session-conversation-confirm"]').click();

  const target = win.locator('[data-testid="session-conversation-target"]');
  await expect(target).toBeVisible();
  await chooseOption(target, 'host');

  // Paste an image, then send the directed message with it.
  const input = win.locator('[data-testid="session-follow-up-input"]');
  await input.evaluate((node, encoded) => {
    const bytes = Uint8Array.from(atob(encoded), c => c.charCodeAt(0));
    const dt = new DataTransfer();
    dt.items.add(new File([bytes], 'pasted.png', { type: 'image/png' }));
    (node as HTMLTextAreaElement).focus();
    node.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, PNG);
  await expect(win.locator('[data-testid="session-image-chip"]')).toBeVisible();
  await input.fill('Look at this screenshot, host.');
  await win.locator('[data-testid="session-conversation-send"]').click();

  // The addressed participant's request on the wire carries the image part.
  await expect.poll(async () => mock!.requests.filter(request => {
    const body = JSON.parse(request.body) as { messages: Array<{ role: string; content: unknown }> };
    const lastUser = body.messages.filter(message => message.role === 'user').at(-1) as { content?: unknown } | undefined;
    return Array.isArray(lastUser?.content)
      && (lastUser.content as Array<{ type: string }>).some(part => part.type === 'image_url');
  }).length, { timeout: 15000 }).toBe(1);

  // The turn renders in the transcript with its image thumbnail.
  await expect(win.locator('[data-testid="session-chat-user"]').last()).toContainText('Look at this screenshot, host.');
  await expect(win.locator('[data-testid="session-chat-attachments"]').last().locator('img')).toHaveCount(1);

  // Wind the conversation down so teardown is not blocked by the close guard.
  await win.evaluate(key => window.praxis.ai.stopConversation(key), session.issueKey);
  await expect.poll(async () => win.evaluate(key => window.praxis.ai.listSessions().then(records =>
    records.find(record => record.issueKey === key)?.conversation?.state ?? ''
  ), session.issueKey), { timeout: 15000 }).toBe('stopped');
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

  await openSession(win);
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
  await win.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/session-focus-navigation.png') });

  const activeTab = win.locator('[data-testid="session-focus-tab"][aria-selected="true"]');
  await activeTab.focus();
  await activeTab.press('ArrowRight');
  await expect(win.locator('[data-testid="session-console-title"]')).toHaveText('First focus chat');
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('First focus-mode conversation.');

  await win.locator('[data-testid="session-focus-new"]').click();
  await expect(win.locator('[data-testid="new-session-view"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-focus-tabs"]')).toBeVisible();
  await expect(win.locator('[data-testid="session-focus-new"]')).toHaveClass(/active/);
  await win.screenshot({ path: path.resolve(__dirname, '../../.praxis/session-artifacts/new-conversation-focus-tabs.png') });

  await win.locator('[data-testid="session-focus-tab"]', { hasText: 'Second focus chat' }).click();
  await expect(win.locator('[data-testid="session-console-title"]')).toHaveText('Second focus chat');
  await expect(win.locator('[data-testid="session-chat-thread"]')).toContainText('Second focus-mode conversation.');
});

test('session failure displays unified error banner above the chat panel and not scattered in chat', async () => {
  mock = await startMockGatewayServer({ mode: 'error' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  await win.evaluate(async () => {
    await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      task: { goal: 'Test error banner display on 429 quota exhaustion.' }
    });
  });

  await openSession(win);
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Failed', {
    timeout: 15000
  });

  // The unified error banner is visible above the chat panel
  const errorBanner = win.locator('[data-testid="session-error-banner"]');
  await expect(errorBanner).toBeVisible();
  await expect(errorBanner).toContainText('Provider Limit / Quota Exceeded');
  await expect(errorBanner).toContainText('This provider has reached its usage limit. Switch providers to continue, or stop this session.');
  await expect(errorBanner).not.toContainText('Insufficient balance or no resource package. Please recharge.');
  await expect(errorBanner).not.toContainText('Code 1113 · HTTP 429');

  // No error bubbles or duplicate banners in the chat thread or composer
  await expect(win.locator('[data-testid="session-chat-error"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-chat-failed-banner"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-composer-failed-banner"]')).toHaveCount(0);

  // Take a visual screenshot for verification
  const screenshotPath = path.resolve(__dirname, '../../.praxis/session-artifacts/session-error-banner.png');
  fs.mkdirSync(path.dirname(screenshotPath), { recursive: true });
  await win.screenshot({ path: screenshotPath });

  // Position: error banner is located before the chat thread scroll container
  const positions = await win.evaluate(() => {
    const banner = document.querySelector('[data-testid="session-error-banner"]');
    const thread = document.querySelector('[data-testid="session-chat-thread"]');
    if (!banner || !thread) return null;
    const bannerRect = banner.getBoundingClientRect();
    const threadRect = thread.getBoundingClientRect();
    return {
      bannerBottom: bannerRect.bottom,
      threadTop: threadRect.top
    };
  });
  expect(positions).not.toBeNull();
  expect(positions!.bannerBottom).toBeLessThanOrEqual(positions!.threadTop + 2);

  // Usage displays model name before tokens
  const usageSummary = win.locator('[data-testid="session-usage-summary"]');
  await expect(usageSummary).toBeVisible();
  const usageMeta = usageSummary.locator('.session-usage-summary-meta');
  await expect(usageMeta).toContainText('anthropic/claude-sonnet-4.6 · ');

  // Dismissing the error banner resets it
  const dismissBtn = win.locator('[data-testid="session-error-banner-dismiss"]');
  await expect(dismissBtn).toBeVisible();
  await dismissBtn.click();
  await expect(win.locator('[data-testid="session-error-banner"]')).toHaveCount(0);
});

test('composer paste and drop carries an image to the agent and the transcript', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  // Start a free-form session against the mock gateway.
  await win.evaluate(async () => {
    await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      task: { goal: 'Describe the attached screenshot.' }
    });
  });
  await openSession(win);
  const input = win.locator('[data-testid="session-follow-up-input"]');
  await input.waitFor();

  // A real 2x2 red/green PNG (valid CRCs, decodable by the browser's image
  // decoder — the composer downscales through a canvas before sending).
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4z8DAAMQACf4B/4PiLjgAAAAASUVORK5CYII=';
  const pngBytes = Buffer.from(pngBase64, 'base64');

  // Paste: dispatch a clipboard event carrying the PNG as a File.
  await win.evaluate(bytes => {
    const file = new File([new Uint8Array(bytes)], 'paste.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('[data-testid="session-follow-up-input"]') as HTMLTextAreaElement;
    input.focus();
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, Array.from(pngBytes));

  const chip = win.locator('[data-testid="session-image-chip"]');
  await expect(chip).toBeVisible();

  // Drop: dispatch a drop event with a second PNG file.
  await win.evaluate(bytes => {
    const file = new File([new Uint8Array(bytes)], 'dropped.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const composer = document.querySelector('.composer.session-follow-up-composer') as HTMLElement;
    composer.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    composer.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, Array.from(pngBytes));

  await expect(chip).toHaveCount(2);

  // Sending delivers both images on the wire and renders them in the transcript.
  await input.fill('What do you see in these?');
  await win.locator('[data-testid="session-follow-up-send"]').click();

  await expect.poll(() => mock!.requests.length, { timeout: 15000 }).toBe(2);
  const followUpBody = JSON.parse(mock.requests[1].body) as {
    messages: Array<{ role: string; content: unknown }>;
  };
  const userTurn = followUpBody.messages.filter(message => message.role === 'user').at(-1) as { content: Array<{ type: string; text?: string; image_url?: { url: string } }> };
  expect(Array.isArray(userTurn.content)).toBe(true);
  const imageParts = userTurn.content.filter(part => part.type === 'image_url');
  expect(imageParts).toHaveLength(2);
  expect(imageParts[0].image_url?.url.startsWith('data:image/png;base64,')).toBe(true);

  // The staged chips clear and the turn renders in the transcript with thumbnails.
  await expect(win.locator('[data-testid="session-image-attachments"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-chat-user"]').last()).toContainText('What do you see in these?');
  await expect(win.locator('[data-testid="session-chat-attachments"]').last().locator('img')).toHaveCount(2);

  // The agent side completes as usual.
  await expect(win.locator('[data-testid="session-state-badge"]')).toHaveText('Completed', { timeout: 15000 });
});

test('a transcript attachment enlarges in a lightbox and closes on click', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  await win.evaluate(async () => {
    await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      task: { goal: 'Describe the attached screenshot.' }
    });
  });
  await openSession(win);
  const input = win.locator('[data-testid="session-follow-up-input"]');
  await input.waitFor();

  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4z8DAAMQACf4B/4PiLjgAAAAASUVORK5CYII=';
  const pngBytes = Buffer.from(pngBase64, 'base64');
  await win.evaluate(bytes => {
    const file = new File([new Uint8Array(bytes)], 'paste.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    const input = document.querySelector('[data-testid="session-follow-up-input"]') as HTMLTextAreaElement;
    input.focus();
    input.dispatchEvent(new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true }));
  }, Array.from(pngBytes));
  await expect(win.locator('[data-testid="session-image-chip"]')).toBeVisible();

  await input.fill('What is this?');
  await win.locator('[data-testid="session-follow-up-send"]').click();
  await expect(win.locator('[data-testid="session-chat-attachments"]').last().locator('img')).toHaveCount(1);

  // Click the thumbnail → the lightbox shows the full-size image.
  await win.locator('[data-testid="session-chat-attachment"]').last().click();
  const lightbox = win.locator('[data-testid="session-image-lightbox"]');
  await expect(lightbox).toBeVisible();
  await expect(lightbox.locator('img')).toHaveCount(1);

  // Click anywhere on the lightbox to dismiss it.
  await lightbox.click();
  await expect(lightbox).toHaveCount(0);
});

test('a file dropped outside the composer never navigates the window', async () => {
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  await win.evaluate(async () => {
    await window.praxis.ai.delegate({
      provider: 'vercel-gateway',
      task: { goal: 'Describe the attached screenshot.' }
    });
  });
  await openSession(win);
  const input = win.locator('[data-testid="session-follow-up-input"]');
  await input.waitFor();

  // Drop an image onto the page background — away from the composer. The
  // window-level guard swallows it: the app stays exactly where it is.
  const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAIAAAD91JpzAAAADklEQVR4nGP4z8DAAMQACf4B/4PiLjgAAAAASUVORK5CYII=';
  const pngBytes = Buffer.from(pngBase64, 'base64');
  await win.evaluate(bytes => {
    const file = new File([new Uint8Array(bytes)], 'stray.png', { type: 'image/png' });
    const dt = new DataTransfer();
    dt.items.add(file);
    document.body.dispatchEvent(new DragEvent('dragover', { dataTransfer: dt, bubbles: true, cancelable: true }));
    document.body.dispatchEvent(new DragEvent('drop', { dataTransfer: dt, bubbles: true, cancelable: true }));
  }, Array.from(pngBytes));

  // The session view survived the stray drop — no navigation, no chip staged.
  await expect(input).toBeVisible();
  await expect(win.locator('[data-testid="session-image-chip"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-state-badge"]')).toBeVisible();
});

test('a session can be archived from its row and restored from the inspector browser', async () => {
  // 'complete' — archiving is refused while a task is still running, so the
  // sessions must settle before the row icon is exercised.
  mock = await startMockGatewayServer({ mode: 'complete' });
  app = await launchTestApp(undefined, undefined, {
    ...NO_GATEWAY_ENV,
    AI_GATEWAY_API_KEY: 'e2e-gateway-key',
    AI_GATEWAY_URL: mock.baseUrl
  });
  const win = app.window;

  // Start two free-form sessions and let the mock complete both.
  const first = await win.evaluate(async () => window.praxis.ai.delegate({
    provider: 'vercel-gateway',
    task: { goal: 'First archive-flow session.' }
  }));
  const second = await win.evaluate(async () => window.praxis.ai.delegate({
    provider: 'vercel-gateway',
    task: { goal: 'Second archive-flow session.' }
  }));
  await expect.poll(() => win.evaluate(async () =>
    window.praxis.ai.listSessions().then(records =>
      records.filter(record => ['completed', 'failed', 'aborted'].includes(record.state)).length
    )
  )).toBe(2);

  // Both rows show in the sidebar tree.
  await openSession(win);
  await expect(win.locator('[data-testid="session-list-row"]')).toHaveCount(2);

  // The inspector's Sessions tab lists every session under Active.
  await win.locator('[data-testid="session-tab-sessions"]').click();
  const browser = win.locator('[data-testid="session-browser"]');
  await expect(browser).toBeVisible();
  await expect(browser.locator('[data-testid="session-browser-active"] [data-testid="session-browser-row"]')).toHaveCount(2);
  await expect(browser.locator('[data-testid="session-browser-archived-toggle"]')).toContainText('0');

  // Archive the first session from the sidebar row icon.
  // Free-form sessions get synthesized keys the row deliberately hides, so
  // match on the goal-derived title instead.
  const firstRow = win.locator('[data-testid="session-list-row"]', { hasText: 'First archive-flow session' });
  await firstRow.hover();
  await firstRow.locator('[data-testid="session-archive-btn"]').click();

  // It leaves the sidebar tree but stays listed — now under Archived.
  await win.screenshot({ path: 'output/playwright/session-archived-in-browser.png', fullPage: true });
  await expect(win.locator('[data-testid="session-list-row"]')).toHaveCount(1);
  await expect(win.locator('[data-testid="session-list-row"]', { hasText: first.issueKey })).toHaveCount(0);
  await expect(browser.locator('[data-testid="session-browser-archived-toggle"]')).toContainText('1');

  // Archiving is persisted on the record and reversible.
  await expect.poll(() => win.evaluate(key =>
    window.praxis.ai.listSessions().then(records => records.find(record => record.issueKey === key)?.archived)
  , first.issueKey)).toBe(true);

  // Expand Archived and restore it.
  await browser.locator('[data-testid="session-browser-archived-toggle"]').click();
  const archivedRow = browser.locator('[data-testid="session-browser-row"]', { hasText: first.issueKey });
  await expect(archivedRow).toBeVisible();
  await expect(archivedRow).toContainText('Archived');
  await archivedRow.locator('[data-testid="session-restore-btn"]').click();

  // Back in the tree, flag cleared.
  await expect(win.locator('[data-testid="session-list-row"]')).toHaveCount(2);
  await expect.poll(() => win.evaluate(key =>
    window.praxis.ai.listSessions().then(records => records.find(record => record.issueKey === key)?.archived)
  , first.issueKey)).toBe(undefined);

  // The other session was never touched.
  await expect.poll(() => win.evaluate(key =>
    window.praxis.ai.listSessions().then(records => records.find(record => record.issueKey === key)?.archived)
  , second.issueKey)).toBe(undefined);

  // Archiving every session must not orphan the restore path: with none left
  // active, the inspector itself becomes the browser.
  await win.evaluate(async keys => {
    for (const key of keys) await window.praxis.ai.archiveSession(key, true);
  }, [first.issueKey, second.issueKey]);
  await expect(win.locator('[data-testid="session-list-row"]')).toHaveCount(0);
  await expect(win.locator('[data-testid="session-browser"]')).toBeVisible();
  const restoreAll = win.locator('[data-testid="session-restore-btn"]');
  await expect(restoreAll).toHaveCount(2);
  await restoreAll.first().click();
  await expect(win.locator('[data-testid="session-list-row"]')).toHaveCount(1);
});
