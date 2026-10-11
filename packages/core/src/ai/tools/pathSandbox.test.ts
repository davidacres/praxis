import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveSandboxedPath } from './pathSandbox';

test('filesystem sandbox rejects linked files/directories/dangling links and permits canonical roots and new paths', async () => {
  const base = await mkdtemp(join(tmpdir(), 'praxis-sandbox-'));
  try {
    const root = join(base, 'root'), outside = join(base, 'outside');
    await mkdir(root); await mkdir(outside); await writeFile(join(outside, 'secret'), 'private');
    await writeFile(join(root, '..notes'), 'allowed');
    await symlink(join(outside, 'secret'), join(root, 'file'));
    await symlink(outside, join(root, 'dir'), 'dir');
    await symlink(join(outside, 'new'), join(root, 'dangling'));
    for (const path of ['file', 'dir/secret', 'dir/new', 'dangling', '../outside/secret']) await assert.rejects(resolveSandboxedPath(root, path), /escapes|symlink/);
    assert.match(await resolveSandboxedPath(root, '..notes'), /\.\.notes$/);
    assert.match(await resolveSandboxedPath(root, 'nested/new'), /nested[/\\]new$/);
    await symlink(root, join(base, 'linked-root'), 'dir');
    assert.equal(await resolveSandboxedPath(join(base, 'linked-root'), '..notes'), await resolveSandboxedPath(root, '..notes'));
  } finally { await rm(base, { recursive: true, force: true }); }
});
