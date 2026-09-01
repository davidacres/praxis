import test from 'node:test';
import assert from 'node:assert/strict';
import { migrateWorkflow, normalizeWorkflow, validateWorkflow } from './workflowValidation';
import { WORKFLOW_SCHEMA_VERSION, type WorkflowDefinition, type WorkflowPolicyProfile } from './workflowTypes';

/**
 * The shape FX-BE-022 ships as the built-in template:
 * plan → implement → (review ∥ qa ∥ security) → join → approval.
 *
 * Written already-normalized so a round-trip through `normalizeWorkflow` can be
 * asserted as an exact deep-equal.
 */
function deliveryWorkflow(): WorkflowDefinition {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'governed-delivery',
    name: 'Governed delivery',
    scope: 'global',
    version: 1,
    entryNodeId: 'plan',
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z',
    nodes: [
      {
        type: 'agent-task',
        id: 'plan',
        name: 'Plan',
        x: 0,
        y: 0,
        inputs: [],
        agent: { agentId: 'planner', scope: 'global', toolMode: 'read-only' },
        instructions: 'Produce an implementation plan.',
        outputs: [{ id: 'plan-doc', kind: 'plan', required: true }],
        mutatesWorktree: false
      },
      {
        type: 'agent-task',
        id: 'implement',
        name: 'Implement',
        x: 200,
        y: 0,
        inputs: ['plan-doc'],
        agent: { agentId: 'coder', scope: 'global', toolMode: 'full' },
        instructions: 'Implement the plan.',
        outputs: [{ id: 'change-diff', kind: 'diff', required: true }],
        mutatesWorktree: true
      },
      {
        type: 'agent-task',
        id: 'review',
        name: 'Review',
        x: 400,
        y: -120,
        inputs: ['change-diff'],
        agent: { agentId: 'reviewer', scope: 'global', toolMode: 'read-only' },
        instructions: 'Review the diff.',
        outputs: [{ id: 'review-report', kind: 'report', required: true }],
        mutatesWorktree: false,
        satisfiesGate: 'review'
      },
      {
        type: 'check',
        id: 'qa',
        name: 'QA',
        x: 400,
        y: 0,
        inputs: ['change-diff'],
        command: 'npm',
        args: ['test'],
        successExitCodes: [0],
        outputs: [{ id: 'qa-results', kind: 'test-results', required: true }],
        satisfiesGate: 'qa'
      },
      {
        type: 'check',
        id: 'security',
        name: 'Security scan',
        x: 400,
        y: 120,
        inputs: ['change-diff'],
        command: 'npm',
        args: ['audit'],
        successExitCodes: [0],
        outputs: [{ id: 'security-report', kind: 'report', required: true }],
        satisfiesGate: 'security'
      },
      { type: 'join', id: 'gates', name: 'Gates', x: 600, y: 0, inputs: [], mode: 'all' },
      {
        type: 'approval',
        id: 'approve',
        name: 'Approve',
        x: 800,
        y: 0,
        inputs: ['review-report', 'qa-results', 'security-report'],
        prompt: 'Approve this change for delivery?',
        requiredGates: ['review', 'qa', 'security'],
        allowBypass: false
      }
    ],
    edges: [
      { id: 'e1', from: 'plan', to: 'implement', on: 'success', required: true },
      { id: 'e2', from: 'implement', to: 'review', on: 'success', required: true },
      { id: 'e3', from: 'implement', to: 'qa', on: 'success', required: true },
      { id: 'e4', from: 'implement', to: 'security', on: 'success', required: true },
      { id: 'e5', from: 'review', to: 'gates', on: 'success', required: true },
      { id: 'e6', from: 'qa', to: 'gates', on: 'success', required: true },
      { id: 'e7', from: 'security', to: 'gates', on: 'success', required: true },
      { id: 'e8', from: 'gates', to: 'approve', on: 'success', required: true }
    ]
  };
}

function strictPolicy(): WorkflowPolicyProfile {
  return {
    schemaVersion: WORKFLOW_SCHEMA_VERSION,
    id: 'strict',
    name: 'Strict delivery',
    scope: 'global',
    requiredGates: ['review', 'qa', 'security'],
    requireHumanApproval: true,
    allowGateBypass: false,
    requireTrustedAgents: true,
    maxAttemptsPerNode: 3,
    createdAt: '2026-09-02T09:00:00.000Z',
    updatedAt: '2026-09-02T09:00:00.000Z'
  };
}

const paths = (issues: Array<{ path: string }>): string[] => issues.map(issue => issue.path);

// ── Happy path ───────────────────────────────────────────────────────────

test('the governed delivery shape validates clean against a strict policy', () => {
  const result = validateWorkflow(deliveryWorkflow(), strictPolicy());
  assert.deepEqual(result.errors, []);
  assert.equal(result.valid, true);
});

test('a valid definition round-trips through normalization unchanged', () => {
  const definition = deliveryWorkflow();
  const roundTripped = normalizeWorkflow(JSON.parse(JSON.stringify(definition)));
  assert.deepEqual(roundTripped, definition);
});

// ── Migration ────────────────────────────────────────────────────────────

test('a current-version payload migrates without being marked migrated', () => {
  const result = migrateWorkflow(JSON.parse(JSON.stringify(deliveryWorkflow())));
  assert.deepEqual(result.errors, []);
  assert.equal(result.migrated, false);
  assert.equal(result.definition?.id, 'governed-delivery');
});

test('a payload from a newer schema is refused rather than guessed at', () => {
  const result = migrateWorkflow({ ...deliveryWorkflow(), schemaVersion: WORKFLOW_SCHEMA_VERSION + 1 });
  assert.equal(result.definition, undefined);
  assert.deepEqual(paths(result.errors), ['schemaVersion']);
  assert.match(result.errors[0].message, /newer app/);
});

test('a non-object payload is refused', () => {
  assert.deepEqual(paths(migrateWorkflow('not a workflow').errors), ['']);
  assert.deepEqual(paths(migrateWorkflow(null).errors), ['']);
});

test('migration is deterministic — the same payload yields the same definition', () => {
  const payload = JSON.parse(JSON.stringify(deliveryWorkflow()));
  assert.deepEqual(migrateWorkflow(payload).definition, migrateWorkflow(payload).definition);
});

// ── Normalization defaults fail safe ─────────────────────────────────────

test('an unreadable tool mode narrows to read-only rather than widening access', () => {
  const definition = normalizeWorkflow({
    ...deliveryWorkflow(),
    nodes: [{ type: 'agent-task', id: 'a', name: 'A', agent: { agentId: 'x', toolMode: 'root' } }]
  });
  assert.equal(definition.nodes[0].type === 'agent-task' && definition.nodes[0].agent.toolMode, 'read-only');
});

test('a missing mutatesWorktree defaults to mutating so the scheduler serialises it', () => {
  const definition = normalizeWorkflow({
    ...deliveryWorkflow(),
    nodes: [{ type: 'agent-task', id: 'a', name: 'A', agent: { agentId: 'x', toolMode: 'full' } }]
  });
  assert.equal(definition.nodes[0].type === 'agent-task' && definition.nodes[0].mutatesWorktree, true);
});

test('an unreadable allowBypass defaults to false', () => {
  const definition = normalizeWorkflow({
    ...deliveryWorkflow(),
    nodes: [{ type: 'approval', id: 'a', name: 'A', prompt: 'ok?', allowBypass: 'yes' }]
  });
  assert.equal(definition.nodes[0].type === 'approval' && definition.nodes[0].allowBypass, false);
});

// ── Structural failures name the offending path ──────────────────────────

test('a cycle is reported with the path that forms it', () => {
  const definition = deliveryWorkflow();
  definition.edges.push({ id: 'loop', from: 'approve', to: 'implement', on: 'failure', required: false });
  const result = validateWorkflow(definition);
  assert.equal(result.valid, false);
  const cycle = result.errors.find(issue => issue.message.includes('cycle'));
  assert.ok(cycle, 'expected a cycle error');
  assert.match(cycle.message, /implement/);
});

test('an edge naming an unknown node reports that edge, not the graph', () => {
  const definition = deliveryWorkflow();
  definition.edges[0] = { ...definition.edges[0], to: 'ghost' };
  const result = validateWorkflow(definition);
  assert.ok(paths(result.errors).includes('edges[0].to'));
});

test('an unreachable node is rejected and identified by index', () => {
  const definition = deliveryWorkflow();
  definition.nodes.push({
    type: 'check',
    id: 'orphan',
    name: 'Orphan',
    x: 0,
    y: 400,
    inputs: [],
    command: 'echo',
    successExitCodes: [0],
    outputs: []
  });
  const result = validateWorkflow(definition);
  const issue = result.errors.find(candidate => candidate.message.includes('unreachable'));
  assert.ok(issue);
  assert.equal(issue.path, `nodes[${definition.nodes.length - 1}]`);
});

test('the entry node may not have inbound edges', () => {
  const definition = deliveryWorkflow();
  definition.edges.push({ id: 'back', from: 'approve', to: 'plan', on: 'always', required: false });
  assert.ok(paths(validateWorkflow(definition).errors).includes('entryNodeId'));
});

test('a non-join node with two concurrent parents must converge through a join', () => {
  const definition = deliveryWorkflow();
  definition.edges.push({ id: 'extra', from: 'plan', to: 'review', on: 'success', required: true });
  const result = validateWorkflow(definition);
  assert.ok(result.errors.some(issue => issue.message.includes('converge them through a join')));
});

test('success and failure edges from one node may share a target', () => {
  // Routing both outcomes of a stage to the same cleanup/notify node is a
  // normal shape: the edges are mutually exclusive, so only one ever fires.
  // Counting raw inbound edges rejected this; parents are counted by distinct
  // source node for exactly that reason.
  const definition = deliveryWorkflow();
  definition.nodes.push({
    type: 'check',
    id: 'notify',
    name: 'Notify',
    x: 1000,
    y: 0,
    inputs: [],
    command: 'echo',
    successExitCodes: [0],
    outputs: []
  });
  definition.edges.push(
    { id: 'n-ok', from: 'approve', to: 'notify', on: 'success', required: true },
    { id: 'n-no', from: 'approve', to: 'notify', on: 'failure', required: false }
  );
  const result = validateWorkflow(definition);
  assert.deepEqual(result.errors, []);
});

test('an all-required join with no required inbound edge would never release', () => {
  const definition = deliveryWorkflow();
  const join = definition.nodes.find(node => node.id === 'gates');
  if (join?.type === 'join') join.mode = 'all-required';
  definition.edges = definition.edges.map(edge => (edge.to === 'gates' ? { ...edge, required: false } : edge));
  const result = validateWorkflow(definition);
  assert.ok(result.errors.some(issue => issue.message.includes('never release')));
});

// ── Artifact wiring ──────────────────────────────────────────────────────

test('an input no node produces is rejected at its exact index', () => {
  const definition = deliveryWorkflow();
  const index = definition.nodes.findIndex(node => node.id === 'implement');
  definition.nodes[index] = { ...definition.nodes[index], inputs: ['missing-doc'] } as never;
  const result = validateWorkflow(definition);
  assert.ok(paths(result.errors).includes(`nodes[${index}].inputs[0]`));
});

test('an input from a node that is not upstream is rejected', () => {
  // `plan` cannot consume the diff that `implement` produces downstream of it.
  const definition = deliveryWorkflow();
  const index = definition.nodes.findIndex(node => node.id === 'plan');
  definition.nodes[index] = { ...definition.nodes[index], inputs: ['change-diff'] } as never;
  const result = validateWorkflow(definition);
  const issue = result.errors.find(candidate => candidate.path === `nodes[${index}].inputs[0]`);
  assert.ok(issue);
  assert.match(issue.message, /not upstream/);
});

test('a node cannot consume its own output', () => {
  const definition = deliveryWorkflow();
  const index = definition.nodes.findIndex(node => node.id === 'implement');
  definition.nodes[index] = { ...definition.nodes[index], inputs: ['change-diff'] } as never;
  const result = validateWorkflow(definition);
  assert.ok(result.errors.some(issue => issue.message.includes('cannot consume its own output')));
});

test('two nodes producing the same artifact id is rejected', () => {
  const definition = deliveryWorkflow();
  const index = definition.nodes.findIndex(node => node.id === 'review');
  definition.nodes[index] = {
    ...definition.nodes[index],
    outputs: [{ id: 'change-diff', kind: 'report', required: true }]
  } as never;
  const result = validateWorkflow(definition);
  assert.ok(result.errors.some(issue => issue.message.includes('already produced by node')));
});

// ── Permission safety ────────────────────────────────────────────────────

test('a non-mutating stage cannot hold full tool mode', () => {
  const definition = deliveryWorkflow();
  const index = definition.nodes.findIndex(node => node.id === 'review');
  const node = definition.nodes[index];
  if (node.type === 'agent-task') node.agent = { ...node.agent, toolMode: 'full' };
  const result = validateWorkflow(definition);
  assert.ok(paths(result.errors).includes(`nodes[${index}].agent.toolMode`));
});

test('a fingerprint pinning a skill the stage never requests is dead configuration', () => {
  const definition = deliveryWorkflow();
  const index = definition.nodes.findIndex(node => node.id === 'review');
  const node = definition.nodes[index];
  if (node.type === 'agent-task') node.agent = { ...node.agent, skillFingerprints: { auditing: 'abc123' } };
  const result = validateWorkflow(definition);
  assert.ok(paths(result.errors).includes(`nodes[${index}].agent.skillFingerprints.auditing`));
});

// ── Gates and policy ─────────────────────────────────────────────────────

test('approval cannot require a gate no upstream node satisfies', () => {
  const definition = deliveryWorkflow();
  const index = definition.nodes.findIndex(node => node.id === 'security');
  definition.nodes[index] = { ...definition.nodes[index], satisfiesGate: undefined } as never;
  const approvalIndex = definition.nodes.findIndex(node => node.id === 'approve');
  const result = validateWorkflow(definition);
  assert.ok(paths(result.errors).includes(`nodes[${approvalIndex}].requiredGates[2]`));
});

test('a policy requiring human approval rejects a workflow with no approval stage', () => {
  const definition = deliveryWorkflow();
  definition.nodes = definition.nodes.filter(node => node.id !== 'approve');
  definition.edges = definition.edges.filter(edge => edge.to !== 'approve');
  const result = validateWorkflow(definition, strictPolicy());
  assert.ok(result.errors.some(issue => issue.message.includes('requires a human approval stage')));
});

test('a policy forbidding bypass rejects an approval stage that allows it', () => {
  const definition = deliveryWorkflow();
  const index = definition.nodes.findIndex(node => node.id === 'approve');
  definition.nodes[index] = { ...definition.nodes[index], allowBypass: true } as never;
  const result = validateWorkflow(definition, strictPolicy());
  assert.ok(paths(result.errors).includes(`nodes[${index}].allowBypass`));
});

test('a policy gate that no node satisfies is reported against the policy', () => {
  const definition = deliveryWorkflow();
  const index = definition.nodes.findIndex(node => node.id === 'security');
  definition.nodes[index] = { ...definition.nodes[index], satisfiesGate: undefined } as never;
  const result = validateWorkflow(definition, strictPolicy());
  assert.ok(paths(result.errors).includes('policy.requiredGates[2]'));
});

test('a node exceeding the policy attempt cap is rejected', () => {
  const definition = deliveryWorkflow();
  const index = definition.nodes.findIndex(node => node.id === 'qa');
  definition.nodes[index] = { ...definition.nodes[index], maxAttempts: 9 } as never;
  const result = validateWorkflow(definition, strictPolicy());
  assert.ok(paths(result.errors).includes(`nodes[${index}].maxAttempts`));
});

// ── Scope and ownership ──────────────────────────────────────────────────

test('a project-scoped workflow without a projectId is rejected', () => {
  const result = validateWorkflow({ ...deliveryWorkflow(), scope: 'project' });
  assert.ok(paths(result.errors).includes('projectId'));
});

test('a global workflow carrying a projectId is rejected', () => {
  const result = validateWorkflow({ ...deliveryWorkflow(), projectId: 'project-1' });
  assert.ok(paths(result.errors).includes('projectId'));
});
