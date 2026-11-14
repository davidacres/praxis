import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, stat, rm, utimes, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { syncAssets } from '../build-run-renderer.mjs';

test('unchanged builds preserve file and directory timestamps; changed assets replace stale output', async () => {
  const root = await mkdtemp(path.join(tmpdir(), 'praxis-assets-'));
  const source = path.join(root, 'stage');
  const output = path.join(root, 'dist');
  try {
    await mkdir(path.join(source, 'assets'), { recursive: true });
    await writeFile(path.join(source, 'index.html'), 'page');
    await writeFile(path.join(source, 'assets/app.js'), 'original');
    await syncAssets(source, output);
    const paths = [output, path.join(output, 'assets'), path.join(output, 'index.html'), path.join(output, 'assets/app.js')];
    for (const file of paths) await utimes(file, 1000, 1000);
    await syncAssets(source, output);
    for (const file of paths) assert.equal((await stat(file)).mtimeMs, 1000000);
    await rm(path.join(source, 'assets/app.js'));
    await writeFile(path.join(source, 'assets/new.js'), 'new');
    await writeFile(path.join(source, 'index.html'), 'updated');
    await syncAssets(source, output);
    assert.deepEqual(await readdir(path.join(output, 'assets')), ['new.js']);
    assert.equal(await readFile(path.join(output, 'index.html'), 'utf8'), 'updated');
    // Vite public assets may change from a file to a directory or back.
    await rm(path.join(source, 'assets'), { recursive: true });
    await writeFile(path.join(source, 'assets'), 'file');
    await syncAssets(source, output);
    assert.equal(await readFile(path.join(output, 'assets'), 'utf8'), 'file');
    await rm(path.join(source, 'assets'));
    await mkdir(path.join(source, 'assets'));
    await syncAssets(source, output);
    assert.ok((await stat(path.join(output, 'assets'))).isDirectory());
  } finally { await rm(root, { recursive: true, force: true }); }
});
