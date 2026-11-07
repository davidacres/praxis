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

test('a repository details file stores no project id, keeps a stable order, and is re-read when it changes', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-artifact-details-'));
  try {
    const file = join(dir, 'docs', 'published-artifacts', '.praxis-artifacts.json');
    const store = new SavedArtifactStore(file, { projectId: 'local-1' });
    await store.upsert({ projectId: 'local-1', path: 'docs/published-artifacts/b.html', title: 'B', savedAt: '2026-11-07T00:00:00.000Z' });
    await store.upsert({ projectId: 'local-1', path: 'docs/published-artifacts/a.html', title: 'A', savedAt: '2026-11-07T00:00:00.000Z' });
    await store.saveGroup({ ...group('g', ['docs/published-artifacts/a.html']), projectId: 'local-1' });

    const written = JSON.parse(await readFile(file, 'utf8'));
    assert.equal(written.version, 1);
    assert.deepEqual(written.records.map((record: { path: string }) => record.path), ['docs/published-artifacts/a.html', 'docs/published-artifacts/b.html']);
    assert.ok(!JSON.stringify(written).includes('local-1'), 'install-local project ids stay out of the repository');

    // Another clone reads the same file under its own project id.
    const elsewhere = new SavedArtifactStore(file, { projectId: 'local-2' });
    assert.deepEqual((await elsewhere.list('local-2')).map(record => record.title), ['A', 'B']);
    assert.deepEqual((await elsewhere.listGroups('local-2')).map(g => g.paths), [['docs/published-artifacts/a.html']]);

    // A pull or hand edit is picked up without a restart.
    written.records[0].title = 'A, renamed';
    await writeFile(file, JSON.stringify(written));
    assert.equal((await store.list('local-1'))[0]?.title, 'A, renamed');
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a missing repository details file is seeded once from what the app already knew', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-artifact-details-'));
  try {
    const file = join(dir, '.praxis-artifacts.json');
    const store = new SavedArtifactStore(file, { projectId: 'p' });
    await store.seedIfMissing([{ projectId: 'p', path: 'x.html', title: 'Imported', savedAt: '2026-11-07T00:00:00.000Z' }], [group('g', ['x.html'])]);
    assert.deepEqual((await store.list('p')).map(record => record.title), ['Imported']);

    // Once the file exists, seeding never overwrites it.
    await store.seedIfMissing([{ projectId: 'p', path: 'y.html', title: 'Late', savedAt: '2026-11-07T00:00:00.000Z' }], []);
    assert.deepEqual((await store.list('p')).map(record => record.title), ['Imported']);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('a repository details file left with conflict markers is read as empty and never overwritten', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'praxis-artifact-details-'));
  try {
    const file = join(dir, '.praxis-artifacts.json');
    const conflicted = '<<<<<<< HEAD\n{"version":1}\n=======\n{"version":1}\n>>>>>>> other\n';
    await writeFile(file, conflicted);
    const store = new SavedArtifactStore(file, { projectId: 'p' });
    assert.deepEqual(await store.list('p'), []);
    await assert.rejects(store.upsert({ projectId: 'p', path: 'x.html', savedAt: '2026-11-07T00:00:00.000Z' }));
    assert.equal(await readFile(file, 'utf8'), conflicted);
    // Seeding does not paper over it either.
    await store.seedIfMissing([{ projectId: 'p', path: 'x.html', savedAt: '2026-11-07T00:00:00.000Z' }], []);
    assert.equal(await readFile(file, 'utf8'), conflicted);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
