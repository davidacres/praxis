import assert from 'node:assert/strict';
import test from 'node:test';
import { canExecuteOnMobileConnection, transitionMobileConnection } from './mobileConnectionLifecycle';

const base={connectionId:'conn-1',deviceId:'phone-dave',state:'disconnected' as const,changedAt:'2026-09-09T12:00:00.000Z'};
const at=(state:any)=>({...base,state,changedAt:'2026-09-09T12:00:00.000Z'});

test('connects only through authentication into ready',()=>{
 let c=base;
 c=transitionMobileConnection(c,'connect',c.changedAt).connection as typeof c;
 assert.equal(c.state,'connecting');
 c=transitionMobileConnection(c,'authenticate',c.changedAt).connection as typeof c;
 c=transitionMobileConnection(c,'ready',c.changedAt).connection as typeof c;
 assert.equal(c.state,'ready');
 assert.equal(canExecuteOnMobileConnection(c),true);
});
test('disconnect detaches client without affecting execution eligibility elsewhere',()=>{
 const disconnected=transitionMobileConnection(at('ready'),'disconnect',base.changedAt);
 assert.equal(disconnected.ok,true);
 if(disconnected.ok) assert.equal(canExecuteOnMobileConnection(disconnected.connection),false);
});
test('rejects execution before ready and invalid transitions',()=>{
 assert.equal(canExecuteOnMobileConnection(base),false);
 assert.equal(transitionMobileConnection(base,'ready',base.changedAt).ok,false);
 assert.equal(transitionMobileConnection(at('closing'),'ready',base.changedAt).ok,false);
});
