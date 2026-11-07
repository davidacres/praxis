import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  DEFAULT_ARTIFACTS_FOLDER,
  findRepositoryRoot,
  listArtifactsFolder,
  normalizeArtifactsFolder,
  publishArtifact,
  resolveArtifactsFolder
} from './artifactsFolder';
import { artifactKindOf, buildArtifactLibraryItems, htmlDocumentTitle, isInsideArtifactsFolder, visibleArtifactGroups } from './artifactLibrary';

async function withRepo(run: (repo: string, base: string) => Promise<void>): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'praxis-artifacts-'));
  try {
    const repo = join(base, 'repo');
    await mkdir(join(repo, '.git'), { recursive: true });
    await mkdir(join(repo, 'apps', 'desktop'), { recursive: true });
    await run(repo, base);
  } finally {
    await rm(base, { recursive: true, force: true });
  }
}

test('normalizeArtifactsFolder keeps repository-relative POSIX paths and refuses escapes', () => {
  assert.equal(normalizeArtifactsFolder(''), undefined);
  assert.equal(normalizeArtifactsFolder('   '), undefined);
  assert.equal(normalizeArtifactsFolder('docs/published-artifacts'), 'docs/published-artifacts');
  assert.equal(normalizeArtifactsFolder('./docs//published-artifacts/'), 'docs/published-artifacts');
  assert.equal(normalizeArtifactsFolder('docs\\published-artifacts'), 'docs/published-artifacts');
  assert.throws(() => normalizeArtifactsFolder('../outside'), /above the repository root/);
  assert.throws(() => normalizeArtifactsFolder('docs/../../outside'), /above the repository root/);
  assert.throws(() => normalizeArtifactsFolder('/etc'), /inside the repository/);
  assert.throws(() => normalizeArtifactsFolder('C:\\temp'), /inside the repository/);
  assert.throws(() => normalizeArtifactsFolder('.'), /not the repository root/);
  assert.throws(() => normalizeArtifactsFolder('.git/hooks'), /\.git/);
});

test('the folder resolves against the repository root, not the project folder', async () => {
  await withRepo(async repo => {
    const project = join(repo, 'apps', 'desktop');
    assert.equal(await findRepositoryRoot(project), repo);
    assert.deepEqual(await resolveArtifactsFolder(project), { root: repo, folder: DEFAULT_ARTIFACTS_FOLDER });
    assert.deepEqual(await resolveArtifactsFolder(project, 'design/pages'), { root: repo, folder: 'design/pages' });
  });
});

test('outside a repository the folder resolves against the base folder', async () => {
  const base = await mkdtemp(join(tmpdir(), 'praxis-artifacts-nogit-'));
  try {
    // tmpdir is never inside a git checkout on CI; guard anyway so the test cannot lie.
    if (await findRepositoryRoot(base)) return;
    assert.deepEqual(await resolveArtifactsFolder(base), { root: base, folder: DEFAULT_ARTIFACTS_FOLDER });
  } finally {
    await rm(base, { recursive: true, force: true });
  }
});

test('publishArtifact copies into the folder, reuses identical copies and never overwrites', async () => {
  await withRepo(async repo => {
    const project = join(repo, 'apps', 'desktop');
    const folder = join(repo, 'docs', 'published-artifacts');
    await mkdir(join(folder, 'shots'), { recursive: true });
    await writeFile(join(folder, 'README.md'), '# index');
    await writeFile(join(folder, 'page.html'), '<p>original</p>');

    const fresh = await publishArtifact({ baseFolder: project, fileName: '.praxis/session-artifacts/new.html', bytes: Buffer.from('<p>new</p>') });
    assert.deepEqual([fresh.savedPath, fresh.unchanged], ['docs/published-artifacts/new.html', false]);
    assert.equal(await readFile(join(folder, 'new.html'), 'utf8'), '<p>new</p>');

    const same = await publishArtifact({ baseFolder: project, fileName: 'new.html', bytes: Buffer.from('<p>new</p>') });
    assert.deepEqual([same.savedPath, same.unchanged], ['docs/published-artifacts/new.html', true]);

    const clash = await publishArtifact({ baseFolder: project, fileName: 'page.html', bytes: Buffer.from('<p>changed</p>') });
    assert.deepEqual([clash.savedPath, clash.unchanged], ['docs/published-artifacts/page-2.html', false]);
    assert.equal(await readFile(join(folder, 'page.html'), 'utf8'), '<p>original</p>', 'existing page untouched');
    assert.equal(await readFile(join(folder, 'README.md'), 'utf8'), '# index', 'index untouched');

    const binary = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0xff, 0xfe]);
    const png = await publishArtifact({ baseFolder: project, fileName: 'shot.png', bytes: binary });
    assert.ok((await readFile(join(repo, png.savedPath))).equals(binary), 'binary bytes survive the copy');

    assert.deepEqual((await readdir(folder)).sort(), ['README.md', 'new.html', 'page-2.html', 'page.html', 'shot.png', 'shots']);
  });
});

test('publishArtifact creates a missing folder and refuses one that links outside the repository', async () => {
  await withRepo(async (repo, base) => {
    const created = await publishArtifact({ baseFolder: repo, setting: 'design/pages', fileName: 'a.html', bytes: Buffer.from('a') });
    assert.equal(created.savedPath, 'design/pages/a.html');
    assert.equal(await readFile(join(repo, 'design', 'pages', 'a.html'), 'utf8'), 'a');

    const outside = join(base, 'outside');
    await mkdir(outside);
    await symlink(outside, join(repo, 'escape'), 'dir');
    await assert.rejects(publishArtifact({ baseFolder: repo, setting: 'escape', fileName: 'b.html', bytes: Buffer.from('b') }));
    assert.deepEqual(await readdir(outside), []);
  });
});

test('listArtifactsFolder lists files and subfolders, skipping hidden files and links', async () => {
  await withRepo(async (repo, base) => {
    assert.deepEqual(await listArtifactsFolder(repo, DEFAULT_ARTIFACTS_FOLDER), { entries: [], truncated: false }, 'missing folder is empty');

    const folder = join(repo, 'docs', 'published-artifacts');
    await mkdir(join(folder, 'shots'), { recursive: true });
    await writeFile(join(folder, 'page.html'), '<p>page</p>');
    await writeFile(join(folder, 'titled.html'), '<html><head><title>Release &amp; rollout\n  plan</title></head><body></body></html>');
    await writeFile(join(folder, 'shots', 'one.png'), 'png');
    await writeFile(join(folder, '.DS_Store'), 'x');
    const outside = join(base, 'secret.txt');
    await writeFile(outside, 'secret');
    await symlink(outside, join(folder, 'linked.txt'));

    const listed = await listArtifactsFolder(repo, DEFAULT_ARTIFACTS_FOLDER);
    assert.equal(listed.truncated, false);
    assert.deepEqual(listed.entries.map(entry => [entry.path, entry.name, entry.documentTitle]), [
      ['docs/published-artifacts/page.html', 'page.html', undefined],
      ['docs/published-artifacts/shots/one.png', 'one.png', undefined],
      ['docs/published-artifacts/titled.html', 'titled.html', 'Release & rollout plan']
    ]);
    assert.equal(listed.entries[0].sizeBytes, 11);

    const capped = await listArtifactsFolder(repo, DEFAULT_ARTIFACTS_FOLDER, { maxFiles: 1 });
    assert.deepEqual([capped.entries.length, capped.truncated], [1, true]);
  });
});

test('the library joins files with saved records and ignores records whose file is gone', () => {
  const items = buildArtifactLibraryItems(
    [
      { path: 'a/by-hand.md', name: 'by-hand.md', sizeBytes: 1, modifiedAt: '2026-11-01T00:00:00.000Z' },
      { path: 'a/saved.png', name: 'saved.png', sizeBytes: 2, modifiedAt: '2026-10-01T00:00:00.000Z' }
    ],
    [
      { projectId: 'p', path: 'a/saved.png', title: 'Login screen', description: 'After the fix', sessionKey: 'S-1', sessionTitle: 'Fix login', savedAt: '2026-11-05T00:00:00.000Z' },
      { projectId: 'p', path: 'a/deleted.txt', title: 'Gone', savedAt: '2026-11-06T00:00:00.000Z' }
    ]
  );
  assert.deepEqual(items.map(item => [item.path, item.title, item.kind, item.sessionKey]), [
    ['a/saved.png', 'Login screen', 'image', 'S-1'],
    ['a/by-hand.md', 'by-hand.md', 'document', undefined]
  ]);
  assert.equal(items[0].description, 'After the fix');
});

test('library paths must stay inside the artifacts folder', () => {
  const folder = 'docs/published-artifacts';
  assert.equal(isInsideArtifactsFolder(folder, 'docs/published-artifacts/page.html'), true);
  assert.equal(isInsideArtifactsFolder(folder, 'docs/published-artifacts/shots/a.png'), true);
  assert.equal(isInsideArtifactsFolder(folder, 'docs/published-artifacts-other/a.png'), false);
  assert.equal(isInsideArtifactsFolder(folder, 'docs/published-artifacts/../secret'), false);
  assert.equal(isInsideArtifactsFolder(folder, '/docs/published-artifacts/a'), false);
  assert.equal(isInsideArtifactsFolder(folder, 'docs\\published-artifacts\\a'), false);
  assert.equal(isInsideArtifactsFolder(folder, 'docs/published-artifacts'), false);
  assert.deepEqual(['x.html', 'x.svg', 'x.json', 'x.log', 'x.zip'].map(path => artifactKindOf(path)), ['page', 'image', 'data', 'document', 'other']);
});

test('a page is named by its own title; other files by their saved title or name', () => {
  const items = buildArtifactLibraryItems(
    [
      { path: 'a/report.html', name: 'report.html', sizeBytes: 1, modifiedAt: '2026-11-01T00:00:00.000Z', documentTitle: 'Q4 Release Report' },
      { path: 'a/untitled.html', name: 'untitled.html', sizeBytes: 1, modifiedAt: '2026-11-02T00:00:00.000Z' }
    ],
    [{ projectId: 'p', path: 'a/report.html', title: 'report from chat', savedAt: '2026-10-01T00:00:00.000Z' }]
  );
  assert.deepEqual(items.map(item => item.title).sort(), ['Q4 Release Report', 'untitled.html']);
  assert.equal(htmlDocumentTitle('<title>A &#8212; B &#x2713;</title>'), 'A \u2014 B \u2713');
  assert.equal(htmlDocumentTitle('<title>   </title>'), undefined);
  assert.equal(htmlDocumentTitle('<h1>No title</h1>'), undefined);
});

test('groups show only files that still exist, and vanish when empty', () => {
  const groups = visibleArtifactGroups(
    [
      { id: 'g1', projectId: 'p', name: 'Kept', paths: ['a/1', 'a/gone', 'a/2'], createdAt: '' },
      { id: 'g2', projectId: 'p', name: 'Empty', paths: ['a/gone'], createdAt: '' }
    ],
    new Set(['a/1', 'a/2'])
  );
  assert.deepEqual(groups.map(group => [group.name, group.paths]), [['Kept', ['a/1', 'a/2']]]);
});
