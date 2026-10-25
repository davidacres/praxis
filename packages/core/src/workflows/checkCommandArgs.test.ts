import test from 'node:test';
import assert from 'node:assert/strict';
import { checkArgsNeedBaseCommit, resolveCheckArgs } from './checkCommandArgs';

test('the base commit fills every argument that names it', () => {
  assert.deepEqual(
    resolveCheckArgs(['scan', '--baseline-commit={baseCommit}', '--output=semgrep.sarif'], { baseCommit: 'abc123' }),
    ['scan', '--baseline-commit=abc123', '--output=semgrep.sarif']
  );
});

test('with no base commit an argument that names it is dropped, so the scan covers everything', () => {
  assert.deepEqual(resolveCheckArgs(['scan', '--baseline-commit={baseCommit}', '.'], {}), ['scan', '.']);
  assert.deepEqual(resolveCheckArgs(['scan', '--baseline-commit={baseCommit}'], { baseCommit: '  ' }), ['scan']);
});

test('arguments without the token are passed through unchanged', () => {
  assert.deepEqual(resolveCheckArgs(['run', 'test'], { baseCommit: 'abc' }), ['run', 'test']);
  assert.deepEqual(resolveCheckArgs(undefined, { baseCommit: 'abc' }), []);
  assert.equal(checkArgsNeedBaseCommit(['run', 'test']), false);
  assert.equal(checkArgsNeedBaseCommit(['--baseline-commit={baseCommit}']), true);
  assert.equal(checkArgsNeedBaseCommit(undefined), false);
});
