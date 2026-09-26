import assert from 'node:assert/strict'; import test from 'node:test'; import {parseMobileLanDiscoveryHint,resolveMobileHost,rememberMobileHost} from './mobileHostDiscovery';
const good={hostId:'host-1',hostName:'Mac',address:'192.168.1.2',port:43100,hostKeyFingerprint:'key-1',source:'discovery' as const};
test('authenticates discovery hints by host identity',()=>{assert.equal(resolveMobileHost([{...good,hostKeyFingerprint:'wrong'},good],{verify:h=>h.hostKeyFingerprint==='key-1'})?.hostId,'host-1');});
test('supports last-known manual fallback',()=>{const h=rememberMobileHost({...good,source:'manual'});assert.equal(h.source,'last-known');assert.equal(resolveMobileHost([h],{verify:()=>true})?.address,'192.168.1.2');});
test('parses identity-only LAN advertisements and rejects pairing material',()=>{
 const hint=parseMobileLanDiscoveryHint(JSON.stringify({v:1,hostId:'h1',displayName:'Mac',fingerprint:'0123456789abcdef',port:43100,addresses:['192.168.1.2']}));
 assert.equal(hint?.hostId,'h1');
 assert.equal(parseMobileLanDiscoveryHint(JSON.stringify({v:1,hostId:'h1',displayName:'Mac',fingerprint:'0123456789abcdef',port:43100,addresses:[],tokenId:'secret'})),undefined);
});
