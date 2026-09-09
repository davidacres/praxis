import assert from 'node:assert/strict';
import test from 'node:test';
import { DEFAULT_MOBILE_ACCESS_POLICY, evaluateMobileAccess } from './mobileAccessPolicy';

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
test('internet mode requires an explicit relay route',()=>{
 const policy={mode:'internet' as const,allowedInterfaces:[],allowedSubnets:[]};
 assert.equal(evaluateMobileAccess(policy,peer).allowed,false);
 assert.equal(evaluateMobileAccess(policy,{...peer,relayRoute:true}).allowed,true);
});
