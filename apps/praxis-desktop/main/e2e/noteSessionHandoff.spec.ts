import { test, expect, type Page } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';

let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

/** A project, two ordered notes in a group, an empty group, and one finished session; provider calls are counted. */
async function seed(page: Page, electronApp: TestApp['electronApp']) {
  const ids = await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Note Handoff', key: 'NHO', type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: [{ summary: 'Seed', description: '', issueType: 'Task', status: 'To do' }]
    } as never, workspace.id);
    const value = <T,>(result: { ok: boolean; value?: T }) => result.value as T;
    const first = value<{ id: string }>(await window.praxis.notes.createNote(project.id, { title: 'Second idea', body: 'beta body' }));
    const second = value<{ id: string }>(await window.praxis.notes.createNote(project.id, { title: 'First idea', body: 'alpha body' }));
    await window.praxis.notes.createGroup(project.id, { title: 'Ideas', noteIds: [first.id, second.id] });
    await window.praxis.notes.createGroup(project.id, { title: 'Empty', noteIds: [] });
    return { projectId: project.id as string, noteId: first.id };
  });
  await electronApp.evaluate(({ ipcMain }, projectId) => {
    const calls: { delegate: unknown[]; continueSession: { key: string; message: string }[]; conversation: unknown[] } =
      { delegate: [], continueSession: [], conversation: [] };
    (globalThis as { __handoffCalls?: typeof calls }).__handoffCalls = calls;
    const at = new Date().toISOString();
    const records = [{
      issueKey: 'SESSION-abc123', sessionId: 'abc123', title: 'Existing work', projectId, state: 'completed',
      provider: 'claude', startedAt: at, taskDefinition: { goal: 'Earlier goal', sessionMode: 'task' }, events: []
    }];
    ipcMain.removeHandler('ai:listSessions');
    ipcMain.handle('ai:listSessions', () => records);
    ipcMain.removeHandler('ai:continueSession');
    ipcMain.handle('ai:continueSession', (_event, key: string, message: string) => { calls.continueSession.push({ key, message }); });
    ipcMain.removeHandler('ai:sendConversationMessage');
    ipcMain.handle('ai:sendConversationMessage', (_event, ...args: unknown[]) => { calls.conversation.push(args); });
    ipcMain.removeHandler('ai:delegate');
    ipcMain.handle('ai:delegate', (_event, ...args: unknown[]) => { calls.delegate.push(args); throw new Error('mock delegate'); });
  }, ids.projectId);
  await page.reload();
  return ids;
}

const providerCalls = (electronApp: TestApp['electronApp']) => electronApp.evaluate(() => {
  const calls = (globalThis as { __handoffCalls?: { delegate: unknown[]; continueSession: unknown[]; conversation: unknown[] } }).__handoffCalls!;
  return calls.delegate.length + calls.continueSession.length + calls.conversation.length;
});

async function openFromMenu(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('option', { name: 'Send to session…', exact: true }).click();
  await expect(page.getByTestId('note-send-dialog')).toBeVisible();
}

test('opening, changing the destination and cancelling make no provider request', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seed(page, app.electronApp);
  await openFromMenu(page, 'Actions for group Ideas');
  await expect(page.getByTestId('note-send-preview-note')).toHaveCount(2);
  await chooseOption(page.getByTestId('note-send-destination'), { label: 'New session…' });
  await expect(page.getByTestId('note-send-confirm')).toHaveText('Continue in new session');
  await page.getByTestId('note-send-cancel').click();
  await expect(page.getByTestId('note-send-dialog')).toHaveCount(0);
  expect(await providerCalls(app.electronApp)).toBe(0);
});

test('a group previews in group order and sends once to an existing session', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const { projectId, noteId } = await seed(page, app.electronApp);
  await openFromMenu(page, 'Actions for group Ideas');
  await expect(page.getByTestId('note-send-preview-note').locator('strong')).toHaveText(['Second idea', 'First idea']);
  await page.getByTestId('note-send-instruction').fill('Summarise these');
  const confirm = page.getByTestId('note-send-confirm');
  await expect(confirm).toHaveText('Send');
  await confirm.dblclick();

  await expect.poll(() => providerCalls(app!.electronApp)).toBe(1);
  const message = await app.electronApp.evaluate(() => (globalThis as { __handoffCalls?: { continueSession: { key: string; message: string }[] } }).__handoffCalls!.continueSession[0]);
  expect(message.key).toBe('SESSION-abc123');
  expect(message.message).toContain('<selected_context>');
  expect(message.message.indexOf('beta body')).toBeGreaterThan(-1);
  expect(message.message.indexOf('beta body')).toBeLessThan(message.message.indexOf('alpha body'));
  expect(message.message).toContain('Summarise these');

  // Later edits to the source note don't resend or alter anything.
  await page.evaluate(({ projectId, id }) => window.praxis.notes.updateNote(projectId, id, { title: 'Second idea', body: 'edited' }), { projectId, id: noteId });
  expect(await providerCalls(app.electronApp)).toBe(1);
});

test('a new-session destination stages the note in the composer and sends only on Start', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seed(page, app.electronApp);
  await openFromMenu(page, 'Actions for group Ideas');
  await chooseOption(page.getByTestId('note-send-destination'), { label: 'New session…' });
  await page.getByTestId('note-send-instruction').fill('Plan from these');
  await page.getByTestId('note-send-confirm').click();
  await expect(page.getByTestId('new-session-context-references')).toContainText('Group: Ideas (2 notes)');
  expect(await providerCalls(app.electronApp)).toBe(0);
  // The session name follows the goal as it is typed; Start stays disabled without one.
  await page.locator('.composer-input').fill('Plan from these');
  await page.getByTestId('new-session-submit').click();
  await expect.poll(() => providerCalls(app!.electronApp)).toBe(1);
  const goal = await app.electronApp.evaluate(() =>
    JSON.stringify((globalThis as { __handoffCalls?: { delegate: unknown[] } }).__handoffCalls!.delegate[0]));
  expect(goal).toContain('alpha body');
  expect(goal).toContain('Plan from these');
});

test('an empty group cannot be sent', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seed(page, app.electronApp);
  await page.getByRole('button', { name: 'Actions for group Empty', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Send to session…', exact: true })).toBeDisabled();
});
