import * as fs from 'node:fs';
import { test, expect } from '@playwright/test';
import { launchTestApp, closeTestApp, type TestApp } from './launchTestApp';
import {
  addSidebarNote, blockNotesFile, createProject, menu, notesFilePath, openShelf, openShelfNotes,
  readNotesFile, relaunch, seedNotes, showSidebar, spyProviderCalls
} from './notesTestKit';

// Keyboard and .click() only: no hover, page.mouse, drag or screenshots, so this stays in the smoke set.

let app: TestApp | undefined;
test.afterEach(async () => {
  if (app) await closeTestApp(app);
  app = undefined;
});

test('every notes channel resolves a typed result for bad input, a foreign project or a foreign note', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const a = await createProject(page, 'Alpha Project', 'ALP');
  const b = await createProject(page, 'Beta Project', 'BET');
  const { noteIds: [aNote] } = await seedNotes(page, a, [{ title: 'in A', body: 'a body' }]);
  const { noteIds: [bNote], groupIds: [bGroup] } = await seedNotes(page, b, [{ title: 'in B', body: 'b body' }], [{ title: 'B group', members: [0] }]);

  const outcome = await page.evaluate(async ({ a, bNote, bGroup }) => {
    const n = window.praxis.notes as unknown as Record<string, (...args: unknown[]) => Promise<{ ok: boolean; error?: { code: string } }>>;
    const summarise = async (run: () => Promise<{ ok: boolean; error?: { code: string } }>) => {
      try { const r = await run(); return r.ok ? 'ok' : r.error?.code; } catch (error) { return `rejected: ${String(error)}`; }
    };
    const bad: Record<string, string | undefined> = {};
    for (const [name, args] of Object.entries({
      list: [undefined], createNote: [undefined, undefined], updateNote: [42, {}, {}], deleteNote: [{}, {}],
      createGroup: [undefined, 7], updateGroup: [undefined, undefined, undefined], deleteGroup: [42, 42],
      replaceMemberships: [undefined, undefined, undefined], prepareSnapshot: [undefined, undefined]
    }) as [string, unknown[]][]) bad[name] = await summarise(() => n[name](...args));
    return {
      bad,
      unknownProject: await summarise(() => n.list('no-such-project')),
      foreignNoteUpdate: await summarise(() => n.updateNote(a, bNote, { title: 'hijack' })),
      foreignNoteDelete: await summarise(() => n.deleteNote(a, bNote)),
      foreignGroupDelete: await summarise(() => n.deleteGroup(a, bGroup)),
      foreignSnapshot: await summarise(() => n.prepareSnapshot(a, { kind: 'note', id: bNote }))
    };
  }, { a, bNote, bGroup });

  for (const [name, result] of Object.entries(outcome.bad)) expect(result, `${name} with malformed input`).toBe('VALIDATION_ERROR');
  expect(outcome.unknownProject).toBe('PROJECT_NOT_FOUND');
  for (const result of [outcome.foreignNoteUpdate, outcome.foreignNoteDelete, outcome.foreignGroupDelete, outcome.foreignSnapshot])
    expect(['NOTE_NOT_FOUND', 'PROJECT_MISMATCH', 'GROUP_NOT_FOUND']).toContain(result);

  // B's data is exactly as it was, and A's note was never touched.
  const file = readNotesFile(app);
  expect(file.notes.find(n => n.id === bNote)).toMatchObject({ projectId: b, title: 'in B', body: 'b body' });
  expect(file.groups.find(g => g.id === bGroup)?.noteIds).toEqual([bNote]);
  expect(file.notes.find(n => n.id === aNote)).toMatchObject({ projectId: a, title: 'in A' });
});

test('onChanged fires once per mutation with the project id, and never for reads', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const projectId = await createProject(page, 'Change Feed', 'CHF');
  const seen = await page.evaluate(async projectId => {
    const events: string[] = [];
    const off = window.praxis.notes.onChanged(id => events.push(id));
    const settle = () => new Promise(resolve => setTimeout(resolve, 150));
    const note = await window.praxis.notes.createNote(projectId, { title: 't', body: '' });
    if (!note.ok) throw new Error('createNote');
    await settle();
    const afterCreate = events.length;
    await window.praxis.notes.list(projectId);
    await window.praxis.notes.prepareSnapshot(projectId, { kind: 'note', id: note.value.id });
    await settle();
    const afterReads = events.length;
    await window.praxis.notes.updateNote(projectId, note.value.id, { body: 'edited' });
    await settle();
    off();
    return { afterCreate, afterReads, final: events.length, ids: [...new Set(events)] };
  }, projectId);
  expect(seen.afterCreate).toBe(1);
  expect(seen.afterReads).toBe(1);
  expect(seen.final).toBe(2);
  expect(seen.ids).toEqual([projectId]);
});

test('a restart restores notes from both surfaces, the group and its order', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  let page = app.window;
  const projectId = await createProject(page, 'Restart Notes', 'RST');
  await page.reload();

  // One note from the sidebar editor, one from the shelf editor.
  let section = await addSidebarNote(page, 'Restart Notes', 'From sidebar', 'sidebar body');
  await section.getByRole('button', { name: 'Close editor' }).click();
  await openShelf(page);
  let card = await openShelfNotes(page, 'Restart Notes');
  await card.getByTestId('note-title').fill('From shelf');
  await card.getByTestId('note-body').fill('shelf body');
  await expect(card.getByTestId('note-save-state')).toHaveText('Saved');

  const before = readNotesFile(app);
  const bySidebar = before.notes.find(n => n.title === 'From sidebar')!;
  const byShelf = before.notes.find(n => n.title === 'From shelf')!;
  expect(bySidebar.projectId).toBe(projectId);
  // Group the two in a stated order: shelf note first.
  await page.evaluate(async ({ projectId, ids }) => {
    await window.praxis.notes.createGroup(projectId, { title: 'Ordered', noteIds: ids });
  }, { projectId, ids: [byShelf.id, bySidebar.id] });

  app = await relaunch(app);
  page = app.window;
  const after = readNotesFile(app);
  expect(after.notes.map(n => [n.id, n.title, n.body])).toEqual(before.notes.map(n => [n.id, n.title, n.body]));
  expect(after.groups).toHaveLength(1);
  expect(after.groups[0]).toMatchObject({ title: 'Ordered', noteIds: [byShelf.id, bySidebar.id] });

  section = await showSidebar(page);
  const group = section.getByRole('button', { name: /^Ordered/ });
  await expect(group).toBeVisible();
  if (await group.getAttribute('aria-expanded') === 'false') await group.click();
  // Members render in the stored order: the shelf note first.
  const members = section.getByTestId('notes-tree').getByRole('listitem').filter({ hasText: /^From (shelf|sidebar)/ });
  await expect(members).toHaveCount(2);
  await expect(members.nth(0)).toContainText('From shelf');
  await expect(members.nth(1)).toContainText('From sidebar');
  // The shelf shows the same stored text.
  await section.getByRole('button', { name: 'From sidebar', exact: true }).first().click();
  await expect(section.getByTestId('note-body')).toHaveValue('sidebar body');
  await openShelf(page);
  card = await openShelfNotes(page, 'Restart Notes');
  await expect(card.getByTestId('note-body')).toHaveValue('sidebar body');
});

test('a failed save never reports saved, and a restart keeps the last committed text', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  let page = app.window;
  await createProject(page, 'Draft Notes', 'DRF');
  await page.reload();
  await openShelf(page);
  const card = await openShelfNotes(page, 'Draft Notes');
  await card.getByTestId('note-title').fill('Draft title');
  await card.getByTestId('note-body').fill('safe line');
  await expect(card.getByTestId('note-save-state')).toHaveText('Saved');

  const restore = blockNotesFile(app);
  await card.getByTestId('note-body').fill('safe line, then an unsaved one');
  await expect(card.getByTestId('note-save-error')).toBeVisible();
  await expect(card.getByTestId('note-save-state')).toHaveCount(0);
  restore();
  // The committed file holds only what was really saved.
  const committed = fs.readFileSync(notesFilePath(app), 'utf8');
  expect(committed).toContain('safe line');
  expect(committed).not.toContain('then an unsaved one');

  app = await relaunch(app);
  page = app.window;
  const section = await showSidebar(page);
  await section.getByRole('button', { name: 'Draft title', exact: true }).click();
  const text = await section.getByTestId('note-body').inputValue();
  expect(text).toContain('safe line');
  // Whatever the editor shows, it only says "Saved" for text that is in the file.
  if (text.includes('then an unsaved one')) await expect(section.getByTestId('note-save-state')).not.toHaveText('Saved');
});

test('notes stay in their own project, in the sidebar, the store and the file', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  const a = await createProject(page, 'Isolation One', 'ISO');
  const b = await createProject(page, 'Isolation Two', 'ISW');
  await seedNotes(page, a, [{ title: 'Only in one', body: 'one body' }]);
  await seedNotes(page, b, [{ title: 'Only in two', body: 'two body' }]);
  await page.reload();

  // The sidebar lists the active project's notes only.
  const section = page.getByTestId('notes-section');
  await expect(section).toBeVisible();
  const visible = (title: string) => section.getByRole('button', { name: title, exact: true });
  // Wait for the list to render after the reload (a bare count() would race it), then require exactly one.
  await expect(section.getByRole('button', { name: /^Only in (one|two)$/ })).toHaveCount(1);
  const shown = [await visible('Only in one').count(), await visible('Only in two').count()];
  expect(shown.reduce((x, y) => x + y, 0)).toBe(1);

  // Every note on disk belongs to exactly the project it was created under.
  const file = readNotesFile(app);
  expect(file.notes.find(n => n.title === 'Only in one')?.projectId).toBe(a);
  expect(file.notes.find(n => n.title === 'Only in two')?.projectId).toBe(b);

  const listed = await page.evaluate(async ({ a, b }) => {
    const titles = async (id: string) => {
      const r = await window.praxis.notes.list(id);
      return r.ok ? r.value.notes.map(n => n.title) : [];
    };
    return { a: await titles(a), b: await titles(b) };
  }, { a, b });
  expect(listed).toEqual({ a: ['Only in one'], b: ['Only in two'] });
});

test('ungrouping and deleting persist across a restart; cancelling a delete changes nothing', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  let page = app.window;
  const projectId = await createProject(page, 'Linked Notes', 'LNK');
  const { noteIds: [shared, other], groupIds: [first, second] } = await seedNotes(page, projectId,
    [{ title: 'Shared note', body: 'shared body' }, { title: 'Other note', body: 'other body' }],
    [{ title: 'First group', members: [0, 1] }, { title: 'Second group', members: [1, 0] }]);
  await page.reload();
  const firstGroup = page.getByTestId(`notes-group-${first}`);
  const secondGroup = page.getByTestId(`notes-group-${second}`);
  for (const group of [firstGroup, secondGroup]) {
    const header = group.getByRole('button', { name: /group/ }).first();
    if (await header.getAttribute('aria-expanded') === 'false') await header.click();
  }

  // Remove from one group only: the note sits under both, so use that group's own menu.
  await firstGroup.getByRole('button', { name: 'Actions for note Shared note', exact: true }).click();
  await page.getByRole('option', { name: 'Remove from this group', exact: true }).click();
  await expect.poll(() => readNotesFile(app!).groups.find(g => g.id === first)?.noteIds).toEqual([other]);
  expect(readNotesFile(app).groups.find(g => g.id === second)?.noteIds).toEqual([other, shared]);
  expect(readNotesFile(app).notes.map(n => n.id)).toContain(shared);

  // Cancelling a delete leaves the file byte-identical.
  const bytes = fs.readFileSync(notesFilePath(app), 'utf8');
  await secondGroup.getByRole('button', { name: 'Actions for note Other note', exact: true }).click();
  await page.getByRole('option', { name: 'Delete note', exact: true }).click();
  await page.getByRole('button', { name: 'Cancel' }).click();
  expect(fs.readFileSync(notesFilePath(app), 'utf8')).toBe(bytes);

  // Delete the shared note for real.
  await menu(page, 'Actions for note Shared note', 'Delete note');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect.poll(() => readNotesFile(app!).notes.map(n => n.id)).toEqual([other]);

  app = await relaunch(app);
  page = app.window;
  const after = readNotesFile(app);
  expect(after.notes.map(n => n.id)).toEqual([other]);
  for (const group of after.groups) expect(group.noteIds).not.toContain(shared);
  expect(after.groups.map(g => g.id).sort()).toEqual([first, second].sort());
  await expect(page.getByTestId('notes-section').getByRole('button', { name: 'Shared note', exact: true })).toHaveCount(0);
});

test('ordinary note actions never call a provider or create a session', async () => {
  test.slow();
  app = await launchTestApp(undefined, undefined, undefined, { openNewSession: false });
  const page = app.window;
  await createProject(page, 'Quiet Notes', 'QUI');
  await page.reload();
  const spy = await spyProviderCalls(app);
  const sessionsBefore = await spy.sessions();

  const section = await addSidebarNote(page, 'Quiet Notes', 'Quiet', 'no ai here');
  await section.getByTestId('note-title').fill('Quiet, renamed');
  await expect(section.getByTestId('note-save-state')).toHaveText('Saved');
  await section.getByRole('button', { name: 'Close editor' }).click();
  await menu(page, 'Actions for note Quiet, renamed', 'Add to new group…');
  await page.getByLabel('Group name').fill('Quiet group');
  await page.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(section.getByRole('button', { name: /^Quiet group/ })).toBeVisible();
  await section.getByRole('button', { name: 'Quiet, renamed', exact: true }).first().click();
  await expect(section.getByTestId('note-body')).toHaveValue('no ai here');
  await section.getByRole('button', { name: 'Close editor' }).click();

  // From the shelf: open the same note.
  await openShelf(page);
  await page.getByTestId('session-shelf').getByTestId('session-shelf-notes').click();
  await expect(page.getByTestId('session-shelf-notes-card')).toBeVisible();
  await page.keyboard.press('Escape');

  // Open and cancel the send dialog.
  await page.getByRole('button', { name: 'Toggle sidebar', exact: true }).click();
  await menu(page, 'Actions for group Quiet group', 'Send to session…');
  await expect(page.getByTestId('note-send-dialog')).toBeVisible();
  await page.getByTestId('note-send-cancel').click();

  await menu(page, 'Actions for note Quiet, renamed', 'Remove from this group');
  await menu(page, 'Actions for note Quiet, renamed', 'Delete note');
  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await menu(page, 'Actions for group Quiet group', 'Delete group');
  await page.getByRole('button', { name: 'Delete group' }).last().click();
  await expect(section.getByRole('button', { name: /^Quiet group/ })).toHaveCount(0);

  expect(await spy.count()).toBe(0);
  expect(await spy.sessions()).toBe(sessionsBefore);
});
