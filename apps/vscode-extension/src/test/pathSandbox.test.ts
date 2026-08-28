import * as assert from 'assert';
import * as nodePath from 'node:path';
import { PathSandboxError, resolveSandboxedPath } from '@praxis/core';

suite('pathSandbox', () => {
  const root = nodePath.resolve('C:/work/project');

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
      () => resolveSandboxedPath(root, 'C:/other/file.txt'),
      (error: unknown) => error instanceof PathSandboxError
    );
  });
});
