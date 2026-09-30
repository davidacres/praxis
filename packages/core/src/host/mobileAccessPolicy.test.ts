import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MOBILE_ACCESS_POLICY, evaluateMobileAccess, isPrivateAddress } from './mobileAccessPolicy';

const peer={interfaceName:'en0',remoteAddress:'192.168.1.20',authenticated:true};

test('defaults to disabled',()=>{assert.deepEqual(evaluateMobileAccess(DEFAULT_MOBILE_ACCESS_POLICY,peer),{allowed:false,reason:'disabled'});});
test('allows authenticated local peers only on configured interface/subnet',()=>{
 const policy={mode:'local-only' as const,allowedInterfaces:['en0'],allowedSubnets:['192.168.1.']};
 assert.equal(evaluateMobileAccess(policy,peer).allowed,true);
 assert.equal(evaluateMobileAccess(policy,{...peer,interfaceName:'utun0'}).allowed,false);
 assert.equal(evaluateMobileAccess(policy,{...peer,remoteAddress:'10.0.0.4'}).allowed,false);
});
test('rejects spoofed forwarding and relay routes in local-only mode',()=>{
 const policy={mode:'local-only' as const,allowedInterfaces:[],allowedSubnets:[]};
 assert.equal(evaluateMobileAccess(policy,{...peer,forwardedFor:'8.8.8.8'}).reason,'forwarded-header-not-trusted');
 assert.equal(evaluateMobileAccess(policy,{...peer,relayRoute:true}).reason,'relay-not-enabled');
});
test('internet mode admits relayed peers and still applies the local allowlists to direct ones',()=>{
 const open={mode:'internet' as const,allowedInterfaces:[],allowedSubnets:[]};
 assert.equal(evaluateMobileAccess(open,{...peer,relayRoute:true}).reason,'internet-peer');
 assert.equal(evaluateMobileAccess(open,peer).reason,'local-peer');
 const scoped={mode:'internet' as const,allowedInterfaces:['en0'],allowedSubnets:['192.168.1.']};
 assert.equal(evaluateMobileAccess(scoped,{...peer,interfaceName:'en1'}).reason,'interface-not-allowed');
 assert.equal(evaluateMobileAccess(scoped,{...peer,relayRoute:true,interfaceName:'',remoteAddress:'relay'}).allowed,true);
});
test('off never admits a relayed peer',()=>{
 const off={mode:'off' as const,allowedInterfaces:[],allowedSubnets:[]};
 assert.equal(evaluateMobileAccess(off,{...peer,relayRoute:true}).reason,'disabled');
});

test('internet mode does not admit a direct peer from a public address',()=>{
 const policy={mode:'internet' as const,allowedInterfaces:[],allowedSubnets:[]};
 assert.equal(evaluateMobileAccess(policy,{...peer,remoteAddress:'203.0.113.9'}).reason,'address-not-allowed');
 assert.equal(evaluateMobileAccess(policy,{...peer,remoteAddress:'::ffff:203.0.113.9'}).reason,'address-not-allowed');
 assert.equal(evaluateMobileAccess(policy,{...peer,remoteAddress:'::ffff:192.168.1.5'}).allowed,true);
 assert.equal(evaluateMobileAccess(policy,{...peer,remoteAddress:'relay',relayRoute:true}).allowed,true);
});
test('isPrivateAddress covers the private ranges and rejects the rest',()=>{
 for(const a of ['127.0.0.1','10.1.2.3','172.16.0.1','172.31.255.1','192.168.10.7','169.254.1.1','::1','fe80::1%en0','fd12:3456::1','::ffff:10.0.0.1']) assert.equal(isPrivateAddress(a),true,a);
 for(const a of ['8.8.8.8','172.15.0.1','172.32.0.1','192.169.0.1','100.64.0.1','2001:db8::1','::ffff:8.8.8.8','relay','']) assert.equal(isPrivateAddress(a),false,a);
});
