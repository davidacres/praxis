import { test, expect, type Page } from '@playwright/test';
import * as path from 'node:path';
import * as fs from 'node:fs';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { startMockOpenAiCompatibleServer, type MockOpenAiCompatibleServer } from './mockOpenAiCompatibleServer';

/**
 * TASK-487 (FX-BE-184): the release journey through the built app, in one profile and one
 * repository, so the hand-driven checks are reproducible. Each step leaves a capture under
 * .praxis/session-artifacts/ (git-ignored). Clicks and focus, never hover: a screenshot ends
 * hover in this harness. Functional project only; not in the smoke set.
 */
let app: TestApp | undefined;
let mock: MockOpenAiCompatibleServer | undefined;
test.afterEach(async () => { if (app) await closeTestApp(app); if (mock) await mock.close(); app = undefined; mock = undefined; });

const artifacts = path.resolve(__dirname, '../../../../.praxis/session-artifacts');
async function capture(win: Page, step: string): Promise<void> {
  fs.mkdirSync(artifacts, { recursive: true });
  await win.screenshot({ path: path.join(artifacts, `fx-be-184-journey-${step}.png`) });
}
const completions = (server: MockOpenAiCompatibleServer) => server.requests.filter(request => request.url.endsWith('/chat/completions')).length;
const turnStates = (userDataDir: string): string[] => {
  const file = path.join(userDataDir, 'team-chats.json');
  if (!fs.existsSync(file)) return [];
  const snapshot = JSON.parse(fs.readFileSync(file, 'utf8')) as { conversations: Array<{ turns: Array<{ state: string }> }> };
  return snapshot.conversations.flatMap(c => c.turns.map(t => t.state));
};

test('journey: float and dock, sidebar row, queue and cancel, Stop, restart mid-reply, retry, transcript and usage survive', async () => {
  test.setTimeout(120000);
  let openGate!: () => void;
  const responseGate = new Promise<void>(resolve => { openGate = resolve; });
  mock = await startMockOpenAiCompatibleServer({ reply: 'Journey answer', responseGate });
  try {
    app = await launchTestApp({ ai: { activeProvider: 'custom:mock', customProviders: [{ id: 'custom:mock', label: 'Mock', protocol: 'openai-chat', baseUrl: mock.baseUrl, apiPath: '/v1', auth: { kind: 'none' }, manualModels: ['mock-model'] }], providers: { 'custom:mock': { defaultModel: 'mock-model', enabled: true, added: true } } } }, undefined, undefined, { openNewSession: false });
    let win = app.window;
    await win.evaluate(async folderPath => {
      const workspace = (await window.praxis.workspaces.list())[0];
      const project = await window.praxis.projects.create({ name: 'Journey project', key: 'JRN', type: 'product', purpose: '', brief: {}, startingPoint: 'existing-folder', folderPath, planningMode: 'files', workflowStages: [{ id: 'todo', name: 'Todo', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }], starterTickets: [], defaultAiToolMode: 'project-only' }, workspace.id);
      localStorage.setItem(`praxis-last-workspace-route:${workspace.id}`, JSON.stringify({ projectId: project.id }));
      localStorage.removeItem('tm-assistant-open');
      localStorage.removeItem('tm-assistant-docked');
      await window.praxis.assistant.createChat(project.id);
    }, app.userDataDir);
    await win.reload();

    // 1. Sidebar (project scope): the team chat is one row in the project's feed.
    await expect(win.getByTestId('sidebar-project-select')).toContainText('Journey project');
    await expect(win.getByTestId('team-chat-row')).toHaveCount(1);
    await win.getByTestId('team-chat-row').locator('.team-chat-main').click();
    // 2. Float, then dock: one transcript, two homes.
    await expect(win.getByTestId('assistant-floating')).toBeVisible();
    await capture(win, '01-floating');
    await win.getByTestId('assistant-pin').click();
    await expect(win.getByTestId('assistant-docked')).toBeVisible();
    await expect(win.getByTestId('assistant-floating')).toHaveCount(0);

    // 3. Queue two turns, cancel the queued one, Stop the active one.
    await win.getByTestId('assistant-input').fill('Journey active question');
    await win.getByTestId('assistant-send').click();
    await expect(win.getByTestId('assistant-turn-status')).toContainText('dev: running');
    await win.getByTestId('assistant-input').fill('Journey queued question');
    await win.getByTestId('assistant-send').click();
    const queued = win.getByTestId('assistant-turn-status').filter({ hasText: 'Queued' });
    await expect(queued).toHaveCount(1);
    await capture(win, '02-docked-queue');
    // Keyboard cancellation is covered by durableTeamChat.spec.ts; the journey clicks.
    await queued.getByRole('button', { name: 'Cancel queued turn' }).click();
    // Before TASK-487 this hung on a stale revision: the cancel was refused and the window never refreshed.
    await expect(queued).toHaveCount(0);
    await win.getByRole('button', { name: 'Stop', exact: true }).click();
    await expect(win.getByTestId('assistant-turn-status')).toHaveCount(0);
    await expect(win.getByTestId('assistant-message-user')).toHaveText(['Journey active question', 'Journey queued question']);
    expect(turnStates(app.userDataDir)).toEqual(['cancelled', 'cancelled']);

    // 4. Restart during a reply: SIGKILL, so no shutdown handler settles anything.
    const requestsBeforeCrash = completions(mock);
    await win.getByTestId('assistant-input').fill('Journey interrupted question');
    await win.getByTestId('assistant-send').click();
    await expect(win.getByTestId('assistant-turn-status')).toContainText('dev: running');
    // Crash only once the provider has the request: before dispatch, startup rightly resumes instead.
    await expect.poll(() => completions(mock!)).toBe(requestsBeforeCrash + 1);
    const reuse = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
    const child = app.electronApp.process();
    const exited = new Promise(resolve => child.once('exit', resolve));
    child.kill('SIGKILL');
    await exited;
    app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
    win = app.window;
    await expect.poll(() => turnStates(reuse.userDataDir)).toEqual(['cancelled', 'cancelled', 'interrupted']);
    expect(completions(mock)).toBe(requestsBeforeCrash + 1);
    await win.getByTestId('team-chat-row').locator('.team-chat-main').click();
    // Docking is a renderer preference: a SIGKILL may lose it with unflushed localStorage, so only the panel is asserted.
    await expect(win.getByTestId('assistant-panel')).toBeVisible();
    await expect(win.getByTestId('assistant-turn-status')).toContainText('dev: interrupted');
    await capture(win, '03-restart-interrupted');

    // 5. Retry the interrupted member once the provider answers again.
    openGate();
    const retry = win.getByRole('button', { name: 'Retry dev', exact: true });
    await expect(retry).toBeEnabled();
    await retry.click();
    await expect(win.getByTestId('assistant-message-dev')).toContainText('Journey answer');
    await expect(win.getByTestId('assistant-turn-status')).toHaveCount(0);
    expect(turnStates(reuse.userDataDir)).toEqual(['cancelled', 'cancelled', 'completed']);

    // 6. A second restart: transcript and usage are read back from disk, not from renderer memory.
    // A clean quit that keeps the profile (closeTestApp would delete it).
    await app.electronApp.close();
    app = await launchTestApp(undefined, reuse, undefined, { openNewSession: false });
    win = app.window;
    await win.getByTestId('team-chat-row').locator('.team-chat-main').click();
    await expect(win.getByTestId('assistant-message-user')).toHaveText(['Journey active question', 'Journey queued question', 'Journey interrupted question']);
    await expect(win.getByTestId('assistant-message-dev')).toHaveCount(1);
    await expect(win.getByTestId('session-usage-summary')).toContainText('tok');
    await capture(win, '04-transcript-after-restart');

    // 7. "All projects": the team chat stays out of the general feed and the shell keeps one row per chat.
    const conversations = await win.evaluate(async () => {
      const projects = await window.praxis.projects.list();
      return (await window.praxis.assistant.listChats(projects[0].id)).length + (await window.praxis.assistant.listChats('')).length;
    });
    expect(conversations).toBe(1);
  } finally { openGate(); }
});
