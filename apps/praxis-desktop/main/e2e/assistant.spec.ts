import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, expandAllIssueStacks, launchTestApp, type TestApp } from './launchTestApp';
import { startMockOpenAiCompatibleServer, type MockOpenAiCompatibleServer } from './mockOpenAiCompatibleServer';
import { chooseOption } from './chipSelect';

/**
 * FX-BF-050: the app-wide Virtual Team Assistant — summon with ⌘J, float or dock
 * without losing the conversation, @mention a persona, page context that follows
 * navigation, a team review, and persisted Team Chats in the project tree.
 */

const REPLY = 'Looks fine.\n```praxis-assistant\n{"choices":[{"label":"Go deeper","prompt":"go deeper"}],"action":{"kind":"delegate-session","label":"Open as Coding Session","summary":"Hand the plan to an agent","prompt":"Implement the plan"}}\n```';
const shots = path.resolve(process.cwd(), 'output', 'playwright');

let app: TestApp | undefined;
let mock: MockOpenAiCompatibleServer | undefined;
let plansDir: string | undefined;
let replyText = REPLY;

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  if (plansDir) fs.rmSync(plansDir, { recursive: true, force: true });
  app = undefined;
  mock = undefined;
  plansDir = undefined;
  replyText = REPLY;
});

async function launch(responseDelayMs = 0, withToolFolder = false, toolCall?: { name: string; arguments: string }): Promise<Page> {
  replyText = REPLY;
  mock = await startMockOpenAiCompatibleServer({ reply: () => replyText, responseDelayMs, toolCall });
  plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-assistant-'));
  const featureDir = path.join(plansDir, 'features', 'feature-01-demo');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'feature.md'), '# Demo Feature\n\n**Status:** 📋 Proposed\n**Type:** Feature\n\n## Description\n\nDemo.\n\n## Items\n\n| Ref | Type | Name | Status |\n| --- | --- | --- | --- |\n| 01.1 | Task | Fix login bug | 📋 Proposed |\n');
  fs.writeFileSync(path.join(featureDir, 'task-01-01-fix-login-bug.md'), '# Fix login bug\n\n**Status:** 📋 Proposed\n**Type:** Task\n**Priority:** Medium\n\n## Description\n\nUsers cannot log in.\n\n## Comments\n');
  // A real repository with one modified file, so the Git changes page has a diff to describe.
  const git = (...args: string[]) => execFileSync('git', ['-c', 'user.email=e2e@example.com', '-c', 'user.name=E2E', ...args], { cwd: plansDir!, stdio: 'ignore' });
  git('init', '-q');
  git('add', '.');
  git('commit', '-q', '-m', 'initial');
  fs.appendFileSync(path.join(featureDir, 'task-01-01-fix-login-bug.md'), '\nExtra diff line for the team.\n');
  app = await launchTestApp({
    ai: {
      ...(withToolFolder ? { workingDirectory: plansDir } : {}),
      activeProvider: 'custom:mock',
      customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: mock.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }],
      providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } }
    }
  }, undefined, undefined, { openNewSession: false });
  const win = app.window;
  await win.evaluate(async folderPath => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Team Project', key: 'TEAM', type: 'product', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath, planningMode: 'files',
      workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: [], defaultAiToolMode: 'project-only'
    }, workspace.id);
    await window.praxis.connection.add({
      id: 'team-board', name: 'Team board', mode: 'folder',
      settings: { roots: [folderPath], projectId: project.id, projectKey: 'TEAM', projectName: 'Team Board', allowIssueCreation: true }
    });
    localStorage.setItem(`praxis-last-workspace-route:${workspace.id}`, JSON.stringify({ projectId: project.id }));
    localStorage.removeItem('tm-assistant-open');
    localStorage.removeItem('tm-assistant-docked');
  }, plansDir);
  await win.reload();
  await expect(win.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  await expect(win.getByTestId('project-nav-item').first()).toBeVisible();
  return win;
}

test('⌘J summons the floating assistant; pin docks it, keeping the conversation', async () => {
  const win = await launch();
  await expect(win.getByTestId('assistant-launcher')).toBeVisible();
  await win.keyboard.press('ControlOrMeta+j');
  await expect(win.getByTestId('assistant-floating')).toBeVisible();
  await expect(win.getByTestId('assistant-input')).toBeFocused();

  await win.getByTestId('assistant-input').fill('hello team');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-message-dev')).toBeVisible();

  const before = (await win.getByTestId('main-content-pane').boundingBox())!.width;
  await win.getByTestId('assistant-pin').click();
  await expect(win.getByTestId('assistant-docked')).toBeVisible();
  await expect(win.getByTestId('assistant-floating')).toHaveCount(0);
  // Same transcript after the shell changed home.
  await expect(win.getByTestId('assistant-message-dev')).toHaveCount(1);
  await expect(win.getByTestId('assistant-message-user')).toHaveText('hello team');
  const after = (await win.getByTestId('main-content-pane').boundingBox())!.width;
  expect(after).toBeLessThan(before - 200);
  await win.screenshot({ path: path.join(shots, 'assistant-docked.png') });

  await win.keyboard.press('ControlOrMeta+j');
  await expect(win.getByTestId('assistant-docked')).toHaveCount(0);
  await expect.poll(async () => (await win.getByTestId('main-content-pane').boundingBox())!.width).toBeGreaterThan(before - 5);
});

test('floating assistant drags by its header and resizes from its corner', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  const panel = win.getByTestId('assistant-floating');
  const initial = (await panel.boundingBox())!;
  const header = (await win.getByTestId('assistant-drag-handle').boundingBox())!;
  await win.mouse.move(header.x + 260, header.y + 16);
  await win.mouse.down();
  await win.mouse.move(header.x + 170, header.y - 90, { steps: 8 });
  await win.mouse.up();
  const moved = (await panel.boundingBox())!;
  expect(moved.x).toBeLessThan(initial.x - 70);
  expect(moved.y).toBeLessThan(initial.y - 70);
  expect(moved.width).toBe(initial.width);

  const handle = (await win.getByTestId('assistant-floating-resize').boundingBox())!;
  await win.mouse.move(handle.x + 8, handle.y + 8);
  await win.mouse.down();
  await win.mouse.move(handle.x - 72, handle.y + 58, { steps: 8 });
  await win.mouse.up();
  const resized = (await panel.boundingBox())!;
  expect(resized.width).toBeGreaterThan(moved.width + 60);
  expect(resized.height).toBeGreaterThan(moved.height + 40);
  await expect(win.getByTestId('assistant-provider')).toBeVisible();
  await expect(win.getByTestId('assistant-send')).toBeVisible();
  await win.getByTestId('assistant-member-qa').click();
  await expect(win.getByTestId('assistant-member-qa')).toHaveAttribute('aria-pressed', 'true');
  await panel.screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'assistant-floating-resized.png') });
});

test('assistant composer selects provider, model, reasoning, and permission mode for the next turn', async () => {
  const win = await launch();
  await win.getByTestId('session-focus-new').click();
  const sessionCard = win.getByTestId('new-session-view').locator('.session-follow-up-composer');
  await expect(sessionCard).toBeVisible();
  await win.getByTestId('new-session-view').locator('.session-follow-up-composer').screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'standard-session-composer-reference.png') });
  await win.getByTestId('titlebar-assistant').click();
  const assistantCard = win.getByTestId('assistant-panel').locator('.assistant-composer');
  await expect(assistantCard).toBeVisible();
  await win.getByTestId('assistant-close').focus();
  const cardStyles = async (selector: string) => win.locator(selector).evaluate(element => {
    const style = getComputedStyle(element);
    return { background: style.backgroundColor, border: style.borderColor, radius: style.borderRadius };
  });
  await assistantCard.screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'assistant-composer-comparison.png') });
  const assistantStyle = await cardStyles('.assistant-composer');
  const sessionStyle = await cardStyles('#root [data-testid="new-session-view"] .session-follow-up-composer');
  expect(assistantStyle.background).toBe(sessionStyle.background);
  expect(assistantStyle.radius).toBe(sessionStyle.radius);
  await expect(win.getByTestId('assistant-context-indicator')).toHaveAttribute('aria-label', 'Context usage unavailable');
  await expect(win.getByTestId('assistant-panel').getByTestId('session-usage-summary')).toContainText('Team chat usage unavailable');
  await expect(win.getByTestId('assistant-provider')).toContainText('Mock');
  await expect(win.getByTestId('assistant-model')).toContainText('mock-model');
  await expect(win.getByTestId('assistant-reasoning')).toHaveAttribute('data-value', 'medium');
  await expect(win.getByTestId('assistant-mode-chat')).toHaveAttribute('aria-pressed', 'true');
  await expect(win.getByTestId('assistant-tool-mode')).toHaveAttribute('data-value', 'project-only');
  await expect(win.getByTestId('assistant-working-directory')).toContainText('Attach folder');
  await win.getByTestId('assistant-mode-analysis').click();
  await expect(win.getByTestId('assistant-mode-analysis')).toHaveAttribute('aria-pressed', 'true');

  const reasoning = win.locator('[data-testid="assistant-reasoning"] input');
  await reasoning.focus();
  await reasoning.press('End');
  await expect(win.getByTestId('assistant-reasoning')).toHaveAttribute('data-value', 'high');

  await win.getByTestId('assistant-permission-chip').click();
  const permissionMenu = win.getByRole('listbox', { name: 'Permission mode' });
  await expect(permissionMenu).toBeVisible();
  await win.getByTestId('assistant-permission-option-auto').click();
  await expect(win.getByTestId('assistant-permission-chip')).toContainText('Auto');
  const toolbar = win.getByTestId('assistant-panel').locator('.assistant-composer .composer-controls');
  await expect(toolbar.getByTestId('assistant-provider')).toBeVisible();
  await expect(toolbar.getByTestId('assistant-model')).toBeVisible();
  await expect(toolbar.getByTestId('assistant-send')).toBeVisible();
  const floatingWidth = (await win.getByTestId('assistant-floating').boundingBox())!.width;
  expect(floatingWidth).toBeGreaterThanOrEqual(520);
  const chipRow = await win.getByTestId('assistant-composer-options').evaluate(element => {
    const children = [...element.children] as HTMLElement[];
    return children.map(child => ({ top: child.getBoundingClientRect().top, right: child.getBoundingClientRect().right }));
  });
  expect(Math.max(...chipRow.map(chip => chip.top)) - Math.min(...chipRow.map(chip => chip.top)), JSON.stringify(chipRow)).toBeLessThan(8);
  expect(Math.max(...chipRow.map(chip => chip.right))).toBeLessThan((await win.getByTestId('assistant-send').boundingBox())!.x);
  expect(Math.abs((await win.getByTestId('assistant-input').boundingBox())!.height - (await win.getByTestId('new-session-view').locator('textarea').boundingBox())!.height)).toBeLessThanOrEqual(2);

  await win.getByTestId('assistant-input').fill('Use the selected runtime settings');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-message-dev')).toBeVisible();
  const request = mock!.requests.filter(r => r.url.endsWith('/chat/completions')).at(-1)!;
  const body = JSON.parse(request.body) as { model: string; messages: Array<{ content: string }> };
  expect(body.model).toBe('mock-model');
  expect(body.messages[0]?.content).toContain('Use high reasoning effort.');
  expect(body.messages[0]?.content).toContain('Analyze the user request and available context.');
  await win.getByTestId('assistant-panel').screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'assistant-composer-runtime-controls.png') });
  await win.getByTestId('assistant-pin').click();
  await expect(win.getByTestId('assistant-docked')).toBeVisible();
  expect((await win.getByTestId('assistant-docked').boundingBox())!.width).toBeGreaterThanOrEqual(500);
  await win.getByTestId('assistant-docked').screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'assistant-composer-wide-docked.png') });
});

test('assistant composer collapses and animates its border while the team replies', async () => {
  const win = await launch(1800);
  await win.getByTestId('titlebar-assistant').click();
  const composer = win.getByTestId('assistant-composer');
  const expandedHeight = (await composer.boundingBox())!.height;
  await win.getByTestId('assistant-input').fill('Check the running state');
  await win.getByTestId('assistant-send').click();
  await expect(composer).toHaveClass(/is-collapsed/);
  await expect(composer).toHaveClass(/is-running/);
  await expect(win.getByTestId('assistant-composer-activity-orbit')).toBeVisible();
  const capsule = win.getByTestId('assistant-composer-activity-orbit').locator('[data-activity-capsule="true"]');
  const initialTransform = await capsule.getAttribute('transform');
  await expect.poll(() => capsule.getAttribute('transform')).not.toBe(initialTransform);
  await expect(win.getByTestId('assistant-composer-activity-chip')).toContainText('The team is thinking');
  await expect(win.getByTestId('assistant-send')).toHaveCount(0);
  await expect.poll(async () => (await composer.boundingBox())!.height).toBeLessThan(expandedHeight - 12);
  await composer.screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'assistant-composer-running.png') });
  await expect(win.getByTestId('assistant-message-dev')).toBeVisible();
  await expect(composer).not.toHaveClass(/is-collapsed/);
  await expect(win.getByTestId('assistant-send')).toBeVisible();
});

test('assistant full tools uses the selected working folder through an agent session', async () => {
  const win = await launch(0, false, { name: 'read_file', arguments: JSON.stringify({ path: 'features/feature-01-demo/task-01-01-fix-login-bug.md' }) });
  await app!.electronApp.evaluate(({ ipcMain }, folder) => {
    ipcMain.removeHandler('dialog:pickFolder');
    ipcMain.handle('dialog:pickFolder', () => folder);
  }, plansDir!);
  await win.getByTestId('titlebar-assistant').click();
  await expect(win.getByTestId('assistant-working-directory')).toContainText('Attach folder');
  await chooseOption(win.getByTestId('assistant-tool-mode'), 'full');
  await expect(win.getByTestId('assistant-tool-mode')).toHaveAttribute('data-value', 'full');
  await expect(win.getByTestId('assistant-working-directory')).toContainText(path.basename(plansDir!));
  await win.getByTestId('assistant-input').fill('Inspect the working folder and answer.');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-tool-permission')).toBeVisible({ timeout: 15000 });
  await win.getByTestId('assistant-tool-permission').getByRole('button', { name: 'Allow' }).click();
  await expect(win.getByTestId('assistant-message-dev')).toBeVisible({ timeout: 30000 });
  const sessions = await win.evaluate(() => window.praxis.ai.listSessions());
  const toolTurn = sessions.find(session => session.issueKey.startsWith('ASSISTANT-'));
  expect(toolTurn).toBeDefined();
  expect(toolTurn!.toolMode).toBe('full');
  expect(toolTurn!.workingDirectory).toBe(plansDir);
  expect(mock!.requests.some(request => request.url.endsWith('/chat/completions') && JSON.parse(request.body).tools?.length > 0)).toBe(true);
  expect(mock!.requests.some(request => request.url.endsWith('/chat/completions') && request.body.includes('Users cannot log in.'))).toBe(true);
  await win.getByTestId('assistant-panel').screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'assistant-full-tools.png') });
});

test('an @mention routes to that persona and transcript suggestions are read-only', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  const input = win.getByTestId('assistant-input');
  await input.fill('@q');
  await expect(win.getByTestId('assistant-mention-menu')).toBeVisible();
  await input.press('Enter');
  await expect(input).toHaveValue('@qa ');
  await input.pressSequentially('what edge cases should I test?');
  await input.press('Enter');

  await expect(win.getByTestId('assistant-message-qa')).toBeVisible();
  await expect(win.locator('.persona-badge--qa').first()).toBeVisible();
  await expect(win.getByTestId('assistant-message-suggestions')).toHaveText('Suggestions: Go deeper');
  await expect(win.getByTestId('assistant-action-card')).toContainText('Suggested action: Hand the plan to an agent');
  await expect(win.getByTestId('assistant-message-qa').getByRole('button')).toHaveCount(0);
  await expect(win.getByTestId('assistant-feed').getByRole('button')).toHaveCount(0);
  await expect(win.getByTestId('assistant-member-dev')).toHaveAttribute('aria-pressed', 'true');
  await expect(win.getByTestId('assistant-send')).toBeVisible();
  const chat = mock!.requests.filter(r => r.url.endsWith('/chat/completions')).at(-1)!;
  expect(chat.body).toContain('QA SPECIALIST');
  await win.getByTestId('assistant-panel').screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'assistant-chat-no-message-buttons.png') });

  await expect(win.getByTestId('assistant-message-qa').getByText('Open as Coding Session')).toHaveCount(0);
  await win.getByTestId('assistant-input').fill('go deeper');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-message-user').last()).toHaveText('go deeper');
  await expect(win.getByTestId('assistant-message-dev')).toBeVisible();
});

test('selected team members reply in order, then the selected lead synthesises', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await expect(win.getByTestId('assistant-member-dev')).toHaveAttribute('aria-pressed', 'true');
  await expect(win.getByTestId('assistant-member-qa')).toHaveAttribute('aria-pressed', 'false');
  await win.getByTestId('assistant-member-qa').click();
  await win.getByTestId('assistant-member-security').click();
  await win.getByTestId('assistant-member-lead').click();
  await expect(win.getByTestId('assistant-team-review')).toHaveCount(0);
  await win.getByTestId('assistant-input').fill('Review this page as a team');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-message-lead')).toBeVisible({ timeout: 30000 });
  const order = await win.locator('[data-testid^="assistant-message-"]:not([data-testid="assistant-message-user"])').evaluateAll(
    nodes => nodes
      .map(node => node.getAttribute('data-testid')!)
      .filter(testId => testId !== 'assistant-message-suggestions')
      .map(testId => testId.replace('assistant-message-', ''))
  );
  expect(order).toEqual(['dev', 'qa', 'security', 'lead']);
  await win.getByTestId('assistant-panel').screenshot({ path: path.resolve(process.cwd(), '..', '.praxis', 'session-artifacts', 'assistant-selectable-team.png') });
});

test('deselecting every seat sends a general chat to the Tech Lead', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-member-dev').click();
  await expect(win.getByTestId('assistant-member-dev')).toHaveAttribute('aria-pressed', 'false');
  await win.getByTestId('assistant-input').fill('A general question');
  await expect(win.getByTestId('assistant-send')).toHaveAttribute('aria-label', 'Send general chat');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-message-lead')).toBeVisible();
  await expect(win.getByTestId('assistant-message-dev')).toHaveCount(0);
});

test('page context follows navigation, can be detached, and chats persist in the tree', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-pin').click();

  await win.locator('.project-board-row').first().click();
  await expandAllIssueStacks(win);
  await expect(win.getByTestId('assistant-context-pill')).toContainText('Board');
  await expect(win.getByTestId('assistant-suggestions')).toContainText('Summarize blocked tickets');

  await win.locator('[data-testid="issue-card"]', { hasText: 'Fix login bug' }).click();
  await expect(win.getByTestId('assistant-context-pill')).toContainText('Issue ');

  // Detach: the turn is sent without the page context block.
  await win.getByTestId('assistant-context-pill').click();
  await win.getByTestId('assistant-input').fill('general question');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-message-dev')).toBeVisible();
  let body = mock!.requests.filter(r => r.url.endsWith('/chat/completions')).at(-1)!.body;
  expect(body).not.toContain('[Current Page Context: ');

  // Detaching lasts one message: the pill re-attaches itself and the next turn carries the ticket.
  await expect(win.getByTestId('assistant-context-pill')).not.toHaveClass(/is-detached/);
  await win.getByTestId('assistant-input').fill('review this ticket');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-message-dev')).toHaveCount(2);
  body = mock!.requests.filter(r => r.url.endsWith('/chat/completions')).at(-1)!.body;
  expect(body).toContain('[Current Page Context: Issue ');
  expect(body).toContain('Users cannot log in.');

  // The conversation is now a Team Chat in the project tree.
  const row = win.getByTestId('team-chat-row');
  await expect(row).toHaveCount(1);
  await expect(row).toContainText('general question');
  await win.screenshot({ path: path.join(shots, 'assistant-team-chats-tree.png') });

  // New chat clears the feed; opening the saved chat restores it.
  await win.getByTestId('assistant-new-chat').click();
  await expect(win.getByTestId('assistant-message-dev')).toHaveCount(0);
  await row.locator('.team-chat-main').click();
  await expect(win.getByTestId('assistant-message-dev')).toHaveCount(2);

  // Deleting it removes the record and resets the open transcript.
  await row.hover();
  await row.getByRole('button', { name: /Delete team chat/ }).click();
  await win.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(win.getByTestId('team-chat-row')).toHaveCount(0);
  await expect(win.getByTestId('assistant-message-dev')).toHaveCount(0);
});

async function openIssue(win: Page): Promise<void> {
  await win.locator('.project-board-row').first().click();
  await expandAllIssueStacks(win);
  await win.locator('[data-testid="issue-card"]', { hasText: 'Fix login bug' }).click();
  await expect(win.getByTestId('assistant-context-pill')).toContainText('Issue ');
}

const action = (value: unknown) => `Here is a proposal.\n\`\`\`praxis-assistant\n${JSON.stringify({ action: value })}\n\`\`\``;

test('an update-ticket proposal is informational and has no transcript controls', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-pin').click();
  await openIssue(win);
  replyText = action({ kind: 'update-ticket', label: 'Apply to Ticket', summary: 'Add acceptance criteria', description: 'Users cannot log in.\n\n## Acceptance criteria\n- Login works' });
  await win.getByTestId('assistant-input').fill('add acceptance criteria');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-action-card')).toBeVisible();
  await expect(win.getByTestId('assistant-message-dev').getByRole('button')).toHaveCount(0);
  await expect(win.getByTestId('assistant-action-card')).toContainText('Suggested action: Add acceptance criteria');

  const key = /Issue (\S+)/.exec((await win.getByTestId('assistant-context-pill').textContent()) ?? '')![1];
  const description = await win.evaluate(async issueKey => (await window.praxis.issue.get(issueKey, 'team-board')).description, key);
  expect(description).toBe('Users cannot log in.');
});

test('a create-subtask proposal does not create a task without a composer send', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-pin').click();
  await openIssue(win);
  replyText = action({ kind: 'create-subtask', label: 'Create Subtask', summary: 'Add a regression test task', title: 'Add login regression test', description: 'Cover the broken login path.' });
  await win.getByTestId('assistant-input').fill('make a test task');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-action-card')).toContainText('Suggested action: Add a regression test task');
  await expect(win.getByTestId('assistant-message-dev').getByRole('button')).toHaveCount(0);
  const featureDir = path.join(plansDir!, 'features', 'feature-01-demo');
  expect(fs.readdirSync(featureDir).filter(name => name.startsWith('task-'))).toHaveLength(1);
});

test('an update-workflow proposal is informational and leaves the workflow unchanged', async () => {
  const win = await launch();
  const { projectId, workflow } = await win.evaluate(async () => {
    const project = (await window.praxis.projects.list())[0];
    const now = new Date().toISOString();
    const definition = {
      schemaVersion: 1, id: 'assistant-wf', name: 'Original flow', scope: 'project', projectId: project.id, version: 1,
      entryNodeId: 'verify', createdAt: now, updatedAt: now,
      nodes: [{ type: 'check', id: 'verify', name: 'Verify', x: 0, y: 0, inputs: [], command: 'true', successExitCodes: [0], timeoutMs: 30000, outputs: [{ id: 'log', kind: 'log', required: false }] }],
      edges: []
    };
    await window.praxis.workflows.save(project.id, definition as never);
    const workspace = (await window.praxis.workspaces.list())[0];
    localStorage.setItem(`praxis-last-workspace-route:${workspace.id}`, JSON.stringify({ projectId: project.id, feature: 'workflows', workflowId: 'assistant-wf' }));
    return { projectId: project.id, workflow: definition };
  });
  await win.reload();
  await expect(win.getByTestId('startup-splash')).toHaveCount(0, { timeout: 15000 });
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-pin').click();
  await expect(win.getByTestId('assistant-context-pill')).toContainText('Workflow Original flow');
  expect(projectId).toBeTruthy();

  replyText = action({ kind: 'update-workflow', label: 'Apply Workflow Changes', summary: 'Rename the workflow', workflow: { ...workflow, name: 'Renamed by the team' } });
  await win.getByTestId('assistant-input').fill('rename it');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-action-card')).toContainText('Suggested action: Rename the workflow');
  await expect(win.getByTestId('assistant-message-lead').getByRole('button')).toHaveCount(0);
  await expect(win.getByTestId('assistant-context-pill')).toContainText('Workflow Original flow');
  expect(await win.evaluate(async id => (await window.praxis.workflows.get(id, 'assistant-wf'))?.name, projectId)).toBe('Original flow');

  // A proposal for some other workflow is refused, not applied.
  replyText = action({ kind: 'update-workflow', label: 'Apply Workflow Changes', summary: 'Wrong one', workflow: { ...workflow, id: 'someone-else' } });
  await win.getByTestId('assistant-input').fill('change another');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-action-card').last()).toContainText('Suggested action: Wrong one');
  await expect(win.getByRole('alert')).toHaveCount(0);
});

test('Git changes context carries the file list and the diff hunks', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-pin').click();
  await win.getByRole('button', { name: 'Git changes for Team Project' }).click();
  await expect(win.getByTestId('assistant-context-pill')).toContainText('Git changes');
  await expect(win.getByTestId('assistant-suggestions')).toContainText('Draft conventional commit message');
  // Hunks arrive asynchronously after the file list.
  await expect.poll(async () => {
    await win.getByTestId('assistant-input').fill('summarise');
    await win.getByTestId('assistant-send').click();
    await expect(win.getByTestId('assistant-message-dev').last()).toBeVisible();
    return mock!.requests.filter(r => r.url.endsWith('/chat/completions')).at(-1)!.body.includes('Extra diff line for the team.');
  }, { timeout: 20000 }).toBe(true);
  const body = mock!.requests.filter(r => r.url.endsWith('/chat/completions')).at(-1)!.body;
  expect(body).toContain('task-01-01-fix-login-bug.md');
  expect(body).toContain('+Extra diff line for the team.');
});

test('a chat can be renamed, survives an app restart, and the docked width persists', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-pin').click();
  await win.getByTestId('assistant-input').fill('persist me');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('team-chat-row')).toContainText('persist me');

  // Rename from the tree (double-click opens the in-app prompt).
  await win.locator('.team-chat-main').dblclick();
  await win.getByRole('dialog').getByRole('textbox').fill('Login review');
  await win.getByRole('dialog').getByRole('button', { name: /^(OK|Save|Confirm|Rename)$/ }).click();
  await expect(win.getByTestId('team-chat-row')).toContainText('Login review');

  // Drag the divider to widen the dock, then confirm it was stored.
  const dock = win.getByTestId('assistant-docked');
  const before = (await dock.boundingBox())!.width;
  const handle = (await win.getByRole('separator', { name: 'Resize assistant' }).boundingBox())!;
  await win.mouse.move(handle.x + handle.width / 2, handle.y + 200);
  await win.mouse.down();
  await win.mouse.move(handle.x - 120, handle.y + 200, { steps: 8 });
  await win.mouse.up();
  const widened = (await dock.boundingBox())!.width;
  expect(widened).toBeGreaterThan(before + 60);
  expect(Math.abs(Number(await win.evaluate(() => localStorage.getItem('tm-assistant-width'))) - widened)).toBeLessThan(1);

  // Restart on the same profile.
  const { userDataDir, settingsPath } = app!;
  await app!.electronApp.close();
  app = await launchTestApp(undefined, { userDataDir, settingsPath }, undefined, { openNewSession: false });
  const again = app.window;
  await expect(again.getByTestId('assistant-docked')).toBeVisible();
  expect(Math.abs((await again.getByTestId('assistant-docked').boundingBox())!.width - widened)).toBeLessThan(2);
  await expect(again.getByTestId('team-chat-row')).toContainText('Login review');
  await again.locator('.team-chat-main').click();
  await expect(again.getByTestId('assistant-message-user')).toHaveText('persist me');
  await expect(again.getByTestId('assistant-message-dev')).toBeVisible();
});

test('the assistant IPC reports a missing provider as an error message, not a crash', async () => {
  app = await launchTestApp({ ai: { activeProvider: 'claude-code-cli' } }, undefined, undefined, { openNewSession: false });
  const result = await app.window.evaluate(async () => window.praxis.assistant.turn({ message: 'hello' }));
  expect(result.messages).toHaveLength(1);
  expect(result.messages[0]).toMatchObject({ role: 'lead', error: true });
  await expect(app.window.evaluate(async () => window.praxis.assistant.turn({ message: '   ' }))).rejects.toThrow(/Ask the team/);
  const chat = await app.window.evaluate(async () => {
    const created = await window.praxis.assistant.createChat('p1');
    await window.praxis.assistant.saveChat(created.id, [{ id: 'm1', role: 'user', text: 'First question here', createdAt: new Date().toISOString() }]);
    const listed = await window.praxis.assistant.listChats('p1');
    const other = await window.praxis.assistant.listChats('p2');
    await window.praxis.assistant.deleteChat(created.id);
    return { listed, other, after: await window.praxis.assistant.getChat(created.id) };
  });
  expect(chat.listed[0]).toMatchObject({ title: 'First question here', messageCount: 1 });
  expect(chat.other).toHaveLength(0);
  expect(chat.after).toBeUndefined();
});

test('every persona renders with its own distinct colour and a readable badge', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-pin').click();
  for (const role of ['lead', 'dev', 'qa', 'security', 'product']) {
    await win.getByTestId('assistant-input').fill(`@${role} hello`);
    await win.getByTestId('assistant-send').click();
    await expect(win.getByTestId(`assistant-message-${role}`)).toBeVisible();
  }
  const tones = await win.evaluate(() => ['lead', 'dev', 'qa', 'security', 'product'].map(role => {
    const badge = document.querySelector(`[data-testid="assistant-message-${role}"] .persona-badge`) as HTMLElement;
    return getComputedStyle(badge).borderTopColor;
  }));
  expect(new Set(tones).size).toBe(5);
  await win.getByTestId('assistant-feed').screenshot({ path: path.join(shots, 'assistant-personas.png') });
});

test('the assistant\'s controls show a focus ring and carry tooltips', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-pin').click();
  await win.getByTestId('assistant-input').fill('hello');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-action-card')).toBeVisible();

  // Tab through the whole panel.
  await win.getByTestId('assistant-input').fill('draft'); // an empty draft leaves Send disabled, and so out of the tab order
  // Reach the first control by keyboard: a programmatic focus() is not :focus-visible and would show no ring.
  await win.getByTestId('assistant-pin').focus();
  await win.keyboard.press('Shift+Tab');
  const seen: string[] = [];
  const unringed: string[] = [];
  for (let step = 0; step < 20; step += 1) {
    const focused = await win.evaluate(() => {
      const el = document.activeElement as HTMLElement | null;
      if (!el || !el.closest('[data-testid="assistant-panel"]')) return undefined;
      const style = getComputedStyle(el);
      const composer = el.closest('.assistant-composer');
      return {
        name: el.getAttribute('data-testid') ?? el.getAttribute('aria-label') ?? el.textContent?.trim() ?? el.tagName,
        painted: style.outlineStyle !== 'none' && style.outlineWidth !== '0px',
        // The composer box rings its container on focus-within instead of the bare textarea.
        containerRing: Boolean(composer) && getComputedStyle(composer!).boxShadow !== 'none'
      };
    });
    if (focused) {
      seen.push(focused.name);
      if (!focused.painted && !focused.containerRing) unringed.push(focused.name);
    }
    await win.keyboard.press('Tab');
  }
  expect(seen).toEqual(expect.arrayContaining(['assistant-new-chat', 'assistant-pin', 'assistant-close', 'assistant-input', 'assistant-send']));
  expect(unringed, `assistant controls with no visible focus: ${unringed.join(', ')}`).toEqual([]);

  // The roster precedes the header actions, so walk back from Close to reach it
  // with keyboard modality and prove the persona toggle gets a visible ring.
  await win.getByTestId('assistant-close').focus();
  await win.keyboard.press('Shift+Tab');
  await win.keyboard.press('Shift+Tab');
  await win.keyboard.press('Shift+Tab');
  const memberFocus = await win.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    const style = el ? getComputedStyle(el) : undefined;
    return {
      name: el?.getAttribute('data-testid'),
      painted: Boolean(style && style.outlineStyle !== 'none' && style.outlineWidth !== '0px')
        || Boolean(el && getComputedStyle(el).boxShadow !== 'none')
    };
  });
  expect(memberFocus.name).toBe('assistant-member-product');
  expect(memberFocus.painted).toBe(true);

  // Every icon-only button has an accessible name that becomes its tooltip.
  for (const id of ['assistant-member-lead', 'assistant-member-dev', 'assistant-member-qa', 'assistant-member-security', 'assistant-member-product', 'assistant-new-chat', 'assistant-pin', 'assistant-close', 'assistant-send']) {
    const button = win.getByTestId(id);
    await button.hover();
    expect((await button.getAttribute('aria-label'))?.length ?? 0).toBeGreaterThan(3);
    await expect(button).toHaveAttribute('title', /.+/);
  }
});

test('the assistant stays readable on every theme and surface pack', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-pin').click();
  await win.getByTestId('assistant-input').fill('@qa hello');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-action-card')).toBeVisible();

  const themes = ['praxis-dark', 'praxis-light', 'github-dark', 'github-light', 'dracula-dark', 'nord-dark', 'solarized-light', 'catppuccin-latte', 'tokyo-night', 'xcode-light', 'humanist-light', 'tm-default-1'];
  const packs = ['flat', 'parchment', 'graphite', 'aurora-glass', 'noir'];
  const failures: string[] = [];
  const darkOnly = new Set(['noir']);
  for (const theme of themes) {
    for (const pack of packs) {
      const result = await win.evaluate(([themeId, packId]) => {
        const root = document.documentElement;
        const dark = /dark|mocha|night|dracula|nord|monokai|one-dark|rose-pine|tm-default-1|gruvbox|vscode-dark|rider|xcode-dark/.test(themeId);
        root.setAttribute('data-mode', dark ? 'dark' : 'light');
        root.setAttribute('data-theme', themeId);
        root.setAttribute('data-surface', packId);
        const parse = (color: string): [number, number, number, number] => {
          const canvas = document.createElement('canvas');
          canvas.width = canvas.height = 1;
          const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
          ctx.clearRect(0, 0, 1, 1);
          ctx.fillStyle = color;
          ctx.fillRect(0, 0, 1, 1);
          const d = ctx.getImageData(0, 0, 1, 1).data;
          return [d[0], d[1], d[2], d[3] / 255];
        };
        const over = (top: [number, number, number, number], bottom: [number, number, number]): [number, number, number] =>
          [0, 1, 2].map(i => top[i] * top[3] + bottom[i] * (1 - top[3])) as [number, number, number];
        /** The colour actually behind an element: every ancestor fill composited down to the window. */
        const ground = (el: Element): [number, number, number] => {
          const chain: Element[] = [];
          for (let node: Element | null = el; node; node = node.parentElement) chain.push(node);
          let base: [number, number, number] = [255, 255, 255];
          for (const node of chain.reverse()) base = over(parse(getComputedStyle(node).backgroundColor), base);
          return base;
        };
        const lum = ([r, g, b]: [number, number, number]) => {
          const f = (v: number) => { const c = v / 255; return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
          return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
        };
        const ratio = (el: Element) => {
          const bg = ground(el);
          const fg = parse(getComputedStyle(el).color);
          const text = over(fg, bg);
          const [hi, lo] = [lum(text), lum(bg)].sort((a, b) => b - a);
          return (hi + 0.05) / (lo + 0.05);
        };
        const sample = (selector: string) => ratio(document.querySelector(selector)!);
        // What the theme itself achieves for its own text on the panel: the assistant must not do worse than the palette.
        const panel = document.querySelector('[data-testid="assistant-panel"]')!;
        const themeText = over(parse(getComputedStyle(document.documentElement).getPropertyValue('--text').trim() || '#000'), ground(panel));
        const [bh, bl] = [lum(themeText), lum(ground(panel))].sort((a, b) => b - a);
        const baseline = (bh + 0.05) / (bl + 0.05);
        return {
          baseline,
          body: sample('[data-testid="assistant-message-qa"] .assistant-message-body p'),
          badge: sample('[data-testid="assistant-message-qa"] .persona-badge span'),
          name: sample('[data-testid="assistant-message-qa"] .assistant-message-head strong'),
          user: sample('[data-testid="assistant-message-user"] span'),
          suggestions: sample('.assistant-message-suggestions'),
          proposal: sample('.assistant-action-summary span')
        };
      }, [theme, pack] as const);
      if (darkOnly.has(pack) && !/dark|mocha|night|dracula|nord|tm-default-1/.test(theme)) continue;
      const { baseline, ...parts } = result;
      // WCAG AA is 4.5:1, but a palette whose own text is lower (solarized-light) sets the ceiling; a tinted badge may lose 0.3.
      const bar = Math.min(4.5, baseline) - 0.05;
      for (const [part, value] of Object.entries(parts)) {
        const allowed = part === 'badge' ? bar - 0.3 : bar;
        if (value < allowed) failures.push(`${theme}/${pack}: ${part} ${value.toFixed(2)}:1 (needs ${allowed.toFixed(2)}, theme text is ${baseline.toFixed(2)}:1)`);
      }
    }
  }
  expect(failures, failures.join('\n')).toEqual([]);

  // Capture a spread for a human to look at.
  for (const [theme, pack] of [['praxis-dark', 'flat'], ['praxis-light', 'parchment'], ['github-light', 'graphite'], ['dracula-dark', 'aurora-glass'], ['praxis-dark', 'noir']]) {
    await win.evaluate(([t, p]) => {
      const root = document.documentElement;
      root.setAttribute('data-theme', t);
      root.setAttribute('data-surface', p);
      root.setAttribute('data-mode', /dark/.test(t) ? 'dark' : 'light');
    }, [theme, pack]);
    await win.getByTestId('assistant-docked').screenshot({ path: path.join(shots, `assistant-${theme}-${pack}.png`) });
  }
});

test('the composer grows with its text up to six lines, then scrolls', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  const input = win.getByTestId('assistant-input');
  const initial = (await input.boundingBox())!.height;
  await input.fill('one\ntwo\nthree');
  const three = (await input.boundingBox())!.height;
  expect(three).toBeGreaterThan(initial);
  await input.fill(Array.from({ length: 14 }, (_, i) => `line ${i + 1}`).join('\n'));
  const metrics = await input.evaluate(el => {
    const style = getComputedStyle(el);
    const line = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.3;
    return { height: el.getBoundingClientRect().height, line, scrolls: el.scrollHeight > el.clientHeight };
  });
  expect(metrics.height).toBeGreaterThan(three);
  expect(metrics.height).toBeLessThanOrEqual(metrics.line * 6 + 40); // six lines plus the box's padding
  expect(metrics.scrolls).toBe(true);
  await input.fill('');
  expect((await input.boundingBox())!.height).toBeLessThanOrEqual(initial + 1);
});
