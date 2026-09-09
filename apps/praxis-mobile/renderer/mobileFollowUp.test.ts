import assert from 'node:assert/strict';import test from 'node:test';import {addFollowUp,followUpScopeKey,updateFollowUp} from './mobileFollowUp';
const f={messageId:'m1',hostId:'h1',projectId:'p1',sessionId:'s1',workId:'w1',text:'continue',state:'pending' as const,createdAt:'2026-09-09T12:00:00.000Z'};
test('keeps follow-ups scoped to work identity',()=>{assert.equal(followUpScopeKey(f),'h1:p1:s1:w1');assert.equal(addFollowUp([],f).length,1);});
test('updates result state without changing scope',()=>{const u=updateFollowUp([f],'m1','completed','done')[0];assert.equal(u.state,'completed');assert.equal(followUpScopeKey(u),followUpScopeKey(f));});
