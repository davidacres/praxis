import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryMobileTrustStore, canReconnectTrustedDevice } from './mobileTrustStore';

const device={deviceId:'phone-1',label:'Dave phone',hostId:'host-mac',hostKeyFingerprint:'host-key-1',devicePublicKey:'public-key',projectIds:['praxis'],pairedAt:'2026-09-09T12:00:00.000Z'};

test('allows reconnect only for active device and matching host key',()=>{const store=new InMemoryMobileTrustStore();store.save(device);assert.equal(canReconnectTrustedDevice(store,'host-mac','phone-1','host-key-1'),true);assert.equal(canReconnectTrustedDevice(store,'host-mac','phone-1','host-key-2'),false);});
test('revocation blocks reconnect and is idempotent',()=>{const store=new InMemoryMobileTrustStore([device] as never); assert.equal(store.revoke('host-mac','phone-1','2026-09-09T13:00:00.000Z'),true);assert.equal(store.revoke('host-mac','phone-1','2026-09-09T14:00:00.000Z'),false);assert.equal(canReconnectTrustedDevice(store,'host-mac','phone-1','host-key-1'),false);});
test('host key rotation forces the new fingerprint',()=>{const store=new InMemoryMobileTrustStore();store.save(device);store.rotateHostKey('host-mac','host-key-2');assert.equal(canReconnectTrustedDevice(store,'host-mac','phone-1','host-key-1'),false);assert.equal(canReconnectTrustedDevice(store,'host-mac','phone-1','host-key-2'),true);});
