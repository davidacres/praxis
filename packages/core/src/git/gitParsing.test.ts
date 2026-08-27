import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPartialHunkPatch, parseGitBranches, parseGitDiff, parseGitLog, parseGitStatus, parseGitTags } from './gitParsing';

test('parses structured local, remote, and tag refs while ignoring malformed records', () => {
  const branches = parseGitBranches('refs/heads/main\0abc\0*\0\nmalformed\nrefs/remotes/origin/main\0def\0\0refs/remotes/origin/main\n');
  assert.equal(branches.length, 2);
  assert.equal(branches[0].isCurrent, true);
  assert.equal(branches[1].isRemote, true);
  assert.deepEqual(parseGitTags('v1.0\0abc\ninvalid\n'), [{ name: 'v1.0', tip: 'abc' }]);
});

test('parses status paths and safely skips malformed log records', () => {
  const status = parseGitStatus(' M src/file.ts\0A  new.ts\0R  src/new-name.ts\0src/old-name.ts\0', '/repo', 'main');
  assert.equal(status.files.length, 3);
  assert.equal(status.files[0].staged, false);
  assert.equal(status.files[1].staged, true);
  assert.equal(status.files[2].path, 'src/new-name.ts');
  const log = parseGitLog('bad\x1e\nabc\0base\0A\x002026-01-01T00:00:00Z\0message\0body\x1e');
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].parents, ['base']);
});

test('parses additions, deletions, context, renames, and self-contained hunk patches', () => {
  const files = parseGitDiff([
    'diff --git a/src/old.ts b/src/new.ts',
    'similarity index 80%',
    'rename from src/old.ts',
    'rename to src/new.ts',
    'index 1111111..2222222 100644',
    '--- a/src/old.ts',
    '+++ b/src/new.ts',
    '@@ -1,3 +1,3 @@',
    ' const stable = true;',
    '-const oldName = 1;',
    '+const newName = 2;',
    ' export { stable };',
    ''
  ].join('\n'));
  assert.equal(files.length, 1);
  assert.equal(files[0].status, 'renamed');
  assert.equal(files[0].displayPath, 'src/new.ts');
  assert.equal(files[0].additions, 1);
  assert.equal(files[0].deletions, 1);
  assert.deepEqual(files[0].hunks[0].lines[1], { kind: 'deletion', content: 'const oldName = 1;', oldLineNumber: 2 });
  assert.match(files[0].hunks[0].patch, /diff --git a\/src\/old\.ts b\/src\/new\.ts/);
  assert.match(files[0].hunks[0].patch, /@@ -1,3 \+1,3 @@/);
  const partial = buildPartialHunkPatch(files[0].hunks[0], [2]);
  assert.match(partial, /\+const newName = 2;/);
  assert.doesNotMatch(partial, /-const oldName = 1;/);
  assert.match(partial, / const oldName = 1;/);
});

test('parses added, deleted, and binary files without inventing hunks', () => {
  const files = parseGitDiff([
    'diff --git a/new.txt b/new.txt',
    'new file mode 100644',
    '--- /dev/null',
    '+++ b/new.txt',
    '@@ -0,0 +1 @@',
    '+hello',
    'diff --git a/old.txt b/old.txt',
    'deleted file mode 100644',
    '--- a/old.txt',
    '+++ /dev/null',
    '@@ -1 +0,0 @@',
    '-gone',
    'diff --git a/logo.png b/logo.png',
    'index 1234567..abcdef0 100644',
    'Binary files a/logo.png and b/logo.png differ',
    ''
  ].join('\n'));
  assert.deepEqual(files.map(file => file.status), ['added', 'deleted', 'binary']);
  assert.equal(files[2].hunks.length, 0);
  assert.equal(files[2].isBinary, true);
});
