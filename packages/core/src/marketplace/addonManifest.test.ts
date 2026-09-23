import { strict as assert } from 'node:assert';
import { test } from 'node:test';

import { validateAddonManifest } from './addonManifest';

function base(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 1,
    kind: 'theme',
    id: 'nord-aurora',
    name: 'Nord Aurora',
    summary: 'A cool, muted palette.',
    author: 'acme',
    ...overrides
  };
}

test('a well-formed manifest validates and is normalized', () => {
  const { manifest, errors, warnings } = validateAddonManifest(base({ name: '  Nord Aurora  ' }));
  assert.deepEqual(errors, []);
  assert.deepEqual(warnings, []);
  assert.equal(manifest?.name, 'Nord Aurora');
  assert.equal(manifest?.kind, 'theme');
  assert.equal(manifest?.id, 'nord-aurora');
});

test('missing or non-object manifest is a single blocking error', () => {
  assert.equal(validateAddonManifest(undefined).manifest, undefined);
  assert.equal(validateAddonManifest('nope').errors.length, 1);
  assert.equal(validateAddonManifest([]).errors.length, 1);
});

test('schemaVersion must be exactly 1', () => {
  assert.match(validateAddonManifest(base({ schemaVersion: 2 })).errors.join(), /schemaVersion/);
  assert.match(validateAddonManifest(base({ schemaVersion: '1' })).errors.join(), /schemaVersion/);
});

test('kind must be one of the four known kinds', () => {
  assert.equal(validateAddonManifest(base({ kind: 'surface-pack' })).errors.length, 0);
  assert.equal(validateAddonManifest(base({ kind: 'agent' })).errors.length, 0);
  assert.equal(validateAddonManifest(base({ kind: 'workflow-template' })).errors.length, 0);
  assert.match(validateAddonManifest(base({ kind: 'connection' })).errors.join(), /kind/);
});

test('id must be lower-kebab and bounded', () => {
  for (const bad of ['Nord', 'nord_aurora', '-nord', 'nörd', 'a'.repeat(65)]) {
    assert.match(validateAddonManifest(base({ id: bad })).errors.join(), /id/, bad);
  }
  for (const good of ['a', 'nord-aurora-2', '9-lives']) {
    assert.equal(validateAddonManifest(base({ id: good })).errors.length, 0, good);
  }
});

test('name is required and length-bounded', () => {
  assert.match(validateAddonManifest(base({ name: '   ' })).errors.join(), /name/);
  assert.match(validateAddonManifest(base({ name: 123 })).errors.join(), /name/);
  assert.match(validateAddonManifest(base({ name: 'x'.repeat(81) })).errors.join(), /80/);
});

test('homepage must be an https URL when present', () => {
  assert.equal(validateAddonManifest(base({ homepage: 'https://example.com/x' })).errors.length, 0);
  assert.match(validateAddonManifest(base({ homepage: 'http://example.com' })).errors.join(), /homepage/);
  assert.match(validateAddonManifest(base({ homepage: 'ftp://x' })).errors.join(), /homepage/);
});

test('contentVersion and minAppVersion must be semver when present', () => {
  assert.equal(
    validateAddonManifest(base({ contentVersion: '1.2.0', minAppVersion: '0.2.0' })).errors.length,
    0
  );
  assert.match(validateAddonManifest(base({ contentVersion: '1.2' })).errors.join(), /contentVersion/);
  assert.match(validateAddonManifest(base({ minAppVersion: 'latest' })).errors.join(), /minAppVersion/);
});

test('display hints are validated and normalized when present', () => {
  const { manifest, errors } = validateAddonManifest(
    base({
      display: {
        preview: { canvas: '#111', accent: '#88c0d0', bogus: 42 },
        mode: 'dark'
      }
    })
  );
  assert.deepEqual(errors, []);
  assert.deepEqual(manifest?.display, { preview: { canvas: '#111', accent: '#88c0d0' }, mode: 'dark' });
});

test('a malformed display block is a blocking error', () => {
  assert.match(validateAddonManifest(base({ display: 'nope' })).errors.join(), /display/);
  assert.match(validateAddonManifest(base({ display: { preview: [] } })).errors.join(), /display\.preview/);
  assert.match(validateAddonManifest(base({ display: { mode: 'sepia' } })).errors.join(), /display\.mode/);
});

test('an empty or colourless display block collapses to undefined', () => {
  assert.equal(validateAddonManifest(base({ display: {} })).manifest?.display, undefined);
  assert.equal(validateAddonManifest(base({ display: { preview: {} } })).manifest?.display, undefined);
});

test('absent summary and author are warnings, not errors', () => {
  const { manifest, errors, warnings } = validateAddonManifest({
    schemaVersion: 1,
    kind: 'theme',
    id: 'bare',
    name: 'Bare'
  });
  assert.ok(manifest);
  assert.deepEqual(errors, []);
  assert.equal(warnings.length, 2);
});
