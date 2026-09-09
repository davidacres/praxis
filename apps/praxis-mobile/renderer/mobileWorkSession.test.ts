import assert from 'node:assert/strict';import test from 'node:test';import {restoreMobileWork,workCacheKey} from './mobileWorkSession';
const a={hostId:'h1',projectId:'p1',sessionId:'s1',workId:'issue-1'},b={...a,projectId:'p2'};
test('scopes cache by host project session and work',()=>{assert.notEqual(workCacheKey(a),workCacheKey(b));assert.equal(restoreMobileWork([{identity:a,value:'one'},{identity:b,value:'two'}],b),'two');});
test('missing scope does not restore stale work',()=>{assert.equal(restoreMobileWork([{identity:a,value:'one'}],{...a,hostId:'h2'}),undefined);});
