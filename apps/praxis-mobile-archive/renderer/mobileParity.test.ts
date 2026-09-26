import assert from 'node:assert/strict';import test from 'node:test';import {hasDesktopParity,MOBILE_EXECUTION_ACTIONS} from './mobileParity';
test('requires every mobile action to exist on desktop',()=>{assert.equal(hasDesktopParity([...MOBILE_EXECUTION_ACTIONS]),true);assert.equal(hasDesktopParity(['sessions.continue']),false);});
