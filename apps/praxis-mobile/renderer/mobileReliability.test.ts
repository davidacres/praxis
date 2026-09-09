import assert from 'node:assert/strict';import test from 'node:test';import {restoreAfterSuspension} from './mobileReliability';
test('restores without rewinding cursor',()=>{assert.equal(restoreAfterSuspension({wasSuspended:true,lastCursor:4,pendingCommandIds:['c']},3).lastCursor,4);});
