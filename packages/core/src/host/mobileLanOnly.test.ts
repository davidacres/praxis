import assert from 'node:assert/strict';import test from 'node:test';import {assertLanOnlyExecution} from './mobileLanOnly';
const p={interfaceName:'en0',remoteAddress:'192.168.1.4',authenticated:true};
test('allows authenticated direct LAN execution',()=>{assert.deepEqual(assertLanOnlyExecution(p),{allowed:true});});
test('rejects relay, unauthenticated, and forwarded peers',()=>{assert.equal(assertLanOnlyExecution({...p,relayRoute:true}).allowed,false);assert.equal(assertLanOnlyExecution({...p,authenticated:false}).allowed,false);assert.equal(assertLanOnlyExecution({...p,forwardedFor:'8.8.8.8'}).allowed,false);});
