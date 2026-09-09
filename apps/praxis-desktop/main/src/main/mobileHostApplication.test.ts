import assert from 'node:assert/strict';import test from 'node:test';import {createDesktopMobileHostApplication} from './mobileHostApplication';
test('composes injected desktop services without owning execution',()=>{const d={reads:{},commands:{} as never,ledger:{} as never,payloadDigest:()=>''};assert.equal(createDesktopMobileHostApplication(d).reads,d.reads);});
