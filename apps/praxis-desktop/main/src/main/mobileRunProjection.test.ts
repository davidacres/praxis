import test from 'node:test';
import assert from 'node:assert/strict';
import { InMemoryMobileCommandLedger, type MobileRunEvent, type WorkflowRunSummary } from '@praxis/core';
import { appendMobileRunEvent, currentRunStage, mobileRunSnapshot } from './mobileRunProjection';

type Stage = WorkflowRunSummary['stages'][number];

function stage(nodeId: string, patch: Partial<Stage> = {}): Stage {
  return { nodeId, name: nodeId[0]!.toUpperCase() + nodeId.slice(1), type: 'agent-task', outcome: 'pending', lane: 'idle', attempts: 0, artifacts: [], ...patch };
}

function summary(stages: Stage[], patch: Partial<WorkflowRunSummary> = {}): WorkflowRunSummary {
  return {
    runId: 'run-1',
    projectId: 'p1',
    workflowName: 'Governed delivery — FX-1',
    status: 'running',
    explanation: 'Implement is running.',
    stages,
    graph: { nodes: [], edges: [], entryNodeId: stages[0]?.nodeId ?? '' },
    gates: [],
    branchGroups: [],
    actions: [],
    outstanding: [],
    events: [],
    startedAt: '2026-09-23T22:55:59.686Z',
    permissionMode: 'auto',
    providerLimitPolicy: 'switch',
    exhaustedProviders: [],
    ...patch,
  } as WorkflowRunSummary;
}

test('the current stage is the running agent stage, even beside a running check', () => {
  assert.equal(currentRunStage([
    stage('plan', { lane: 'done', attempts: 1 }),
    stage('lint', { type: 'check', lane: 'running', attempts: 1 }),
    stage('implement', { lane: 'running', attempts: 2 }),
  ]), 'implement');
  assert.equal(currentRunStage([stage('plan', { lane: 'done', attempts: 1 }), stage('qa', { type: 'check', lane: 'running', attempts: 1 })]), 'qa');
});

test('with nothing running it is the stage waiting on a person, then a paused one, then a failure', () => {
  const done = stage('implement', { lane: 'done', attempts: 1 });
  assert.equal(currentRunStage([done, stage('approve', { type: 'approval', lane: 'awaiting' }), stage('review', { lane: 'paused', attempts: 1 })]), 'approve');
  assert.equal(currentRunStage([done, stage('review', { lane: 'paused', attempts: 1 }), stage('qa', { lane: 'failed', attempts: 1 })]), 'review');
  assert.equal(currentRunStage([done, stage('qa', { lane: 'failed', attempts: 1 })]), 'qa');
});

test('a run between stages or finished shows the last stage that did something', () => {
  assert.equal(currentRunStage([
    stage('plan', { lane: 'done', attempts: 1 }),
    stage('implement', { lane: 'done', attempts: 1 }),
    stage('gates', { type: 'join', lane: 'done' }),
    stage('approve', { type: 'approval', lane: 'idle' }),
  ]), 'implement');
  assert.equal(currentRunStage([stage('plan'), stage('implement')]), 'plan');
  assert.equal(currentRunStage([]), undefined);
});

test('the snapshot carries each stage’s session and AI, and whether a person can approve', () => {
  const snapshot = mobileRunSnapshot(summary([
    stage('plan', { lane: 'done', attempts: 3, sessionId: 's-plan', sessionKey: 'WF-RUN1-plan', provider: 'claude-code-cli' }),
    stage('implement', { lane: 'running', attempts: 2, sessionId: 's-impl', sessionKey: 'WF-RUN1-implement', chosenProvider: 'claude-code-cli' }),
    stage('review', { lane: 'paused', attempts: 1, pause: 'provider-limit', lastError: 'Provider limit reached: …' }),
  ], { aiProvider: 'codex-cli', aiModel: 'gpt-5.6-terra', issueKey: 'FX-1' }), 42);

  assert.equal(snapshot.currentNodeId, 'implement');
  assert.equal(snapshot.sequence, 42);
  assert.equal(snapshot.canApprove, false);
  assert.equal(snapshot.paused, false);
  assert.deepEqual(snapshot.stages[0], { nodeId: 'plan', name: 'Plan', type: 'agent-task', lane: 'done', attempts: 3, sessionId: 's-plan', sessionKey: 'WF-RUN1-plan', provider: 'claude-code-cli' });
  // A stage switched to another AI but not yet run on it reports the AI it will use.
  assert.equal(snapshot.stages[1]!.provider, 'claude-code-cli');
  assert.deepEqual({ pause: snapshot.stages[2]!.pause, lastError: snapshot.stages[2]!.lastError }, { pause: 'provider-limit', lastError: 'Provider limit reached: …' });
  assert.equal(mobileRunSnapshot(summary([stage('approve', { lane: 'awaiting' })], { status: 'awaiting-approval' }), 1).canApprove, true);

  const checkSnapshot = mobileRunSnapshot(summary([
    stage('qa', {
      type: 'check',
      lane: 'done',
      attempts: 1,
      command: 'npm test',
      exitCode: 0,
      gate: 'qa',
      findings: {
        metrics: { passed: 51, failed: 0 },
        findings: [{ ruleId: 'r1', file: 'f.ts', line: 1, message: 'm', severity: 'low', fingerprint: 'fp1', category: 'quality' }]
      }
    })
  ]), 2);
  assert.equal(checkSnapshot.stages[0]?.command, 'npm test');
  assert.equal(checkSnapshot.stages[0]?.exitCode, 0);
  assert.equal(checkSnapshot.stages[0]?.gate, 'qa');
  assert.deepEqual(checkSnapshot.stages[0]?.metrics, { passed: 51, failed: 0 });
  assert.deepEqual(checkSnapshot.stages[0]?.findingsSummary, { low: 1 });
});

test('run events are scoped to the run’s project, and a removal says which run went', () => {
  const ledger = new InMemoryMobileCommandLedger();
  const first = appendMobileRunEvent(ledger, 'host-mac', { summary: summary([stage('plan', { lane: 'running', attempts: 1 })]) });
  const second = appendMobileRunEvent(ledger, 'host-mac', { removed: { runId: 'run-1', projectId: 'p1' } });
  assert.equal(second, first + 1);
  const events = ledger.replay(0);
  assert.deepEqual(events.map(envelope => envelope.target), [
    { hostId: 'host-mac', projectId: 'p1', runId: 'run-1' },
    { hostId: 'host-mac', projectId: 'p1', runId: 'run-1' },
  ]);
  const [snapshotEvent, removedEvent] = events.map(envelope => envelope.event as MobileRunEvent);
  assert.equal(snapshotEvent!.type, 'run.snapshot');
  assert.equal(snapshotEvent!.type === 'run.snapshot' && snapshotEvent!.run.sequence, first);
  assert.deepEqual(removedEvent, { type: 'run.removed', runId: 'run-1' });
});
