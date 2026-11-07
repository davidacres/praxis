import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SavedArtifactStore } from './savedArtifactStore';

async function withStore(run: (store: SavedArtifactStore, file: string) => Promise<void>): Promise<void> {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-saved-artifacts-'));
  try {
    const file = join(dir, 'saved-artifacts.json');
    await run(new SavedArtifactStore(file), file);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const group = (id: string, paths: string[]) => ({ id, projectId: 'p', name: id, paths, createdAt: '2026-11-07T00:00:00.000Z' });

test('a file belongs to one group at a time, and an emptied group disappears', async () => {
  await withStore(async store => {
    await store.saveGroup(group('first', ['a/1', 'a/2']));
    await store.saveGroup(group('second', ['a/3']));
    // Dragging a/2 into "second" takes it out of "first".
    await store.saveGroup(group('second', ['a/3', 'a/2']));
    assert.deepEqual((await store.listGroups('p')).map(g => [g.id, g.paths]), [['first', ['a/1']], ['second', ['a/3', 'a/2']]]);

    // Moving the last file out of "first" removes it.
    await store.saveGroup(group('second', ['a/3', 'a/2', 'a/1']));
    assert.deepEqual((await store.listGroups('p')).map(g => g.id), ['second']);

    // Deleting a file takes it out of its group; ungrouping keeps the files' records.
    await store.upsert({ projectId: 'p', path: 'a/3', title: 'Three', savedAt: '2026-11-07T00:00:00.000Z' });
    await store.remove('p', 'a/1');
    assert.deepEqual((await store.getGroup('p', 'second'))?.paths, ['a/3', 'a/2']);
    await store.deleteGroup('p', 'second');
    assert.deepEqual(await store.listGroups('p'), []);
    assert.deepEqual((await store.list('p')).map(record => record.title), ['Three']);
  });
});

test('an older file without groups still loads, and an unreadable one is never overwritten', async () => {
  await withStore(async (store, file) => {
    await writeFile(file, JSON.stringify({ version: 1, records: [{ projectId: 'p', path: 'a/1', savedAt: 'x' }] }));
    assert.deepEqual(await store.listGroups('p'), []);
    assert.equal((await store.list('p')).length, 1);
  });
  await withStore(async (store, file) => {
    await writeFile(file, '{ not json');
    await assert.rejects(store.saveGroup(group('g', ['a/1'])), /could not be read/);
    assert.equal(await readFile(file, 'utf8'), '{ not json');
  });
});
