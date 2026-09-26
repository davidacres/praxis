import assert from 'node:assert/strict';
import test from 'node:test';
import type { MobileRunSnapshot, MobileRunStage } from '@praxis/core';
import {
  approvalContext,
  currentStage,
  isStageSessionKey,
  mergeRun,
  removeRun,
  replaceRuns,
  runCaption,
  runStageSessionKeys,
  runStatus,
  stageStatus,
  stageWithoutSession,
  stepPosition,
  viewedStage,
} from './mobileWorkflowRuns';

const stage = (nodeId: string, patch: Partial<MobileRunStage> = {}): MobileRunStage => ({
  nodeId, name: nodeId[0]!.toUpperCase() + nodeId.slice(1), type: 'agent-task', lane: 'idle', attempts: 0, ...patch,
});

const run = (patch: Partial<MobileRunSnapshot> = {}): MobileRunSnapshot => ({
  runId: '8b14fe21-527f-4f52-b20c-0f1decc4e9fd',
  projectId: 'p1',
  workflowName: 'Governed delivery — FX-BF-035',
  status: 'running',
  paused: false,
  explanation: 'Implement is running.',
  startedAt: '2026-09-23T22:55:59.686Z',
  currentNodeId: 'implement',
  stages: [
    stage('plan', { lane: 'done', attempts: 3, sessionId: 's-plan', sessionKey: 'WF-8B14FE21-plan', provider: 'claude-code-cli' }),
    stage('implement', { lane: 'running', attempts: 2, sessionId: 's-impl', sessionKey: 'WF-8B14FE21-implement', provider: 'claude-code-cli' }),
    stage('qa', { type: 'check', lane: 'idle' }),
    stage('approve', { type: 'approval', lane: 'idle' }),
  ],
  canApprove: false,
  sequence: 10,
  ...patch,
});

test('a live snapshot replaces an older one and never an newer one', () => {
  const list = mergeRun([], run());
  const moved = mergeRun(list, run({ sequence: 12, currentNodeId: 'qa' }));
  assert.equal(moved.length, 1);
  assert.equal(moved[0]!.currentNodeId, 'qa');
  assert.equal(mergeRun(moved, run({ sequence: 11, currentNodeId: 'implement' }))[0]!.currentNodeId, 'qa', 'a replayed older event does not move it back');
  assert.deepEqual(removeRun(moved, run().runId), []);
});

test('runs are listed newest first, and a fresh read keeps a live event that beat it', () => {
  const older = run({ runId: 'c7cdfc50-a44c-4c77-ab7d-195ca6b2ccb9', startedAt: '2026-09-22T10:00:00.000Z', status: 'failed' });
  const listed = mergeRun(mergeRun([], older), run());
  assert.deepEqual(listed.map(entry => entry.runId.slice(0, 8)), ['8b14fe21', 'c7cdfc50']);

  const live = [run({ sequence: 20, currentNodeId: 'qa' })];
  const refreshed = replaceRuns(live, [run({ sequence: 15 }), older]);
  assert.equal(refreshed.find(entry => entry.runId === run().runId)!.currentNodeId, 'qa');
  assert.equal(refreshed.length, 2);
  assert.deepEqual(replaceRuns(live, []), [], 'a run the desktop no longer lists drops out');
});

test('the view follows the current stage unless a person pinned one', () => {
  assert.equal(currentStage(run())!.nodeId, 'implement');
  assert.equal(viewedStage(run(), undefined)!.nodeId, 'implement');
  assert.equal(viewedStage(run(), 'plan')!.nodeId, 'plan');
  assert.equal(viewedStage(run(), 'gone')!.nodeId, 'implement', 'a pin to a stage that no longer exists falls back');
  assert.equal(viewedStage(run({ currentNodeId: 'qa', sequence: 11 }), undefined)!.nodeId, 'qa', 'and moves on with the run');
  assert.equal(stepPosition(run(), 'implement'), 'Step 2 of 4');
});

test('stage sessions are recognised so the chat list can leave them to their run', () => {
  assert.deepEqual([...runStageSessionKeys([run()])], ['WF-8B14FE21-plan', 'WF-8B14FE21-implement']);
  assert.equal(isStageSessionKey('WF-8B14FE21-review', '8b14fe21-527f-4f52-b20c-0f1decc4e9fd'), true);
  assert.equal(isStageSessionKey('SESSION-1', '8b14fe21-527f-4f52-b20c-0f1decc4e9fd'), false, 'a controller chat with a run stays a chat');
  assert.equal(isStageSessionKey('WF-8B14FE21-plan', undefined), false);
});

test('statuses read the way the desktop monitor does', () => {
  assert.equal(runStatus(run()).label, 'Running');
  assert.equal(runStatus(run({ paused: true })).label, 'Paused');
  assert.equal(runStatus(run({ status: 'awaiting-approval' })).label, 'Needs approval');
  assert.equal(runCaption(run()), 'Running · Implement');
  assert.equal(runCaption(run({ status: 'succeeded', currentNodeId: 'approve' })), 'Succeeded');
  assert.equal(stageStatus(stage('review', { lane: 'paused', pause: 'provider-limit' })).label, 'Paused · AI out of budget');
  assert.equal(stageStatus(stage('plan', { lane: 'done' })).tone, 'ok');
  assert.match(stageWithoutSession(stage('qa', { type: 'check', lane: 'running' })), /check/);
  assert.match(stageWithoutSession(stage('approve', { type: 'approval', lane: 'awaiting' })), /waiting for a person/);
  assert.match(stageWithoutSession(stage('qa', { type: 'check' })), /not started/);
});

test('approval context lists the steps before the gate, their outcomes and findings', () => {
  const stage = (overrides: Record<string, unknown>) => ({ nodeId: 'x', name: 'x', type: 'check', lane: 'done', attempts: 1, ...overrides });
  const context = approvalContext({
    runId: 'r', projectId: 'p', workflowName: 'Release', status: 'awaiting-approval', paused: false, explanation: 'Waiting for approval.',
    startedAt: 't', canApprove: true, sequence: 1,
    stages: [
      stage({ nodeId: 'impl', name: 'Implement', type: 'agent-task', attempts: 2 }),
      stage({ nodeId: 'sast', name: 'SAST', findingsSummary: { high: 1, low: 3 } }),
      stage({ nodeId: 'join', name: 'Gates', type: 'join' }),
      stage({ nodeId: 'tests', name: 'Tests', lane: 'failed', exitCode: 1 }),
      stage({ nodeId: 'approve', name: 'Approve release', type: 'approval', lane: 'awaiting', prompt: 'Check the SAST report.', gate: 'release' }),
      stage({ nodeId: 'deploy', name: 'Deploy', type: 'deployment', lane: 'idle' }),
    ] as never,
  });
  assert.equal(context?.stageName, 'Approve release');
  assert.equal(context?.prompt, 'Check the SAST report.');
  assert.deepEqual(context?.steps.map(step => [step.name, step.label, step.detail]), [
    ['Implement', 'Done', '2 attempts'],
    ['SAST', 'Done', undefined],
    ['Tests', 'Failed', 'exit 1'],
  ]);
  assert.deepEqual(context?.findings, [{ severity: 'low', count: 3 }, { severity: 'high', count: 1 }]);
});
