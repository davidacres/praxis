import * as fs from 'node:fs';
import * as os from 'node:os';
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

test.afterEach(async () => {
  if (app) await closeTestApp(app);
  if (mock) await mock.close();
  if (plansDir) fs.rmSync(plansDir, { recursive: true, force: true });
  app = undefined;
  mock = undefined;
  plansDir = undefined;
});

async function launch(): Promise<Page> {
  mock = await startMockOpenAiCompatibleServer({ reply: REPLY });
  plansDir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-assistant-'));
  const featureDir = path.join(plansDir, 'features', 'feature-01-demo');
  fs.mkdirSync(featureDir, { recursive: true });
  fs.writeFileSync(path.join(featureDir, 'feature.md'), '# Demo Feature\n\n**Status:** 📋 Proposed\n**Type:** Feature\n\n## Description\n\nDemo.\n\n## Items\n\n| Ref | Type | Name | Status |\n| --- | --- | --- | --- |\n| 01.1 | Task | Fix login bug | 📋 Proposed |\n');
  fs.writeFileSync(path.join(featureDir, 'task-01-01-fix-login-bug.md'), '# Fix login bug\n\n**Status:** 📋 Proposed\n**Type:** Task\n**Priority:** Medium\n\n## Description\n\nUsers cannot log in.\n\n## Comments\n');
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
      settings: { roots: [folderPath], projectId: project.id, projectKey: 'TEAM', projectName: 'Team Board' }
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

  // Re-attach: the next turn carries the ticket.
  await win.getByTestId('assistant-context-pill').click();
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
