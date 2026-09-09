import assert from 'node:assert/strict';import test from 'node:test';import {registerMobileIpcBridge} from './mobileIpc';
test('registers read and command channels',()=>{const channels:string[]=[];registerMobileIpcBridge({handle:(c)=>{channels.push(c);}},{} as never);assert.deepEqual(channels,['mobile.read','mobile.command']);});
