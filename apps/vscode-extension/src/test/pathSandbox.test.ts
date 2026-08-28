import * as assert from 'assert';
import * as nodePath from 'node:path';
import { PathSandboxError, resolveSandboxedPath } from '@praxis/core';

suite('pathSandbox', () => {
  // Build genuinely-absolute paths for whichever platform the suite runs on:
  // `C:/work/project` is absolute on Windows but a relative segment on posix,
  // which is why the earlier hard-coded form only rejected the escape on Windows.
  const fsRoot = nodePath.parse(nodePath.resolve('.')).root;
  const root = nodePath.join(fsRoot, 'work', 'project');
  const outside = nodePath.join(fsRoot, 'other', 'file.txt');

  test('resolves relative paths under working directory', () => {
    const resolved = resolveSandboxedPath(root, 'src/a.ts');
    assert.strictEqual(resolved, nodePath.resolve(root, 'src/a.ts'));
  });

  test('rejects path escape with ..', () => {
    assert.throws(
      () => resolveSandboxedPath(root, '../secret.txt'),
      (error: unknown) => error instanceof PathSandboxError
    );
  });

  test('rejects absolute path outside working directory', () => {
    assert.throws(
      () => resolveSandboxedPath(root, outside),
      (error: unknown) => error instanceof PathSandboxError
    );
  });
});
