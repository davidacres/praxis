import assert from 'node:assert/strict';import test from 'node:test';import {canAcceptMobilePeer,createMobileListener,applyMobileAccessPolicy} from './mobileHostListener';
const p={interfaceName:'en0',remoteAddress:'192.168.1.4',authenticated:true};
test('off has no bound listener',()=>{assert.equal(createMobileListener({mode:'off',allowedInterfaces:[],allowedSubnets:[]}).bound,false);});
test('policy changes apply to established listener state',()=>{let l=createMobileListener({mode:'off',allowedInterfaces:[],allowedSubnets:[]});l=applyMobileAccessPolicy(l,{mode:'local-only',allowedInterfaces:['en0'],allowedSubnets:['192.168.1.']});assert.equal(l.bound,true);assert.equal(canAcceptMobilePeer(l,{mode:'local-only',allowedInterfaces:['en0'],allowedSubnets:['192.168.1.']},p),true);});
