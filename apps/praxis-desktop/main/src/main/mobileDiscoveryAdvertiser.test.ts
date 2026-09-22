import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MobileDiscoveryAdvertiser,
  encodeMobileDiscoveryHint,
  parseMobileDiscoveryHint,
  type MobileDiscoveryHint,
} from './mobileDiscoveryAdvertiser';

const hint: MobileDiscoveryHint = {
  version: 1,
  hostId: 'host-abc',
  displayName: 'Dave Mac',
  fingerprint: '0123456789abcdef',
  port: 43100,
  addresses: ['192.168.1.20'],
};

test('discovery payload round-trips identity and never carries a pairing grant', () => {
  const raw = encodeMobileDiscoveryHint(hint);
  assert.equal(raw.includes('token'), false);
  assert.equal(raw.includes('private'), false);
  assert.equal(raw.includes('pairing'), false);
  assert.deepEqual(parseMobileDiscoveryHint(raw), hint);
});

test('rejects pairing-shaped or malformed payloads', () => {
  assert.equal(parseMobileDiscoveryHint('P1|host|aa|192.168.1.2:43100|deadbeef|soon'), undefined);
  assert.equal(
    parseMobileDiscoveryHint(JSON.stringify({ ...JSON.parse(encodeMobileDiscoveryHint(hint)), tokenId: 'deadbeef' })),
    undefined,
  );
  assert.equal(
    parseMobileDiscoveryHint(JSON.stringify({ v: 1, hostId: 'h', displayName: 'n', fingerprint: 'short', port: 43100, addresses: [] })),
    undefined,
  );
});

test('start emits the encoded hint and stop ends the broadcasts', async () => {
  const sent: string[] = [];
  const advertiser = new MobileDiscoveryAdvertiser({
    broadcast: payload => sent.push(payload.toString('utf8')),
    intervalMs: 20,
  });
  advertiser.start(hint);
  assert.equal(advertiser.advertised, true);
  assert.equal(parseMobileDiscoveryHint(sent[0] ?? '')?.hostId, 'host-abc');
  await new Promise(resolve => setTimeout(resolve, 50));
  const beforeStop = sent.length;
  assert.ok(beforeStop >= 2);
  advertiser.stop();
  assert.equal(advertiser.advertised, false);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(sent.length, beforeStop);
});
