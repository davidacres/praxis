import assert from 'node:assert/strict';
import test from 'node:test';
import { addressInSubnet, isLocalNetworkAddress, isNonPublicNetworkAddress, normalizeMobileSubnet, parseNetworkAddress } from './networkAddress';

// SEC-005: every spelling the old string-prefix guard let through must classify as non-public.
test('the SEC-005 bypass spellings are non-public', () => {
  for (const address of ['::ffff:127.0.0.1', '::ffff:169.254.169.254', '::ffff:7f00:1', 'fd00::1', 'fe80::1', 'fe80::1%en0', '[fe80::1]', '100.64.1.1', '0:0:0:0:0:0:0:1', '0.0.0.0', '::', '::127.0.0.1', '224.0.0.1', '240.0.0.1', 'ff02::1']) {
    assert.equal(isNonPublicNetworkAddress(address), true, address);
  }
});

test('public addresses stay public, including mapped ones', () => {
  for (const address of ['8.8.8.8', '1.1.1.1', '172.15.255.255', '172.32.0.0', '192.169.0.1', '100.63.255.255', '100.128.0.0', '2001:4860:4860::8888', '::ffff:8.8.8.8']) {
    assert.equal(isNonPublicNetworkAddress(address), false, address);
  }
});

test('mobile locality is narrower than the browser deny set', () => {
  for (const address of ['127.0.0.1', '10.0.0.1', '172.16.0.1', '172.31.255.255', '192.168.0.1', '169.254.1.1', '::1', 'fd12::1', 'fe80::1%en0', '::ffff:192.168.1.5']) {
    assert.equal(isLocalNetworkAddress(address), true, address);
  }
  for (const address of ['100.64.1.1', '0.0.0.0', '224.0.0.1', '8.8.8.8', '2001:db8::1']) {
    assert.equal(isLocalNetworkAddress(address), false, address);
  }
});

test('mapped IPv4 in either spelling parses to the same 32-bit value', () => {
  assert.deepEqual(parseNetworkAddress('::ffff:192.168.1.5'), parseNetworkAddress('192.168.1.5'));
  assert.deepEqual(parseNetworkAddress('::ffff:c0a8:105'), parseNetworkAddress('192.168.1.5'));
  assert.equal(parseNetworkAddress('not-an-ip'), undefined);
  assert.equal(parseNetworkAddress('192.168.1'), undefined);
});

test('CIDR edges match on the boundary and never across families', () => {
  assert.equal(addressInSubnet('192.168.1.0', '192.168.1.0/24'), true);
  assert.equal(addressInSubnet('192.168.1.255', '192.168.1.0/24'), true);
  assert.equal(addressInSubnet('192.168.2.0', '192.168.1.0/24'), false);
  assert.equal(addressInSubnet('10.9.9.9', '0.0.0.0/0'), true);
  assert.equal(addressInSubnet('10.0.0.1', '10.0.0.1'), true, 'a bare address is a /32');
  assert.equal(addressInSubnet('10.0.0.2', '10.0.0.1'), false);
  assert.equal(addressInSubnet('::1', '0.0.0.0/0'), false);
  assert.equal(addressInSubnet('10.0.0.1', '10.0.0.0/33'), false);
  assert.equal(addressInSubnet('10.0.0.1', '10.0.0.0/-1'), false);
  assert.equal(addressInSubnet('10.0.0.1', '10.0.0.0/8/8'), false);
  assert.equal(addressInSubnet('10.0.0.1', '10.0.0.0/x'), false);
});

test('mobile subnets accept addresses and CIDRs, migrate octet prefixes, and reject the rest', () => {
  assert.equal(normalizeMobileSubnet(' 192.168.1.0/24 '), '192.168.1.0/24');
  assert.equal(normalizeMobileSubnet('10.'), '10.0.0.0/8');
  assert.equal(normalizeMobileSubnet('172.16.5.'), '172.16.5.0/24');
  assert.equal(normalizeMobileSubnet('fd00::/8'), 'fd00::/8');
  for (const raw of ['192.168.1', '256.1.', 'lan', '', '192.168.1.0/33', '1.2.3.4.']) assert.equal(normalizeMobileSubnet(raw), undefined, raw);
});
