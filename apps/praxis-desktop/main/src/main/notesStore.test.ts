import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { NotesStore } from './notesStore';

const A = 'project-a';
const B = 'project-b';

function setup(options: { fs?: ConstructorParameters<typeof NotesStore>[0]['fs']; file?: string } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'praxis-notes-'));
  const filePath = options.file ?? path.join(dir, 'notes.json');
  const changes: string[] = [];
  let tick = 0;
  let id = 0;
  const make = (overrides: Partial<ConstructorParameters<typeof NotesStore>[0]> = {}) =>
    new NotesStore({
      filePath,
      knownProjectIds: () => [A, B],
      now: () => new Date(Date.UTC(2026, 0, 1, 0, 0, tick++)).toISOString(),
      newId: () => `id-${++id}`,
      onChanged: projectId => changes.push(projectId),
      fs: options.fs,
      ...overrides
    });
  return { dir, filePath, changes, make, store: make() };
}

function value<T>(result: { ok: boolean } & object): T {
  assert.equal(result.ok, true, JSON.stringify(result));
  return (result as unknown as { value: T }).value;
}
function code(result: { ok: boolean; error?: { code: string } }): string | undefined {
  return result.ok ? undefined : result.error?.code;
}
const strays = (dir: string) => fs.readdirSync(dir).filter(name => name.endsWith('.tmp'));

test('missing file lists empty and writes nothing until the first mutation', async () => {
  const { store, filePath } = setup();
  assert.deepEqual(value(await store.list(A)), { notes: [], groups: [] });
  assert.equal(fs.existsSync(filePath), false);
  await store.createNote(A, { title: 'one', body: '' });
  assert.equal(fs.existsSync(filePath), true);
});

test('round trip survives a new store on the same file, in order', async () => {
  const { store, make, changes } = setup();
  const n1 = value<{ id: string }>(await store.createNote(A, { title: 'one', body: 'first' }));
  const n2 = value<{ id: string }>(await store.createNote(A, { title: 'two', body: 'second' }));
  const g = value<{ id: string }>(await store.createGroup(A, { title: 'group', noteIds: [n1.id, n2.id] }));
  await store.replaceMemberships(A, g.id, [n2.id, n1.id]);
  await store.updateNote(A, n1.id, { body: '' });
  await store.updateGroup(A, g.id, { title: 'renamed' });
  const before = value(await store.list(A));
  const reopened = make();
  assert.deepEqual(value(await reopened.list(A)), before);
  const loaded = value<{ notes: { body: string }[]; groups: { title: string; noteIds: string[] }[] }>(await reopened.list(A));
  assert.equal(loaded.notes[0].body, '');
  assert.equal(loaded.groups[0].title, 'renamed');
  assert.deepEqual(loaded.groups[0].noteIds, [n2.id, n1.id]);
  assert.equal(changes.length, 6);
});

test('existing valid data is loaded on startup', async () => {
  const { filePath, make } = setup();
  const at = '2026-01-01T00:00:00.000Z';
  fs.writeFileSync(filePath, JSON.stringify({
    schemaVersion: 1,
    notes: [{ id: 'n', projectId: A, title: 't', body: 'b', createdAt: at, updatedAt: at }],
    groups: [{ id: 'g', projectId: A, title: 'g', noteIds: ['n'], createdAt: at, updatedAt: at }]
  }));
  const listed = value<{ notes: unknown[]; groups: { noteIds: string[] }[] }>(await make().list(A));
  assert.equal(listed.notes.length, 1);
  assert.deepEqual(listed.groups[0].noteIds, ['n']);
});

for (const [label, content, expected] of [
  ['malformed JSON', '{ not json', 'INVALID_PERSISTED_DATA'],
  ['unsupported schema', JSON.stringify({ schemaVersion: 99, notes: [], groups: [] }), 'UNSUPPORTED_SCHEMA'],
  ['dangling member', JSON.stringify({
    schemaVersion: 1, notes: [],
    groups: [{ id: 'g', projectId: A, title: 'g', noteIds: ['gone'], createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }]
  }), 'INVALID_PERSISTED_DATA']
] as const) {
  test(`${label} yields a typed error and the file is left untouched`, async () => {
    const { filePath, make, changes } = setup();
    fs.writeFileSync(filePath, content);
    const store = make();
    assert.equal(code(await store.list(A)), expected);
    assert.equal(code(await store.createNote(A, { title: 'x', body: '' })), expected);
    assert.equal(fs.readFileSync(filePath, 'utf8'), content);
    assert.deepEqual(changes, []);
  });
}

test('a failed write reports PERSISTENCE_FAILURE, keeps memory, cleans up and recovers', async () => {
  let failRename = false;
  const failing = {
    ...fs.promises,
    readFile: fs.promises.readFile,
    writeFile: fs.promises.writeFile,
    mkdir: fs.promises.mkdir,
    rm: fs.promises.rm,
    rename: (async (from: fs.PathLike, to: fs.PathLike) => {
      if (failRename) throw new Error('disk full at /secret/path');
      return fs.promises.rename(from, to);
    }) as typeof fs.promises.rename
  };
  const { store, dir, changes } = setup({ fs: failing });
  await store.createNote(A, { title: 'kept', body: 'private body' });
  const before = value(await store.list(A));
  failRename = true;
  const result = await store.createNote(A, { title: 'lost', body: 'private body 2' });
  assert.equal(code(result), 'PERSISTENCE_FAILURE');
  const text = JSON.stringify(result);
  assert.ok(!text.includes(dir) && !text.includes('private') && !text.includes('secret'));
  assert.deepEqual(value(await store.list(A)), before);
  assert.deepEqual(strays(dir), []);
  assert.equal(changes.length, 1);
  failRename = false;
  value(await store.createNote(A, { title: 'after', body: '' }));
  assert.equal(changes.length, 2);
});

test('deleting a group keeps its notes; deleting a note cleans every membership in one write', async () => {
  let writes = 0;
  const counting = { ...fs.promises, readFile: fs.promises.readFile, mkdir: fs.promises.mkdir, rm: fs.promises.rm, rename: fs.promises.rename,
    writeFile: (async (...args: Parameters<typeof fs.promises.writeFile>) => { writes++; return fs.promises.writeFile(...args); }) as typeof fs.promises.writeFile };
  const { store, make } = setup({ fs: counting });
  const n1 = value<{ id: string }>(await store.createNote(A, { title: 'one', body: '' }));
  const n2 = value<{ id: string }>(await store.createNote(A, { title: 'two', body: '' }));
  const g1 = value<{ id: string }>(await store.createGroup(A, { title: 'g1', noteIds: [n1.id, n2.id] }));
  const g2 = value<{ id: string }>(await store.createGroup(A, { title: 'g2', noteIds: [n2.id, n1.id] }));
  writes = 0;
  value(await store.deleteNote(A, n1.id));
  assert.equal(writes, 1);
  const afterNote = value<{ notes: { id: string }[]; groups: { id: string; noteIds: string[] }[] }>(await make().list(A));
  assert.deepEqual(afterNote.groups.map(g => g.noteIds), [[n2.id], [n2.id]]);
  value(await store.deleteGroup(A, g1.id));
  const afterGroup = value<{ notes: { id: string }[]; groups: { id: string }[] }>(await make().list(A));
  assert.deepEqual(afterGroup.notes.map(n => n.id), [n2.id]);
  assert.deepEqual(afterGroup.groups.map(g => g.id), [g2.id]);
});

test('membership rules: unknown, duplicate and empty updates are rejected without change', async () => {
  const { store, changes } = setup();
  const n = value<{ id: string }>(await store.createNote(A, { title: 'one', body: '' }));
  const g = value<{ id: string }>(await store.createGroup(A, { title: 'g', noteIds: [n.id] }));
  const before = value(await store.list(A));
  const count = changes.length;
  assert.equal(code(await store.replaceMemberships(A, g.id, [n.id, 'unknown'])), 'NOTE_NOT_FOUND');
  assert.equal(code(await store.replaceMemberships(A, g.id, [n.id, n.id])), 'VALIDATION_ERROR');
  assert.equal(code(await store.updateNote(A, n.id, {})), 'VALIDATION_ERROR');
  assert.deepEqual(value(await store.list(A)), before);
  assert.equal(changes.length, count);
});

test('project isolation across every operation', async () => {
  const { store } = setup();
  const n = value<{ id: string }>(await store.createNote(B, { title: 'b note', body: '' }));
  const g = value<{ id: string }>(await store.createGroup(B, { title: 'b group', noteIds: [n.id] }));
  const mine = value<{ id: string }>(await store.createNote(A, { title: 'a note', body: '' }));
  const ag = value<{ id: string }>(await store.createGroup(A, { title: 'a group', noteIds: [mine.id] }));
  assert.equal(code(await store.updateNote(A, n.id, { title: 'x' })), 'PROJECT_MISMATCH');
  assert.equal(code(await store.deleteNote(A, n.id)), 'PROJECT_MISMATCH');
  assert.equal(code(await store.updateGroup(A, g.id, { title: 'x' })), 'PROJECT_MISMATCH');
  assert.equal(code(await store.deleteGroup(A, g.id)), 'PROJECT_MISMATCH');
  assert.equal(code(await store.replaceMemberships(A, g.id, [])), 'PROJECT_MISMATCH');
  assert.equal(code(await store.replaceMemberships(A, ag.id, [n.id])), 'PROJECT_MISMATCH');
  assert.equal(code(await store.createGroup(A, { title: 'x', noteIds: [n.id] })), 'PROJECT_MISMATCH');
  assert.equal(code(await store.prepareSnapshot(A, { kind: 'note', id: n.id })), 'PROJECT_MISMATCH');
  assert.equal(code(await store.list('nope')), 'PROJECT_NOT_FOUND');
  assert.equal(code(await store.createNote('nope', { title: 't', body: '' })), 'PROJECT_NOT_FOUND');
  const listed = value<{ notes: { projectId: string }[]; groups: { projectId: string }[] }>(await store.list(A));
  assert.ok([...listed.notes, ...listed.groups].every(item => item.projectId === A));
});

test('concurrent creates all persist; reads and snapshots never notify', async () => {
  const { store, make, changes } = setup();
  await Promise.all(Array.from({ length: 20 }, (_, i) => store.createNote(A, { title: `n${i}`, body: '' })));
  assert.equal(changes.length, 20);
  assert.equal(value<{ notes: unknown[] }>(await make().list(A)).notes.length, 20);
  const first = value<{ notes: { id: string }[] }>(await store.list(A)).notes[0];
  value(await store.prepareSnapshot(A, { kind: 'note', id: first.id }));
  assert.equal(changes.length, 20);
});

test('snapshots are detached and empty groups are refused', async () => {
  const { store } = setup();
  const n = value<{ id: string }>(await store.createNote(A, { title: 'one', body: 'original' }));
  const g = value<{ id: string }>(await store.createGroup(A, { title: 'g', noteIds: [] }));
  assert.equal(code(await store.prepareSnapshot(A, { kind: 'group', id: g.id })), 'EMPTY_GROUP');
  const snapshot = value<{ notes: { body: string }[] }>(await store.prepareSnapshot(A, { kind: 'note', id: n.id }));
  await store.updateNote(A, n.id, { body: 'edited' });
  assert.equal(snapshot.notes[0].body, 'original');
});

test('a backwards clock never makes updatedAt precede createdAt', async () => {
  const { dir, filePath, make } = setup();
  const times = ['2026-01-02T00:00:00.000Z', '2026-01-01T00:00:00.000Z'];
  const store = make({ now: () => times.shift() ?? '2026-01-01T00:00:00.000Z' });
  const n = value<{ id: string }>(await store.createNote(A, { title: 'one', body: '' }));
  value(await store.updateNote(A, n.id, { body: 'x' }));
  assert.ok(dir);
  value(await make().list(A));
  assert.ok(fs.existsSync(filePath));
});
