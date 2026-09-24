import assert from 'node:assert/strict';
import test from 'node:test';
import { createMobileCommand } from './mobileProtocol';
import { dispatchMobileCommand } from './mobileExecutionBoundary';

const command=createMobileCommand({
 commandId:'cmd-87654321',
 issuedAt:'2026-09-09T12:00:00.000Z',
 caller:{deviceId:'phone-dave',capabilities:['execute'] as const},
 target:{hostId:'host-mac',projectId:'praxis'},
 operation:'sessions.continue',
 payload:{sessionId:'session-1',prompt:'Continue the work'},
});

test('dispatches only through the injected execution handler',async()=>{
 let received:string|undefined;
 const result=await dispatchMobileCommand(command,{
  'sessions.create':async()=>undefined,
  'sessions.continue':async c=>{received=c.target.projectId;return {accepted:true};},
  'sessions.cancel':async()=>undefined,'sessions.configure':async()=>undefined,
  'workflowRuns.start':async()=>undefined,
  'workflowRuns.cancel':async()=>undefined,
  'workflowRuns.retryStage':async()=>undefined,
  'permissions.respond':async()=>undefined,
  'workflowGates.approve':async()=>undefined,
  'workflowGates.reject':async()=>undefined,
  'gadgets.submit':async()=>undefined,
 });
 assert.deepEqual(result,{ok:true,value:{accepted:true}});
 assert.equal(received,'praxis');
});

test('returns a typed conflict when the host handler rejects',async()=>{
 const result=await dispatchMobileCommand(command,{
  'sessions.create':async()=>undefined,
  'sessions.continue':async()=>{throw new Error('session is already running');},
  'sessions.cancel':async()=>undefined,'sessions.configure':async()=>undefined,
  'workflowRuns.start':async()=>undefined,
  'workflowRuns.cancel':async()=>undefined,
  'workflowRuns.retryStage':async()=>undefined,
  'permissions.respond':async()=>undefined,
  'workflowGates.approve':async()=>undefined,
  'workflowGates.reject':async()=>undefined,
  'gadgets.submit':async()=>undefined,
 });
 assert.equal(result.ok,false);
 if(!result.ok) assert.equal(result.error.code,'command-conflict');
});
