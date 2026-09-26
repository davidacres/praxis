import assert from 'node:assert/strict';import test from 'node:test';import {createMobilePlatformAdapters} from './mobilePlatformAdapters';
test('composes platform adapters without prescribing implementations',()=>{const adapters={secureStore:{} as never,qrScanner:{} as never,discovery:{} as never,socket:{} as never};assert.equal(createMobilePlatformAdapters(adapters),adapters);});
