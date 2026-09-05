import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { test } from 'node:test';

import {
  assertTarballIntegrity,
  verifyShasum,
  verifySubresourceIntegrity
} from './integrity';

const BYTES = new TextEncoder().encode('a pretend .tgz payload');
const SHA512 = createHash('sha512').update(BYTES).digest('base64');
const SHA256 = createHash('sha256').update(BYTES).digest('base64');
const SHA1_HEX = createHash('sha1').update(BYTES).digest('hex');

test('verifySubresourceIntegrity passes on a matching sha512 and reports the algorithm', () => {
  const result = verifySubresourceIntegrity(BYTES, `sha512-${SHA512}`);
  assert.equal(result.ok, true);
  assert.equal(result.algorithm, 'sha512');
});

test('verifySubresourceIntegrity passes when any one entry in a space-separated list matches', () => {
  const result = verifySubresourceIntegrity(BYTES, `sha256-not-the-hash sha512-${SHA512}`);
  assert.equal(result.ok, true);
  assert.equal(result.algorithm, 'sha512');
});

test('verifySubresourceIntegrity accepts sha256 too', () => {
  assert.equal(verifySubresourceIntegrity(BYTES, `sha256-${SHA256}`).ok, true);
});

test('verifySubresourceIntegrity fails on a mismatch', () => {
  const result = verifySubresourceIntegrity(BYTES, `sha512-${SHA256}`);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /did not match/);
});

test('verifySubresourceIntegrity rejects an unparseable or unsupported string', () => {
  assert.equal(verifySubresourceIntegrity(BYTES, 'deadbeef').ok, false);
  assert.equal(verifySubresourceIntegrity(BYTES, 'md5-abc').ok, false);
});

test('verifyShasum checks a hex SHA-1', () => {
  assert.equal(verifyShasum(BYTES, SHA1_HEX).ok, true);
  assert.equal(verifyShasum(BYTES, SHA1_HEX.toUpperCase()).ok, true);
  assert.equal(verifyShasum(BYTES, 'f'.repeat(40)).ok, false);
  assert.equal(verifyShasum(BYTES, 'not-hex').ok, false);
});

test('assertTarballIntegrity prefers SRI, falls back to shasum, and throws on a mismatch', () => {
  assert.doesNotThrow(() => assertTarballIntegrity(BYTES, { integrity: `sha512-${SHA512}` }));
  assert.doesNotThrow(() => assertTarballIntegrity(BYTES, { shasum: SHA1_HEX }));
  assert.throws(
    () => assertTarballIntegrity(BYTES, { integrity: `sha512-${SHA256}`, shasum: SHA1_HEX }),
    /did not match the integrity hash/
  );
});

test('assertTarballIntegrity refuses a version with nothing to verify against', () => {
  assert.throws(() => assertTarballIntegrity(BYTES, {}), /no integrity hash or shasum/);
  assert.throws(() => assertTarballIntegrity(BYTES, { integrity: '  ' }), /no integrity hash or shasum/);
});
