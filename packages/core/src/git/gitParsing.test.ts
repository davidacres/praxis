import test from 'node:test';
import assert from 'node:assert/strict';
import { parseGitBranches, parseGitLog, parseGitStatus, parseGitTags } from './gitParsing';

test('parses structured local, remote, and tag refs while ignoring malformed records', () => {
  const branches = parseGitBranches('refs/heads/main\0abc\0*\0\nmalformed\nrefs/remotes/origin/main\0def\0\0refs/remotes/origin/main\n');
  assert.equal(branches.length, 2);
  assert.equal(branches[0].isCurrent, true);
  assert.equal(branches[1].isRemote, true);
  assert.deepEqual(parseGitTags('v1.0\0abc\ninvalid\n'), [{ name: 'v1.0', tip: 'abc' }]);
});

test('parses status paths and safely skips malformed log records', () => {
  const status = parseGitStatus(' M\0src/file.ts\0A \0new.ts\0', '/repo', 'main');
  assert.equal(status.files.length, 2);
  assert.equal(status.files[0].staged, false);
  assert.equal(status.files[1].staged, true);
  const log = parseGitLog('bad\x1e\nabc\0base\0A\x002026-01-01T00:00:00Z\0message\0body\x1e');
  assert.equal(log.length, 1);
  assert.deepEqual(log[0].parents, ['base']);
});
