import assert from 'node:assert/strict';import test from 'node:test';import {selectMobileDetail,selectMobileRoute} from './mobileNavigation';
const base={primary:'work' as const,detail:'progress' as const,hostId:'host-1',projectId:'praxis'};
test('primary navigation stays within work-focused destinations',()=>{assert.equal(selectMobileRoute(base,'attention').primary,'attention');assert.equal(selectMobileRoute(base,'attention').detail,'chat');});
test('detail tabs are explicit and preserve host scope',()=>{const s=selectMobileDetail(base,'changes');assert.equal(s.detail,'changes');assert.equal(s.hostId,'host-1');});
