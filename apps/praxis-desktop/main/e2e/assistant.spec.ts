import * as fs from 'node:fs';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import * as path from 'node:path';
import { expect, test, type Page } from '@playwright/test';
import { closeTestApp, expandAllIssueStacks, launchTestApp, type TestApp } from './launchTestApp';
import { startMockOpenAiCompatibleServer, type MockOpenAiCompatibleServer } from './mockOpenAiCompatibleServer';

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

async function launch(): Promise<Page> {
  replyText = REPLY;
  mock = await startMockOpenAiCompatibleServer({ reply: () => replyText });
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
  await expect(win.getByTestId('assistant-message-lead')).toBeVisible();

  const before = (await win.getByTestId('main-content-pane').boundingBox())!.width;
  await win.getByTestId('assistant-pin').click();
  await expect(win.getByTestId('assistant-docked')).toBeVisible();
  await expect(win.getByTestId('assistant-floating')).toHaveCount(0);
  // Same transcript after the shell changed home.
  await expect(win.getByTestId('assistant-message-lead')).toHaveCount(1);
  await expect(win.getByTestId('assistant-message-user')).toHaveText('hello team');
  const after = (await win.getByTestId('main-content-pane').boundingBox())!.width;
  expect(after).toBeLessThan(before - 200);
  await win.screenshot({ path: path.join(shots, 'assistant-docked.png') });

  await win.keyboard.press('ControlOrMeta+j');
  await expect(win.getByTestId('assistant-docked')).toHaveCount(0);
  await expect.poll(async () => (await win.getByTestId('main-content-pane').boundingBox())!.width).toBeGreaterThan(before - 5);
});

test('an @mention routes to that persona, with choices and a coding-session handoff', async () => {
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
  const chat = mock!.requests.filter(r => r.url.endsWith('/chat/completions')).at(-1)!;
  expect(chat.body).toContain('QA SPECIALIST');
  await win.screenshot({ path: path.join(shots, 'assistant-floating.png') });

  await win.getByRole('button', { name: 'Go deeper' }).click();
  await expect(win.getByTestId('assistant-message-user').last()).toHaveText('go deeper');
  await expect(win.getByTestId('assistant-message-lead')).toBeVisible();

  await win.getByRole('button', { name: 'Open as Coding Session' }).first().click();
  await expect(win.getByTestId('new-session-view')).toBeVisible();
  await expect(win.locator('textarea').filter({ hasText: 'Implement the plan' }).first()).toBeVisible();
});

test('a team review speaks dev, qa, security, then the lead', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-team-review').click();
  await expect(win.getByTestId('assistant-message-lead')).toBeVisible({ timeout: 30000 });
  const order = await win.locator('[data-testid^="assistant-message-"]:not([data-testid="assistant-message-user"])').evaluateAll(
    nodes => nodes.map(node => node.getAttribute('data-testid')!.replace('assistant-message-', ''))
  );
  expect(order).toEqual(['dev', 'qa', 'security', 'lead']);
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
  await expect(win.getByTestId('assistant-message-lead')).toBeVisible();
  let body = mock!.requests.filter(r => r.url.endsWith('/chat/completions')).at(-1)!.body;
  expect(body).not.toContain('[Current Page Context: ');

  // Detaching lasts one message: the pill re-attaches itself and the next turn carries the ticket.
  await expect(win.getByTestId('assistant-context-pill')).not.toHaveClass(/is-detached/);
  await win.getByTestId('assistant-input').fill('review this ticket');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-message-lead')).toHaveCount(2);
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
  await expect(win.getByTestId('assistant-message-lead')).toHaveCount(0);
  await row.locator('.team-chat-main').click();
  await expect(win.getByTestId('assistant-message-lead')).toHaveCount(2);

  // Deleting it removes the record and resets the open transcript.
  await row.hover();
  await row.getByRole('button', { name: /Delete team chat/ }).click();
  await win.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(win.getByTestId('team-chat-row')).toHaveCount(0);
  await expect(win.getByTestId('assistant-message-lead')).toHaveCount(0);
});

async function openIssue(win: Page): Promise<void> {
  await win.locator('.project-board-row').first().click();
  await expandAllIssueStacks(win);
  await win.locator('[data-testid="issue-card"]', { hasText: 'Fix login bug' }).click();
  await expect(win.getByTestId('assistant-context-pill')).toContainText('Issue ');
}

const action = (value: unknown) => `Here is a proposal.\n\`\`\`praxis-assistant\n${JSON.stringify({ action: value })}\n\`\`\``;

test('an update-ticket proposal can be previewed, then applied to the ticket', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-pin').click();
  await openIssue(win);
  replyText = action({ kind: 'update-ticket', label: 'Apply to Ticket', summary: 'Add acceptance criteria', description: 'Users cannot log in.\n\n## Acceptance criteria\n- Login works' });
  await win.getByTestId('assistant-input').fill('add acceptance criteria');
  await win.getByTestId('assistant-send').click();
  await expect(win.getByTestId('assistant-action-card')).toBeVisible();

  await win.getByTestId('assistant-action-preview').click();
  await expect(win.getByTestId('assistant-action-preview-body')).toContainText('Acceptance criteria');
  await win.getByTestId('assistant-action-apply').click();
  await expect(win.getByTestId('assistant-action-card')).toContainText('Ticket description updated.');

  const key = /Issue (\S+)/.exec((await win.getByTestId('assistant-context-pill').textContent()) ?? '')![1];
  const description = await win.evaluate(async issueKey => (await window.praxis.issue.get(issueKey, 'team-board')).description, key);
  expect(description).toContain('Login works');
});

test('a create-subtask proposal creates a new task file under the ticket\'s feature', async () => {
  const win = await launch();
  await win.getByTestId('titlebar-assistant').click();
  await win.getByTestId('assistant-pin').click();
  await openIssue(win);
  replyText = action({ kind: 'create-subtask', label: 'Create Subtask', summary: 'Add a regression test task', title: 'Add login regression test', description: 'Cover the broken login path.' });
  await win.getByTestId('assistant-input').fill('make a test task');
  await win.getByTestId('assistant-send').click();
  await win.getByTestId('assistant-action-apply').click();
  await expect(win.getByTestId('assistant-action-card')).toContainText(/Created TEAM-\S+ under /);
  const featureDir = path.join(plansDir!, 'features', 'feature-01-demo');
  await expect.poll(() => fs.readdirSync(featureDir).filter(name => name.startsWith('task-')).length).toBe(2);
  expect(fs.readdirSync(featureDir).some(name => name.includes('add-login-regression-test'))).toBe(true);
});

test('an update-workflow proposal re-validates and lands on the designer canvas', async () => {
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
  await win.getByTestId('assistant-action-preview').click();
  await expect(win.getByTestId('assistant-action-preview-body')).toContainText('Renamed by the team');
  await win.getByTestId('assistant-action-apply').click();
  await expect(win.getByTestId('assistant-action-card')).toContainText('Applied to the canvas');
  await expect(win.getByTestId('assistant-context-pill')).toContainText('Workflow Renamed by the team');

  // Saving the dirtied canvas persists it.
  await win.locator('.wf-header-save').click();
  await expect.poll(async () => win.evaluate(async id => (await window.praxis.workflows.get(id, 'assistant-wf'))?.name, projectId)).toBe('Renamed by the team');

  // A proposal for some other workflow is refused, not applied.
  replyText = action({ kind: 'update-workflow', label: 'Apply Workflow Changes', summary: 'Wrong one', workflow: { ...workflow, id: 'someone-else' } });
  await win.getByTestId('assistant-input').fill('change another');
  await win.getByTestId('assistant-send').click();
  await win.getByTestId('assistant-action-apply').last().click();
  await expect(win.getByRole('alert')).toContainText('only change the workflow open in this designer');
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
    await expect(win.getByTestId('assistant-message-lead').last()).toBeVisible();
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
  await expect(again.getByTestId('assistant-message-lead')).toBeVisible();
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
  expect(seen).toEqual(expect.arrayContaining(['assistant-new-chat', 'assistant-pin', 'assistant-close', 'assistant-action-preview', 'assistant-action-apply', 'assistant-input', 'assistant-team-review', 'assistant-send']));
  expect(unringed, `assistant controls with no visible focus: ${unringed.join(', ')}`).toEqual([]);

  // Every icon-only button has an accessible name that becomes its tooltip.
  for (const id of ['assistant-new-chat', 'assistant-pin', 'assistant-close', 'assistant-send']) {
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
  await win.getByTestId('assistant-action-preview').click();

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
          chip: sample('.assistant-suggestions .assistant-chip, .assistant-choices .assistant-chip'),
          preview: sample('.assistant-action-preview pre')
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
