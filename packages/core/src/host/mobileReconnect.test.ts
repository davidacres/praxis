import assert from 'node:assert/strict';import test from 'node:test';import {nextMobileReconnect,resetMobileReconnect} from './mobileReconnect';
test('backs off while preserving event cursor',()=>{const s=nextMobileReconnect({attempt:1,nextAttemptAt:'',cursor:42},'2026-09-09T12:00:00.000Z');assert.equal(s.attempt,2);assert.equal(s.cursor,42);assert.equal(s.nextAttemptAt,'2026-09-09T12:00:00.500Z');});
test('reset starts immediately at the last cursor',()=>{assert.deepEqual(resetMobileReconnect(9,'2026-09-09T12:00:00.000Z'),{attempt:0,nextAttemptAt:'2026-09-09T12:00:00.000Z',cursor:9});});
