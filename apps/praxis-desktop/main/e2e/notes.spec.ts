import { test, expect } from '@playwright/test';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';

let app: TestApp | undefined;

test.afterEach(async () => {
  if (app) {
    await closeTestApp(app);
    app = undefined;
  }
});

/** Notes are app-local and have no UI yet, so these drive `window.praxis.notes` directly. */
async function createProjects(win: TestApp['window']): Promise<{ a: string; b: string }> {
  return win.evaluate(async () => {
    const workspace = (await window.praxis.workspaces.list())[0];
    const make = async (name: string, key: string) =>
      (await window.praxis.projects.create({
        name, key, type: 'product', purpose: '', brief: {}, startingPoint: 'app-storage',
        workflowStages: [{ id: 'todo', name: 'To do', category: 'todo' }, { id: 'done', name: 'Done', category: 'done' }],
        starterTickets: [{ summary: 'Seed', description: '', issueType: 'Task', status: 'To do' }]
      } as never, workspace.id)).id;
    return { a: await make('Notes A', 'NTA'), b: await make('Notes B', 'NTB') };
  });
}

test('notes round-trip, notify, reject cross-project access and survive a relaunch', async () => {
  app = await launchTestApp();
  const { a, b } = await createProjects(app.window);

  const result = await app.window.evaluate(async ({ a, b }) => {
    const notes = window.praxis.notes;
    const events: string[] = [];
    const off = notes.onChanged(projectId => events.push(projectId));
    const keep = await notes.createNote(a, { title: 'Keep', body: 'kept body' });
    const drop = await notes.createNote(a, { title: 'Drop', body: '' });
    if (!keep.ok || !drop.ok) throw new Error('create failed');
    const group = await notes.createGroup(a, { title: 'Both', noteIds: [keep.value.id, drop.value.id] });
    if (!group.ok) throw new Error('group failed');
    const foreign = await notes.createNote(b, { title: 'Foreign', body: '' });
    if (!foreign.ok) throw new Error('foreign failed');
    const mismatch = await notes.deleteNote(a, foreign.value.id);
    const unknown = await notes.list('no-such-project');
    await notes.deleteNote(a, drop.value.id);
    const afterDelete = await notes.list(a);
    await new Promise(resolve => setTimeout(resolve, 200));
    off();
    const seen = events.length;
    await notes.updateNote(a, keep.value.id, { body: 'after unsubscribe' });
    await new Promise(resolve => setTimeout(resolve, 200));
    return {
      events, unsubscribed: events.length === seen,
      mismatch: mismatch.ok ? 'ok' : mismatch.error.code,
      unknown: unknown.ok ? 'ok' : unknown.error.code,
      groups: afterDelete.ok ? afterDelete.value.groups.map(g => g.noteIds.length) : [],
      keepId: keep.value.id
    };
  }, { a, b });

  expect(result.mismatch).toBe('PROJECT_MISMATCH');
  expect(result.unknown).toBe('PROJECT_NOT_FOUND');
  expect(result.groups).toEqual([1]);
  expect(result.events.length).toBe(5);
  expect(result.events.every(id => id === a || id === b)).toBe(true);
  expect(result.unsubscribed).toBe(true);

  const notesFile = path.join(app.userDataDir, 'notes.json');
  expect(fs.existsSync(notesFile)).toBe(true);

  const profile = { userDataDir: app.userDataDir, settingsPath: app.settingsPath };
  await app.electronApp.close();
  app = await launchTestApp(undefined, profile);

  const restored = await app.window.evaluate(async ({ a, b }) => {
    const listA = await window.praxis.notes.list(a);
    const listB = await window.praxis.notes.list(b);
    return {
      a: listA.ok ? { notes: listA.value.notes.map(n => [n.title, n.body]), groups: listA.value.groups.map(g => g.noteIds.length) } : null,
      b: listB.ok ? listB.value.notes.map(n => n.title) : null
    };
  }, { a, b });
  expect(restored.a).toEqual({ notes: [['Keep', 'after unsubscribe']], groups: [1] });
  expect(restored.b).toEqual(['Foreign']);
});
