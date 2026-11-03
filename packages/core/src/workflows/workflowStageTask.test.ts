import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStageTaskDefinition, formatUpstreamReports, readEnvironmentBlock, readPlanStatus, stageOutcomeFromSession, stageSessionKey } from './workflowStageTask';
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
  assert.ok(task.nonGoals?.some(goal => /Do not link, copy or install dependencies from outside/.test(goal)));
  assert.ok(task.nonGoals?.some(goal => /throwaway files.*system temporary directory.*never commit them/.test(goal)));
});

test('each kind of stage is told a failure in delivered work is fixed here, and only a later ticket\'s work is deferred', () => {
  const plan = buildStageTaskDefinition(context({ expectedOutputs: [{ id: 'plan-doc', kind: 'plan', required: true }] })).definitionOfDone;
  const implement = buildStageTaskDefinition(context({ expectedOutputs: [{ id: 'change-diff', kind: 'diff', required: true }] })).definitionOfDone;
  const review = buildStageTaskDefinition(context({ expectedOutputs: [{ id: 'review-findings', kind: 'findings', required: true }] })).definitionOfDone;
  assert.match(plan, /Plan to fix every failing test .* already delivered .* later ticket in the same plan explicitly covers/);
  assert.match(implement, /run the tests that cover what you changed \(the plan's "Tests to keep passing".*including the end-to-end or UI tests/);
  assert.match(plan, /## Tests to keep passing/);
  assert.match(plan, /find_related on a component returns the tests .*search the test files for the test ids \(data-testid\), aria-labels, role names/);
  assert.match(review, /report an existing test that covers changed code or UI but is missing from it/);
  assert.match(implement, /even when earlier, already-delivered work caused it: no other ticket will/);
  assert.match(review, /later ticket .* report it as info and name that ticket/);
  assert.match(review, /already delivered .* not deferred: report it at its real severity/);
  assert.doesNotMatch(review, /run the tests that cover/, 'a reviewer is not told to run tests');
  for (const brief of [plan, implement, review]) assert.match(brief, /Stage status: blocked-environment:/);
});

test('a stage that says its environment stopped it pauses, without using an attempt or sending a loop round', () => {
  const node = reviewNode({ id: 'implement', name: 'Implement', outputs: [{ id: 'change-diff', kind: 'diff', required: true }], mutatesWorktree: true });
  const outcome = stageOutcomeFromSession(node, {
    state: 'completed',
    responseText: 'I could not run anything.\n\nStage status: blocked-environment: node_modules is missing; run the install stage first.',
    startRef: 'a', snapshotRef: 'b'
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.pause, 'environment');
  assert.match(outcome.error ?? '', /Implement was blocked by its environment: node_modules is missing; run the install stage first\./);
  const quoted = stageOutcomeFromSession(reviewNode(), { state: 'completed', responseText: 'The brief mentions `Stage status: blocked-environment:` lines.\n\nAll good.' });
  assert.notEqual(quoted.pause, 'environment', 'only a line of its own counts');
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

test('a stage carries ticket context when provided on context', () => {
  const task = buildStageTaskDefinition(context({ ticketContext: '## Active Ticket: PROJ-101 — Fix bug' }));
  assert.equal(task.ticketContext, '## Active Ticket: PROJ-101 — Fix bug');
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

test('an implementer that committed nothing fails, rather than passing the unchanged branch on', () => {
  const node = reviewNode({
    id: 'implement',
    name: 'Implement',
    outputs: [{ id: 'change-diff', kind: 'diff', required: true }],
    mutatesWorktree: true
  });
  // The shape of a real run: the stage gave up, and the frozen "change" was the commit it started on.
  const outcome = stageOutcomeFromSession(node, {
    state: 'completed',
    startRef: '56bab2a61ecc064858d7ceca5610941cae465543',
    snapshotRef: '56bab2a61ecc064858d7ceca5610941cae465543',
    responseText: 'I will inspect the artifacts first.\n\nI made no changes, produced no TASK-496 change-diff, and did not commit.'
  });
  assert.equal(outcome.status, 'failed');
  assert.match(outcome.error ?? '', /^Implement made no changes: the branch is still at 56bab2a6/);
  assert.match(outcome.error ?? '', /It said: I made no changes/);
  assert.equal(outcome.artifacts, undefined);

  const changed = stageOutcomeFromSession(node, { state: 'completed', startRef: 'sha-before', snapshotRef: 'sha-after' });
  assert.equal(changed.status, 'succeeded');
  assert.deepEqual(changed.artifacts, [{ contractId: 'change-diff', kind: 'diff', path: 'sha-after' }]);
});

function planNode(): WorkflowAgentTaskNode {
  return reviewNode({ id: 'plan', name: 'Plan', inputs: [], outputs: [{ id: 'plan-doc', kind: 'plan', required: true }] });
}

test('a planner that says it is blocked has not produced a plan', () => {
  // A real planner's reply when it had no file tools: non-empty, so it used to count as the plan.
  const outcome = stageOutcomeFromSession(planNode(), {
    state: 'completed',
    responseText: 'Blocked before repository analysis. The available tools provide no local read_file.\n\nPlan status: blocked: no file tools to read the repository'
  });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'Plan did not produce a plan: it reported itself blocked: no file tools to read the repository.');
});

test('a plan must confirm it is ready; prose without the status line is not a plan', () => {
  const missing = stageOutcomeFromSession(planNode(), {
    state: 'completed',
    responseText: 'Blocked before repository analysis. The required plan-doc artifact remains unproduced.'
  });
  assert.equal(missing.status, 'failed');
  assert.match(missing.error ?? '', /no "Plan status: ready" line/);

  const ready = stageOutcomeFromSession(planNode(), {
    state: 'completed',
    responseText: '# Plan\n\n1. Add the contract.\n\n**Plan status: ready**\n\n```praxis-plan\n{}\n```'
  });
  assert.equal(ready.status, 'succeeded');
  assert.deepEqual(ready.artifacts, [{ contractId: 'plan-doc', kind: 'plan' }]);
});

test('readPlanStatus takes the last status line and tolerates markdown around it', () => {
  assert.deepEqual(readPlanStatus('Plan status: blocked: x\n\nNow done.\n`Plan status: ready`'), { ready: true });
  assert.deepEqual(readPlanStatus('Plan status: blocked'), { ready: false, reason: 'it reported itself blocked' });
  assert.deepEqual(readPlanStatus('plan status: Blocked \u2014 no access'), { ready: false, reason: 'it reported itself blocked: no access' });
});

test('readEnvironmentBlock tolerates markdown formatting and concatenated ACP output', () => {
  assert.equal(
    readEnvironmentBlock('**Stage status: blocked-environment: the feature design is missing.**'),
    'the feature design is missing.'
  );
  assert.equal(
    readEnvironmentBlock('Sentence. `Stage status: blocked-environment: missing tool`'),
    'missing tool'
  );
  assert.equal(
    readEnvironmentBlock('*Stage status: blocked-environment: no network*'),
    'no network'
  );
  const outcome = stageOutcomeFromSession(planNode(), {
    state: 'completed',
    responseText: 'I cannot begin implementation.\n\n**Stage status: blocked-environment: the design is missing from this worktree.**'
  });
  assert.equal(outcome.pause, 'environment');
  assert.match(outcome.error ?? '', /the design is missing from this worktree/);
});

test('a concatenated ACP progress message does not hide a final environment block', () => {
  const outcome = stageOutcomeFromSession(planNode(), {
    state: 'completed',
    responseText: 'I will inspect the source first.Stage status: blocked-environment: required file tools are unavailable; enable them.'
  });
  assert.equal(outcome.pause, 'environment');
  assert.match(outcome.error ?? '', /required file tools are unavailable/);
  assert.deepEqual(outcome.artifacts ?? [], []);
});

test('a plan stage is told how to confirm its plan', () => {
  const task = buildStageTaskDefinition(context({ expectedOutputs: [{ id: 'plan-doc', kind: 'plan', required: true }] }));
  assert.match(task.definitionOfDone, /captures that response as the plan artifact/);
  assert.match(task.definitionOfDone, /no writable artifact tool is needed/);
  assert.match(task.definitionOfDone, /Plan status: ready/);
  assert.match(task.definitionOfDone, /Plan status: blocked: <why>/);
  assert.doesNotMatch(buildStageTaskDefinition(context()).definitionOfDone, /Plan status/);
});

test('a board-published plan is proven by its praxis-plan block, not the status line', () => {
  const node = reviewNode({ id: 'plan', name: 'Plan', inputs: [], outputs: [{ id: 'plan-doc', kind: 'plan', required: true, publishTo: 'board' }] });
  const outcome = stageOutcomeFromSession(node, { state: 'completed', responseText: 'Two items.\n```praxis-plan\n{}\n```' });
  assert.equal(outcome.status, 'succeeded');
  const task = buildStageTaskDefinition(context({ expectedOutputs: [{ id: 'plan-doc', kind: 'plan', required: true, publishTo: 'board' }] }));
  assert.doesNotMatch(task.definitionOfDone, /Plan status/);
});

test('readEnvironmentBlock rejects pseudo-blockers where the agent reports incomplete implementation', () => {
  assert.equal(
    readEnvironmentBlock('**Stage status: blocked-environment:** The implementation, verification, diff artifact, and commit are incomplete. I can’t report a commit ref until those steps are finished.'),
    undefined
  );
  assert.equal(
    readEnvironmentBlock('Stage status: blocked-environment: I have not inspected the checkout in this turn.'),
    undefined
  );
});

test('a written markdown file does not displace snapshotRef for diff contracts', () => {
  const node = reviewNode({
    id: 'implement',
    name: 'Implement',
    inputs: [],
    outputs: [{ id: 'change-diff', kind: 'diff', required: true }]
  });
  const outcome = stageOutcomeFromSession(node, {
    state: 'completed',
    responseText: 'Implemented.',
    snapshotRef: 'c0ffee1234567890',
    artifactPaths: { 'change-diff': '.praxis/change-diff.md' }
  });
  assert.deepEqual(outcome.artifacts, [
    { contractId: 'change-diff', kind: 'diff', path: 'c0ffee1234567890' }
  ]);
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

test('formatUpstreamReports inlines each report, capped with head and tail, and says so', () => {
  const long = `START${'x'.repeat(200)}END`;
  const out = formatUpstreamReports(
    [
      { contractId: 'review-report', stageName: 'Review', text: 'looks fine' },
      { contractId: 'big', stageName: 'Analyse', text: long },
      { contractId: 'empty', stageName: 'Skip', text: '   ' }
    ],
    100
  )!;
  assert.match(out, /"review-report" from Review\nlooks fine/);
  assert.match(out, /START/);
  assert.match(out, /END/);
  assert.match(out, /characters omitted/);
  assert.doesNotMatch(out, /"empty"/);
  assert.equal(formatUpstreamReports([{ contractId: 'a', stageName: 'A', text: '' }]), undefined);
});
