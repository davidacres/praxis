import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStageTaskDefinition, stageOutcomeFromSession, stageSessionKey } from './workflowStageTask';
import type { WorkflowStageContext } from './workflowStageSession';
import type { WorkflowAgentTaskNode } from './workflowTypes';

function reviewNode(overrides: Partial<WorkflowAgentTaskNode> = {}): WorkflowAgentTaskNode {
  return {
    type: 'agent-task',
    id: 'review',
    name: 'Review',
    x: 0,
    y: 0,
    inputs: ['change-diff'],
    agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only' },
    instructions: 'Review the change.',
    outputs: [{ id: 'review-report', kind: 'report', required: true }],
    mutatesWorktree: false,
    ...overrides
  };
}

function context(overrides: Partial<WorkflowStageContext> = {}): WorkflowStageContext {
  return {
    runId: 'run-1',
    nodeId: 'review',
    stageName: 'Review',
    instructions: 'Review the change for correctness.',
    inputs: [
      {
        artifactId: 'a1',
        contractId: 'change-diff',
        nodeId: 'implement',
        runId: 'run-1',
        kind: 'diff',
        createdAt: '2026-09-02T09:00:00.000Z'
      }
    ],
    expectedOutputs: [{ id: 'review-report', kind: 'report', required: true }],
    snapshot: { ref: 'sha-abc', producedByNodeId: 'implement' },
    ...overrides
  };
}

// ── Session keys ─────────────────────────────────────────────────────────

test('a stage session key is deterministic per run and node', () => {
  assert.equal(stageSessionKey('abcdef1234567890', 'review'), 'WF-ABCDEF12-review');
  assert.equal(stageSessionKey('abcdef1234567890', 'review'), stageSessionKey('abcdef1234567890', 'review'));
  assert.notEqual(stageSessionKey('abcdef1234567890', 'qa'), stageSessionKey('abcdef1234567890', 'review'));
});

// ── Task definition ──────────────────────────────────────────────────────

test('the brief carries the stage instructions, its inputs, and what it must produce', () => {
  const task = buildStageTaskDefinition(context());
  assert.equal(task.goal, 'Review the change for correctness.');
  assert.match(task.scope, /"Review" stage/);
  assert.match(task.scope, /diff "change-diff"/);
  assert.match(task.definitionOfDone, /report "review-report" \(required\)/);
});

test('the brief points a verification stage at the frozen snapshot, not the branch', () => {
  const task = buildStageTaskDefinition(context());
  assert.match(task.scope, /frozen implementation snapshot sha-abc/);
  assert.match(task.scope, /not the live branch/);
});

test('a stage with no upstream snapshot says nothing about one', () => {
  const task = buildStageTaskDefinition(context({ snapshot: undefined }));
  assert.doesNotMatch(task.scope, /snapshot/);
  assert.match(task.scope, /Inputs available/);
});

test('a stage with no inputs says so rather than leaving the list blank', () => {
  const task = buildStageTaskDefinition(context({ inputs: [] }));
  assert.match(task.scope, /Inputs available to you:\n- none/);
});

test('the brief forbids the agent advancing the workflow itself', () => {
  const task = buildStageTaskDefinition(context());
  assert.ok(task.nonGoals?.some(goal => /approve, or skip/.test(goal)));
});

test('a governed stage receives bounded workflow-pack guidance and immutable provenance', () => {
  const task = buildStageTaskDefinition(context({
    workflowPack: {
      reference: {
        id: 'frontend-ui',
        name: 'Frontend UI',
        version: '2.1.0',
        instructionsPath: '.github/skills/frontend-ui/SKILL.md'
      },
      instructions: 'Run the visual checks before declaring the stage complete.',
      provenance: {
        source: 'workspace',
        resolutionMode: 'content',
        fingerprint: 'sha256-pack',
        version: '2.1.0'
      }
    }
  }));

  assert.equal(task.workflow?.id, 'frontend-ui');
  assert.equal(task.workflowProvenance?.fingerprint, 'sha256-pack');
  assert.match(task.goal, /visual checks/);
  assert.match(task.goal, /guidance only/);
});

test('an empty instruction falls back to naming the stage rather than an empty goal', () => {
  const task = buildStageTaskDefinition(context({ instructions: '   ' }));
  assert.equal(task.goal, 'Complete the Review stage.');
});

// ── Outcome extraction ───────────────────────────────────────────────────

test('an aborted or failed session fails the stage', () => {
  assert.equal(stageOutcomeFromSession(reviewNode(), { state: 'aborted' }).status, 'failed');
  const failed = stageOutcomeFromSession(reviewNode(), { state: 'failed', responseText: 'ran out of tokens\nmore' });
  assert.equal(failed.status, 'failed');
  assert.match(failed.error ?? '', /ran out of tokens/);
  assert.doesNotMatch(failed.error ?? '', /more/, 'only the first line is quoted');
});

test('a failed session with provider limit or budget exhaustion pauses with provider-limit', () => {
  // Case 1: Generic Internal error in lastError, but responseText indicates usage limit
  const codexLimit = stageOutcomeFromSession(reviewNode(), {
    state: 'failed',
    lastError: 'Internal error',
    responseText: "You've hit your usage limit. Upgrade to Pro (https://chatgpt.com/explore/pro), visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at 12:24 PM.\n\n"
  });
  assert.equal(codexLimit.status, 'failed');
  assert.equal(codexLimit.pause, 'provider-limit');
  assert.match(codexLimit.error ?? '', /usage limit/);
  assert.doesNotMatch(codexLimit.error ?? '', /Internal error/);

  // Case 2: Budget limit in lastError
  const budgetLimit = stageOutcomeFromSession(reviewNode(), {
    state: 'failed',
    lastError: 'The AI has exceeded its budget'
  });
  assert.equal(budgetLimit.status, 'failed');
  assert.equal(budgetLimit.pause, 'provider-limit');
  assert.match(budgetLimit.error ?? '', /budget/);

  // Case 3: providerLimitReached set, with generic lastError
  const flaggedLimit = stageOutcomeFromSession(reviewNode(), {
    state: 'failed',
    providerLimitReached: true,
    lastError: 'The stage session failed: Internal error'
  });
  assert.equal(flaggedLimit.status, 'failed');
  assert.equal(flaggedLimit.pause, 'provider-limit');
  assert.doesNotMatch(flaggedLimit.error ?? '', /Internal error/);
});

test('a report artifact is claimed when the session actually said something', () => {
  const outcome = stageOutcomeFromSession(reviewNode(), { state: 'completed', responseText: 'Looks correct.' });
  assert.equal(outcome.status, 'succeeded');
  assert.deepEqual(outcome.artifacts?.map(artifact => artifact.contractId), ['review-report']);
});

test('a silent session claims no narrative artifact, so the engine fails the stage', () => {
  const outcome = stageOutcomeFromSession(reviewNode(), { state: 'completed', responseText: '   ' });
  assert.deepEqual(outcome.artifacts, [], 'nothing to stand behind the report');
});

test('a diff artifact is claimed from the commit the stage froze', () => {
  const node = reviewNode({
    id: 'implement',
    outputs: [{ id: 'change-diff', kind: 'diff', required: true }],
    mutatesWorktree: true
  });
  const outcome = stageOutcomeFromSession(node, { state: 'completed', snapshotRef: 'sha-xyz' });
  assert.equal(outcome.snapshotRef, 'sha-xyz');
  assert.deepEqual(outcome.artifacts, [{ contractId: 'change-diff', kind: 'diff', path: 'sha-xyz' }]);
});

test('a diff with no commit behind it is not claimed', () => {
  const node = reviewNode({
    id: 'implement',
    outputs: [{ id: 'change-diff', kind: 'diff', required: true }],
    mutatesWorktree: true
  });
  const outcome = stageOutcomeFromSession(node, { state: 'completed', responseText: 'I thought about it.' });
  assert.deepEqual(outcome.artifacts, [], 'prose cannot stand in for a commit');
});

test('a written file wins over the narrative fallback', () => {
  const outcome = stageOutcomeFromSession(reviewNode(), {
    state: 'completed',
    responseText: 'Looks correct.',
    artifactPaths: { 'review-report': '/runs/run-1/review/report.md' }
  });
  assert.deepEqual(outcome.artifacts, [
    { contractId: 'review-report', kind: 'report', path: '/runs/run-1/review/report.md' }
  ]);
});

test('an artifact the node never declared is not invented', () => {
  const outcome = stageOutcomeFromSession(reviewNode(), {
    state: 'completed',
    responseText: 'Fine.',
    artifactPaths: { smuggled: '/tmp/x' }
  });
  assert.deepEqual(outcome.artifacts?.map(artifact => artifact.contractId), ['review-report']);
});
