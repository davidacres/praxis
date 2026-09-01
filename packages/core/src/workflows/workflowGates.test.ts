import test from 'node:test';
import assert from 'node:assert/strict';
import { applyWorkflowRunCommand, createWorkflowRun, type WorkflowRun } from './workflowRun';
import { advanceJoins } from './workflowScheduler';
import { approvalReadiness, approveStage, bypassGate, evaluateGates, rejectStage } from './workflowGates';
import { preflightStage, preflightWorkflow, type AgentCatalogSnapshot } from './workflowPreflight';
import { buildStageContext, findSnapshot, stageSessions } from './workflowStageSession';
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition, type WorkflowNode, type WorkflowPolicyProfile } from './workflowTypes';
import type { DiscoveredAgent } from '../ai/agentRuntime/manifest';
import type { DiscoveredSkill } from '../ai/agentRuntime/skillRegistry';

const T = (m: number): string => new Date(Date.UTC(2026, 8, 2, 9, m)).toISOString();

// ── Fixtures ─────────────────────────────────────────────────────────────

function agent(id: string, overrides: Partial<DiscoveredAgent> = {}): DiscoveredAgent {
  return {
    manifest: { schemaVersion: 1, id, name: id, type: 'acp', entry: 'run.js' },
    manifestPath: `/agents/${id}/agent.json`,
    rootPath: `/agents/${id}`,
    trusted: true,
    errors: [],
    ...overrides
  };
}

function skill(name: string, overrides: Partial<DiscoveredSkill> = {}): DiscoveredSkill {
  return {
    metadata: { name, description: `${name} skill`, triggers: [] },
    skillPath: `/skills/${name}`,
    instructionsPath: `/skills/${name}/SKILL.md`,
    fingerprint: 'abc123',
    trusted: true,
    ...overrides
  };
}

function catalog(overrides: Partial<AgentCatalogSnapshot> = {}): AgentCatalogSnapshot {
  return {
    agents: [agent('reviewer'), agent('coder')],
    skills: [skill('auditing')],
    capabilities: {},
    ...overrides
  };
}

function reviewNode(overrides: Record<string, unknown> = {}): WorkflowNode {
  return {
    type: 'agent-task',
    id: 'review',
    name: 'Review',
    x: 0,
    y: 0,
    inputs: [],
    agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only' },
    instructions: 'Review it.',
    outputs: [],
    mutatesWorktree: false,
    ...overrides
  } as WorkflowNode;
}

function policy(overrides: Partial<WorkflowPolicyProfile> = {}): WorkflowPolicyProfile {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'p',
    name: 'Policy',
    scope: 'global',
    requiredGates: [],
    requireHumanApproval: true,
    allowGateBypass: false,
    requireTrustedAgents: true,
    maxAttemptsPerNode: 3,
    createdAt: T(0),
    updatedAt: T(0),
    ...overrides
  };
}

// ── Preflight: agents ────────────────────────────────────────────────────

test('an unknown agent fails preflight with a remediation', () => {
  const result = preflightStage(reviewNode({ agent: { agentId: 'ghost', scope: 'global', toolMode: 'read-only' } }), catalog());
  assert.equal(result.ok, false);
  assert.equal(result.failures[0].kind, 'agent-not-found');
  assert.match(result.failures[0].remediation, /Install or import/);
});

test('a malformed manifest fails preflight and points at the file', () => {
  const broken = agent('reviewer', { errors: [{ path: 'entry', message: 'entry requires command or url.' }] });
  const result = preflightStage(reviewNode(), catalog({ agents: [broken] }));
  assert.equal(result.failures[0].kind, 'agent-invalid');
  assert.match(result.failures[0].remediation, /agent\.json/);
});

test('an untrusted agent cannot start a stage under a trust-requiring policy', () => {
  const untrusted = agent('reviewer', { trusted: false });
  const result = preflightStage(reviewNode(), catalog({ agents: [untrusted] }), policy());
  assert.equal(result.ok, false);
  assert.ok(result.failures.some(failure => failure.kind === 'agent-untrusted'));
});

test('an untrusted agent is allowed when policy relaxes the requirement', () => {
  const untrusted = agent('reviewer', { trusted: false });
  const result = preflightStage(reviewNode(), catalog({ agents: [untrusted] }), policy({ requireTrustedAgents: false }));
  assert.equal(result.ok, true);
});

test('trust is required by default when no policy is supplied', () => {
  const untrusted = agent('reviewer', { trusted: false });
  assert.equal(preflightStage(reviewNode(), catalog({ agents: [untrusted] })).ok, false);
});

// ── Preflight: capabilities ──────────────────────────────────────────────

test('a stage requiring capabilities fails when the host is not running', () => {
  const node = reviewNode({
    agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only', requiredCapabilities: { supportsTools: true } }
  });
  const result = preflightStage(node, catalog());
  assert.equal(result.failures[0].kind, 'agent-unavailable');
  assert.match(result.failures[0].remediation, /Start the agent/);
});

test('a capability the agent lacks is named exactly', () => {
  const node = reviewNode({
    agent: {
      agentId: 'reviewer',
      scope: 'global',
      toolMode: 'read-only',
      requiredCapabilities: { supportsTools: true, supportsSkills: true }
    }
  });
  const result = preflightStage(
    node,
    catalog({
      capabilities: {
        reviewer: { supportsSkills: false, supportsTools: true, supportsMemory: false, supportsResume: false, supportsStreaming: false }
      }
    })
  );
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0].message, /supportsSkills/);
});

test('an unset capability requirement means do-not-care, not must-not-support', () => {
  const node = reviewNode({
    agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only', requiredCapabilities: { supportsTools: true } }
  });
  const result = preflightStage(
    node,
    catalog({
      capabilities: {
        reviewer: { supportsSkills: false, supportsTools: true, supportsMemory: false, supportsResume: false, supportsStreaming: false }
      }
    })
  );
  assert.equal(result.ok, true);
});

// ── Preflight: skills ────────────────────────────────────────────────────

test('a missing skill fails preflight', () => {
  const node = reviewNode({
    agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only', skillNames: ['nonexistent'] }
  });
  assert.equal(preflightStage(node, catalog()).failures[0].kind, 'skill-not-found');
});

test('an invalid skill fails preflight', () => {
  const node = reviewNode({
    agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only', skillNames: ['auditing'] }
  });
  const result = preflightStage(node, catalog({ skills: [skill('auditing', { error: 'name and description are required.' })] }));
  assert.equal(result.failures[0].kind, 'skill-invalid');
});

test('a skill whose content drifted from its pin is refused, not silently upgraded', () => {
  const node = reviewNode({
    agent: {
      agentId: 'reviewer',
      scope: 'global',
      toolMode: 'read-only',
      skillNames: ['auditing'],
      skillFingerprints: { auditing: 'the-old-hash' }
    }
  });
  const result = preflightStage(node, catalog());
  assert.equal(result.failures[0].kind, 'skill-drifted');
  assert.match(result.failures[0].remediation, /re-pin/);
});

test('a matching fingerprint passes and binds the resolved skill paths', () => {
  const node = reviewNode({
    agent: {
      agentId: 'reviewer',
      scope: 'global',
      toolMode: 'read-only',
      skillNames: ['auditing'],
      skillFingerprints: { auditing: 'abc123' }
    }
  });
  const result = preflightStage(node, catalog());
  assert.equal(result.ok, true);
  assert.deepEqual(result.binding?.skills, [
    { name: 'auditing', skillPath: '/skills/auditing', instructionsPath: '/skills/auditing/SKILL.md', fingerprint: 'abc123' }
  ]);
});

// ── Preflight: permissions and scope ─────────────────────────────────────

test('a non-mutating stage requesting full tool mode is refused at preflight too', () => {
  const node = reviewNode({ agent: { agentId: 'reviewer', scope: 'global', toolMode: 'full' } });
  assert.ok(preflightStage(node, catalog()).failures.some(failure => failure.kind === 'tool-mode-refused'));
});

test('check, approval, and join stages have nothing to bind and pass trivially', () => {
  const nodes: WorkflowNode[] = [
    { type: 'check', id: 'qa', name: 'QA', x: 0, y: 0, inputs: [], command: 'npm', successExitCodes: [0], outputs: [] },
    { type: 'approval', id: 'ok', name: 'Approve', x: 0, y: 0, inputs: [], prompt: '?', requiredGates: [], allowBypass: false },
    { type: 'join', id: 'j', name: 'Join', x: 0, y: 0, inputs: [], mode: 'all' }
  ];
  for (const node of nodes) assert.equal(preflightStage(node, catalog()).ok, true);
});

test('preflightWorkflow reports per node and fails the whole set on one bad stage', () => {
  const result = preflightWorkflow(
    [reviewNode(), reviewNode({ id: 'bad', agent: { agentId: 'ghost', scope: 'global', toolMode: 'read-only' } })],
    catalog()
  );
  assert.equal(result.ok, false);
  assert.equal(result.byNode.review.ok, true);
  assert.equal(result.byNode.bad.ok, false);
});

// ── Gate and approval fixtures ───────────────────────────────────────────

/** implement → (review ∥ qa) → join → approve. */
function definition(): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'd', name: 'D', scope: 'global', version: 1, entryNodeId: 'implement',
    createdAt: T(0), updatedAt: T(0),
    nodes: [
      {
        type: 'agent-task', id: 'implement', name: 'Implement', x: 0, y: 0, inputs: [],
        agent: { agentId: 'coder', scope: 'global', toolMode: 'full' },
        instructions: 'Build.', outputs: [{ id: 'change-diff', kind: 'diff', required: true }], mutatesWorktree: true
      },
      {
        type: 'agent-task', id: 'review', name: 'Review', x: 0, y: 0, inputs: ['change-diff'],
        agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only' },
        instructions: 'Review.', outputs: [{ id: 'review-report', kind: 'report', required: true }],
        mutatesWorktree: false, satisfiesGate: 'review'
      },
      {
        type: 'check', id: 'qa', name: 'QA', x: 0, y: 0, inputs: ['change-diff'],
        command: 'npm', args: ['test'], successExitCodes: [0],
        outputs: [{ id: 'qa-results', kind: 'test-results', required: true }], satisfiesGate: 'qa'
      },
      { type: 'join', id: 'gates', name: 'Gates', x: 0, y: 0, inputs: [], mode: 'all' },
      {
        type: 'approval', id: 'approve', name: 'Approve', x: 0, y: 0, inputs: [],
        prompt: 'Ship?', requiredGates: ['review', 'qa'], allowBypass: true
      }
    ],
    edges: [
      { id: 'e1', from: 'implement', to: 'review', on: 'success', required: true },
      { id: 'e2', from: 'implement', to: 'qa', on: 'success', required: true },
      { id: 'e3', from: 'review', to: 'gates', on: 'success', required: true },
      { id: 'e4', from: 'qa', to: 'gates', on: 'success', required: true },
      { id: 'e5', from: 'gates', to: 'approve', on: 'success', required: true }
    ]
  };
}

function run(): WorkflowRun {
  return createWorkflowRun({ runId: 'r1', projectId: 'p1', definition: definition(), at: T(0) });
}

function succeed(r: WorkflowRun, nodeId: string, minute: number, snapshotRef?: string): WorkflowRun {
  const node = r.definition.nodes.find(candidate => candidate.id === nodeId);
  const outputs = node && 'outputs' in node ? node.outputs : [];
  let next = applyWorkflowRunCommand(r, { kind: 'node-started', nodeId, at: T(minute), sessionId: `s-${nodeId}` });
  next = applyWorkflowRunCommand(next, {
    kind: 'node-succeeded',
    nodeId,
    at: T(minute + 1),
    artifacts: outputs.map(contract => ({ contractId: contract.id, kind: contract.kind })),
    ...(snapshotRef ? { snapshotRef } : {})
  });
  return advanceJoins(next, T(minute + 1));
}

// ── Gates ────────────────────────────────────────────────────────────────

test('a gate is pending until the node that owns it finishes', () => {
  const gates = evaluateGates(run(), 'approve');
  assert.deepEqual(gates.map(gate => gate.state), ['pending', 'pending']);
});

test('a gate passes only when its owning node succeeded', () => {
  let r = succeed(run(), 'implement', 1, 'sha-abc');
  r = succeed(r, 'review', 3);
  const gates = evaluateGates(r, 'approve');
  assert.equal(gates.find(gate => gate.gate === 'review')?.state, 'passed');
  assert.equal(gates.find(gate => gate.gate === 'qa')?.state, 'pending');
});

test('agent prose cannot pass a deterministic check gate', () => {
  // Review (an agent) succeeds; QA (a check) fails on its exit code. The agent
  // has no way to reach QA's outcome, so the qa gate stays failed.
  let r = succeed(run(), 'implement', 1, 'sha-abc');
  r = succeed(r, 'review', 3);
  r = applyWorkflowRunCommand(r, { kind: 'node-started', nodeId: 'qa', at: T(5) });
  r = applyWorkflowRunCommand(r, { kind: 'node-failed', nodeId: 'qa', at: T(6), error: 'tests failed', exitCode: 1 });

  const gates = evaluateGates(r, 'approve');
  const qa = gates.find(gate => gate.gate === 'qa');
  assert.equal(qa?.state, 'failed');
  assert.equal(qa?.deterministic, true, 'a check-backed gate is marked deterministic');
  assert.equal(approvalReadiness(r, 'approve').canApprove, false);
});

test('policy widens the required gate set beyond what the definition names', () => {
  let r = succeed(run(), 'implement', 1, 'sha-abc');
  r = succeed(r, 'review', 3);
  r = succeed(r, 'qa', 5);

  assert.equal(approvalReadiness(r, 'approve').canApprove, true);
  // The org also demands security, which this workflow has no stage for.
  const withSecurity = approvalReadiness(r, 'approve', policy({ requiredGates: ['security'] }));
  assert.equal(withSecurity.canApprove, false);
  assert.equal(withSecurity.blocking[0].state, 'missing');
});

// ── Approval ─────────────────────────────────────────────────────────────

test('approval is refused while a gate is unmet, whoever asks', () => {
  const r = succeed(run(), 'implement', 1, 'sha-abc');
  const result = approveStage(r, 'approve', { actor: 'dave', at: T(9) });
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /review \(pending\)/);
  assert.equal(result.run, r, 'a refused approval changes nothing');
});

test('approval settles the stage and records a decision per passing gate', () => {
  let r = succeed(run(), 'implement', 1, 'sha-abc');
  r = succeed(r, 'review', 3);
  r = succeed(r, 'qa', 5);

  const result = approveStage(r, 'approve', { actor: 'dave', at: T(9) });
  assert.equal(result.ok, true);
  assert.equal(result.run.nodes.approve.outcome, 'succeeded');
  assert.deepEqual(result.run.gateDecisions.map(decision => decision.gate).sort(), ['qa', 'review']);
  assert.ok(result.run.gateDecisions.every(decision => decision.passed && !decision.bypassed));
});

test('an approval must record who granted it', () => {
  assert.throws(() => approveStage(run(), 'approve', { actor: '  ', at: T(9) }), /who granted it/);
});

test('a rejection fails the stage with an attributed reason', () => {
  let r = succeed(run(), 'implement', 1, 'sha-abc');
  r = succeed(r, 'review', 3);
  r = succeed(r, 'qa', 5);
  const rejected = rejectStage(r, 'approve', { actor: 'dave', reason: 'ship next week', at: T(9) });
  assert.equal(rejected.nodes.approve.outcome, 'failed');
  assert.match(rejected.nodes.approve.attempts[0].error ?? '', /Rejected by dave: ship next week/);
});

// ── Bypass ───────────────────────────────────────────────────────────────

function failedQa(): WorkflowRun {
  let r = succeed(run(), 'implement', 1, 'sha-abc');
  r = succeed(r, 'review', 3);
  r = applyWorkflowRunCommand(r, { kind: 'node-started', nodeId: 'qa', at: T(5) });
  return applyWorkflowRunCommand(r, { kind: 'node-failed', nodeId: 'qa', at: T(6), error: 'tests failed', exitCode: 1 });
}

test('a bypass is refused outright when policy forbids it', () => {
  const result = bypassGate(failedQa(), 'approve', { gate: 'qa', actor: 'dave', reason: 'known flake', at: T(7) }, policy());
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /cannot be bypassed/);
});

test('a bypass records user, time, and reason when policy permits one', () => {
  const permissive = policy({ allowGateBypass: true });
  const result = bypassGate(failedQa(), 'approve', { gate: 'qa', actor: 'dave', reason: 'known flake', at: T(7) }, permissive);
  assert.equal(result.ok, true);

  const decision = result.run.gateDecisions.find(candidate => candidate.gate === 'qa');
  assert.equal(decision?.bypassed, true);
  assert.equal(decision?.bypassedBy, 'dave');
  assert.equal(decision?.reason, 'known flake');
  assert.equal(decision?.decidedAt, T(7));
  assert.ok(
    result.run.events.some(event => event.kind === 'gate-decided' && /bypassed by dave: known flake/.test(event.message)),
    'the bypass is on the event log, not only in the decision list'
  );
});

test('a bypassed gate unblocks approval, and the bypass stays on the record', () => {
  const permissive = policy({ allowGateBypass: true });
  const bypassed = bypassGate(failedQa(), 'approve', { gate: 'qa', actor: 'dave', reason: 'known flake', at: T(7) }, permissive).run;
  assert.equal(approvalReadiness(bypassed, 'approve', permissive).canApprove, true);

  const approved = approveStage(bypassed, 'approve', { actor: 'dave', at: T(8) }, permissive);
  assert.equal(approved.ok, true);
  assert.ok(approved.run.gateDecisions.some(decision => decision.bypassed));
});

test('a pending gate cannot be bypassed — that is a race, not an exemption', () => {
  const permissive = policy({ allowGateBypass: true });
  const r = succeed(run(), 'implement', 1, 'sha-abc');
  const result = bypassGate(r, 'approve', { gate: 'qa', actor: 'dave', reason: 'in a hurry', at: T(7) }, permissive);
  assert.equal(result.ok, false);
  assert.match(result.reason ?? '', /has not finished/);
});

test('an anonymous or unexplained bypass is a programming error', () => {
  const permissive = policy({ allowGateBypass: true });
  assert.throws(() => bypassGate(failedQa(), 'approve', { gate: 'qa', actor: '', reason: 'x', at: T(7) }, permissive), /who performed it/);
  assert.throws(() => bypassGate(failedQa(), 'approve', { gate: 'qa', actor: 'dave', reason: '  ', at: T(7) }, permissive), /why/);
});

// ── Stage context and attribution ────────────────────────────────────────

test('a stage receives only the artifacts it declared as inputs', () => {
  let r = succeed(run(), 'implement', 1, 'sha-abc');
  r = succeed(r, 'review', 3);
  // QA declares only change-diff, though review-report also exists by now.
  const context = buildStageContext(r, 'qa');
  assert.deepEqual(context?.inputs.map(input => input.contractId), ['change-diff']);
  assert.equal(context?.expectedOutputs[0].id, 'qa-results');
});

test('a stage inspects the frozen implementation snapshot, not the live worktree', () => {
  const r = succeed(run(), 'implement', 1, 'sha-abc');
  const context = buildStageContext(r, 'review');
  assert.deepEqual(context?.snapshot, { ref: 'sha-abc', producedByNodeId: 'implement' });
});

test('the nearest upstream snapshot wins when several stages produced one', () => {
  const def = definition();
  def.nodes.push({
    type: 'agent-task', id: 'fixup', name: 'Fixup', x: 0, y: 0, inputs: ['change-diff'],
    agent: { agentId: 'coder', scope: 'global', toolMode: 'full' },
    instructions: 'Fix.', outputs: [], mutatesWorktree: true
  });
  def.edges = def.edges.map(edge => (edge.id === 'e1' ? { ...edge, from: 'fixup' } : edge));
  def.edges.push({ id: 'e6', from: 'implement', to: 'fixup', on: 'success', required: true });

  let r = createWorkflowRun({ runId: 'r2', projectId: 'p1', definition: def, at: T(0) });
  r = succeed(r, 'implement', 1, 'sha-first');
  r = succeed(r, 'fixup', 3, 'sha-second');
  assert.deepEqual(findSnapshot(r, 'review'), { ref: 'sha-second', producedByNodeId: 'fixup' });
});

test('every attempt links to its attributed session', () => {
  let r = succeed(run(), 'implement', 1, 'sha-abc');
  r = succeed(r, 'review', 3);
  const sessions = stageSessions(r);
  assert.deepEqual(
    sessions.map(session => [session.nodeId, session.sessionId, session.agentId]),
    [
      ['implement', 's-implement', 'coder'],
      ['review', 's-review', 'reviewer']
    ]
  );
});
