import assert from 'node:assert/strict';import test from 'node:test';import {isLocalExecutionMilestoneComplete} from './mobileLocalMilestone';
const m={paired:true,hostSelected:true,workflowStarted:true,reconnected:true,decisionScoped:true,revokedBlocksAccess:true,jobContinuesAfterDisconnect:true};
test('requires every local execution safety condition',()=>{assert.equal(isLocalExecutionMilestoneComplete(m),true);assert.equal(isLocalExecutionMilestoneComplete({...m,decisionScoped:false}),false);});
