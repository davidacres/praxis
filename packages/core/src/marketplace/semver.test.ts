import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import {
  compareVersions,
  isNewerVersion,
  isValidVersion,
  maxVersion,
  meetsMinimum,
  parseVersion,
  sortVersionsDescending
} from './semver';

test('parseVersion accepts MAJOR.MINOR.PATCH with optional v, prerelease, build', () => {
  assert.deepEqual(parseVersion('1.2.3'), { major: 1, minor: 2, patch: 3, prerelease: [] });
  assert.deepEqual(parseVersion('v0.0.1'), { major: 0, minor: 0, patch: 1, prerelease: [] });
  assert.deepEqual(parseVersion('2.0.0-rc.1'), { major: 2, minor: 0, patch: 0, prerelease: ['rc', 1] });
  assert.deepEqual(parseVersion('1.4.0-beta.2+build.9'), {
    major: 1,
    minor: 4,
    patch: 0,
    prerelease: ['beta', 2]
  });
});

test('parseVersion rejects non-semver strings', () => {
  for (const bad of ['', '1', '1.2', '1.2.x', 'latest', '1.2.3.4', 'a.b.c']) {
    assert.equal(parseVersion(bad), undefined, bad);
    assert.equal(isValidVersion(bad), false, bad);
  }
});

test('compareVersions orders by major, then minor, then patch', () => {
  assert.ok(compareVersions('2.0.0', '1.9.9') > 0);
  assert.ok(compareVersions('1.2.0', '1.10.0') < 0);
  assert.ok(compareVersions('1.2.3', '1.2.4') < 0);
  assert.equal(compareVersions('3.1.4', '3.1.4'), 0);
});

test('compareVersions places a prerelease below its release and orders identifiers per spec', () => {
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0') < 0);
  assert.ok(compareVersions('1.0.0-alpha', '1.0.0-alpha.1') < 0);
  assert.ok(compareVersions('1.0.0-alpha.1', '1.0.0-alpha.beta') < 0);
  assert.ok(compareVersions('1.0.0-beta', '1.0.0-beta.2') < 0);
  assert.ok(compareVersions('1.0.0-beta.2', '1.0.0-beta.11') < 0);
  assert.ok(compareVersions('1.0.0-rc.1', '1.0.0') < 0);
});

test('unparseable versions sort below every valid version and equal to each other', () => {
  assert.ok(compareVersions('garbage', '0.0.1') < 0);
  assert.ok(compareVersions('0.0.1', 'garbage') > 0);
  assert.equal(compareVersions('garbage', 'nonsense'), 0);
});

test('isNewerVersion is a strict greater-than', () => {
  assert.equal(isNewerVersion('1.2.4', '1.2.3'), true);
  assert.equal(isNewerVersion('1.2.3', '1.2.3'), false);
  assert.equal(isNewerVersion('1.2.2', '1.2.3'), false);
});

test('maxVersion returns the highest parseable version, ignoring junk', () => {
  assert.equal(maxVersion(['1.0.0', '1.2.0', '1.10.0', '1.9.0']), '1.10.0');
  assert.equal(maxVersion(['2.0.0-rc.1', '1.9.9', '2.0.0']), '2.0.0');
  assert.equal(maxVersion(['nope', 'also-nope']), undefined);
  assert.equal(maxVersion([]), undefined);
});

test('meetsMinimum is inclusive and rejects non-semver inputs', () => {
  assert.equal(meetsMinimum('1.2.3', '1.2.3'), true);
  assert.equal(meetsMinimum('1.3.0', '1.2.9'), true);
  assert.equal(meetsMinimum('1.2.0', '1.2.9'), false);
  assert.equal(meetsMinimum('1.2.0', 'not-semver'), false);
  assert.equal(meetsMinimum('whatever', '1.0.0'), false);
});

test('sortVersionsDescending does not mutate its input', () => {
  const input = ['1.0.0', '1.2.0', '1.1.0'];
  const sorted = sortVersionsDescending(input);
  assert.deepEqual(sorted, ['1.2.0', '1.1.0', '1.0.0']);
  assert.deepEqual(input, ['1.0.0', '1.2.0', '1.1.0']);
});
