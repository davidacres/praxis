import assert from 'node:assert/strict';
import test from 'node:test';
import { InMemoryMobilePairingStore, consumeMobilePairing } from './mobilePairingHandshake';

const token={tokenId:'qr-1',hostId:'host-mac',expiresAt:'2026-09-09T13:00:00.000Z'};
const request={tokenId:'qr-1',hostId:'host-mac',deviceId:'phone-1',devicePublicKey:'pk',projectIds:['praxis'],proof:'valid',requestedAt:'2026-09-09T12:00:00.000Z'};
const verifier={verify:(r:typeof request)=>r.proof==='valid',confirmDevice:()=>true};

test('consumes a valid token once',()=>{const store=new InMemoryMobilePairingStore([token]);assert.deepEqual(consumeMobilePairing(store,verifier,request,'2026-09-09T12:01:00.000Z'),{ok:true,deviceId:'phone-1',projectIds:['praxis']});const replay=consumeMobilePairing(store,verifier,request,'2026-09-09T12:02:00.000Z'); assert.equal(replay.ok,false); if(!replay.ok) assert.equal(replay.reason,'replayed');});
test('rejects expiry, host substitution, proof failure, and missing confirmation',()=>{
 const expired=consumeMobilePairing(new InMemoryMobilePairingStore([token]),verifier,request,'2026-09-09T14:00:00.000Z'); assert.equal(expired.ok,false); if(!expired.ok) assert.equal(expired.reason,'expired');
 const mismatch=consumeMobilePairing(new InMemoryMobilePairingStore([token]),verifier,{...request,hostId:'other'},'2026-09-09T12:01:00.000Z'); assert.equal(mismatch.ok,false); if(!mismatch.ok) assert.equal(mismatch.reason,'host-mismatch');
 const invalid=consumeMobilePairing(new InMemoryMobilePairingStore([token]),{...verifier,verify:()=>false},request,'2026-09-09T12:01:00.000Z'); assert.equal(invalid.ok,false); if(!invalid.ok) assert.equal(invalid.reason,'invalid-proof');
 const unconfirmed=consumeMobilePairing(new InMemoryMobilePairingStore([token]),{...verifier,confirmDevice:()=>false},request,'2026-09-09T12:01:00.000Z'); assert.equal(unconfirmed.ok,false); if(!unconfirmed.ok) assert.equal(unconfirmed.reason,'unconfirmed');
});
