import { test, expect, type Page } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import { chooseOption } from './chipSelect';

let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

/** A project, two ordered notes in a group, an empty group, and one finished session; provider calls are counted. */
type HandoffCalls = { delegate: unknown[]; continueSession: { key: string; message: string }[]; conversation: unknown[] };
// Provider traffic is recorded in the test process by the channel overrides seed() installs.
let handoffCalls: HandoffCalls = { delegate: [], continueSession: [], conversation: [] };
let failNextContinue = false;

async function seed(page: Page, app: TestApp) {
  const ids = await page.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const project = await window.praxis.projects.create({
      name: 'Note Handoff', key: 'NHO', type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage',
      workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
      starterTickets: [{ summary: 'Seed', description: '', issueType: 'Task', status: 'To do' }], defaultAiToolMode: 'read-only'
    } as never, workspace.id);
    const value = <T,>(result: { ok: boolean; value?: T }) => result.value as T;
    const first = value<{ id: string }>(await window.praxis.notes.createNote(project.id, { title: 'Second idea', body: 'beta body' }));
    const second = value<{ id: string }>(await window.praxis.notes.createNote(project.id, { title: 'First idea', body: 'alpha body' }));
    await window.praxis.notes.createGroup(project.id, { title: 'Ideas', noteIds: [first.id, second.id] });
    await window.praxis.notes.createGroup(project.id, { title: 'Empty', noteIds: [] });
    return { projectId: project.id as string, noteId: first.id };
  });
  const projectId = ids.projectId;
  const calls: HandoffCalls = { delegate: [], continueSession: [], conversation: [] };
  handoffCalls = calls;
  failNextContinue = false;
  const at = new Date().toISOString();
  const records = [{
    issueKey: 'SESSION-abc123', sessionId: 'abc123', title: 'Existing work', projectId, state: 'completed',
    provider: 'claude', startedAt: at, taskDefinition: { goal: 'Earlier goal', sessionMode: 'task' }, events: []
  }];
  await app.overrideChannel('ai:listSessions', () => records);
  await app.overrideChannel('ai:continueSession', ([key, message]) => {
    calls.continueSession.push({ key, message });
    if (failNextContinue) { failNextContinue = false; throw new Error('mock provider rejection'); }
  });
  await app.overrideChannel('ai:sendConversationMessage', args => { calls.conversation.push(args); });
  await app.overrideChannel('ai:delegate', args => { calls.delegate.push(args); throw new Error('mock delegate'); });
  await page.reload();
  return ids;
}

const providerCalls = async () => handoffCalls.delegate.length + handoffCalls.continueSession.length + handoffCalls.conversation.length;

async function openFromMenu(page: Page, label: string) {
  await page.getByRole('button', { name: label, exact: true }).click();
  await page.getByRole('option', { name: 'Send to session…', exact: true }).click();
  await expect(page.getByTestId('note-send-dialog')).toBeVisible();
}

test('opening, changing the destination and cancelling make no provider request', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seed(page, app);
  await openFromMenu(page, 'Actions for group Ideas');
  await expect(page.getByTestId('note-send-preview-note')).toHaveCount(2);
  await chooseOption(page.getByTestId('note-send-destination'), { label: 'New session…' });
  await expect(page.getByTestId('note-send-confirm')).toHaveText('Continue in new session');
  await page.getByTestId('note-send-cancel').click();
  await expect(page.getByTestId('note-send-dialog')).toHaveCount(0);
  expect(await providerCalls()).toBe(0);
});

test('a group previews in group order and sends once to an existing session', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const { projectId, noteId } = await seed(page, app);
  await openFromMenu(page, 'Actions for group Ideas');
  await expect(page.getByTestId('note-send-preview-note').locator('strong')).toHaveText(['Second idea', 'First idea']);
  await page.getByTestId('note-send-instruction').fill('Summarise these');
  const confirm = page.getByTestId('note-send-confirm');
  await expect(confirm).toHaveText('Send');
  // Two clicks in the same frame: a pointer double-click would depend on the real mouse.
  await confirm.evaluate(button => { (button as HTMLButtonElement).click(); (button as HTMLButtonElement).click(); });

  await expect.poll(() => providerCalls()).toBe(1);
  const message = handoffCalls.continueSession[0];
  expect(message.key).toBe('SESSION-abc123');
  expect(message.message).toContain('<selected_context>');
  expect(message.message.indexOf('beta body')).toBeGreaterThan(-1);
  expect(message.message.indexOf('beta body')).toBeLessThan(message.message.indexOf('alpha body'));
  expect(message.message).toContain('Summarise these');

  // Later edits to the source note don't resend or alter anything.
  await page.evaluate(({ projectId, id }) => window.praxis.notes.updateNote(projectId, id, { title: 'Second idea', body: 'edited' }), { projectId, id: noteId });
  expect(await providerCalls()).toBe(1);
});

test('a new-session destination stages the note in the composer and sends only on Start', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seed(page, app);
  await openFromMenu(page, 'Actions for group Ideas');
  await chooseOption(page.getByTestId('note-send-destination'), { label: 'New session…' });
  await page.getByTestId('note-send-instruction').fill('Plan from these');
  await page.getByTestId('note-send-confirm').click();
  await expect(page.getByTestId('new-session-context-references')).toContainText('Group: Ideas (2 notes)');
  expect(await providerCalls()).toBe(0);
  // The session name follows the goal as it is typed; Start stays disabled without one.
  await page.locator('.composer-input').fill('Plan from these');
  await page.getByTestId('new-session-submit').click();
  await expect.poll(() => providerCalls()).toBe(1);
  const goal = JSON.stringify(handoffCalls.delegate[0]);
  expect(goal).toContain('alpha body');
  expect(goal).toContain('Plan from these');
});

test('an empty group cannot be sent', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seed(page, app);
  await page.getByRole('button', { name: 'Actions for group Empty', exact: true }).click();
  await expect(page.getByRole('option', { name: 'Send to session…', exact: true })).toBeDisabled();
});

const recorded = async () => handoffCalls.continueSession;

test('a rejected send keeps the note, chip and instruction, and retry sends the same snapshot', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const { projectId, noteId } = await seed(page, app);
  failNextContinue = true;
  await openFromMenu(page, 'Actions for group Ideas');
  await page.getByTestId('note-send-instruction').fill('Summarise these');
  await page.getByTestId('note-send-confirm').click();

  await expect(page.getByRole('alert').filter({ hasText: 'mock provider rejection' })).toBeVisible();
  await expect(page.getByTestId('session-follow-up-input')).toHaveValue(/Summarise these/);
  await expect(page.getByTestId('session-context-reference')).toContainText('Group: Ideas (2 notes)');
  const notes = await page.evaluate(id => window.praxis.notes.list(id), projectId);
  expect(JSON.stringify(notes)).toContain('beta body');

  await page.getByTestId('session-follow-up-send').click();
  await expect.poll(() => providerCalls()).toBe(2);
  const [first, second] = await recorded();
  expect(second.message).toBe(first.message);
  expect(first.message).toContain(noteId);
  expect(first.message).toContain('"updatedAt"');
});

test('editing or deleting a note after sending changes nothing already recorded', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const { projectId, noteId } = await seed(page, app);
  await openFromMenu(page, 'Actions for group Ideas');
  await page.getByTestId('note-send-confirm').click();
  await expect.poll(() => providerCalls()).toBe(1);
  const before = (await recorded())[0].message;
  await page.evaluate(({ projectId, id }) => window.praxis.notes.updateNote(projectId, id, { title: 'Second idea', body: 'edited' }), { projectId, id: noteId });
  await page.evaluate(({ projectId, id }) => window.praxis.notes.deleteNote(projectId, id), { projectId, id: noteId });
  const after = await recorded();
  expect(after).toHaveLength(1);
  expect(after[0].message).toBe(before);
  expect(before).toContain('beta body');
  expect(before).toContain(noteId);
});

test('a note deleted before the dialog opens is left out of the preview', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const { projectId, noteId } = await seed(page, app);
  await openFromMenu(page, 'Actions for group Ideas');
  await page.getByTestId('note-send-cancel').click();
  await page.evaluate(({ projectId, id }) => window.praxis.notes.deleteNote(projectId, id), { projectId, id: noteId });
  await page.getByRole('button', { name: 'Actions for group Ideas', exact: true }).click();
  await page.getByRole('option', { name: 'Send to session…', exact: true }).click();
  await expect(page.getByTestId('note-send-dialog')).toBeVisible();
  await expect(page.getByTestId('note-send-preview-note')).toHaveCount(1);
  expect(await providerCalls()).toBe(0);
});

test('a destination that disappears is reported, not replaced by a new session', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seed(page, app);
  await openFromMenu(page, 'Actions for group Ideas');
  await page.getByTestId('note-send-instruction').fill('Keep this text');
  await expect(page.getByTestId('note-send-confirm')).toHaveText('Send');
  {
    await app.emitEvent('ai:sessionDeleted', 'SESSION-abc123');
  }
  await expect(page.getByTestId('note-send-destination-error')).toBeVisible();
  await expect(page.getByTestId('note-send-confirm')).toBeDisabled();
  expect(await providerCalls()).toBe(0);
  await page.getByTestId('note-send-cancel').click();
  await openFromMenu(page, 'Actions for group Ideas');
  await expect(page.getByTestId('note-send-instruction')).toHaveValue('Keep this text');
});

test('a failed new-session Start keeps the goal and the note chip', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await seed(page, app);
  await openFromMenu(page, 'Actions for group Ideas');
  await chooseOption(page.getByTestId('note-send-destination'), { label: 'New session…' });
  await page.getByTestId('note-send-confirm').click();
  await page.locator('.composer-input').fill('Plan from these');
  await page.getByTestId('new-session-submit').click();
  await expect.poll(() => providerCalls()).toBe(1);
  await expect(page.locator('.composer-input')).toHaveValue('Plan from these');
  await expect(page.getByTestId('new-session-context-references')).toContainText('Group: Ideas (2 notes)');
});

test('a single note sends once to an existing session as a one-note reference; cancelling sends nothing', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const { noteId } = await seed(page, app);
  // The group starts collapsed, so open it to reach its notes.
  await page.getByRole('button', { name: /^Ideas/ }).click();
  await openFromMenu(page, 'Actions for note Second idea');
  await expect(page.getByTestId('note-send-preview-note')).toHaveCount(1);
  await page.getByTestId('note-send-cancel').click();
  await expect(page.getByTestId('note-send-dialog')).toHaveCount(0);
  expect(await providerCalls()).toBe(0);

  await openFromMenu(page, 'Actions for note Second idea');
  await page.getByTestId('note-send-instruction').fill('Expand on this');
  await expect(page.getByTestId('note-send-confirm')).toHaveText('Send');
  await page.getByTestId('note-send-confirm').click();
  await expect.poll(() => providerCalls()).toBe(1);
  const [sent] = await recorded();
  expect(sent.key).toBe('SESSION-abc123');
  expect(sent.message).toContain('beta body');
  expect(sent.message).not.toContain('alpha body');
  expect(sent.message).toContain(noteId);
  expect(sent.message).toContain('Expand on this');
});
