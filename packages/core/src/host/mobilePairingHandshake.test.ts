import assert from 'node:assert/strict';
import test from 'node:test';
import {
  InMemoryMobilePairingStore,
  compactMobilePairingPayload,
  consumeMobilePairing,
  createMobilePairingInvitation,
  isActivePairingToken,
  issueMobilePairingToken,
} from './mobilePairingHandshake';

const token={tokenId:'qr-1',hostId:'host-mac',expiresAt:'2026-09-09T13:00:00.000Z'};
const request={tokenId:'qr-1',hostId:'host-mac',deviceId:'phone-1',devicePublicKey:'pk',projectIds:['praxis'],proof:'valid',requestedAt:'2026-09-09T12:00:00.000Z'};
const verifier={verify:(r:typeof request)=>r.proof==='valid',confirmDevice:()=>true};

test('consumes a valid token once',()=>{const store=new InMemoryMobilePairingStore([token]);assert.deepEqual(consumeMobilePairing(store,verifier,request,'2026-09-09T12:01:00.000Z'),{ok:true,deviceId:'phone-1',projectIds:['praxis']});const replay=consumeMobilePairing(store,verifier,request,'2026-09-09T12:02:00.000Z'); assert.equal(replay.ok,false); if(!replay.ok) assert.equal(replay.reason,'replayed');});
test('issues a single-use expiring invitation without a private key',()=>{
  const token=issueMobilePairingToken('host-mac','qr-1',new Date('2026-09-09T12:00:00.000Z'),60_000);
  assert.equal(token.expiresAt,'2026-09-09T12:01:00.000Z');
  assert.equal(isActivePairingToken(token,'2026-09-09T12:00:30.000Z'),true);
  assert.equal(isActivePairingToken({...token,consumedAt:'2026-09-09T12:00:10.000Z'},'2026-09-09T12:00:30.000Z'),false);
  const invitation=createMobilePairingInvitation(token,{displayName:'Dave Mac',publicKeyHex:'aa',endpoints:[{address:'192.168.1.2',port:43100}]});
  assert.equal(invitation.version,1);
  assert.match(compactMobilePairingPayload(invitation),/^P1\|host-mac\|aa\|192.168.1.2:43100\|qr-1\|/);
});
test('rejects expiry, host substitution, proof failure, and missing confirmation',()=>{
 const expired=consumeMobilePairing(new InMemoryMobilePairingStore([token]),verifier,request,'2026-09-09T14:00:00.000Z'); assert.equal(expired.ok,false); if(!expired.ok) assert.equal(expired.reason,'expired');
 const mismatch=consumeMobilePairing(new InMemoryMobilePairingStore([token]),verifier,{...request,hostId:'other'},'2026-09-09T12:01:00.000Z'); assert.equal(mismatch.ok,false); if(!mismatch.ok) assert.equal(mismatch.reason,'host-mismatch');
 const invalid=consumeMobilePairing(new InMemoryMobilePairingStore([token]),{...verifier,verify:()=>false},request,'2026-09-09T12:01:00.000Z'); assert.equal(invalid.ok,false); if(!invalid.ok) assert.equal(invalid.reason,'invalid-proof');
 const unconfirmed=consumeMobilePairing(new InMemoryMobilePairingStore([token]),{...verifier,confirmDevice:()=>false},request,'2026-09-09T12:01:00.000Z'); assert.equal(unconfirmed.ok,false); if(!unconfirmed.ok) assert.equal(unconfirmed.reason,'unconfirmed');
});

test('an invitation carries an optional relay route as trailing QR parts',()=>{
  const token=issueMobilePairingToken('host-mac','qr-1',new Date('2026-09-09T12:00:00.000Z'),60_000);
  const base={displayName:'Dave Mac',publicKeyHex:'aa',endpoints:[{address:'192.168.1.2',port:43100}]};
  const relay={url:'wss://relay.example.com',channel:'0123456789abcdef0123456789abcdef'};
  const without=compactMobilePairingPayload(createMobilePairingInvitation(token,base));
  const withRelay=compactMobilePairingPayload(createMobilePairingInvitation(token,{...base,relay}));
  assert.equal(without.split('|').length,6);
  assert.deepEqual(withRelay.split('|').slice(0,6),without.split('|'),'the first six parts are unchanged, so an older phone still reads it');
  assert.deepEqual(withRelay.split('|').slice(6),[relay.url,relay.channel]);
  assert.equal(createMobilePairingInvitation(token,base).relay,undefined);
});
