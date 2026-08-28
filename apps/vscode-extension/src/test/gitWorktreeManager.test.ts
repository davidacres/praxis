import * as assert from 'node:assert';
import * as path from 'node:path';
import { resolveRepoWorktreeRoot } from '../git/gitWorktreeManager';

suite('gitWorktreeManager', () => {
  test('stores delivery worktrees under the loaded repository', () => {
    // Worktrees are created on the host running the extension, so the separator
    // is the host's. Assert against path.join rather than a hard-coded Windows
    // string, which only matched on Windows.
    const repoRoot = path.join(path.parse(path.resolve('.')).root, 'dev', 'system-configurator');
    assert.strictEqual(
      resolveRepoWorktreeRoot(repoRoot),
      path.join(repoRoot, '.worktrees')
    );
  });
});
