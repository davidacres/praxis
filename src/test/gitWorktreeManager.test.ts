import * as assert from 'node:assert';
import { resolveRepoWorktreeRoot } from '../git/gitWorktreeManager';

suite('gitWorktreeManager', () => {
  test('stores delivery worktrees under the loaded repository', () => {
    assert.strictEqual(
      resolveRepoWorktreeRoot(String.raw`C:\dev\system-configurator`),
      String.raw`C:\dev\system-configurator\.worktrees`
    );
  });
});