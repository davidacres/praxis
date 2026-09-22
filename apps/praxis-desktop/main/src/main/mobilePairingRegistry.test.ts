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
  const pending = registry.submitUnpaired('bb'.repeat(32), '2026-09-22T10:00:01.000Z');
  assert.ok(pending);
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
  registry.issueInvitation('host-1', details, new Date('2026-09-22T10:00:00.000Z'));
  const pending = registry.submitUnpaired('bb'.repeat(32), '2026-09-22T10:00:01.000Z');
  assert.equal(registry.confirm(pending!.requestId, { capabilities: ['view'], projectIds: ['p1'] }, '2026-09-22T10:00:02.000Z').ok, true);
  assert.equal(registry.confirm(pending!.requestId, { capabilities: ['view'], projectIds: ['p1'] }, '2026-09-22T10:00:03.000Z').ok, false);
});

test('revoke and host-key reset drop trust', () => {
  const registry = new MobilePairingRegistry(memoryPersist());
  registry.issueInvitation('host-1', details, new Date('2026-09-22T10:00:00.000Z'));
  const pending = registry.submitUnpaired('bb'.repeat(32), '2026-09-22T10:00:01.000Z');
  const confirmed = registry.confirm(pending!.requestId, { capabilities: ['view'], projectIds: ['p1'] }, '2026-09-22T10:00:02.000Z');
  assert.equal(confirmed.ok, true);
  if (!confirmed.ok) return;
  registry.revoke(confirmed.device.deviceId, '2026-09-22T10:01:00.000Z');
  assert.equal(registry.authorize('bb'.repeat(32)), undefined);
  registry.issueInvitation('host-1', details, new Date('2026-09-22T10:02:00.000Z'));
  const other = registry.submitUnpaired('cc'.repeat(32), '2026-09-22T10:02:01.000Z');
  assert.equal(registry.confirm(other!.requestId, { capabilities: ['view'], projectIds: ['p1'] }, '2026-09-22T10:02:02.000Z').ok, true);
  registry.revokeAll('2026-09-22T10:03:00.000Z');
  assert.equal(registry.authorize('cc'.repeat(32)), undefined);
});

test('unpaired peers without an invitation are ignored', () => {
  const registry = new MobilePairingRegistry(memoryPersist());
  assert.equal(registry.submitUnpaired('bb'.repeat(32)), undefined);
});
