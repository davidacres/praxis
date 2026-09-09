import assert from 'node:assert/strict';import test from 'node:test';import {createMockHostSnapshot} from './mobileMockHost';
test('mock host is deterministic and isolated',()=>{const s=createMockHostSnapshot();assert.equal(s.host.hostId,'mock-host');assert.equal(s.online,true);});
