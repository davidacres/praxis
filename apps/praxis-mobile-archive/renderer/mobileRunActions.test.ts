import assert from 'node:assert/strict';import test from 'node:test';import {isValidMobileRunAction} from './mobileRunActions';
test('validates scoped run actions',()=>{assert.equal(isValidMobileRunAction({action:'start',runId:'r1',projectId:'p1',expectedVersion:0}),true);assert.equal(isValidMobileRunAction({action:'cancel',runId:'',projectId:'p1',expectedVersion:0}),false);});
