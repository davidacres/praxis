import assert from 'node:assert/strict';
import test from 'node:test';
import { MobileConnectionError, classifyMobileTransportFailure, mobileConnectionStatus } from '@praxis/mobile-protocol';
import { describeConnectionIssue, parseMobileInvitation, reconnectDelayMs } from './mobilePairingInvitation';

const KEY = 'ab'.repeat(32);
const NOW = new Date('2026-09-23T10:00:00.000Z');

test('the compact QR keeps its single-use token and expiry', () => {
  const parsed = parseMobileInvitation(`P1|dave-mac|${KEY}|192.168.1.20:43100|a1b2c3d4e5f6|2026-09-23T10:10:00.000Z`, NOW);
  assert.equal(parsed.kind, 'invitation');
  if (parsed.kind !== 'invitation') return;
  assert.deepEqual(parsed.details, { hostId: 'dave-mac', hostPublicKeyHex: KEY, address: '192.168.1.20', port: 43100, tokenId: 'a1b2c3d4e5f6', expiresAt: '2026-09-23T10:10:00.000Z' });
  assert.equal(parsed.expired, false);
});

test('the copied JSON invitation parses the same, and expiry is caught before connecting', () => {
  const parsed = parseMobileInvitation(JSON.stringify({
    version: 1, hostId: 'dave-mac', displayName: 'Dave Mac', publicKeyHex: KEY, endpoints: [{ address: '10.0.0.4', port: 43100 }], tokenId: 'tok123456789', expiresAt: '2026-09-23T09:59:00.000Z',
  }), NOW);
  assert.equal(parsed.kind, 'invitation');
  if (parsed.kind !== 'invitation') return;
  assert.equal(parsed.details.hostName, 'Dave Mac');
  assert.equal(parsed.details.tokenId, 'tok123456789');
  assert.equal(parsed.expired, true);
});

test('a bare key is a reconnect, and junk is rejected', () => {
  assert.deepEqual(parseMobileInvitation(KEY.toUpperCase()), { kind: 'key', details: { hostPublicKeyHex: KEY } });
  assert.equal(parseMobileInvitation('hello').kind, 'unrecognised');
  assert.equal(parseMobileInvitation(`P1|host|not-a-key|1.2.3.4:1`).kind, 'unrecognised');
});

test('connection failures become actionable issues', () => {
  const revoked = describeConnectionIssue(MobileConnectionError.fromStatus(mobileConnectionStatus('device-revoked')));
  assert.deepEqual([revoked.title, revoked.action, revoked.retryable], ['Access revoked', 'rescan', false]);
  const pending = describeConnectionIssue(MobileConnectionError.fromStatus(mobileConnectionStatus('pairing-pending')));
  assert.equal(pending.action, 'wait');
  const unreachable = describeConnectionIssue(classifyMobileTransportFailure({ stage: 'connect', endpoint: '10.0.0.4:43100', cause: new Error('ECONNREFUSED') }));
  assert.equal(unreachable.title, 'Desktop unreachable');
  assert.match(unreachable.message, /10\.0\.0\.4:43100 \(ECONNREFUSED\)/);
  assert.equal(unreachable.retryable, true);
  const keyReset = describeConnectionIssue(classifyMobileTransportFailure({ stage: 'handshake', endpoint: 'x' }));
  assert.equal(keyReset.action, 'rescan');
  assert.equal(describeConnectionIssue(new Error('boom')).title, 'Couldn’t connect');
  assert.doesNotMatch(unreachable.message, /^The Praxis desktop connection closed\.$/);
});

test('reconnect backs off exponentially to a cap', () => {
  assert.deepEqual([0, 1, 2, 3, 10].map(reconnectDelayMs), [1000, 2000, 4000, 8000, 30000]);
});
