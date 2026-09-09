import assert from 'node:assert/strict';
import test from 'node:test';
import { canExecuteOnMobileConnection, transitionMobileConnection, type MobileConnection, type MobileConnectionTransition } from './mobileConnectionLifecycle';

const base:MobileConnection={connectionId:'conn-1',deviceId:'phone-dave',state:'disconnected',changedAt:'2026-09-09T12:00:00.000Z'};
const at=(state:MobileConnection['state']):MobileConnection=>({...base,state,changedAt:'2026-09-09T12:00:00.000Z'});
const connected=(transition:MobileConnectionTransition):MobileConnection=>{
 assert.equal(transition.ok,true);
 if(!transition.ok) throw new Error('expected a valid transition');
 return transition.connection;
};

test('connects only through authentication into ready',()=>{
 let c=base;
 c=connected(transitionMobileConnection(c,'connect',c.changedAt));
 assert.equal(c.state,'connecting');
 c=connected(transitionMobileConnection(c,'authenticate',c.changedAt));
 c=connected(transitionMobileConnection(c,'ready',c.changedAt));
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
