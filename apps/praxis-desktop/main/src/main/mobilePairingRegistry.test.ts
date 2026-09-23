import assert from 'node:assert/strict';
import test from 'node:test';
import { MobilePairingRegistry, type MobilePairingPersist } from './mobilePairingRegistry';
import type { MobilePairedDevice } from '@praxis/core';

function memoryPersist(seed: MobilePairedDevice[] = []): MobilePairingPersist & { devices: MobilePairedDevice[] } {
  const persist = {
    devices: [...seed],
    load() { return { devices: persist.devices }; },
    save(state: { devices: MobilePairedDevice[] }) { persist.devices = [...state.devices]; },
  };
  return persist;
}

const details = {
  displayName: 'Dave Mac',
  publicKeyHex: 'aa'.repeat(32),
  endpoints: [{ address: '192.168.1.2', port: 43100 }],
};

test('issues one active invitation and consumes it on confirm', () => {
  const registry = new MobilePairingRegistry(memoryPersist());
  const invitation = registry.issueInvitation('host-1', details, new Date('2026-09-22T10:00:00.000Z'));
  const submitted = registry.submitUnpaired('bb'.repeat(32), invitation.tokenId, '2026-09-22T10:00:01.000Z');
  assert.equal(submitted.ok, true);
  const pending = submitted.ok ? submitted.request : undefined;
  assert.equal(pending?.tokenId, invitation.tokenId);
  const confirmed = registry.confirm(pending!.requestId, { capabilities: ['view', 'execute'], projectIds: ['p1'] }, '2026-09-22T10:00:02.000Z');
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  assert.equal(confirmed.device.projectIds?.[0], 'p1');
  assert.equal(registry.authorize('bb'.repeat(32))?.deviceId, confirmed.device.deviceId);
  assert.equal(registry.listPending().length, 0);
  assert.equal(registry.activeInvitation('2026-09-22T10:00:03.000Z', details), undefined);
});

test('forged later confirm cannot reuse a consumed token', () => {
  const registry = new MobilePairingRegistry(memoryPersist());
  const invitation = registry.issueInvitation('host-1', details, new Date('2026-09-22T10:00:00.000Z'));
  const pending = request(registry.submitUnpaired('bb'.repeat(32), invitation.tokenId, '2026-09-22T10:00:01.000Z'));
  assert.equal(registry.confirm(pending!.requestId, { capabilities: ['view'], projectIds: ['p1'] }, '2026-09-22T10:00:02.000Z').ok, true);
  assert.equal(registry.confirm(pending!.requestId, { capabilities: ['view'], projectIds: ['p1'] }, '2026-09-22T10:00:03.000Z').ok, false);
});

test('revoke and host-key reset drop trust', () => {
  const registry = new MobilePairingRegistry(memoryPersist());
  const first = registry.issueInvitation('host-1', details, new Date('2026-09-22T10:00:00.000Z'));
  const pending = request(registry.submitUnpaired('bb'.repeat(32), first.tokenId, '2026-09-22T10:00:01.000Z'));
  const confirmed = registry.confirm(pending!.requestId, { capabilities: ['view'], projectIds: ['p1'] }, '2026-09-22T10:00:02.000Z');
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  registry.revoke(confirmed.device.deviceId, '2026-09-22T10:01:00.000Z');
  assert.equal(registry.authorize('bb'.repeat(32)), undefined);
  assert.equal(registry.wasRevoked('bb'.repeat(32)), true);
  const second = registry.issueInvitation('host-1', details, new Date('2026-09-22T10:02:00.000Z'));
  const other = request(registry.submitUnpaired('cc'.repeat(32), second.tokenId, '2026-09-22T10:02:01.000Z'));
  assert.equal(registry.confirm(other!.requestId, { capabilities: ['view'], projectIds: ['p1'] }, '2026-09-22T10:02:02.000Z').ok, true);
  registry.revokeAll('2026-09-22T10:03:00.000Z');
  assert.equal(registry.authorize('cc'.repeat(32)), undefined);
});

test('unpaired peers without an invitation are ignored', () => {
  const registry = new MobilePairingRegistry(memoryPersist());
  assert.deepEqual(registry.submitUnpaired('bb'.repeat(32), 'anything'), { ok: false, reason: 'no-invitation' });
});

test('only the current invitation token creates a request, and never after expiry or use', () => {
  const registry = new MobilePairingRegistry(memoryPersist());
  const invitation = registry.issueInvitation('host-1', details, new Date('2026-09-22T10:00:00.000Z'));
  assert.deepEqual(registry.submitUnpaired('bb'.repeat(32), 'not-the-token', '2026-09-22T10:00:01.000Z'), { ok: false, reason: 'invalid-token' });
  assert.equal(registry.listPending().length, 0, 'knowing the host key alone does not queue a request');
  assert.deepEqual(registry.submitUnpaired('bb'.repeat(32), invitation.tokenId, '2026-09-22T10:10:00.001Z'), { ok: false, reason: 'expired' });

  const fresh = registry.issueInvitation('host-1', details, new Date('2026-09-22T11:00:00.000Z'));
  assert.deepEqual(registry.submitUnpaired('bb'.repeat(32), invitation.tokenId, '2026-09-22T11:00:01.000Z'), { ok: false, reason: 'invalid-token' }, 'a replaced invitation is dead');
  const phoneA = request(registry.submitUnpaired('aa'.repeat(32), fresh.tokenId, '2026-09-22T11:00:01.000Z'));
  const again = request(registry.submitUnpaired('aa'.repeat(32), fresh.tokenId, '2026-09-22T11:00:02.000Z'));
  assert.equal(again.requestId, phoneA.requestId, 'reconnecting while pending keeps the same request');
  const phoneB = request(registry.submitUnpaired('bb'.repeat(32), fresh.tokenId, '2026-09-22T11:00:03.000Z'));
  assert.equal(registry.confirm(phoneA.requestId, { capabilities: ['view'], projectIds: ['p1'] }, '2026-09-22T11:00:04.000Z').ok, true);
  assert.deepEqual(registry.takeSuperseded().map(item => item.requestId), [phoneB.requestId], 'the single-use token voids the other request');
  assert.equal(registry.listPending().length, 0);
  assert.deepEqual(registry.submitUnpaired('cc'.repeat(32), fresh.tokenId, '2026-09-22T11:00:05.000Z'), { ok: false, reason: 'used' });
});

function request(result: ReturnType<MobilePairingRegistry['submitUnpaired']>) {
  if (!result.ok) return assert.fail(`expected a pairing request, got ${result.reason}`);
  return result.request;
}
